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
import { killTask } from "./process.ts";
import { clearRegistry, listRunningTasks, setMessageSender } from "./runtime.ts";
import { disposeWidget, setUi } from "./tui.ts";
import { subagentAgentsTool } from "./tools/subagent-agents.ts";
import { subagentStatusTool } from "./tools/subagent-status.ts";
import { subagentWaitTool } from "./tools/subagent-wait.ts";
import { subagentTool } from "./tools/subagent.ts";

// Set when the extension loads; used by async completion notifications.
let api: ExtensionAPI;

export default function (pi: ExtensionAPI) {
	api = pi;
	setMessageSender((text) => {
		void api.sendUserMessage(text, { deliverAs: "steer" });
	});

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		setUi(ctx.ui);
	});

	pi.on("session_shutdown", async () => {
		// Drop UI references first so task-close callbacks during teardown no-op.
		setUi(undefined);
		disposeWidget();
		for (const t of listRunningTasks()) killTask(t);
		clearRegistry();
	});

	pi.registerTool(subagentTool);
	pi.registerTool(subagentWaitTool);
	pi.registerTool(subagentStatusTool);
	pi.registerTool(subagentAgentsTool);
}
