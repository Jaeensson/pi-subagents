/**
 * core.ts — Pure logic for the subagent extension.
 *
 * No runtime imports from pi packages: this module is fully unit-testable
 * with `node --test` (Node >= 22.6 type stripping). Keep it to erasable
 * TypeScript syntax only (no enums, no parameter properties).
 */

export const DEFAULT_OUTPUT_CAP_BYTES = 50 * 1024;
export const NOTIFICATION_PREVIEW_BYTES = 200;

// ── Types (structural, shared with index.ts) ─────────────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface MessageLike {
	role: string;
	content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	stopReason?: string;
	errorMessage?: string;
	model?: string;
	toolName?: string;
}

/** Pure state fed by `applyEventLine` while a child pi process streams JSON. */
export interface TaskResultState {
	messages: MessageLike[];
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface AgentSummary {
	name: string;
	description: string;
	systemPrompt: string;
	source: "user" | "builtin";
	filePath: string;
	model?: string;
	tools?: string[];
}

// ── Default agent (raw prompt mode) ──────────────────────────────────────────

export const DEFAULT_AGENT_SYSTEM_PROMPT = `You are a general-purpose subagent operating in an isolated context window. You were delegated a task by a parent agent.

Work autonomously to complete the assigned task. Use all available tools as needed. Explore the codebase and verify your work before reporting completion.

Output format when finished:

## Completed
What was done.

## Files Changed
- \`path/to/file.ts\` - what changed

## Notes (if any)
Anything the parent agent should know.`;

// ── Agent markdown parsing ───────────────────────────────────────────────────

/**
 * Parse an agent definition file: YAML frontmatter + markdown body.
 *
 * Frontmatter must be delimited by `---` lines at the top of the file and
 * contain at least `name` and `description`. Supported keys (flat, single
 * line): name, description, tools (comma-separated), model. Values may be
 * quoted with single or double quotes.
 */
export function parseAgentMarkdown(
	content: string,
): { name: string; description: string; tools?: string[]; model?: string; systemPrompt: string } | null {
	const lines = content.split("\n");
	if (lines.length === 0 || lines[0].trim() !== "---") return null;

	let endIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIdx = i;
			break;
		}
	}
	if (endIdx === -1) return null;

	const frontmatter = new Map<string, string>();
	for (let i = 1; i < endIdx; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();
		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) frontmatter.set(key, value);
	}

	const name = frontmatter.get("name");
	const description = frontmatter.get("description");
	if (!name || !description) return null;

	const toolsRaw = frontmatter.get("tools");
	const tools = toolsRaw
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const model = frontmatter.get("model");

	const systemPrompt = lines.slice(endIdx + 1).join("\n").trimStart().replace(/\n$/, "");

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: model || undefined,
		systemPrompt,
	};
}

// ── Child invocation ─────────────────────────────────────────────────────────

/**
 * Build the CLI args for a child pi process that runs one subagent.
 * Children run in JSON print mode, ephemeral, without extensions (no
 * recursion, lean startup).
 */
export function buildChildArgs(options: {
	model?: string;
	tools?: string[];
	systemPromptFile?: string;
	task: string;
}): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
	];
	if (options.model) args.push("--model", options.model);
	if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
	if (options.systemPromptFile) args.push("--append-system-prompt", options.systemPromptFile);
	args.push(`Task: ${options.task}`);
	return args;
}

// ── JSON event stream parsing ────────────────────────────────────────────────

/** Parse one line of the child's JSON-mode stdout into the task state. */
export function applyEventLine(line: string, state: TaskResultState): void {
	if (!line.trim()) return;
	let event: { type?: string; message?: MessageLike };
	try {
		event = JSON.parse(line);
	} catch {
		return;
	}
	if (!event.message) return;

	const msg = event.message;

	if (event.type === "message_end" && msg.role === "assistant") {
		state.messages.push(msg);
		state.usage.turns++;
		const usage = msg.usage;
		if (usage) {
			state.usage.input += usage.input || 0;
			state.usage.output += usage.output || 0;
			state.usage.cacheRead += usage.cacheRead || 0;
			state.usage.cacheWrite += usage.cacheWrite || 0;
			state.usage.cost += usage.cost?.total || 0;
			state.usage.contextTokens = usage.totalTokens || 0;
		}
		if (msg.model) state.model = msg.model;
		if (msg.stopReason) state.stopReason = msg.stopReason;
		if (msg.errorMessage) state.errorMessage = msg.errorMessage;
	} else if (event.type === "tool_result_end") {
		state.messages.push(msg);
	}
}

// ── Output extraction ────────────────────────────────────────────────────────

export function getFinalOutput(messages: MessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type === "text" && part.text) return part.text;
		}
	}
	return "";
}

export function isFailedState(state: { exitCode: number; stopReason?: string }): boolean {
	return state.exitCode !== 0 || state.stopReason === "error" || state.stopReason === "aborted";
}

export function getResultOutput(result: {
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr?: string;
	messages: MessageLike[];
}): string {
	if (isFailedState(result)) {
		return (
			result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
		);
	}
	return getFinalOutput(result.messages) || "(no output)";
}

// ── Truncation ───────────────────────────────────────────────────────────────

/** Byte-based truncation that never splits multi-byte characters. */
export function truncateOutput(output: string, capBytes: number = DEFAULT_OUTPUT_CAP_BYTES): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= capBytes) return output;

	let kept = "";
	for (const ch of output) {
		const next = kept + ch;
		if (Buffer.byteLength(next, "utf8") > capBytes) break;
		kept = next;
	}
	const keptBytes = Buffer.byteLength(kept, "utf8");
	const omitted = byteLength - keptBytes;
	return `${kept}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

/** Cap a one-line preview (e.g. in completion notifications). */
export function previewLine(text: string, maxBytes: number = NOTIFICATION_PREVIEW_BYTES): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	const truncated = truncateOutput(singleLine, maxBytes);
	if (truncated !== singleLine) return `${truncated}…`;
	return singleLine;
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatElapsed(seconds: number): string {
	const s = Math.floor(seconds);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) {
		const remS = s % 60;
		return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
	}
	const h = Math.floor(m / 60);
	const remM = m % 60;
	return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function formatUsageStats(
	usage: Partial<UsageStats>,
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// ── Agent resolution ─────────────────────────────────────────────────────────

export function resolveAgent(name: string | undefined, discovered: AgentSummary[]): AgentSummary | null {
	if (name === undefined) {
		return {
			name: "default",
			description: "General-purpose subagent with full capabilities",
			source: "builtin",
			filePath: "(builtin)",
			systemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
		};
	}
	return discovered.find((a) => a.name === name) ?? null;
}

// ── Notifications & status reports ───────────────────────────────────────────

/**
 * Completion notifications are injected into the conversation only for
 * asynchronous spawns (wait: false) — synchronous runs already return their
 * results directly in the tool result.
 */
export function shouldNotify(wait: boolean, notifyOnComplete: boolean): boolean {
	return !wait && notifyOnComplete;
}

export function formatCompletionNotification(
	tasks: Array<{
		agent: string;
		status: "completed" | "failed" | "aborted";
		output: string;
		errorMessage?: string;
	}>,
	taskIds: string[],
): string {
	const lines = tasks.map((t) => {
		const icon = t.status === "completed" ? "✓" : "✗";
		if (t.status === "completed") {
			const preview = previewLine(t.output || "(no output)");
			return `- ${icon} [${t.agent}] ${preview}`;
		}
		const reason = previewLine(t.errorMessage || "(no error message)");
		return `- ${icon} [${t.agent}] ${t.status}: ${reason}`;
	});

	return [
		`## Subagent batch complete: ${tasks.length} subagents finished`,
		"",
		...lines,
		"",
		`Full results available via subagent_wait (jobIds: ${taskIds.join(", ")}).`,
	].join("\n");
}

export function formatStatusReport(
	tasks: Array<{
		id: string;
		agent: string;
		status: "running" | "completed" | "failed" | "aborted";
		task: string;
		exitCode?: number;
		messages: MessageLike[];
		usage: UsageStats;
		model?: string;
		errorMessage?: string;
	}>,
	opts: { maxOutputBytes?: number } = {},
): string {
	const maxOutputBytes = opts.maxOutputBytes ?? 4000;
	const sections = tasks.map((t) => {
		const icon =
			t.status === "running" ? "⏳" : t.status === "completed" ? "✓" : "✗";
		const lines = [`### [${t.agent}] ${icon} ${t.status} — id: ${t.id}`, `Task: ${t.task}`];
		if (t.status === "running") {
			lines.push("(running, no output yet)");
		} else {
			const usageStr = formatUsageStats(t.usage, t.model);
			if (usageStr) lines.push(usageStr);
			if (t.status !== "completed") {
				lines.push(`Error: ${t.errorMessage || "(no error message)"}`);
			}
			const output = getFinalOutput(t.messages);
			if (output) lines.push(truncateOutput(output, maxOutputBytes));
		}
		return lines.join("\n");
	});

	return sections.join("\n\n---\n\n");
}
