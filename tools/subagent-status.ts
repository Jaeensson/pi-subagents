/**
 * tools/subagent-status.ts — The `subagent_status` tool.
 *
 * Non-blocking progress check for background subagents: current status,
 * partial output, and usage, without waiting.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatStatusReport } from "../core.ts";
import { formatJobListings, hasPersistedJob, listJobsForCurrentSession, persistedTaskInfos } from "../jobs.ts";
import { jobs, toTaskInfo, type ToolDetails } from "../runtime.ts";

const subagentStatusParams = Type.Object({
	jobIds: Type.Optional(
		Type.Array(Type.String({ description: "Job ids to check. Omit to list all jobs (live + persisted for this session)." })),
	),
});

export const subagentStatusTool = defineTool<typeof subagentStatusParams, ToolDetails>({
	name: "subagent_status",
	label: "Subagent Status",
	description:
		"Non-blocking progress check for background subagents spawned with subagent (wait: false). Returns current status, partial output, and usage without waiting. Omit jobIds to list all jobs for this session, including interrupted jobs from a previous run of it.",
	promptSnippet: "Check progress of background subagents without blocking",
	parameters: subagentStatusParams,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		if (!params.jobIds || params.jobIds.length === 0) {
			return {
				content: [{ type: "text", text: formatJobListings(listJobsForCurrentSession()) }],
				details: { mode: "collect" as const, jobIds: [], tasks: [] },
			};
		}
		const tasksList = params.jobIds.flatMap((id) => jobs.get(id)?.tasks ?? []);
		const unknown = params.jobIds.filter((id) => !jobs.has(id) && !hasPersistedJob(id));
		// Persisted (crashed) jobs are not in the registry; render their manifest
		// tasks so status works for interrupted jobs too.
		const persistedTasks = params.jobIds
			.filter((id) => !jobs.has(id) && hasPersistedJob(id))
			.flatMap((id) => persistedTaskInfos(id));
		const parts: string[] = [];
		if (tasksList.length > 0) parts.push(formatStatusReport(tasksList, { maxOutputBytes: 2000 }));
		if (persistedTasks.length > 0) parts.push(formatStatusReport(persistedTasks, { maxOutputBytes: 2000 }));
		if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
		return {
			content: [{ type: "text", text: parts.join("\n\n---\n\n") || "(no tasks)" }],
			details: { mode: "collect" as const, jobIds: params.jobIds, tasks: [...tasksList.map(toTaskInfo), ...persistedTasks] },
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("muted", "(check progress)"), 0, 0);
	},
});
