/**
 * tools/subagent-resume.ts — The `subagent_resume` tool.
 *
 * {} lists persisted + live jobs for this parent session; { jobId } resumes an
 * interrupted/paused/aborted job: resumable tasks re-spawn on their session
 * transcripts, chain jobs continue from the lowest incomplete step.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverUserAgents } from "../agents.ts";
import {
	buildModelContext,
	collectResultText,
	formatJobListings,
	listJobsForCurrentSession,
	resumeJob,
} from "../jobs.ts";
import { waitForJobOrKill } from "../process.ts";
import { getParentSessionId, toTaskInfo, type ToolDetails } from "../runtime.ts";

const subagentResumeParams = Type.Object({
	jobId: Type.Optional(
		Type.String({
			description:
				"Omit to list persisted jobs for this session; provide to resume that job.",
		}),
	),
	wait: Type.Optional(
		Type.Boolean({
			description: "true (default): block until the resumed job finishes. false: resume in background.",
			default: true,
		}),
	),
	notifyOnComplete: Type.Optional(
		Type.Boolean({
			description: "Deliver a completion summary when the resumed batch finishes. Default: true.",
			default: true,
		}),
	),
});

export const subagentResumeTool = defineTool<typeof subagentResumeParams, ToolDetails>({
	name: "subagent_resume",
	label: "Subagent Resume",
	description:
		"Resume interrupted or paused subagent jobs from a previous run of THIS session (jobs are bound to the session that spawned them). Omit jobId to list persisted jobs; provide jobId to continue where the tasks left off (chain jobs continue from the lowest incomplete step).",
	promptSnippet: "List or resume interrupted/paused subagent jobs bound to this session",
	parameters: subagentResumeParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (params.jobId === undefined) {
			const text = [
				`Subagent jobs for session ${getParentSessionId() ?? "(unknown)"}:`,
				formatJobListings(listJobsForCurrentSession()),
			].join("\n");
			return { content: [{ type: "text", text }], details: { mode: "collect", jobIds: [], tasks: [] } };
		}

		const agents = discoverUserAgents();
		const modelCtx = buildModelContext(ctx);
		const wait = params.wait ?? true;
		const notifyOnComplete = params.notifyOnComplete ?? true;
		const emit = onUpdate
			? (content: string, details: ToolDetails) => onUpdate({ content: [{ type: "text", text: content }], details })
			: undefined;
		const { job, notes, error } = await resumeJob(params.jobId, {
			agents,
			defaultCwd: ctx.cwd,
			modelCtx,
			wait,
			notifyOnComplete,
			emit,
			signal: wait ? signal : undefined,
		});
		if (error || !job) {
			return {
				content: [{ type: "text", text: error ?? "Resume failed." }],
				details: { mode: "collect", jobIds: [params.jobId], tasks: [] },
				isError: true,
			};
		}
		const note = notes?.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : "";
		if (!wait) {
			return {
				content: [
					{
						type: "text",
						text: `Resumed job ${job.id} in the background.${note}\n\nThey will run in the background while you continue working. Collect with subagent_wait (jobId: ${job.id}).`,
					},
				],
				details: { mode: job.mode, jobIds: [job.id], tasks: job.tasks.map(toTaskInfo) },
			};
		}
		const completed = await waitForJobOrKill(job.id, signal);
		const { text } = collectResultText([job.id]);
		return {
			content: [
				{
					type: "text",
					text: completed ? `${text}${note}` : `Resume of job ${job.id}: ${job.status}: ${job.errorMessage || "(aborted)"}`,
				},
			],
			details: { mode: "collect", jobIds: [job.id], tasks: job.tasks.map(toTaskInfo) },
			isError: !completed,
		};
	},

	renderCall(args, theme, _context) {
		const what = args.jobId ? `resume ${args.jobId}` : "(list persisted jobs)";
		return new Text(theme.fg("toolTitle", theme.bold("subagent_resume ")) + theme.fg("accent", what), 0, 0);
	},
});
