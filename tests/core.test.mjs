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
import {
	applyEventLine,
	buildChildArgs,
	DEFAULT_AGENT_SYSTEM_PROMPT,
	formatCompletionNotification,
	formatStatusReport,
	formatTokens,
	formatUsageStats,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	parseAgentMarkdown,
	resolveAgent,
	shouldNotify,
	truncateOutput,
} from "../core.ts";

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
model: claude-haiku-4-5
---

You are a scout. Report findings.`;
	const agent = parseAgentMarkdown(content);
	assert.ok(agent);
	assert.equal(agent.name, "scout");
	assert.equal(agent.description, "Fast codebase recon");
	assert.deepEqual(agent.tools, ["read", "grep", "find", "ls", "bash"]);
	assert.equal(agent.model, "claude-haiku-4-5");
	assert.equal(agent.systemPrompt, "You are a scout. Report findings.");
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
