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
 *   tools/*.ts  — one file per registered tool
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { killTask, markInterruptedSweep } from "./process.ts";
import { seedBundledAgents } from "./agents.ts";
import {
	clearRegistry,
	listRunningTasks,
	setJobFinishedHook,
	setMessageSender,
	setJobsRoot,
	setParentSessionId,
} from "./runtime.ts";
import { COMPLETION_MESSAGE_TYPE, disposeWidget, registerCompletionRenderer, registerInterruptedRenderer, INTERRUPTED_MESSAGE_TYPE, setUi } from "./tui.ts";
import { deletePath, isJobExpired, isResumableJob, listJobManifests, pruneEmptyBuckets } from "./store.ts";
import { formatJobListings, getDefaultJobsRoot, listJobsForCurrentSession, readJobRetentionDays } from "./jobs.ts";
import { disposeWatch, handleWatchInput, maybeAutoCloseWatch } from "./watch.ts";
import { subagentAgentsTool } from "./tools/subagent-agents.ts";
import { subagentPauseTool } from "./tools/subagent-pause.ts";
import { subagentResumeTool } from "./tools/subagent-resume.ts";
import { subagentStatusTool } from "./tools/subagent-status.ts";
import { subagentWaitTool } from "./tools/subagent-wait.ts";
import { subagentTool } from "./tools/subagent.ts";

// Set when the extension loads; used by async completion notifications.
let api: ExtensionAPI;

export default function (pi: ExtensionAPI) {
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
	registerCompletionRenderer(pi);
	registerInterruptedRenderer(pi);

	// Seed bundled default agents (scout, researcher, worker, reviewer) into
	// ~/.pi/agent/agents when missing — existing user files always win.
	seedBundledAgents();

	pi.on("session_start", async (event, ctx) => {
		// Session-scoped persistence: bind the store bucket, GC old jobs, and
		// surface resumable jobs from a previous run of THIS session.
		const psid = ctx.sessionManager?.getSessionId?.();
		setParentSessionId(psid);
		const root = getDefaultJobsRoot();
		setJobsRoot(root);
		if (psid) {
			try {
				const retention = readJobRetentionDays();
				const entries = listJobManifests(root).filter((e) => e.parentSessionId === psid);
				const now = Date.now();
				for (const e of entries) {
					if (isJobExpired(e.manifest.updatedAt, now, retention)) await deletePath(e.dir);
				}
				await pruneEmptyBuckets(root);
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
			} catch {
				/* store problems never block startup */
			}
		}
		if (!ctx.hasUI) return;
		setUi(ctx.ui);
		ctx.ui.onTerminalInput((data) => handleWatchInput(data));
	});

	pi.on("session_shutdown", async () => {
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
		for (const t of listRunningTasks()) killTask(t);
		clearRegistry();
	});

	pi.registerTool(subagentTool);
	pi.registerTool(subagentWaitTool);
	pi.registerTool(subagentStatusTool);
	pi.registerTool(subagentAgentsTool);
	pi.registerTool(subagentPauseTool);
	pi.registerTool(subagentResumeTool);
}
