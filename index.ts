/**
 * Subagent Tool — extension entry.
 *
 * Delegate tasks to specialized agents with isolated context.
 *
 * Spawns a separate `pi --mode json` process per subagent, giving each an
 * isolated context window. Supports:
 *
 *   - Single:   { agent?, task }                 (omit agent for a raw prompt → built-in default agent)
 *   - Parallel: { tasks: [{agent?, task}, ...] }  (concurrent; agent optional → default agent)
 *   - Chain:    { chain: [{agent?, task, ...}] }  (sequential, {previous} placeholder; agent optional)
 *
 * Two execution modes per call:
 *   - wait: true  (default) — blocks until the subagent(s) finish, returns results.
 *   - wait: false — spawns background subagents and returns jobIds immediately,
 *                   so the parent can keep working in parallel. Collect results
 *                   with `subagent_wait`, check progress with `subagent_status`.
 *                   A compact summary is delivered into the conversation when a
 *                   batch finishes (unless notifyOnComplete: false).
 *
 * Children run with --no-extensions/--no-skills/--no-prompt-templates (lean,
 * no recursion). Agent definitions: ~/.pi/agent/agents/*.md (see agents.ts).
 *
 * Module layout (each file is a single responsibility):
 *   runtime.ts  — in-memory task/job registry, waiters, completion checks
 *   process.ts  — child pi process lifecycle (spawn/kill/finalize)
 *   jobs.ts     — job orchestration: chain runner, concurrency, results, model context
 *   tui.ts      — TUI rendering helpers + persistent status widget
 *   command-subagents.ts — /subagents settings dialog (model tiers)
 *   tools/*.ts  — one file per registered tool
 */

import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrAdapter } from "./herdr-adapter.ts";
import { detectMux } from "./mux-detection.ts";
import { createHerdrMonitor, nodeMonitorClock, type HerdrMonitor } from "./mux-monitor.ts";
import { readHerdrOptions } from "./herdr-settings.ts";
import { createViewerManager } from "./mux-viewers.ts";
import { beginTaskShutdown, markInterruptedSweep, resumeTaskSpawning, shutdownTaskProcesses } from "./process.ts";
import { seedBundledAgents } from "./agents.ts";
import {
	clearRegistry,
	setJobFinishedHook,
	setMessageSender,
	setStatusChangedHook,
	setJobsRoot,
	setParentSessionId,
	subscribeRuntimeObservations,
	tasks,
	jobs,
} from "./runtime.ts";
import { COMPLETION_MESSAGE_TYPE, disposeWidget, registerCompletionRenderer, registerInterruptedRenderer, INTERRUPTED_MESSAGE_TYPE, setUi, updateStatusWidget } from "./tui.ts";
import { deleteExpiredJob, isResumableJob, listJobManifests, pruneEmptyBuckets, reconcileManifest } from "./store.ts";
import { formatJobListings, getDefaultJobsRoot, listJobsForCurrentSession, readJobRetentionDays } from "./jobs.ts";
import { disposeWatch, handleWatchInput, maybeAutoCloseWatch } from "./watch.ts";
import { registerSubagentsCommand } from "./command-subagents.ts";
import { subagentAgentsTool } from "./tools/subagent-agents.ts";
import { subagentPauseTool } from "./tools/subagent-pause.ts";
import { subagentResumeTool } from "./tools/subagent-resume.ts";
import { subagentStatusTool } from "./tools/subagent-status.ts";
import { subagentWaitTool } from "./tools/subagent-wait.ts";
import { subagentTool } from "./tools/subagent.ts";

// Set when the extension loads; used by async completion notifications.
let api: ExtensionAPI;

export default function (pi: ExtensionAPI, ports: { createMonitor?: typeof createHerdrMonitor } = {}) {
	api = pi;
	let boundSessionId: string | undefined;
	let monitorStartupGeneration = 0;
	let monitor: HerdrMonitor | undefined;
	// Never relay external CLI diagnostics to JSON stdout or terminal controls.
	const warn = (message: string) => {
		const safe = message.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
			.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 80);
		try { process.stderr.write(`${safe}\n`); } catch { /* display only */ }
	};
	// One idle controller owns sequencing and the shared raw adapter across starts.
	// Construction must not activate commands, subscriptions, files, or timers.
	try {
		monitor = (ports.createMonitor ?? createHerdrMonitor)({
			env: process.env,
			getTasks: () => boundSessionId === undefined ? [] : [...tasks.values()].filter(
				(task) => jobs.get(task.jobId)?.parentSessionId === boundSessionId,
			),
			subscribe: subscribeRuntimeObservations,
			detect: detectMux,
			adapterFactory: createHerdrAdapter,
			clock: nodeMonitorClock,
			viewerFactory: createViewerManager,
			warn,
		});
	} catch { warn("Herdr monitoring unavailable: controller creation failed"); }
	const stopMonitor = (): Promise<void> | undefined => {
		try {
			// Attach rejection handling NOW, not after durable writes or child reaping.
			return monitor?.stop()?.catch(() => { warn("Herdr monitoring cleanup failed"); });
		} catch { warn("Herdr monitoring cleanup failed"); }
	};
	// Completion notifications go out as custom messages (rendered as a
	// "finished" card, not a "Steering: ..." user message) but keep the
	// same delivery timing and still trigger a turn, matching the old
	// sendUserMessage behavior.
	setMessageSender((text, details) => {
		api.sendMessage(
			{ customType: COMPLETION_MESSAGE_TYPE, content: text, display: true, details },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	});
	// The job-finished hook drives the watch-pane auto-close: the pane closes
	// only when a whole job batch completes, not between chain steps.
	setJobFinishedHook(() => maybeAutoCloseWatch());
	setStatusChangedHook(updateStatusWidget);
	registerCompletionRenderer(pi);
	registerInterruptedRenderer(pi);

	// Seed bundled default agents (scout, researcher, worker, reviewer) into
	// ~/.pi/agent/agents when missing — existing user files always win.
	seedBundledAgents();

	pi.on("session_start", async (event, ctx) => {
		// This stamp gates only optional monitoring, never native recovery or UI.
		const startupGeneration = ++monitorStartupGeneration;
		resumeTaskSpawning();
		// Session-scoped persistence: bind the store bucket, GC old jobs, and
		// surface resumable jobs from a previous run of THIS session.
		const psid = ctx.sessionManager?.getSessionId?.();
		setParentSessionId(psid);
		const root = getDefaultJobsRoot();
		setJobsRoot(root);
		try {
			const retention = readJobRetentionDays();
			const now = Date.now();
			// GC all parent-session buckets. A live owner with a running job is
			// protected even when another session starts in this Pi process.
			for (const e of listJobManifests(root)) {
				await deleteExpiredJob(root, e.parentSessionId, e.jobId, now, retention);
			}
			await pruneEmptyBuckets(root);
			if (psid) {
				// Reconcile THIS session only, and await all durable recovery before
				// surfacing jobs or allowing later tool calls to resume them.
				for (const e of listJobManifests(root).filter((entry) => entry.parentSessionId === psid)) {
					await reconcileManifest(root, psid, e.jobId);
				}
				// Surface only when THIS session starts/resumes; a brand-new session
				// gets a fresh id and must never see another session's jobs (spec).
				if (event.reason === "startup" || event.reason === "resume") {
					const resumable = listJobManifests(root).filter(
						(e) => e.parentSessionId === psid && isResumableJob(e.manifest),
					);
					if (resumable.length > 0) {
						api.sendMessage(
							{
								customType: INTERRUPTED_MESSAGE_TYPE,
								content: `${formatJobListings(listJobsForCurrentSession())}\n\nResume with subagent_resume { jobId: "…" } — or omit jobId to list all.`,
								display: true,
							},
							{ triggerTurn: false },
						);
					}
				}
			}
		} catch {
			/* store problems never block startup */
		}
		if (startupGeneration === monitorStartupGeneration) {
			try {
				const options = readHerdrOptions(path.join(getAgentDir(), "settings.json"));
				// Commit the supplier with the synchronous activation, after recovery.
				// Pending work from the old activation keeps its old session until now.
				boundSessionId = psid || undefined;
				if (psid) monitor?.start(psid, ctx.cwd, options);
				else void stopMonitor();
			} catch (error) {
				// Retain the controller even if start allocated resources before throwing.
				void stopMonitor();
				warn(`Herdr monitoring unavailable: ${error instanceof Error ? error.message : "start failed"}`);
			}
		}
		if (!ctx.hasUI) return;
		setUi(ctx.ui);
		ctx.ui.onTerminalInput((data) => handleWatchInput(data));
	});

	pi.on("session_shutdown", async () => {
		// Prevent delayed spawn setup from launching a child after this sweep starts.
		beginTaskShutdown();
		++monitorStartupGeneration;
		boundSessionId = undefined;
		const monitorCleanup = stopMonitor();
		// Drop UI references first so task-close callbacks during teardown no-op.
		setUi(undefined);
		disposeWidget();
		disposeWatch();
		// Durable record first: mark non-terminal tasks `interrupted` and flush
		// their manifests BEFORE killing children (their exit events then no-op).
		try {
			await markInterruptedSweep();
		} catch {
			/* best-effort */
		}
		// Ownership comes from actual child processes, not task status: the
		// durable sweep may already have changed running tasks to interrupted.
		await shutdownTaskProcesses();
		clearRegistry();
		// Only a returned promise earns a final guard; outside Herdr stop is undefined.
		if (monitorCleanup) {
			await new Promise<void>((resolve) => {
				const finish = () => { clearTimeout(timer); resolve(); };
				const timer = setTimeout(finish, 2000);
				void monitorCleanup.then(finish);
			});
		}
	});

	pi.registerTool(subagentTool);
	pi.registerTool(subagentWaitTool);
	pi.registerTool(subagentStatusTool);
	pi.registerTool(subagentAgentsTool);
	pi.registerTool(subagentPauseTool);
	pi.registerTool(subagentResumeTool);
	registerSubagentsCommand(pi, (next) => {
		if (boundSessionId === undefined) return;
		try { monitor?.applyOptions(next); }
		catch { warn("Herdr monitoring unavailable: option change failed"); }
	});
}
