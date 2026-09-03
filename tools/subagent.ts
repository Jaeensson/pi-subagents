/**
 * tools/subagent.ts — The main `subagent` tool.
 *
 * Single / parallel / chain delegation with wait: true (block) and
 * wait: false (background) execution modes. Spawning and job bookkeeping
 * live in process.ts / jobs.ts / runtime.ts; this file wires them to the
 * tool API (schema, execute, renderCall, renderResult).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverUserAgents, getUserAgentsDir } from "../agents.ts";
import {
	displayAgentName,
	formatUsageStats,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	resolveAgent,
	shouldNotify,
	statusIcon,
	truncateOutput,
} from "../core.ts";
import { buildModelContext, createJob, mapWithConcurrencyLimit, MAX_CONCURRENCY, runChain, spawnResultText } from "../jobs.ts";
import { killTask, spawnTask, waitForJobOrKill } from "../process.ts";
import { aggregateUsage, jobDetails, getParentSessionId, getJobsRoot, waitForTask, type TaskInfo, type ToolDetails } from "../runtime.ts";
import { getDisplayItems, renderTaskList } from "../tui.ts";

const MAX_PARALLEL_TASKS = 8;
const COLLAPSED_ITEM_COUNT = 10;

// ── Schema ───────────────────────────────────────────────────────────────────

const TIER_DESCRIPTION =
	"Model tier for this task: fast (small/cheap model), balanced (default model), deep (large/capable model). Resolved via subagent.modelTiers in settings.json; unmapped tiers fall back to the agent's model/tier, then the parent's default model.";

/** Tier parameter factory — main and per-item schemas differ only in wording. */
function tierParam(description: string) {
	return Type.Optional(
		Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("deep")], {
			description,
		}),
	);
}

const taskTierParam = tierParam(TIER_DESCRIPTION);

const singleTierParam = tierParam(
	"Model tier for the subagent (single mode): fast, balanced, or deep. Resolved via subagent.modelTiers in settings.json; falls back to the agent's configured model/tier, then the parent's default model.",
);

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (from ~/.pi/agent/agents). Omit for a raw prompt using the built-in default agent." })),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	tier: taskTierParam,
	name: Type.Optional(Type.String({ description: "Short session name for this task (shown in the status widget)." })),
});

const ChainItem = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke. Omit for a raw prompt using the built-in default agent." })),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	tier: taskTierParam,
	name: Type.Optional(Type.String({ description: "Short session name for this task (shown in the status widget)." })),
});

const subagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode). Omit for a raw prompt using the built-in default agent." })),
	task: Type.Optional(Type.String({ description: "Task to delegate, or the raw prompt when no agent is given (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent?, task} for parallel execution (max 8); omit agent for a raw prompt using the built-in default agent" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent?, task} for sequential execution; use {previous} in a task to reference the prior output; omit agent for a raw prompt using the built-in default agent" })),
	wait: Type.Optional(Type.Boolean({ description: "true (default): block until done and return results. false: spawn in background and return jobIds immediately.", default: true })),
	notifyOnComplete: Type.Optional(Type.Boolean({ description: "When wait: false, deliver a summary message when the batch finishes. Default: true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	tier: singleTierParam,
	name: Type.Optional(Type.String({ description: 'Short human-readable name for this subagent session (single mode), e.g. "feature1-implementation". Shown in the status widget. Defaults to a slug of the task.' })),
});


/** Themed per-status icon shared by the result renderers. */
function themedStatusIcon(status: string, theme: any): string {
	const icon = statusIcon(status);
	if (icon === "✓") return theme.fg("success", icon);
	if (icon === "✗") return theme.fg("error", icon);
	return theme.fg("warning", icon);
}

// ── Tool definition ──────────────────────────────────────────────────────────

export const subagentTool = defineTool<typeof subagentParams, ToolDetails>({
	name: "subagent",
	label: "Subagent",
	description: [
		"Delegate tasks to specialized subagents with isolated context windows (each runs in its own pi process).",
		"Modes (exactly one): single {agent?, task} (omit agent for a raw prompt using the built-in default agent),",
		"parallel {tasks: [{agent?, task}]}, chain {chain: [{agent?, task}]} (sequential, {previous} placeholder; agent optional in both).",
		"wait: true (default) blocks until done and returns results. wait: false spawns background subagents and",
		"returns jobIds immediately so you can keep working; a summary is delivered on completion, full results via subagent_wait.",
		`Agent definitions live in ${getUserAgentsDir()} (*.md with YAML frontmatter: name, description, tools, tier, extensions).`,
		"List available agents with subagent_agents.",
	].join(" "),
	promptSnippet:
		"Delegate isolated tasks to subagent processes (single/parallel/chain; wait:false to keep working in parallel, subagent_wait to collect)",
	promptGuidelines: [
		"Use subagent with wait:false to run background work while continuing your own turn; collect with subagent_wait.",
		"Use subagent with wait:true (default) when you need the delegated result before doing anything else.",
	],
	parameters: subagentParams,

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const agents = discoverUserAgents();
		const modelCtx = buildModelContext(ctx);
		const wait = params.wait ?? true;
		const notifyOnComplete = params.notifyOnComplete ?? true;
		const emit = onUpdate
			? (content: string, details: ToolDetails) => onUpdate({ content: [{ type: "text", text: content }], details })
			: undefined;

		const hasChain = (params.chain?.length ?? 0) > 0;
		const hasTasks = (params.tasks?.length ?? 0) > 0;
		const hasSingle = params.task !== undefined || params.agent !== undefined;
		const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

		if (modeCount !== 1) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters: provide exactly one mode (single, parallel, or chain).\nAvailable agents: ${available}\nRaw prompts: omit the agent field to use the built-in default agent.` }],
				details: { mode: "single" as const, jobIds: [], tasks: [] },
			};
		}

		// Pre-validate agents so we never spawn a partial batch with an unknown agent.
		const unknownAgents = new Set<string>();
		if (params.agent !== undefined && !resolveAgent(params.agent, agents)) unknownAgents.add(params.agent);
		if (params.tasks) for (const t of params.tasks) if (t.agent !== undefined && !resolveAgent(t.agent, agents)) unknownAgents.add(t.agent);
		if (params.chain) for (const c of params.chain) if (c.agent !== undefined && !resolveAgent(c.agent, agents)) unknownAgents.add(c.agent);
		if (unknownAgents.size > 0) {
			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Unknown agent(s): ${Array.from(unknownAgents).join(", ")}. Available agents: ${available}.` }],
				details: { mode: "single" as const, jobIds: [], tasks: [] },
				isError: true,
			};
		}

		// Durable persistence: bind the job to this parent session's store bucket.
		const persist =
			getParentSessionId() && getJobsRoot()
				? { parentSessionId: getParentSessionId()!, chain: hasChain ? params.chain : undefined }
				: undefined;

		// ── Chain mode ──
		if (hasChain) {
			const job = createJob("chain", shouldNotify(wait, notifyOnComplete), emit, params.chain!.length, persist);
			runChain(job, params.chain!, agents, params.cwd ?? ctx.cwd, modelCtx, wait ? signal : undefined);
			if (!wait) {
				return { content: [{ type: "text", text: spawnResultText(job, "chain") }], details: jobDetails(job) };
			}
			const completed = await waitForJobOrKill(job.id, signal);
			if (!completed) {
				return {
					content: [{ type: "text", text: `Chain ${job.status}: ${job.errorMessage || "(aborted)"}` }],
					details: jobDetails(job),
					isError: true,
				};
			}
			const last = job.tasks[job.tasks.length - 1];
			if (job.status === "failed") {
				return {
					content: [{ type: "text", text: job.errorMessage || "Chain failed." }],
					details: jobDetails(job),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(last?.messages ?? []) || "(no output)" }],
				details: jobDetails(job),
			};
		}

		// ── Parallel mode ──
		if (hasTasks) {
			const tasksParam = params.tasks!;
			if (tasksParam.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${tasksParam.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: { mode: "parallel" as const, jobIds: [], tasks: [] },
				};
			}
			const job = createJob("parallel", shouldNotify(wait, notifyOnComplete), emit, undefined, persist);
			if (wait) {
				await mapWithConcurrencyLimit(tasksParam, MAX_CONCURRENCY, async (t) => {
					const agent = resolveAgent(t.agent, agents)!;
					const task = await spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, name: t.name, modelCtx });
					const completed = await waitForTask(task.id, { signal });
					if (!completed && signal?.aborted) {
						killTask(task);
						await waitForTask(task.id, {});
					}
				});
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Parallel run aborted." }],
						details: jobDetails(job),
						isError: true,
					};
				}
				const successCount = job.tasks.filter((t) => !isFailedState(t)).length;
				const summaries = job.tasks.map((t) => {
					const output = truncateOutput(getResultOutput(t), 50 * 1024);
					const status = isFailedState(t) ? `failed${t.stopReason && t.stopReason !== "end" ? ` (${t.stopReason})` : ""}` : "completed";
					return `### [${t.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${job.tasks.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: jobDetails(job),
					isError: successCount !== job.tasks.length,
				};
			}
			for (const t of tasksParam) {
				const agent = resolveAgent(t.agent, agents)!;
				void spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, name: t.name, modelCtx });
			}
			return { content: [{ type: "text", text: spawnResultText(job, "parallel") }], details: jobDetails(job) };
		}

		// ── Single mode ──
		const agent = resolveAgent(params.agent, agents)!;
		const job = createJob("single", shouldNotify(wait, notifyOnComplete), emit, undefined, persist);
		const task = await spawnTask(agent, params.task ?? "", params.cwd ?? ctx.cwd, job.id, { tier: params.tier, name: params.name, modelCtx });
		if (!wait) {
			return { content: [{ type: "text", text: spawnResultText(job, "single") }], details: jobDetails(job) };
		}
		const completed = await waitForJobOrKill(job.id, signal);
		if (!completed) {
			return {
				content: [{ type: "text", text: `Subagent ${job.status}: ${job.errorMessage || "(aborted)"}` }],
				details: jobDetails(job),
				isError: true,
			};
		}
		if (isFailedState(task)) {
			return {
				content: [{ type: "text", text: `Agent ${task.stopReason || "failed"}: ${getResultOutput(task)}` }],
				details: jobDetails(job),
				isError: true,
			};
		}
		return { content: [{ type: "text", text: getFinalOutput(task.messages) || "(no output)" }], details: jobDetails(job) };
	},

	renderCall(args, theme, _context) {
		if (args.chain && args.chain.length > 0) {
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", args.wait === false ? " [async]" : "");
			for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
				const step = args.chain[i];
				const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
				const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
				text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", displayAgentName(step.agent)) + theme.fg("dim", ` ${preview}`);
			}
			if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
			return new Text(text, 0, 0);
		}
		if (args.tasks && args.tasks.length > 0) {
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", args.wait === false ? " [async]" : "");
			for (const t of args.tasks.slice(0, 3)) {
				const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
				text += `\n  ${theme.fg("accent", displayAgentName(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
			}
			if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
			return new Text(text, 0, 0);
		}
		const agentName = args.agent || "default";
		const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
		let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", args.wait === false ? " [async]" : "");
		text += `\n  ${theme.fg("dim", preview)}`;
		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded }, theme, _context) {
		const details = result.details as ToolDetails | undefined;
		if (!details || details.tasks.length === 0) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		}

		if (details.mode === "collect") {
			const lines: string[] = [];
			for (const t of details.tasks) {
				const icon = themedStatusIcon(t.status, theme);
				lines.push(`${icon} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` (${t.status})`)}`);
				if (!expanded) {
					const preview = getFinalOutput(t.messages).split("\n").slice(0, 2).join("\n");
					if (preview) lines.push(theme.fg("toolOutput", preview));
				}
			}
			const usageStr = formatUsageStats(aggregateUsage(details.tasks));
			if (usageStr) lines.push(theme.fg("dim", usageStr));
			return new Text(lines.join("\n"), 0, 0);
		}

		const renderItems = (t: TaskInfo) => {
			if (expanded) return getDisplayItems(t.messages);
			return getDisplayItems(t.messages).slice(-COLLAPSED_ITEM_COUNT);
		};

		const lines: string[] = [];
		if (details.mode === "chain") {
			const successCount = details.tasks.filter((t) => t.status === "completed").length;
			const icon = successCount === details.tasks.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
			lines.push(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.tasks.length} steps`)}`);
			for (const t of details.tasks) {
				const tIcon = themedStatusIcon(t.status, theme);
				lines.push(`\n${theme.fg("muted", `─── Step ${t.step ?? "?"}: `)}${theme.fg("accent", t.agent)} ${tIcon}`);
				lines.push(renderTaskList(renderItems(t), expanded ? Infinity : 5, theme));
				const output = getFinalOutput(t.messages);
				if (expanded && output) lines.push(theme.fg("toolOutput", output));
			}
		} else if (details.mode === "parallel") {
			const running = details.tasks.filter((t) => t.status === "running").length;
			const successCount = details.tasks.filter((t) => t.status === "completed").length;
			const failCount = details.tasks.filter((t) => t.status === "failed" || t.status === "aborted").length;
			const isRunning = running > 0;
			const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const status = isRunning ? `${successCount + failCount}/${details.tasks.length} done, ${running} running` : `${successCount}/${details.tasks.length} tasks`;
			lines.push(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`);
			for (const t of details.tasks) {
				const tIcon = themedStatusIcon(t.status, theme);
				lines.push(`\n${theme.fg("muted", "─── ")}${theme.fg("accent", t.agent)} ${tIcon}`);
				lines.push(renderTaskList(renderItems(t), expanded ? Infinity : 5, theme));
				const output = getFinalOutput(t.messages);
				if (expanded && output) lines.push(theme.fg("toolOutput", output));
			}
		} else {
			const t = details.tasks[0];
			const isError = isFailedState(t);
			const icon = isError && t.status !== "paused" ? theme.fg("error", "✗") : themedStatusIcon(t.status, theme);
			lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(t.agent))}${theme.fg("muted", ` (${t.agentSource})`)}`);
			if (t.status === "running") {
				lines.push(theme.fg("muted", "(running in background...)"));
			} else if (isError && t.errorMessage) {
				lines.push(theme.fg("error", `Error: ${t.errorMessage}`));
			} else {
				lines.push(renderTaskList(renderItems(t), COLLAPSED_ITEM_COUNT, theme));
				if (expanded) {
					const output = getFinalOutput(t.messages);
					if (output) lines.push(theme.fg("toolOutput", output));
				}
			}
		}
		const usageStr = formatUsageStats(
			aggregateUsage(details.tasks),
			details.mode === "single" ? details.tasks[0]?.model : undefined,
			details.mode === "single" ? details.tasks[0]?.tierUsed : undefined,
		);
		if (usageStr && details.tasks.every((t) => t.status !== "running")) {
			lines.push(`\n${theme.fg("dim", usageStr)}`);
		}
		if (details.tasks.some((t) => t.status !== "running") && !expanded) {
			lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
		}
		return new Text(lines.join("\n"), 0, 0);
	},
});
