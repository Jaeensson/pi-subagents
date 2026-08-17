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
	tier?: string;
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

// ── Model tiers ──────────────────────────────────────────────────────────────

export type TierLevel = "fast" | "balanced" | "deep";

export const TIER_LEVELS: readonly TierLevel[] = ["fast", "balanced", "deep"];

/** The `subagent.modelTiers` object from settings.json, normalized. */
export interface TierConfig {
	auto?: boolean;
	fast?: string;
	balanced?: string;
	deep?: string;
}

/** A plain snapshot of a catalog model, built from pi's model registry. */
export interface CatalogModel {
	id: string;
	provider: string;
	inputCost: number;
}

export interface ModelResolution {
	/** Concrete model id to pass to the child; undefined → inherit parent default. */
	model?: string;
	/** The tier that produced the model, if any. */
	tierUsed?: TierLevel;
	/** Human-readable fallback/collapse note, if any. */
	note?: string;
}

export function isTierLevel(value: string | undefined): value is TierLevel {
	return value !== undefined && (TIER_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize an arbitrary settings.json value into a TierConfig.
 * Returns undefined when nothing usable is present (feature off).
 */
export function normalizeTierConfig(value: unknown): TierConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const src = value as Record<string, unknown>;
	const cfg: TierConfig = {};
	if (typeof src.auto === "boolean") cfg.auto = src.auto;
	for (const level of TIER_LEVELS) {
		const v = src[level];
		if (typeof v === "string" && v.trim() !== "") cfg[level] = v.trim();
	}
	if (cfg.auto === undefined && cfg.fast === undefined && cfg.balanced === undefined && cfg.deep === undefined) {
		return undefined;
	}
	return cfg;
}

/** Result of the auto-picker for one tier. */
export interface AutoPick {
	model?: string;
	/** The pick equals the default model (tier collapsed). */
	collapsed?: boolean;
	/** The pick is outside the default model's family (fast fallback only). */
	outsideFamily?: boolean;
}

/**
 * Family stem of a model id: the first `-`-separated segment after stripping
 * trailing `-YYYYMMDD` date suffixes and `-latest`. Brand families keep
 * provider trios together (`claude-haiku-4-5`, `claude-sonnet-4-5` and
 * `claude-opus-4-5` all belong to `claude`).
 */
export function familyStem(id: string): string {
	let stem = id.replace(/-\d{8}$/, "");
	stem = stem.replace(/-latest$/i, "");
	return stem.split("-")[0];
}

/**
 * Pick a model for a fast/deep tier from the catalog, relative to the
 * default model. Cost-ranked within the default model's family; cost ties
 * prefer the canonical (shorter) id so dated duplicates lose.
 *
 * Picks are returned provider-qualified (`provider/id`) so they are
 * unambiguous when the same id exists on multiple authenticated providers.
 */
export function pickAutoTier(
	level: "fast" | "deep",
	options: { defaultModel?: string; catalog: CatalogModel[] },
): AutoPick {
	const { defaultModel, catalog } = options;
	if (!defaultModel) return {};
	const def = catalog.find((m) => m.id === defaultModel);
	if (!def) return {};
	const qualified = (m: CatalogModel) => `${m.provider}/${m.id}`;
	const family = catalog.filter(
		(m) => m.provider === def.provider && familyStem(m.id) === familyStem(def.id),
	);
	const byCost = (models: CatalogModel[]) =>
		[...models].sort((a, b) => a.inputCost - b.inputCost || a.id.length - b.id.length);
	if (level === "fast") {
		const cheaper = byCost(family).filter((m) => m.inputCost < def.inputCost);
		if (cheaper.length > 0) return { model: qualified(cheaper[0]) };
		const providerModels = byCost(catalog.filter((m) => m.provider === def.provider));
		const pick = providerModels[0];
		if (!pick) return {};
		if (pick.id === def.id) return { model: qualified(pick), collapsed: true };
		const inFamily = familyStem(pick.id) === familyStem(def.id);
		return inFamily ? { model: qualified(pick) } : { model: qualified(pick), outsideFamily: true };
	}
	const pricier = [...family]
		.filter((m) => m.inputCost > def.inputCost)
		.sort((a, b) => b.inputCost - a.inputCost || a.id.length - b.id.length);
	if (pricier.length > 0) return { model: qualified(pricier[0]) };
	return { model: qualified(def), collapsed: true };
}

/**
 * Resolve which concrete model a task should run with.
 *
 * Precedence: call-time tier → agent frontmatter model → agent frontmatter
 * tier → parent default (inherit, model undefined). A requested tier resolves
 * via the explicit mapping first, then the auto-picker when enabled; an
 * unresolvable tier falls through to the next precedence level with a note.
 */
export function resolveModel(options: {
	callTier?: string;
	agentModel?: string;
	agentTier?: string;
	tierConfig?: TierConfig;
	defaultModel?: string;
	catalog: CatalogModel[];
}): ModelResolution {
	const { callTier, agentModel, agentTier, tierConfig, defaultModel, catalog } = options;
	const notes: string[] = [];
	const pushNote = (text: string) => {
		if (!notes.includes(text)) notes.push(text);
	};

	if (isTierLevel(callTier)) {
		const resolved = resolveTier(callTier, tierConfig, defaultModel, catalog, notes);
		if (resolved) return { model: resolved, tierUsed: callTier, note: notes.join("; ") || undefined };
		pushNote(`tier "${callTier}" could not be resolved; falling back`);
	}
	if (agentModel) return { model: agentModel, note: notes.join("; ") || undefined };
	if (isTierLevel(agentTier)) {
		const resolved = resolveTier(agentTier, tierConfig, defaultModel, catalog, notes);
		if (resolved) return { model: resolved, tierUsed: agentTier, note: notes.join("; ") || undefined };
		pushNote(`tier "${agentTier}" could not be resolved; falling back`);
	}
	return { model: undefined, note: notes.join("; ") || undefined };
}

function resolveTier(
	level: TierLevel,
	tierConfig: TierConfig | undefined,
	defaultModel: string | undefined,
	catalog: CatalogModel[],
	notes: string[],
): string | undefined {
	if (tierConfig?.[level]) return tierConfig[level];
	if (!tierConfig?.auto) return undefined;
	if (level === "balanced") {
		const def = catalog.find((m) => m.id === defaultModel);
		return def ? `${def.provider}/${def.id}` : defaultModel;
	}
	if (!defaultModel) return undefined;
	const picked = pickAutoTier(level, { defaultModel, catalog });
	if (picked.model) {
		if (picked.collapsed) {
			notes.push(
				`tier "${level}" collapsed to the default model (no ${level === "fast" ? "cheaper" : "pricier"} model in its family)`,
			);
		} else if (picked.outsideFamily) {
			notes.push(`tier "${level}" fell back to the provider's cheapest model outside the default family`);
		}
		return picked.model;
	}
	return undefined;
}

// ── Agent markdown parsing ───────────────────────────────────────────────────

/**
 * Parse an agent definition file: YAML frontmatter + markdown body.
 *
 * Frontmatter must be delimited by `---` lines at the top of the file and
 * contain at least `name` and `description`. Supported keys (flat, single
 * line): name, description, tools (comma-separated), model, tier. Values may be
 * quoted with single or double quotes.
 */
export function parseAgentMarkdown(
	content: string,
): { name: string; description: string; tools?: string[]; model?: string; tier?: string; systemPrompt: string } | null {
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
	const tier = frontmatter.get("tier");

	const systemPrompt = lines.slice(endIdx + 1).join("\n").trimStart().replace(/\n$/, "");

	return {
		name,
		description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model: model || undefined,
		tier: tier || undefined,
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
	tier?: string,
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
	if (model) parts.push(tier ? `${model} (tier: ${tier})` : model);
	return parts.join(" ");
}

/** Name shown for a task/step that may have omitted the agent; empty → "default". */
export function displayAgentName(name: string | undefined): string {
	return name?.trim() || "default";
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

/**
 * Which bundled default agents are missing from the user's agent directory.
 * User files always win: an existing agent with the same name is never
 * overwritten, so it is not "missing".
 */
export function planAgentSeeds(bundledNames: string[], existingNames: string[]): string[] {
	const existing = new Set(existingNames);
	return bundledNames.filter((n) => !existing.has(n));
}

/**
 * Structured summary passed alongside the notification text so the TUI card
 * renderer can header the message without parsing markdown.
 */
export interface CompletionDetails {
	total: number;
	failed: number;
}

/**
 * Header for the completion card. `failed` counts tasks that did not end in
 * "completed" (failed or aborted). A batch with zero tasks is a plain failure.
 */
export function completionHeader(summary: {
	total: number;
	failed: number;
}): { kind: "success" | "error"; text: string } {
	if (summary.total === 0) {
		return { kind: "error", text: "✗ Subagent batch failed" };
	}
	const noun = summary.total === 1 ? "subagent" : "subagents";
	if (summary.failed > 0) {
		return { kind: "error", text: `✗ ${summary.total} ${noun} finished — ${summary.failed} failed` };
	}
	return { kind: "success", text: `✓ ${summary.total} ${noun} finished` };
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
		tierUsed?: string;
		tierNote?: string;
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
			const usageStr = formatUsageStats(t.usage, t.model, t.tierUsed);
			if (usageStr) lines.push(usageStr);
			if (t.tierNote) lines.push(`Note: ${t.tierNote}`);
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
