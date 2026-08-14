/**
 * tools/subagent-wait.ts — The `subagent_wait` tool.
 *
 * Blocks until background subagents (spawned with wait: false) finish and
 * returns their full results. Returns immediately for already-completed jobs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { collectResultText } from "../jobs.ts";
import { jobs, toTaskInfo, waitForJob, type ToolDetails } from "../runtime.ts";

const subagentWaitParams = Type.Object({
	jobIds: Type.Array(Type.String({ description: "Job ids returned by subagent (wait: false)" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Maximum seconds to wait. Returns partial results if exceeded. Default: wait indefinitely." })),
});

export const subagentWaitTool = defineTool<typeof subagentWaitParams, ToolDetails>({
	name: "subagent_wait",
	label: "Subagent Wait",
	description:
		"Block until previously spawned background subagents (from subagent with wait: false) finish, returning their full results. Returns immediately for already-completed jobs.",
	promptSnippet: "Wait for background subagents to finish and return their full results (takes jobIds from subagent wait:false)",
	promptGuidelines: [
		"Use subagent_wait when you need the results of background subagents you spawned with subagent wait:false.",
		"While subagent_wait is running you can only wait; use subagent_status instead to keep working.",
	],
	parameters: subagentWaitParams,

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const timeoutMs = params.timeoutSeconds !== undefined ? params.timeoutSeconds * 1000 : undefined;
		const results = await Promise.all(params.jobIds.map((id) => waitForJob(id, { signal, timeoutMs })));
		const timedOut = results.some((completed) => !completed && !signal?.aborted);
		const aborted = Boolean(signal?.aborted && !results.every(Boolean));
		const timeoutNote = timedOut ? `\n\n(Timed out after ${params.timeoutSeconds}s; still-running jobs continue in the background — call subagent_wait again or subagent_status.)` : aborted ? "\n\n(Wait aborted; background jobs continue running — call subagent_wait or subagent_status later.)" : undefined;
		const { text, anyFailed } = collectResultText(params.jobIds, timeoutNote);
		return {
			content: [{ type: "text", text }],
			details: { mode: "collect" as const, jobIds: params.jobIds, tasks: params.jobIds.flatMap((id) => jobs.get(id)?.tasks.map(toTaskInfo) ?? []) },
			isError: anyFailed && !timedOut && !aborted,
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("subagent_wait ")) + theme.fg("muted", "(collect results)"), 0, 0);
	},
});
