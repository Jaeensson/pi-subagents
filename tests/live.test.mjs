/**
 * Unit tests for live.ts — the pure live-trace reducer + renderer.
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_TRACE_CAP_BYTES, applyLiveEvent, emptyLiveTrace, reduceLiveEvent } from "../live.ts";

// Note: Task 6 extends this import with wrapToWidth, traceToLines, buildTraceView.

const msgu = (ame, message) => ({
	type: "message_update",
	message: message ?? { role: "assistant", content: [] },
	assistantMessageEvent: ame ? { contentIndex: 0, ...ame } : undefined,
});

test("emptyLiveTrace has the expected shape", () => {
	const t = emptyLiveTrace();
	assert.deepEqual(t.segments, []);
	assert.equal(t.bytes, 0);
	assert.equal(t.dropped, 0);
	assert.equal(t.pending, null);
});

test("applyLiveEvent ignores empty, malformed, and unrelated lines", () => {
	const t = emptyLiveTrace();
	assert.equal(applyLiveEvent("", t), t);
	assert.equal(applyLiveEvent("not json{{{", t), t);
	assert.equal(applyLiveEvent(JSON.stringify({ type: "message_start", message: { role: "assistant", content: [] } }), t), t);
	assert.equal(applyLiveEvent(JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [] } }), t), t);
	assert.equal(applyLiveEvent("null", t), t); // literal JSON null — unrelated line, no throw
	assert.equal(t.segments.length, 0);
});

test("text deltas accumulate and seal into a text segment", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "Hello " }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "world" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end", content: "Hello world" }), t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "Hello world" }]);
	assert.equal(t.pending, null);
});

test("thinking deltas accumulate and seal into a thinking segment", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "Let me think" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end", content: "Let me think" }), t);
	assert.deepEqual(t.segments, [{ kind: "thinking", text: "Let me think" }]);
});

test("a new stream seals the previous one (thinking then text order)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "why?" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t); // seals thinking
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "Because." }), t);
	t = reduceLiveEvent(msgu({ type: "text_end", content: "Because." }), t); // seals text
	const kinds = t.segments.map((s) => s.kind);
	assert.deepEqual(kinds, ["thinking", "text"]);
	assert.equal(t.segments[0].text, "why?");
});

test("end events adopt content when the stream emitted no deltas", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end", content: "only-end-content" }), t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "only-end-content" }]);
});

test("end content is ignored when the stream was already sealed by a boundary (out-of-order end events)", () => {
	// Real capture: thinking deltas, then text_start, then a late thinking_end.
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "Think" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t); // seals thinking from deltas
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "done" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end", content: "Think" }), t); // arrives late — must not duplicate
	t = reduceLiveEvent(msgu({ type: "text_end", content: "done" }), t);
	assert.deepEqual(t.segments, [
		{ kind: "thinking", text: "Think" },
		{ kind: "text", text: "done" },
	]);
});

test("whitespace-only streams never produce segments", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "   " }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end" }), t);
	assert.deepEqual(t.segments, []);
	assert.equal(t.pending, null);
});

test("delta without a prior start opens a pending stream (D1)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "hi" }), t);
	assert.equal(t.pending.text, "hi");
	t = reduceLiveEvent(msgu({ type: "text_end", content: "hi" }), t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "hi" }]);
});

test("non-string deltas are ignored without throwing (D2)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: 42 }), t); // must not throw
	t = reduceLiveEvent(msgu({ type: "text_end", content: "x" }), t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "x" }]);
});

test("bytes count multi-byte UTF-8 deltas exactly (D3)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "😀" }), t); // 4 UTF-8 bytes
	assert.equal(t.bytes, 4);
	t = reduceLiveEvent(msgu({ type: "text_end" }), t);
	assert.equal(t.bytes, 4);
});

test("sequential same-kind streams seal into separate same-kind segments (D4)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "a" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "b" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end" }), t);
	assert.deepEqual(t.segments, [
		{ kind: "text", text: "a" },
		{ kind: "text", text: "b" },
	]);
});

test("late *_end never seals a different-kind pending stream (D5)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "Why?" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "Hello" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end", content: "Why?" }), t); // late — must NOT seal text
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: " world" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end", content: "Hello world" }), t);
	assert.deepEqual(t.segments, [
		{ kind: "thinking", text: "Why?" },
		{ kind: "text", text: "Hello world" },
	]);
});

test("dropping a whitespace-only pending stream subtracts its bytes (D6)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "   " }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end" }), t);
	assert.deepEqual(t.segments, []);
	assert.equal(t.pending, null);
	assert.equal(t.bytes, 0);
});

const toolPart = (name, args, index = 0) => ({ type: "toolCall", name, arguments: args });

test("toolCall parts in message content become toolCall segments (args JSON string parsed)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_start" }, { role: "assistant", content: [toolPart("grep", '{"pattern":"modelTiers"}')] }), t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "grep", args: { pattern: "modelTiers" } }]);
});

test("the same content index is not emitted twice per message", () => {
	let t = emptyLiveTrace();
	const msg = { role: "assistant", content: [toolPart("grep", '{"pattern":"x"}')] };
	t = reduceLiveEvent(msgu({ type: "toolcall_end" }, msg), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end" }, msg), t);
	t = reduceLiveEvent({ type: "message_end", message: msg }, t);
	assert.equal(t.segments.length, 1);
});

test("message_end resets the content index for the next message", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end" }, { role: "assistant", content: [toolPart("read", '{"path":"a.ts"}')] }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolPart("read", '{"path":"a.ts"}')] } }, t);
	// next assistant message starts its content array at index 0 again
	t = reduceLiveEvent(msgu({ type: "toolcall_start" }, { role: "assistant", content: [toolPart("bash", '{"command":"npm test"}')] }), t);
	assert.deepEqual(t.segments.map((s) => s.name), ["read", "bash"]);
});

test("toolCall with non-string arguments is passed through", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end" }, { role: "assistant", content: [toolPart("edit", { path: "a.ts", edits: [] })] }), t);
	assert.deepEqual(t.segments[0].args, { path: "a.ts", edits: [] });
});

test("message_end seals any still-open stream", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "trailing" }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "trailing" }] } }, t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "trailing" }]);
});
