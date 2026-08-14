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
import { jobs, toTaskInfo, type ToolDetails } from "../runtime.ts";

const subagentStatusParams = Type.Object({
	jobIds: Type.Array(Type.String({ description: "Job ids returned by subagent (wait: false)" })),
});

export const subagentStatusTool = defineTool<typeof subagentStatusParams, ToolDetails>({
	name: "subagent_status",
	label: "Subagent Status",
	description:
		"Non-blocking progress check for background subagents spawned with subagent (wait: false). Returns current status, partial output, and usage without waiting.",
	promptSnippet: "Check progress of background subagents without blocking",
	parameters: subagentStatusParams,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const tasksList = params.jobIds.flatMap((id) => jobs.get(id)?.tasks ?? []);
		const unknown = params.jobIds.filter((id) => !jobs.has(id));
		const parts: string[] = [];
		if (tasksList.length > 0) parts.push(formatStatusReport(tasksList, { maxOutputBytes: 2000 }));
		if (unknown.length > 0) parts.push(`Unknown job id(s) (not found in this session): ${unknown.join(", ")}`);
		return {
			content: [{ type: "text", text: parts.join("\n\n---\n\n") || "(no tasks)" }],
			details: { mode: "collect" as const, jobIds: params.jobIds, tasks: tasksList.map(toTaskInfo) },
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("subagent_status ")) + theme.fg("muted", "(check progress)"), 0, 0);
	},
});
