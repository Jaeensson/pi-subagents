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

const toolCall = (name, args) => ({ type: "toolCall", name, arguments: args });

test("toolcall_end emits a toolCall segment from its toolCall field (args object)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } } }), t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "bash", args: { command: "ls" } }]);
});

test("toolcall_end with string JSON arguments parses them into an object", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", toolCall: { id: "c1", name: "grep", arguments: '{"pattern":"x"}' } }), t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "grep", args: { pattern: "x" } }]);
});

test("the same contentIndex is not emitted twice; message_end does not duplicate it", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "grep", arguments: { pattern: "x" } } }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "grep", arguments: { pattern: "x" } } }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolCall("grep", { pattern: "x" })] } }, t);
	assert.equal(t.segments.length, 1);
});

test("message_end reconcile emits toolCall parts whose index was never streamed", () => {
	let t = emptyLiveTrace();
	// no toolcall_end was streamed; only the final message has the part
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolCall("read", { path: "a.ts" })] } }, t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "read", args: { path: "a.ts" } }]);
});

test("message_end resets the content index for the next message", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "read", arguments: '{"path":"a.ts"}' } }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolCall("read", { path: "a.ts" })] } }, t);
	// next message begins with toolcall_start (clears the sealed flag), index 0 fresh again
	t = reduceLiveEvent(msgu({ type: "toolcall_start", contentIndex: 0 }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: '{"command":"npm test"}' } }), t);
	assert.deepEqual(t.segments.map((s) => s.name), ["read", "bash"]);
});

test("toolcall_start seals any open stream; toolcall_end emits after it", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "checking" }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_start", contentIndex: 0 }), t); // seals text
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: { command: "ls" } } }), t);
	assert.deepEqual(t.segments.map((s) => s.kind), ["text", "toolCall"]);
});

test("message_end seals any still-open stream", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "trailing" }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "trailing" }] } }, t);
	assert.deepEqual(t.segments, [{ kind: "text", text: "trailing" }]);
});

test("reconcile emits a toolCall index that was never streamed even when a HIGHER index was", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 2, toolCall: { name: "c", arguments: {} } }), t);
	const content = [toolCall("grep", { pattern: "x" }), toolCall("read", { path: "a.ts" }), toolCall("c", {})];
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content } }, t);
	assert.deepEqual(t.segments.map((s) => s.name), ["c", "grep", "read"]);
});

test("toolcall_end WITHOUT contentIndex defaults to index 0 and emits", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } } }, t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "bash", args: { command: "ls" } }]);
});

test("a straggling toolcall_end after message_end does not duplicate (messageSealed)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "read", arguments: { path: "a.ts" } } }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolCall("read", { path: "a.ts" })] } }, t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "read", arguments: { path: "a.ts" } } }), t); // straggler
	assert.equal(t.segments.length, 1);
});

test("text_start after message_end unseals the tool-call path for the next message", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "read", arguments: { path: "a.ts" } } }), t);
	t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [toolCall("read", { path: "a.ts" })] } }, t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t); // next message begins with text — unseals
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "ok" }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: {} } }), t); // now allowed
	assert.deepEqual(t.segments.map((s) => s.kind), ["toolCall", "text", "toolCall"]);
});

test("toolcall with null arguments wraps as raw 'null'", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: null } }), t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "bash", args: { raw: "null" } }]);
});

test("toolcall with non-string name falls back to '?'", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: 42, arguments: {} } }), t);
	assert.deepEqual(t.segments, [{ kind: "toolCall", name: "?", args: {} }]);
});

test("toolcall_delta without toolcall_start still seals an open text stream", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "checking" }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_delta", contentIndex: 0, delta: "{}" }), t); // no preceding start
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: { command: "ls" } } }), t);
	assert.deepEqual(t.segments.map((s) => s.kind), ["text", "toolCall"]);
});
