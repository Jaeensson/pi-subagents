/**
 * tools/subagent-pause.ts — The `subagent_pause` tool.
 *
 * Gracefully interrupts a running job: running tasks are flagged and
 * SIGTERM'd; they finalize as `paused` with their session files intact.
 * Resume later with subagent_resume. Paused jobs hold subagent_wait callers
 * until they time out — resume to let them proceed.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { displayAgentName } from "../core.ts";
import { pauseJob } from "../jobs.ts";
import { toTaskInfo, type ToolDetails } from "../runtime.ts";

const subagentPauseParams = Type.Object({
	jobId: Type.String({ description: "Job id returned by subagent (wait: false)" }),
});

export const subagentPauseTool = defineTool<typeof subagentPauseParams, ToolDetails>({
	name: "subagent_pause",
	label: "Subagent Pause",
	description:
		"Gracefully pause a running background subagent job: running tasks are interrupted, their session transcripts are finalized to disk, and they can be resumed later with subagent_resume. Paused jobs hold subagent_wait callers until they time out.",
	promptSnippet: "Gracefully pause a running background subagent job (resume later with subagent_resume)",
	parameters: subagentPauseParams,

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const found = pauseJob(params.jobId);
		if (!found) {
			return {
				content: [{ type: "text", text: `Unknown job id (not found in this session): ${params.jobId}` }],
				details: { mode: "collect", jobIds: [params.jobId], tasks: [] },
				isError: true,
			};
		}
		const lines = found.paused.length
			? found.paused.map((t) => `- ⏸ [${displayAgentName(t.agent)}${t.name ? `/${t.name}` : ""}] ${t.id}`)
			: ["(no running tasks — nothing to pause)"];
		return {
			content: [
				{
					type: "text",
					text: [
						`Paused ${found.paused.length} task(s) in job ${params.jobId}.`,
						...lines,
						"",
						`Resume with subagent_resume { jobId: "${params.jobId}" }.`,
					].join("\n"),
				},
			],
			details: { mode: "collect", jobIds: [params.jobId], tasks: found.job.tasks.map(toTaskInfo) },
		};
	},

	renderCall(args, theme, _context) {
		return new Text(
			theme.fg("toolTitle", theme.bold("subagent_pause ")) + theme.fg("accent", String(args.jobId ?? "")),
			0,
			0,
		);
	},
});
