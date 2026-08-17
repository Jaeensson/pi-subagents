/**
 * Unit tests for core.ts — the pure logic of the subagent extension.
 *
 * Runs with the built-in node test runner (Node >= 22.6, type stripping):
 *   node --test tests/core.test.mjs
 *
 * core.ts must stay free of runtime imports from pi packages so it can be
 * tested in isolation. Keep it to erasable TypeScript syntax only
 * (no enums, no parameter properties).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import {
	applyEventLine,
	buildChildArgs,
	completionHeader,
	DEFAULT_AGENT_SYSTEM_PROMPT,
	displayAgentName,
	formatCompletionNotification,
	formatStatusReport,
	formatElapsed,
	formatTokens,
	formatUsageStats,
	familyStem,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	normalizeTierConfig,
	isTierLevel,
	parseAgentMarkdown,
	pickAutoTier,
	planAgentSeeds,
	resolveAgent,
	resolveModel,
	shouldNotify,
	truncateOutput,
} from "../core.ts";

// Bundled default agents ship in the repo under agents/ and are seeded into
// the user agent dir when missing (user files always win). These tests keep
// them parseable and restricted to the supported frontmatter schema.
const bundledAgentsDir = fileURLToPath(new URL("../agents/", import.meta.url));
const bundledAgentFiles = () => readdirSync(bundledAgentsDir).filter((f) => f.endsWith(".md")).sort();

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

// ── parseAgentMarkdown ───────────────────────────────────────────────────────

test("parseAgentMarkdown parses frontmatter and body", () => {
	const content = `---
name: scout
description: Fast codebase recon
tools: read, grep, find, ls, bash
tier: fast
---

You are a scout. Report findings.`;
	const agent = parseAgentMarkdown(content);
	assert.ok(agent);
	assert.equal(agent.name, "scout");
	assert.equal(agent.description, "Fast codebase recon");
	assert.deepEqual(agent.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(agent.tier, "fast");
	assert.equal(agent.systemPrompt, "You are a scout. Report findings.");
});

test("parseAgentMarkdown parses the extensions list", () => {
	const agent = parseAgentMarkdown(`---
name: researcher
description: Web research
tools: read, web_search
extensions: npm:pi-web-access
---
body`);
	assert.deepEqual(agent?.extensions, ["npm:pi-web-access"]);
});

test("parseAgentMarkdown ignores the model key (tier is the only model control)", () => {
	const agent = parseAgentMarkdown(`---
name: researcher
description: Web research
tools: read, web_search
model: claude-haiku-4-5
tier: deep
---
body`);
	assert.ok(agent);
	assert.equal(agent.model, undefined);
	assert.equal(agent.tier, "deep");
});

test("parseAgentMarkdown returns null without frontmatter or required fields", () => {
	assert.equal(parseAgentMarkdown("# just a heading"), null);
	assert.equal(parseAgentMarkdown("---\ndescription: no name\n---\nbody"), null);
	assert.equal(parseAgentMarkdown("---\nname: x\n---\nno description"), null);
});

test("parseAgentMarkdown handles quoted values and colons in values", () => {
	const content = `---
name: "quote agent"
description: "Finds: things, quickly"
tools: "read, bash"
---`;
	const agent = parseAgentMarkdown(content);
	assert.equal(agent.name, "quote agent");
	assert.equal(agent.description, "Finds: things, quickly");
	assert.deepEqual(agent.tools, ["read", "bash"]);
});

test("parseAgentMarkdown allows empty body and missing optional fields", () => {
	const agent = parseAgentMarkdown("---\nname: a\ndescription: b\n---\n");
	assert.ok(agent);
	assert.equal(agent.systemPrompt, "");
	assert.equal(agent.model, undefined);
	assert.equal(agent.tools, undefined);
});

test("parseAgentMarkdown parses the tier key when present", () => {
	const agent = parseAgentMarkdown("---\nname: planner\ndescription: plans\ntier: deep\n---\nBody");
	assert.ok(agent);
	assert.equal(agent.tier, "deep");
});

test("parseAgentMarkdown leaves tier undefined when absent and keeps raw invalid values", () => {
	const absent = parseAgentMarkdown("---\nname: a\ndescription: b\n---\n");
	assert.equal(absent.tier, undefined);
	const invalid = parseAgentMarkdown("---\nname: a\ndescription: b\ntier: mega\n---\n");
	assert.equal(invalid.tier, "mega");
});

// ── Model tiers: normalizeTierConfig / isTierLevel ───────────────────────────

test("normalizeTierConfig extracts auto and level mappings, ignores junk", () => {
	assert.deepEqual(
		normalizeTierConfig({ auto: true, fast: "a", balanced: "b", deep: "c", junk: 1 }),
		{ auto: true, fast: "a", balanced: "b", deep: "c" },
	);
	assert.deepEqual(normalizeTierConfig({ fast: "x" }), { fast: "x" });
	assert.deepEqual(normalizeTierConfig({ auto: false }), { auto: false });
});

test("normalizeTierConfig trims strings and drops non-string levels", () => {
	assert.deepEqual(normalizeTierConfig({ fast: "  claude-haiku-4-5 ", balanced: 42 }), {
		fast: "claude-haiku-4-5",
	});
});

test("normalizeTierConfig returns undefined for missing, empty, or malformed config", () => {
	assert.equal(normalizeTierConfig(undefined), undefined);
	assert.equal(normalizeTierConfig(null), undefined);
	assert.equal(normalizeTierConfig("auto"), undefined);
	assert.equal(normalizeTierConfig([]), undefined);
	assert.equal(normalizeTierConfig({}), undefined);
	assert.equal(normalizeTierConfig({ auto: "yes" }), undefined);
	assert.equal(normalizeTierConfig({ deep: "" }), undefined);
});

test("isTierLevel accepts only fast, balanced, deep", () => {
	assert.equal(isTierLevel("fast"), true);
	assert.equal(isTierLevel("balanced"), true);
	assert.equal(isTierLevel("deep"), true);
	assert.equal(isTierLevel("mega"), false);
	assert.equal(isTierLevel(undefined), false);
	assert.equal(isTierLevel(""), false);
});

// ── Model tiers: familyStem / pickAutoTier ───────────────────────────────────

test("familyStem strips date and -latest suffixes and returns the first segment", () => {
	assert.equal(familyStem("claude-haiku-4-5-20251001"), "claude");
	assert.equal(familyStem("claude-haiku-4-5-latest"), "claude");
	assert.equal(familyStem("deepseek-v4-pro"), "deepseek");
	assert.equal(familyStem("gpt-5.6-luna"), "gpt");
	assert.equal(familyStem("hy3"), "hy3");
});

test("pickAutoTier picks same-family cheaper/pricier models around the default", () => {
	const catalog = [
		{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 1 },
		{ id: "claude-haiku-4-5-20251001", provider: "anthropic", inputCost: 1 },
		{ id: "claude-sonnet-4-5", provider: "anthropic", inputCost: 3 },
		{ id: "claude-opus-4-5", provider: "anthropic", inputCost: 15 },
		{ id: "qwen-whatever", provider: "anthropic", inputCost: 0.5 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "claude-sonnet-4-5", catalog }), {
		model: "anthropic/claude-haiku-4-5",
	});
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "claude-sonnet-4-5", catalog }), {
		model: "anthropic/claude-opus-4-5",
	});
});

test("pickAutoTier deep prefers the canonical id on cost ties", () => {
	const catalog = [
		{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 3 },
		{ id: "claude-haiku-4-5-20251001", provider: "anthropic", inputCost: 3 },
		{ id: "claude-opus-4-5", provider: "anthropic", inputCost: 1 },
	];
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "claude-opus-4-5", catalog }), {
		model: "anthropic/claude-haiku-4-5",
	});
});

test("pickAutoTier collapses deep when no pricier family member exists", () => {
	const catalog = [
		{ id: "deepseek-v4-flash", provider: "opencode-go", inputCost: 0.14 },
		{ id: "deepseek-v4-pro", provider: "opencode-go", inputCost: 0.435 },
	];
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "deepseek-v4-pro", catalog }), {
		model: "opencode-go/deepseek-v4-pro",
		collapsed: true,
	});
});

test("pickAutoTier fast falls back to the provider's cheapest model outside the family", () => {
	const catalog = [
		{ id: "gpt-5.4", provider: "opencode-go", inputCost: 2 },
		{ id: "mini-m3", provider: "opencode-go", inputCost: 1 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "gpt-5.4", catalog }), {
		model: "opencode-go/mini-m3",
		outsideFamily: true,
	});
});

test("pickAutoTier ignores other providers sharing the family stem", () => {
	const catalog = [
		{ id: "claude-sonnet-4-5", provider: "anthropic", inputCost: 3 },
		{ id: "claude-haiku-4-5", provider: "other-provider", inputCost: 1 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "claude-sonnet-4-5", catalog }), {
		model: "anthropic/claude-sonnet-4-5",
		collapsed: true,
	});
});

test("pickAutoTier fast keeps in-family picks unflagged when the cheapest ties the default", () => {
	const catalog = [
		{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 1 },
		{ id: "claude-sonnet-4-5-20251001", provider: "anthropic", inputCost: 1 },
		{ id: "kimi-k3", provider: "anthropic", inputCost: 2 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "claude-sonnet-4-5-20251001", catalog }), {
		model: "anthropic/claude-haiku-4-5",
	});
});

test("pickAutoTier fast collapses when the default is already cheapest", () => {
	const catalog = [
		{ id: "gpt-5.4", provider: "opencode-go", inputCost: 2 },
		{ id: "kimi-k3", provider: "opencode-go", inputCost: 3 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "gpt-5.4", catalog }), {
		model: "opencode-go/gpt-5.4",
		collapsed: true,
	});
});

test("pickAutoTier returns nothing for missing defaults or unknown models", () => {
	assert.deepEqual(pickAutoTier("fast", { defaultModel: undefined, catalog: [] }), {});
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "llama3.1:8b", catalog: [] }), {});
});

// ── Model tiers: resolveModel ────────────────────────────────────────────────

const tierCatalog = [
	{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 1 },
	{ id: "claude-sonnet-4-5", provider: "anthropic", inputCost: 3 },
	{ id: "claude-opus-4-5", provider: "anthropic", inputCost: 15 },
];

test("resolveModel prefers an explicit call-time tier mapping over the agent model", () => {
	assert.deepEqual(
		resolveModel({
			callTier: "deep",
			agentModel: "claude-haiku-4-5",
			tierConfig: { deep: "claude-opus-4-5" },
			catalog: tierCatalog,
		}),
		{ model: "claude-opus-4-5", tierUsed: "deep", note: undefined },
	);
});

test("resolveModel uses auto for balanced and fast tiers", () => {
	assert.deepEqual(
		resolveModel({
			callTier: "balanced",
			tierConfig: { auto: true },
			defaultModel: "claude-sonnet-4-5",
			catalog: tierCatalog,
		}),
		{ model: "anthropic/claude-sonnet-4-5", tierUsed: "balanced", note: undefined },
	);
	assert.deepEqual(
		resolveModel({
			callTier: "fast",
			tierConfig: { auto: true },
			defaultModel: "claude-sonnet-4-5",
			catalog: tierCatalog,
		}),
		{ model: "anthropic/claude-haiku-4-5", tierUsed: "fast", note: undefined },
	);
});

test("resolveModel reports deep collapse through auto", () => {
	const r = resolveModel({
		agentTier: "deep",
		tierConfig: { auto: true },
		defaultModel: "deepseek-v4-pro",
		catalog: [
			{ id: "deepseek-v4-flash", provider: "opencode-go", inputCost: 0.14 },
			{ id: "deepseek-v4-pro", provider: "opencode-go", inputCost: 0.435 },
		],
	});
	assert.equal(r.model, "opencode-go/deepseek-v4-pro");
	assert.equal(r.tierUsed, "deep");
	assert.ok(r.note?.includes("collapsed"));
});

test("resolveModel resolves the agent tier when no call tier applies", () => {
	assert.deepEqual(
		resolveModel({ agentTier: "deep", tierConfig: { deep: "claude-opus-4-5" }, catalog: tierCatalog }),
		{ model: "claude-opus-4-5", tierUsed: "deep", note: undefined },
	);
});

test("resolveModel falls back to the parent default with a note when tiers are unresolvable", () => {
	assert.deepEqual(
		resolveModel({ callTier: "fast", tierConfig: {}, catalog: tierCatalog }),
		{ model: undefined, note: 'tier "fast" could not be resolved; falling back' },
	);
});

test("resolveModel deduplicates identical fallback notes across both tier levels", () => {
	assert.deepEqual(
		resolveModel({ callTier: "fast", agentTier: "fast", tierConfig: {}, catalog: tierCatalog }),
		{ model: undefined, note: 'tier "fast" could not be resolved; falling back' },
	);
});

test("resolveModel accumulates distinct fallback notes across levels", () => {
	assert.deepEqual(
		resolveModel({ callTier: "fast", agentTier: "deep", tierConfig: {}, catalog: tierCatalog }),
		{
			model: undefined,
			note: 'tier "fast" could not be resolved; falling back; tier "deep" could not be resolved; falling back',
		},
	);
});

test("resolveModel reports auto configured but unresolvable", () => {
	assert.deepEqual(
		resolveModel({ callTier: "fast", tierConfig: { auto: true }, catalog: tierCatalog }),
		{ model: undefined, note: 'tier "fast" could not be resolved; falling back' },
	);
});

test("resolveModel ignores invalid tier strings and falls through to the agent tier", () => {
	assert.deepEqual(
		resolveModel({ callTier: "mega", agentTier: "fast", tierConfig: { fast: "claude-haiku-4-5" }, catalog: tierCatalog }),
		{ model: "claude-haiku-4-5", tierUsed: "fast", note: undefined },
	);
});

test("resolveModel returns no model when nothing applies", () => {
	assert.deepEqual(resolveModel({ catalog: tierCatalog }), { model: undefined, note: undefined });
});

// ── buildChildArgs ───────────────────────────────────────────────────────────

test("buildChildArgs builds base args with json mode, no session, no extensions", () => {
	assert.deepEqual(buildChildArgs({ task: "Do the thing" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"Task: Do the thing",
	]);
});

test("buildChildArgs adds -e flags for extensions while keeping --no-extensions", () => {
	assert.deepEqual(
		buildChildArgs({
			tools: ["read", "web_search"],
		extensions: ["npm:pi-web-access"],
			task: "T",
		}),
		[
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			"npm:pi-web-access",
			"--tools",
			"read,web_search",
			"Task: T",
		],
	);
});

test("buildChildArgs adds model, tools, and system prompt file in order", () => {
	assert.deepEqual(
		buildChildArgs({
			model: "claude-haiku-4-5",
			tools: ["read", "bash"],
			systemPromptFile: "/tmp/p.md",
			task: "T",
		}),
		[
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--model",
			"claude-haiku-4-5",
			"--tools",
			"read,bash",
			"--append-system-prompt",
			"/tmp/p.md",
			"Task: T",
		],
	);
});

// ── applyEventLine ───────────────────────────────────────────────────────────

test("applyEventLine accumulates assistant usage from message_end events", () => {
	const state = { messages: [], usage: emptyUsage() };
	const line = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				cost: { total: 0.01 },
				totalTokens: 15,
			},
			stopReason: "end",
			model: "some-model",
		},
	});
	applyEventLine(line, state);
	assert.equal(state.messages.length, 1);
	assert.equal(state.usage.input, 10);
	assert.equal(state.usage.output, 5);
	assert.equal(state.usage.cacheRead, 2);
	assert.equal(state.usage.cacheWrite, 1);
	assert.equal(state.usage.cost, 0.01);
	assert.equal(state.usage.contextTokens, 15);
	assert.equal(state.usage.turns, 1);
	assert.equal(state.stopReason, "end");
	assert.equal(state.model, "some-model");
});

test("applyEventLine accumulates usage across multiple assistant messages", () => {
	const state = { messages: [], usage: emptyUsage() };
	applyEventLine(
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 100, output: 10, totalTokens: 110 } },
		}),
		state,
	);
	applyEventLine(
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [], usage: { input: 50, output: 5, totalTokens: 55 } },
		}),
		state,
	);
	assert.equal(state.usage.input, 150);
	assert.equal(state.usage.output, 15);
	assert.equal(state.usage.turns, 2);
});

test("applyEventLine records tool results and error messages", () => {
	const state = { messages: [], usage: emptyUsage() };
	applyEventLine(
		JSON.stringify({
			type: "tool_result_end",
			message: { role: "toolResult", content: [{ type: "text", text: "out" }], toolName: "bash" },
		}),
		state,
	);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].toolName, "bash");

	applyEventLine(
		JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "boom" } }),
		state,
	);
	assert.equal(state.errorMessage, "boom");
});

test("applyEventLine ignores malformed lines and unrelated event types", () => {
	const state = { messages: [], usage: emptyUsage() };
	applyEventLine("not json", state);
	applyEventLine("", state);
	applyEventLine(JSON.stringify({ type: "something_else", message: {} }), state);
	applyEventLine(JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }), state);
	assert.equal(state.messages.length, 0);
	assert.equal(state.usage.turns, 0);
});

// ── getFinalOutput / isFailedState / getResultOutput ────────────────────────

test("getFinalOutput returns last assistant text part", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool" }] },
		{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: {} },
				{ type: "text", text: "final answer" },
			],
		},
	];
	assert.equal(getFinalOutput(messages), "final answer");
});

test("getFinalOutput returns empty string when no assistant text", () => {
	assert.equal(getFinalOutput([{ role: "toolResult", content: [] }]), "");
});

test("isFailedState flags non-zero exit and error stop reasons", () => {
	assert.equal(isFailedState({ exitCode: 0, stopReason: "end" }), false);
	assert.equal(isFailedState({ exitCode: 1 }), true);
	assert.equal(isFailedState({ exitCode: 0, stopReason: "error" }), true);
	assert.equal(isFailedState({ exitCode: 0, stopReason: "aborted" }), true);
});

test("getResultOutput prefers errorMessage, then stderr, then final output", () => {
	const base = { exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: "out" }] }] };
	assert.equal(getResultOutput({ ...base }), "out");
	assert.equal(getResultOutput({ ...base, exitCode: 1 }), "out");
	assert.equal(getResultOutput({ ...base, exitCode: 1, errorMessage: "err" }), "err");
	assert.equal(getResultOutput({ ...base, exitCode: 1, stderr: "boom" }), "boom");
});

test("getResultOutput falls back to placeholder when nothing available", () => {
	assert.equal(getResultOutput({ exitCode: 1, messages: [], stderr: "", errorMessage: "" }), "(no output)");
	assert.equal(getResultOutput({ exitCode: 0, messages: [] }), "(no output)");
});

// ── truncateOutput ───────────────────────────────────────────────────────────

test("truncateOutput keeps short output unchanged", () => {
	const out = "short";
	assert.equal(truncateOutput(out), out);
});

test("truncateOutput truncates at byte cap with a note", () => {
	const out = "x".repeat(1000);
	const result = truncateOutput(out, 100);
	assert.ok(result.startsWith("x".repeat(100)));
	assert.ok(result.includes("[Output truncated:"));
	assert.ok(result.includes("900 bytes"));
});

test("truncateOutput never splits multibyte characters", () => {
	const out = "😀".repeat(200); // 4 bytes each = 800 bytes
	const result = truncateOutput(out, 100);
	const kept = result.split("\n\n[Output truncated")[0];
	assert.ok(kept.length > 0, "kept some content");
	assert.ok(Buffer.byteLength(kept, "utf8") <= 100, "kept portion fits in byte cap");
	// A lone surrogate is a high surrogate not followed by a low surrogate,
	// or a low surrogate not preceded by a high surrogate. Valid pairs are fine.
	const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
	assert.ok(!loneSurrogate.test(result), "no lone surrogates in result");
});

// ── formatTokens / formatUsageStats ──────────────────────────────────────────

test("formatTokens formats short and long counts", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1500), "1.5k");
	assert.equal(formatTokens(15000), "15k");
	assert.equal(formatTokens(1500000), "1.5M");
});

test("formatUsageStats joins present fields", () => {
	const stats = formatUsageStats(
		{ turns: 2, input: 100, output: 50, cost: 0.5, contextTokens: 200, cacheRead: 10, cacheWrite: 5 },
		"model-x",
	);
	assert.ok(stats.includes("2 turns"));
	assert.ok(stats.includes("↑100"));
	assert.ok(stats.includes("↓50"));
	assert.ok(stats.includes("R10"));
	assert.ok(stats.includes("W5"));
	assert.ok(stats.includes("$0.5000"));
	assert.ok(stats.includes("ctx:200"));
	assert.ok(stats.includes("model-x"));
});

test("formatUsageStats returns empty string for empty usage", () => {
	assert.equal(formatUsageStats({}), "");
});

test("formatUsageStats appends the tier to the model when given", () => {
	assert.ok(formatUsageStats({ turns: 1 }, "claude-opus-4-5", "deep").includes("claude-opus-4-5 (tier: deep)"));
	assert.ok(formatUsageStats({ turns: 1 }, "claude-opus-4-5").includes("claude-opus-4-5"));
	assert.equal(formatUsageStats({ turns: 1 }, undefined, "deep"), "1 turn");
});

// ── formatElapsed ─────────────────────────────────────────────────────────────

test("formatElapsed formats sub-minute durations as seconds", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(3), "3s");
	assert.equal(formatElapsed(59), "59s");
});

test("formatElapsed formats minute-level durations and drops zero seconds", () => {
	assert.equal(formatElapsed(60), "1m");
	assert.equal(formatElapsed(90), "1m 30s");
	assert.equal(formatElapsed(3599), "59m 59s");
});

test("formatElapsed formats hour-level durations and drops zero minutes", () => {
	assert.equal(formatElapsed(3600), "1h");
	assert.equal(formatElapsed(3661), "1h 1m");
	assert.equal(formatElapsed(7325), "2h 2m");
});

test("formatElapsed floors partial seconds instead of rounding up", () => {
	assert.equal(formatElapsed(1.9), "1s");
	assert.equal(formatElapsed(59.9), "59s");
	assert.equal(formatElapsed(61.9), "1m 1s");
});

// ── resolveAgent / default agent ─────────────────────────────────────────────

test("DEFAULT_AGENT_SYSTEM_PROMPT is a non-empty system prompt", () => {
	assert.ok(typeof DEFAULT_AGENT_SYSTEM_PROMPT === "string");
	assert.ok(DEFAULT_AGENT_SYSTEM_PROMPT.length > 100);
});

test("resolveAgent returns matching discovered agent", () => {
	const agents = [
		{ name: "scout", description: "d", source: "user", systemPrompt: "p", filePath: "/x", model: undefined, tools: undefined },
	];
	const r = resolveAgent("scout", agents);
	assert.ok(r);
	assert.equal(r.name, "scout");
	assert.equal(r.systemPrompt, "p");
});

test("resolveAgent falls back to the built-in default agent for raw prompts", () => {
	const r = resolveAgent(undefined, []);
	assert.ok(r);
	assert.equal(r.name, "default");
	assert.equal(r.systemPrompt, DEFAULT_AGENT_SYSTEM_PROMPT);
});

test("resolveAgent returns null for an unknown agent name", () => {
	assert.equal(resolveAgent("nope", []), null);
});

test("displayAgentName returns the agent name when present", () => {
	assert.equal(displayAgentName("scout"), "scout");
});

test("displayAgentName falls back to 'default' for omitted agents", () => {
	assert.equal(displayAgentName(undefined), "default");
	assert.equal(displayAgentName(""), "default");
});

// ── formatCompletionNotification / formatStatusReport ────────────────────────

test("shouldNotify only enables completion notifications for async runs", () => {
	assert.equal(shouldNotify(false, true), true);
	assert.equal(shouldNotify(true, true), false);
	assert.equal(shouldNotify(false, false), false);
	assert.equal(shouldNotify(true, false), false);
});

test("formatCompletionNotification summarizes a finished batch", () => {
	const text = formatCompletionNotification(
		[
			{ agent: "scout", status: "completed", output: "Found the auth code in src/auth.ts" },
			{ agent: "worker", status: "failed", errorMessage: "timeout" },
		],
		["id-1", "id-2"],
	);
	assert.ok(text.includes("2 subagents finished"));
	assert.ok(text.includes("scout"));
	assert.ok(text.includes("Found the auth code"));
	assert.ok(text.includes("failed"));
	assert.ok(text.includes("timeout"));
	assert.ok(text.includes("id-1"));
	assert.ok(text.includes("jobIds"));
	assert.ok(text.includes("subagent_wait"));
});

test("formatCompletionNotification previews are capped", () => {
	const text = formatCompletionNotification(
		[{ agent: "scout", status: "completed", output: "y".repeat(5000) }],
		["id-1"],
	);
	assert.ok(!text.includes("y".repeat(5000)));
	assert.ok(text.includes("…"));
});

test("formatStatusReport marks running and completed tasks", () => {
	const report = formatStatusReport([
		{ id: "a", agent: "scout", status: "running", task: "find models", messages: [], usage: emptyUsage() },
		{
			id: "b",
			agent: "worker",
			status: "completed",
			task: "implement",
			exitCode: 0,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done!" }] }],
			usage: { ...emptyUsage(), turns: 1 },
		},
	]);
	assert.ok(report.includes("⏳ running"));
	assert.ok(report.includes("✓ completed"));
	assert.ok(report.includes("scout"));
	assert.ok(report.includes("find models"));
	assert.ok(report.includes("done!"));
});

test("formatStatusReport caps final output at maxOutputBytes", () => {
	const report = formatStatusReport(
		[
			{
				id: "b",
				agent: "worker",
				status: "completed",
				task: "implement",
				exitCode: 0,
				messages: [{ role: "assistant", content: [{ type: "text", text: "y".repeat(200) }] }],
				usage: emptyUsage(),
			},
		],
		{ maxOutputBytes: 50 },
	);
	assert.ok(report.includes("[Output truncated:"));
	assert.ok(!report.includes("y".repeat(200)));
});

test("formatStatusReport shows the used tier and fallback notes", () => {
	const report = formatStatusReport([
		{
			id: "b",
			agent: "planner",
			status: "completed",
			task: "plan",
			exitCode: 0,
			messages: [],
			usage: { ...emptyUsage(), turns: 2 },
			model: "claude-opus-4-5",
			tierUsed: "deep",
			tierNote: 'tier "deep" collapsed to the default model',
		},
	]);
	assert.ok(report.includes("claude-opus-4-5 (tier: deep)"));
	assert.ok(report.includes('Note: tier "deep" collapsed'));
});

// ── completionHeader ─────────────────────────────────────────────────────────

test("completionHeader: all tasks completed is a success header with plural count", () => {
	assert.deepEqual(completionHeader({ total: 3, failed: 0 }), {
		kind: "success",
		text: "✓ 3 subagents finished",
	});
});

test("completionHeader: single completed task uses singular form", () => {
	assert.deepEqual(completionHeader({ total: 1, failed: 0 }), {
		kind: "success",
		text: "✓ 1 subagent finished",
	});
});

test("completionHeader: any failed task yields an error header with the failure count", () => {
	assert.deepEqual(completionHeader({ total: 3, failed: 1 }), {
		kind: "error",
		text: "✗ 3 subagents finished — 1 failed",
	});
});

test("completionHeader: a batch with no tasks reports a plain failure", () => {
	assert.deepEqual(completionHeader({ total: 0, failed: 0 }), {
		kind: "error",
		text: "✗ Subagent batch failed",
	});
});

// ── planAgentSeeds ───────────────────────────────────────────────────────────

test("planAgentSeeds: empty user dir seeds every bundled agent", () => {
	assert.deepEqual(planAgentSeeds(["worker", "researcher", "scout"], []), ["worker", "researcher", "scout"]);
});

test("planAgentSeeds: seeds only the missing agents", () => {
	assert.deepEqual(planAgentSeeds(["worker", "researcher", "scout"], ["scout"]), ["worker", "researcher"]);
	assert.deepEqual(planAgentSeeds(["worker", "researcher", "scout"], ["scout", "worker"]), ["researcher"]);
});

test("planAgentSeeds: nothing to seed when everything exists", () => {
	assert.deepEqual(planAgentSeeds(["worker", "researcher", "scout"], ["scout", "worker", "researcher"]), []);
});

// ── Bundled default agents ───────────────────────────────────────────────────

test("bundled agents declare their default tiers", () => {
	const expected = { scout: "fast", researcher: "deep", worker: "balanced" };
	for (const [name, tier] of Object.entries(expected)) {
		const agent = parseAgentMarkdown(readFileSync(path.join(bundledAgentsDir, `${name}.md`), "utf-8"));
		assert.equal(agent?.tier, tier, `${name} must default to tier "${tier}"`);
		assert.ok(isTierLevel(agent?.tier), `${name} tier must be a valid level`);
	}
});

test("bundled agents: worker, researcher, and scout ship in agents/", () => {
	const files = bundledAgentFiles();
	for (const expected of ["researcher.md", "scout.md", "worker.md"]) {
		assert.ok(files.includes(expected), `missing bundled agent ${expected}`);
	}
});

test("bundled agents parse with the existing parser and match their filename", () => {
	for (const file of bundledAgentFiles()) {
		const agent = parseAgentMarkdown(readFileSync(path.join(bundledAgentsDir, file), "utf-8"));
		assert.ok(agent, `${file} must parse as a valid agent`);
		assert.equal(agent.name, file.replace(/\.md$/, ""), `${file} name must match filename`);
		assert.ok(agent.description, `${file} needs a description`);
		assert.ok(agent.systemPrompt.length > 0, `${file} needs a system prompt body`);
	}
});

test("bundled agents use only the supported frontmatter keys", () => {
	const supported = new Set(["name", "description", "tools", "tier", "extensions"]);
	for (const file of bundledAgentFiles()) {
		const content = readFileSync(path.join(bundledAgentsDir, file), "utf-8");
		const lines = content.split("\n");
		let end = 1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				end = i;
				break;
			}
		}
		const keys = lines
			.slice(1, end)
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => l.slice(0, l.indexOf(":")).trim());
		for (const key of keys) {
			assert.ok(supported.has(key), `${file} uses unsupported frontmatter key "${key}"`);
		}
	}
});

test("bundled researcher declares the web-access extension it needs", () => {
	const researcher = parseAgentMarkdown(readFileSync(path.join(bundledAgentsDir, "researcher.md"), "utf-8"));
	assert.ok(researcher?.extensions?.includes("npm:pi-web-access"), "researcher must load its web provider");
});

test("bundled agent prompts reference only tools and concepts this project provides", () => {
	const banned = ["contact_supervisor", "oracle", "progress.md", "context.md"];
	for (const file of bundledAgentFiles()) {
		const content = readFileSync(path.join(bundledAgentsDir, file), "utf-8").toLowerCase();
		for (const term of banned) {
			assert.ok(!content.includes(term), `${file} must not reference "${term}" (not provided by this project)`);
		}
	}
	// Worker must actually be able to edit; researcher must get the web tools.
	const worker = parseAgentMarkdown(readFileSync(path.join(bundledAgentsDir, "worker.md"), "utf-8"));
	assert.ok(worker?.tools?.includes("edit") && worker.tools.includes("write"));
	const researcher = parseAgentMarkdown(readFileSync(path.join(bundledAgentsDir, "researcher.md"), "utf-8"));
	for (const tool of ["web_search", "fetch_content", "get_search_content"]) {
		assert.ok(researcher?.tools?.includes(tool), `researcher must include ${tool}`);
	}
});
