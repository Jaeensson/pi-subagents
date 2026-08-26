/**
 * Unit tests for live.ts — the pure live-trace reducer + renderer.
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_TRACE_CAP_BYTES, applyLiveEvent, buildTraceView, emptyLiveTrace, linesAboveTail, moveViewTop, reduceLiveEvent, resolveViewTop, traceLineCount, traceToLines, wrapToWidth } from "../live.ts";

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

const execEv = (type, extra = {}, toolCallId = "t1") => ({ type, toolCallId, toolName: "bash", args: { command: "npm test" }, ...extra });
const textSnap = (text) => ({ content: [{ type: "text", text }] });

test("tool execution updates REPLACE the open toolOutput segment with the cumulative snapshot", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("npm ") }), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("npm test") }), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.kind, "toolOutput");
	assert.equal(seg.text, "npm test"); // replaced, not "npm npm test"
});

test("tool execution start with no updates leaves an empty open segment", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.kind, "toolOutput");
	assert.equal(seg.text, "");
});

test("tool execution end replaces text with the final result and flags isError", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("ok") }), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("ok"), isError: false }), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.text, "ok");
	assert.equal(seg.isError, false);
});

test("tool execution end delivers a result never streamed", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("boom"), isError: true }), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.text, "boom");
	assert.equal(seg.isError, true);
});

test("tool execution partial result may be a plain string (defensive)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: "plain" }), t);
	assert.equal(t.segments[t.segments.length - 1].text, "plain");
});

test("empty snapshot content renders as empty text (no JSON fallback noise)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [] } }), t);
	assert.equal(t.segments[t.segments.length - 1].text, "");
});

test("parallel executions route updates and errors by toolCallId", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "call_a"), t);
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "call_b"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("AA") }, "call_a"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("BB") }, "call_b"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("AA"), isError: true }, "call_a"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("BB"), isError: false }, "call_b"), t);
	assert.deepEqual(
		t.segments.map((s) => s.kind === "toolOutput" ? [s.toolCallId, s.text, s.isError] : null),
		[["call_a", "AA", true], ["call_b", "BB", false]],
	);
});

test("sequential executions keep separate segments", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("one") }, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("one") }, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "b"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("two") }, "b"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("two") }, "b"), t);
	assert.deepEqual(t.segments.map((s) => s.text), ["one", "two"]);
});

test("tool execution update/end without a preceding start is a no-op", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("x") }), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: textSnap("y"), isError: true }), t);
	assert.deepEqual(t.segments, []);
});

test("tool execution update without partialResult does not blank the segment", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: textSnap("keep") }), t);
	t = reduceLiveEvent(execEv("tool_execution_update", {}), t);
	assert.equal(t.segments[t.segments.length - 1].text, "keep");
});

test("ring buffer evicts oldest segments once over the byte cap", () => {
	let t = emptyLiveTrace();
	const chunk = "x".repeat(4096);
	for (let i = 0; i < 20; i++) {
		t = reduceLiveEvent(msgu({ type: "text_start", contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: chunk, contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "text_end", content: chunk, contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "text_end", content: chunk, contentIndex: i }), t);
	}
	// 20 × ~4KB > 64KB cap → oldest segments evicted
	assert.ok(t.dropped > 0, "expected dropped > 0");
	assert.ok(t.bytes <= LIVE_TRACE_CAP_BYTES || t.segments.length === 0, "bytes over cap with segments remaining");
	// the newest segment survives
	assert.ok(t.segments.length > 0);
	assert.equal(t.segments[t.segments.length - 1].text, chunk);
});

test("toolOutput snapshot over the cap evicts to keep bytes bounded", () => {
	let t = emptyLiveTrace();
	const big = "y".repeat(40 * 1024);
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [{ type: "text", text: big }] } }, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "b"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [{ type: "text", text: big }] } }, "b"), t);
	// two ~40KB snapshots > 64KB cap → head evicted, newest (b) survives
	assert.ok(t.dropped >= 1, "expected eviction");
	assert.ok(t.segments.some((s) => s.kind === "toolOutput" && s.toolCallId === "b"));
	assert.ok(t.bytes <= LIVE_TRACE_CAP_BYTES || t.segments.length === 0);
});

test("a single toolOutput snapshot larger than the cap evicts itself", () => {
	let t = emptyLiveTrace();
	const huge = "z".repeat(200 * 1024);
	t = reduceLiveEvent(execEv("tool_execution_start", {}, "a"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [{ type: "text", text: huge }] } }, "a"), t);
	assert.equal(t.segments.length, 0);
	assert.equal(t.bytes, 0);
	assert.equal(t.dropped, 1);
});

test("cap invariant holds after every reduce in a mixed feed", () => {
	let t = emptyLiveTrace();
	const inv = () => assert.ok(t.bytes <= LIVE_TRACE_CAP_BYTES || t.segments.length === 0, `bytes ${t.bytes} > cap with ${t.segments.length} segments`);
	for (let i = 0; i < 6; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: "x".repeat(48 * 1024) }), t);
		inv();
		t = reduceLiveEvent(execEv("tool_execution_start", {}, `c${i}`), t);
		inv();
		t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [{ type: "text", text: "y".repeat(48 * 1024) }] } }, `c${i}`), t);
		inv();
		t = reduceLiveEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }] } }, t);
		inv();
	}
});

test("toolCall segments are evictable when over cap", () => {
	let t = emptyLiveTrace();
	const callWith = (name, args) => ({ type: "toolcall_end", contentIndex: 0, toolCall: { name, arguments: args } });
	// 2 toolcalls each ~40KB of args (> 64KB total) → head evicted
	for (let i = 0; i < 2; i++) {
		t = reduceLiveEvent(msgu({ type: "toolcall_start", contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: i, toolCall: { name: `t${i}`, arguments: { big: "q".repeat(40 * 1024) } } }), t);
	}
	assert.ok(t.dropped >= 1, "expected eviction");
	assert.ok(t.segments.some((s) => s.kind === "toolCall" && s.name === "t1"));
	assert.ok(t.bytes <= LIVE_TRACE_CAP_BYTES || t.segments.length === 0);
});

const style = (color, text) => `<${color}>${text}</${color}>`;
const fmtCall = (name, args, s) => s("accent", `→ ${name} ${JSON.stringify(args)}`);

test("wrapToWidth splits long lines and preserves short ones", () => {
	assert.deepEqual(wrapToWidth("abcd", 4), ["abcd"]);
	assert.deepEqual(wrapToWidth("abcdefgh", 4), ["abcd", "efgh"]);
	assert.deepEqual(wrapToWidth("ab\ncdef", 3), ["ab", "cde", "f"]);
	assert.deepEqual(wrapToWidth("x", 0), []);
});

test("traceToLines renders thinking, text, toolCall, toolOutput with styles", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "plan" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t); // seals thinking
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "hi" }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end", contentIndex: 0, toolCall: { name: "bash", arguments: { command: "ls" } } }), t); // seals text, emits toolCall
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: { content: [{ type: "text", text: "out" }] } }), t);
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, [
		`<thinking>⠿ plan</thinking>`,
		`<text>hi</text>`,
		`<accent>→ bash ${JSON.stringify({ command: "ls" })}</accent>`,
		`<toolOutput>└ out</toolOutput>`,
	]);
});

test("traceToLines skips empty toolOutput segments (start with no output)", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, []);
});

test("traceToLines renders thinking and text prefixes with wrapping", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "1234567890" }), t);
	t = reduceLiveEvent(msgu({ type: "text_start" }), t);
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "abcdefghij" }), t);
	t = reduceLiveEvent(msgu({ type: "text_end", content: "abcdefghij" }), t);
	const lines = traceToLines(t, { width: 6, style, formatToolCall: fmtCall });
	// thinking prefix "⠿ " consumes 2 columns: "1234", "5678", "90"; text wraps at 6
	assert.deepEqual(lines, ["<thinking>⠿ 1234</thinking>", "<thinking>5678</thinking>", "<thinking>90</thinking>", "<text>abcdef</text>", "<text>ghij</text>"]);
});

test("traceToLines shows the live pending stream as a tail line", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "stream" }), t);
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, ["<text>stream</text>"]);
});

test("traceToLines marks dropped segments", () => {
	const t = emptyLiveTrace();
	t.dropped = 3;
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, ["<muted>⋯ 3 earlier segments dropped</muted>"]);
});

test("buildTraceView windows to height; viewTop -1 = follow the tail", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 8; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view = buildTraceView(t, { width: 60, height: 3, viewTop: -1, style, formatToolCall: fmtCall });
	assert.equal(view.lines.length, 3);
	assert.ok(view.lines[2].includes("line 8"));
	assert.ok(view.lines[0].includes("line 6"));
	assert.equal(view.top, 5);
	assert.equal(view.maxTop, 5);
	assert.equal(view.atTail, true);
});

test("buildTraceView pins an absolute viewTop while content grows", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 6; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view1 = buildTraceView(t, { width: 60, height: 3, viewTop: 2, style, formatToolCall: fmtCall });
	assert.ok(view1.lines[0].includes("line 3"));
	assert.equal(view1.atTail, false);
	// More content arrives: the pinned viewport must NOT move.
	for (let i = 7; i <= 10; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view2 = buildTraceView(t, { width: 60, height: 3, viewTop: 2, style, formatToolCall: fmtCall });
	assert.deepEqual(view2.lines, view1.lines);
	assert.equal(view2.atTail, false);
});

test("buildTraceView clamps viewTop to content and pads short traces", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 3; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view = buildTraceView(t, { width: 60, height: 2, viewTop: 999, style, formatToolCall: fmtCall });
	assert.equal(view.lines.length, 2);
	assert.ok(view.lines[0].includes("line 2")); // clamped to maxTop (1)
	assert.ok(view.lines[1].includes("line 3"));
	const short = buildTraceView(emptyLiveTrace(), { width: 60, height: 3, viewTop: 0, style, formatToolCall: fmtCall });
	assert.deepEqual(short.lines, ["", "", ""]);
	assert.equal(short.top, 0);
	assert.equal(short.atTail, true);
});

test("resolveViewTop: negative = tail, absolute values clamped to content", () => {
	assert.equal(resolveViewTop(10, 3, -1), 7);
	assert.equal(resolveViewTop(10, 3, -5), 7);
	assert.equal(resolveViewTop(10, 3, 2), 2);
	assert.equal(resolveViewTop(10, 3, 999), 7);
	assert.equal(resolveViewTop(2, 3, -1), 0); // content shorter than viewport
});

test("moveViewTop scrolls absolutely and returns to the tail at the bottom edge", () => {
	// 10 lines, height 3 → maxTop 7
	assert.equal(moveViewTop(10, 3, -1, -1), 6); // up from tail pins one line of history
	assert.equal(moveViewTop(10, 3, 6, -1), 5);
	assert.equal(moveViewTop(10, 3, 5, 1), 6);
	assert.equal(moveViewTop(10, 3, 6, 1), -1); // back at the tail → follow again
	assert.equal(moveViewTop(10, 3, 0, -1), 0); // already at the top
	assert.equal(moveViewTop(10, 3, 6, 10), -1); // page-past the edge → follow
	assert.equal(moveViewTop(3, 3, -1, -1), -1); // nothing to scroll
});

test("linesAboveTail counts lines between the viewport top and the live tail", () => {
	assert.equal(linesAboveTail(10, 3, 7), 0);
	assert.equal(linesAboveTail(10, 3, 3), 4);
	assert.equal(linesAboveTail(10, 10, 0), 0);
});

test("traceLineCount counts rendered lines, style-independent", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 4; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	assert.equal(traceLineCount(t, 60, fmtCall), 4);
	assert.equal(traceLineCount(t, 60, fmtCall), traceToLines(t, { width: 60, style, formatToolCall: fmtCall }).length);
});
