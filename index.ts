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

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { beginTaskShutdown, markInterruptedSweep, resumeTaskSpawning, shutdownTaskProcesses } from "./process.ts";
import { seedBundledAgents } from "./agents.ts";
import {
	clearRegistry,
	setJobFinishedHook,
	setMessageSender,
	setStatusChangedHook,
	setJobsRoot,
	setParentSessionId,
	tasks,
	jobs,
	subscribeRuntimeObservations,
} from "./runtime.ts";
import { COMPLETION_MESSAGE_TYPE, disposeWidget, registerCompletionRenderer, registerInterruptedRenderer, INTERRUPTED_MESSAGE_TYPE, setUi, updateStatusWidget } from "./tui.ts";
import { deleteExpiredJob, isResumableJob, listJobManifests, pruneEmptyBuckets, reconcileManifest } from "./store.ts";
import { formatJobListings, getDefaultJobsRoot, listJobsForCurrentSession, readJobRetentionDays } from "./jobs.ts";
import { disposeWatch, handleWatchInput, maybeAutoCloseWatch } from "./watch.ts";
import { registerSubagentsCommand } from "./command-subagents.ts";
import { createHerdrAdapter } from "./herdr-adapter.ts";
import { createHerdrMonitor, nodeMonitorClock, type HerdrMonitor } from "./herdr-monitor.ts";
import { createViewerManager } from "./herdr-viewers.ts";
import { readHerdrOptions, type HerdrOptions } from "./herdr-settings.ts";
import { subagentAgentsTool } from "./tools/subagent-agents.ts";
import { subagentPauseTool } from "./tools/subagent-pause.ts";
import { subagentResumeTool } from "./tools/subagent-resume.ts";
import { subagentStatusTool } from "./tools/subagent-status.ts";
import { subagentWaitTool } from "./tools/subagent-wait.ts";
import { subagentTool } from "./tools/subagent.ts";

// Set when the extension loads; used by async completion notifications.
let api: ExtensionAPI;
let activeHerdrMonitor: HerdrMonitor | undefined;

function warnHerdr(message: string): void {
	const safe = message.replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1F\x7F-\x9F]/g, "").slice(0, 160);
	try { process.stderr.write(`Herdr monitoring: ${safe}\n`); } catch { /* diagnostics only */ }
}

function applyHerdrOptions(next: HerdrOptions): void {
	try { activeHerdrMonitor?.applyOptions(next); } catch { /* monitoring is optional */ }
}

export default function (pi: ExtensionAPI, options: { createMonitor?: typeof createHerdrMonitor } = {}) {
	api = pi;
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
		const previousMonitor = activeHerdrMonitor;
		activeHerdrMonitor = undefined;
		try {
			const previousCleanup = previousMonitor?.stop();
			if (previousCleanup && typeof (previousCleanup as Promise<void>).then === "function") {
				void Promise.resolve(previousCleanup).catch(() => {});
			}
		} catch { /* a prior monitor cannot prevent session rebinding */ }
		try {
			const settingsPath = path.join(getAgentDir(), "settings.json");
			const herdrOptions = readHerdrOptions(settingsPath);
			const createMonitor = options.createMonitor ?? createHerdrMonitor;
			const monitor = createMonitor({
				env: process.env,
				getTasks: () => {
					const sessionId = psid;
					return sessionId ? [...tasks.values()].filter(task => jobs.get(task.jobId)?.parentSessionId === sessionId) : [];
				},
				subscribe: subscribeRuntimeObservations,
				adapterFactory: createHerdrAdapter,
				clock: nodeMonitorClock,
				warn: warnHerdr,
				viewerFactory: createViewerManager,
			});
			monitor.start(psid ?? "", ctx.cwd ?? process.cwd(), herdrOptions);
			activeHerdrMonitor = monitor;
		} catch { /* monitoring is optional and must not affect session startup */ }
		if (!ctx.hasUI) return;
		setUi(ctx.ui);
		ctx.ui.onTerminalInput((data) => handleWatchInput(data));
	});

	pi.on("session_shutdown", async () => {
		// Prevent delayed spawn setup from launching a child after this sweep starts.
		beginTaskShutdown();
		let herdrCleanup: Promise<void> | undefined;
		try {
			const result = activeHerdrMonitor?.stop();
			if (result && typeof (result as Promise<void>).then === "function") {
				herdrCleanup = Promise.resolve(result).catch(() => {});
			}
		} catch { /* monitor cleanup cannot prevent child reaping */ }
		activeHerdrMonitor = undefined;
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
		if (herdrCleanup) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([herdrCleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
			if (timer) clearTimeout(timer);
		}
	});

	pi.registerTool(subagentTool);
	pi.registerTool(subagentWaitTool);
	pi.registerTool(subagentStatusTool);
	pi.registerTool(subagentAgentsTool);
	pi.registerTool(subagentPauseTool);
	pi.registerTool(subagentResumeTool);
	registerSubagentsCommand(pi, applyHerdrOptions);
}
