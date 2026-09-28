/**
 * tools/subagent-wait.ts — The `subagent_wait` tool.
 *
 * Blocks until background subagents (spawned with wait: false) finish and
 * returns their full results. Returns immediately for already-completed jobs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { collectResultText, hasPersistedJob, persistedTaskInfos } from "../jobs.ts";
import { jobs, toTaskInfo, waitForJob, type ToolDetails } from "../runtime.ts";
import { reportPersistedTaskUsage, reportTaskUsage } from "../usage.ts";

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
		if (params.jobIds.length === 0) throw new Error("Missing jobIds: provide one or more job ids returned by subagent (wait: false).");
		const jobIds = [...new Set(params.jobIds)];
		const unknown = jobIds.filter((id) => !jobs.has(id) && !hasPersistedJob(id));
		if (unknown.length > 0) throw new Error(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}. Use jobIds returned by subagent or subagent_resume to restore persisted work.`);
		// Jobs found only on disk belonged to an earlier parent process and are
		// already stopped from this process's perspective; collect them directly.
		const liveIds = jobIds.filter((id) => jobs.has(id));
		const timeoutMs = params.timeoutSeconds !== undefined ? params.timeoutSeconds * 1000 : undefined;
		const results = await Promise.all(liveIds.map((id) => waitForJob(id, { signal, timeoutMs })));
		const timedOut = results.some((completed) => !completed && !signal?.aborted);
		const aborted = Boolean(signal?.aborted && !results.every(Boolean));
		if (aborted) throw new Error(`Wait aborted for job(s) ${jobIds.join(", ")}; background work continues. Call subagent_wait again or inspect with subagent_status.`);
		const timeoutNote = timedOut ? `\n\n(Timed out after ${params.timeoutSeconds}s; still-running jobs continue in the background — call subagent_wait again or subagent_status.)` : undefined;
		const { text } = collectResultText(jobIds, timeoutNote);
		const collectedTasks = jobIds.flatMap((id) => jobs.get(id)?.tasks ?? []);
		const persistedTasks = jobIds.filter((id) => !jobs.has(id)).flatMap((id) => persistedTaskInfos(id));
		const liveUsage = await reportTaskUsage(collectedTasks);
		const diskUsage = await reportPersistedTaskUsage(jobIds.filter((id) => !jobs.has(id)));
		return {
			content: [{ type: "text", text }],
			details: { mode: "collect" as const, jobIds, tasks: [...collectedTasks.map(toTaskInfo), ...persistedTasks] },
			usage: {
				input: liveUsage.input + diskUsage.input,
				output: liveUsage.output + diskUsage.output,
				cacheRead: liveUsage.cacheRead + diskUsage.cacheRead,
				cacheWrite: liveUsage.cacheWrite + diskUsage.cacheWrite,
				totalTokens: liveUsage.totalTokens + diskUsage.totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: liveUsage.cost.total + diskUsage.cost.total },
			},
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("subagent_wait ")) + theme.fg("muted", "(collect results)"), 0, 0);
	},
});
