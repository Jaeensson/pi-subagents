# Live Subagent Watch Pane — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user watch a running subagent's live reasoning/activity stream from the pi TUI, toggled with `shift+ctrl+w` as a non-capturing overlay pane.

**Architecture:** Children already stream `message_update` (text/thinking deltas) and `tool_execution_*` events on stdout in `--mode json`; the extension currently discards them. We add `live.ts` — a pure, ring-buffered per-task live-trace reducer plus a pure trace→lines renderer — feed child stdout through it in `process.ts`, and present it via a new `watch.ts` overlay pane (keybind `shift+ctrl+w` via `ui.onTerminalInput`, keys handled by the extension, overlay is display-only with `nonCapturing: true`).

**Tech Stack:** TypeScript (erasable syntax only, `verbatimModuleSyntax`), Node ≥22.6 type stripping + `node --test`, pi 0.84.1 extension API, `@earendil-works/pi-tui` (`showOverlay`, `matchesKey`, `OverlayOptions`).

**Spec:** `docs/superpowers/specs/2026-08-25-watch-pane-design.md`

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `live.ts` | Pure live-trace state (segments, reducer, ring-buffer cap) + pure trace→lines renderer (`wrapToWidth`, `traceToLines`, `buildTraceView`). Zero pi imports, `node --test`-able. | Create |
| `watch.ts` | Watch-mode state machine: toggle, overlay component, header/footer, ticker, key handling, auto-close, teardown. Imports pi-tui at runtime. | Create |
| `runtime.ts` | `Task` gains `live: LiveTrace` (type-only import from `live.ts`). | Modify |
| `process.ts` | Feed each stdout line into `applyLiveEvent`; init trace in `spawnTask`; `maybeAutoCloseWatch()` on finalize. | Modify |
| `tui.ts` | Export `getWidgetTui()`/`getWidgetTheme()`; compact widget header gains the watch hint. | Modify |
| `index.ts` | Register `ui.onTerminalInput` handler; call `disposeWatch()` on session shutdown. | Modify |
| `tests/live.test.mjs` | Unit tests for `live.ts` (reducer + renderer). | Create |
| `package.json` | Test script runs both test files. | Modify |
| `tsconfig.json` | `include` gains `live.ts`, `watch.ts`. | Modify |
| `README.md` | "Watch pane" section. | Modify |
| `AGENTS.md` | Module layout bullets for `live.ts`/`watch.ts`. | Modify |

Dependency rules (acyclic): `live.ts` imports nothing; `runtime.ts` imports `live.ts` types only; `process.ts` → `runtime` + `core` + `live` + `tui` + `watch`; `watch.ts` → `runtime` + `core` + `live` + `tui` (never `process`); `tui.ts` → `runtime` + `core` (never `watch`).

---

## Task 1: Spike — confirm the child's live event payloads

**Goal:** Verify (against a real model run) that child stdout `message_update` events carry `assistantMessageEvent` with the exact `type`/`delta`/`content`/`toolCall` fields the reducer will consume, and that `tool_execution_*` events carry `partialResult`/`result`/`isError`. Adjust reducer field names now if reality differs.

- [ ] **Step 1: Run a one-shot child and capture its raw event stream**

```bash
pi --mode json -p --no-session --no-extensions --no-skills --no-prompt-templates "Task: reply with exactly: done" > /tmp/pi-child-events.jsonl 2>/tmp/pi-child-err.txt
wc -l /tmp/pi-child-events.jsonl
```

- [ ] **Step 2: Inspect the live-relevant event shapes**

```bash
grep -o '"type":"message_update"[^}]*' /tmp/pi-child-events.jsonl | head -5
grep -o '"type":"tool_execution_[a-z]*"' /tmp/pi-child-events.jsonl | sort | uniq -c
grep '"type":"message_update"' /tmp/pi-child-events.jsonl | head -1 | python3 -c "import json,sys; e=json.load(sys.stdin); print(json.dumps(e.get('assistantMessageEvent'), indent=1)[:500])"
```

Expected: a `message_update` whose `assistantMessageEvent` is e.g. `{"type":"text_delta","contentIndex":0,"delta":"done"}`; `message_end` events carry the full message with `content` parts (`type: "text"` / `type: "toolCall"` with `name` + `arguments`). If a `thinking_delta` is never observed (model without extended thinking), that's fine — the reducer handles its absence.

- [ ] **Step 3: Record findings**

If any field is named differently in reality (`delta` vs `text`, `partialResult` vs `partial`), adjust `live.ts` accessors in Tasks 2–6 accordingly and note it in the commit message. No code changes yet this task; nothing to commit beyond the captured file being discarded after inspection.

---

## Task 2: `live.ts` scaffold — trace state, no-op safety, text/thinking streams

**Files:**
- Create: `live.ts`
- Test: `tests/live.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/live.test.mjs` with the scaffold + stream tests. (Mirrors `tests/core.test.mjs`: imports `../live.ts` directly; Node 24 type-stripping handles it.)

```js
/**
 * Unit tests for live.ts — the pure live-trace reducer + renderer.
 * Runs with: node --test tests/core.test.mjs tests/live.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_TRACE_CAP_BYTES, applyLiveEvent, buildTraceView, emptyLiveTrace, reduceLiveEvent, traceToLines, wrapToWidth } from "../live.ts";

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

test("whitespace-only streams never produce segments", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "thinking_start" }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_delta", delta: "   " }), t);
	t = reduceLiveEvent(msgu({ type: "thinking_end" }), t);
	assert.deepEqual(t.segments, []);
	assert.equal(t.pending, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `../live.ts` cannot be resolved (module does not exist).

- [ ] **Step 3: Implement `live.ts` (scaffold + streams)**

Create `live.ts`:

```ts
/**
 * live.ts — Pure live-trace state for watching running subagents.
 *
 * No runtime imports from pi packages: this module is unit-testable with
 * `node --test` (Node >= 22.6 type stripping). Keep it to erasable
 * TypeScript syntax only (no enums, no parameter properties).
 */

export const LIVE_TRACE_CAP_BYTES = 64 * 1024;

export type TraceSegment =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "toolCall"; name: string; args: Record<string, unknown> }
	| { kind: "toolOutput"; text: string; isError?: boolean };

export interface LiveTrace {
	/** Chronological sealed segments. */
	segments: TraceSegment[];
	/** Approximate retained bytes (sealed segments + pending stream). */
	bytes: number;
	/** Segments evicted from the head by the ring-buffer cap. */
	dropped: number;
	/** Unsealed stream currently being built (thinking or text). */
	pending: { kind: "thinking" | "text"; text: string } | null;
	/** Bookkeeping: highest toolCall content-index emitted from message content. */
	lastToolIndex: number;
}

export type StyleFn = (color: string, text: string) => string;
export type FormatToolCallFn = (
	name: string,
	args: Record<string, unknown>,
	style: StyleFn,
) => string;

interface JsonEvent {
	type?: string;
	message?: { content?: Array<Record<string, unknown>> };
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
		content?: string;
	};
}

export function emptyLiveTrace(): LiveTrace {
	return { segments: [], bytes: 0, dropped: 0, pending: null, lastToolIndex: -1 };
}

function segmentBytes(seg: TraceSegment): number {
	const payload =
		seg.kind === "toolCall" ? `${seg.name}${JSON.stringify(seg.args)}` : seg.text;
	return Buffer.byteLength(payload, "utf8");
}

function sealPending(trace: LiveTrace): void {
	const pending = trace.pending;
	if (!pending) return;
	trace.pending = null;
	if (!pending.text.trim()) return;
	trace.segments.push(
		pending.kind === "thinking"
			? { kind: "thinking", text: pending.text }
			: { kind: "text", text: pending.text },
	);
	// Bytes for pending text were already counted when appended.
}

/** Append a delta to the open thinking/text stream, sealing a prior stream of a different kind. */
function appendStreamDelta(trace: LiveTrace, kind: "thinking" | "text", delta: string): void {
	if (!delta) return;
	if (!trace.pending || trace.pending.kind !== kind) {
		sealPending(trace);
		trace.pending = { kind, text: "" };
	}
	trace.pending.text += delta;
	trace.bytes += Buffer.byteLength(delta, "utf8");
}

/** Handle one text/thinking stream event (`*_start`, `*_delta`, `*_end`). */
function applyStreamDelta(trace: LiveTrace, kind: "thinking" | "text", dt: string, deltaText: string | undefined, content: string | undefined): void {
	if (dt.endsWith("_start")) {
		sealPending(trace);
		trace.pending = { kind, text: "" };
		return;
	}
	if (dt.endsWith("_delta")) {
		appendStreamDelta(trace, kind, deltaText ?? "");
		return;
	}
	// `*_end`: seal what we have; adopt `content` only when the stream was empty
	// (covers providers that emit start/end with no deltas).
	if (content) {
		if (!trace.pending || trace.pending.kind !== kind) {
			sealPending(trace);
			trace.pending = { kind, text: content };
			trace.bytes += Buffer.byteLength(content, "utf8");
		} else if (!trace.pending.text) {
			trace.pending.text = content;
			trace.bytes += Buffer.byteLength(content, "utf8");
		}
	}
	sealPending(trace);
}

function applyMessageUpdate(event: JsonEvent, trace: LiveTrace): LiveTrace {
	const ame = event.assistantMessageEvent;
	if (ame) {
		const dt = ame.type;
		const deltaText = typeof ame.delta === "string" ? ame.delta : undefined;
		const content = typeof ame.content === "string" ? ame.content : undefined;
		if (dt === "thinking_start" || dt === "thinking_delta" || dt === "thinking_end") {
			applyStreamDelta(trace, "thinking", dt, deltaText, content);
		} else if (dt === "text_start" || dt === "text_delta" || dt === "text_end") {
			applyStreamDelta(trace, "text", dt, deltaText, content);
		}
	}
	return trace;
}

/**
 * Parse one child stdout line and reduce live-relevant events into trace.
 * Never throws; non-live or malformed lines leave `trace` untouched.
 */
export function applyLiveEvent(line: string, trace: LiveTrace): LiveTrace {
	if (!line.trim()) return trace;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return trace;
	}
	return reduceLiveEvent(event as JsonEvent, trace);
}

/** Pure reducer over a parsed event object (exported for direct unit tests). */
export function reduceLiveEvent(event: JsonEvent, trace: LiveTrace): LiveTrace {
	switch (event.type) {
		case "message_update":
			return applyMessageUpdate(event, trace);
		default:
			return trace;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS (all 8 tests in `tests/live.test.mjs`; the `node --test` runner exits 0).

- [ ] **Step 5: Commit**

```bash
git add live.ts tests/live.test.mjs
git commit -m "feat(watch): live-trace state — text/thinking stream reducer (pure, tested)"
```

---

## Task 3: Tool calls from message content (dedupe + reset per message)

**Files:**
- Modify: `live.ts` (`scanToolCalls`, `parseArgs`, message_end reconcile; wire into `reduceLiveEvent`)
- Test: `tests/live.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to `tests/live.test.mjs`)

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `scanToolCalls` not implemented; toolCall tests fail (empty segments).

- [ ] **Step 3: Implement tool-call scanning + message_end reconcile**

In `live.ts`:

- Add `toolCall` handling to `applyMessageUpdate` (always scan, even during text streams):

```ts
function applyMessageUpdate(event: JsonEvent, trace: LiveTrace): LiveTrace {
	const ame = event.assistantMessageEvent;
	if (ame) {
		const dt = ame.type;
		const deltaText = typeof ame.delta === "string" ? ame.delta : undefined;
		const content = typeof ame.content === "string" ? ame.content : undefined;
		if (dt === "thinking_start" || dt === "thinking_delta" || dt === "thinking_end") {
			applyStreamDelta(trace, "thinking", dt, deltaText, content);
		} else if (dt === "text_start" || dt === "text_delta" || dt === "text_end") {
			applyStreamDelta(trace, "text", dt, deltaText, content);
		}
	}
	scanToolCalls(event.message, trace);
	return trace;
}

function parseArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* fall through to raw wrapper */
		}
	}
	return { raw: String(raw ?? "") };
}

/** Emit a toolCall segment for each content part not yet emitted (dedupe by content index). */
function scanToolCalls(message: { content?: Array<Record<string, unknown>> } | undefined, trace: LiveTrace): void {
	if (!message?.content) return;
	const content = message.content;
	for (let i = 0; i < content.length; i++) {
		if (i <= trace.lastToolIndex) continue;
		const part = content[i];
		if (!part || part.type !== "toolCall") continue;
		trace.lastToolIndex = i;
		const name = typeof part.name === "string" && part.name ? part.name : "?";
		const args = parseArgs(part.arguments);
		trace.segments.push({ kind: "toolCall", name, args });
		trace.bytes += segmentBytes({ kind: "toolCall", name, args });
	}
}

/** Reconcile at message end: seal open streams, emit remaining toolCalls, reset the content index. */
function applyMessageEnd(event: JsonEvent, trace: LiveTrace): LiveTrace {
	sealPending(trace);
	scanToolCalls(event.message, trace);
	trace.lastToolIndex = -1;
	return trace;
}
```

- Extend `reduceLiveEvent`:

```ts
export function reduceLiveEvent(event: JsonEvent, trace: LiveTrace): LiveTrace {
	switch (event.type) {
		case "message_update":
			return applyMessageUpdate(event, trace);
		case "message_end":
			return applyMessageEnd(event, trace);
		default:
			return trace;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add live.ts tests/live.test.mjs
git commit -m "feat(watch): toolCall segments from message content — dedupe + per-message index reset"
```

---

## Task 4: Tool execution segments (live partial output)

**Files:**
- Modify: `live.ts` (`applyToolExecution`, `appendToolOutput`, wire into `reduceLiveEvent`)
- Test: `tests/live.test.mjs`

- [ ] **Step 1: Write the failing tests** (append)

```js
const execEv = (type, extra = {}) => ({ type, toolCallId: "t1", toolName: "bash", args: { command: "npm test" }, ...extra });

test("tool execution partial updates accumulate into a toolOutput segment", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start", { toolCallId: "t1" }), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: "npm " }), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: "test" }), t);
	assert.equal(t.segments[t.segments.length - 1].kind, "toolOutput");
	assert.equal(t.segments[t.segments.length - 1].text, "npm test");
});

test("tool execution end appends the final result and flags errors", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: "ok\n" }), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: "ok\n", isError: false }), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.kind, "toolOutput");
	assert.equal(seg.isError, false);
	// result already present at tail → not duplicated
	assert.equal(seg.text, "ok\n");
});

test("tool execution end appends a result that was never streamed", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_end", { result: "boom", isError: true }), t);
	const seg = t.segments[t.segments.length - 1];
	assert.equal(seg.text, "boom");
	assert.equal(seg.isError, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `tool_execution_*` events ignored.

- [ ] **Step 3: Implement tool execution handling**

In `live.ts`:

```ts
function appendToolOutput(trace: LiveTrace, delta: string): void {
	if (!delta) return;
	const seg = lastSegment(trace);
	if (!seg || seg.kind !== "toolOutput") return;
	seg.text += delta;
	trace.bytes += Buffer.byteLength(delta, "utf8");
}

/** Last segment if it exists (search backwards for the newest toolOutput). */
function lastToolOutputSegment(trace: LiveTrace): TraceSegment | null {
	for (let i = trace.segments.length - 1; i >= 0; i--) {
		if (trace.segments[i].kind === "toolOutput") return trace.segments[i];
	}
	return null;
}

function applyToolExecution(evType: string, event: Record<string, unknown>, trace: LiveTrace): LiveTrace {
	if (evType === "tool_execution_start") {
		trace.segments.push({ kind: "toolOutput", text: "" });
		return trace;
	}
	if (evType === "tool_execution_update") {
		const partial = event.partialResult;
		if (typeof partial === "string") appendToolOutput(trace, partial);
		return trace;
	}
	// tool_execution_end
	const seg = lastToolOutputSegment(trace);
	if (seg) {
		const result = event.result;
		if (typeof result === "string" && result && !seg.text.endsWith(result)) {
			appendToolOutput(trace, seg.text ? `\n${result}` : result);
		}
		seg.isError = event.isError === true;
	}
	return trace;
}
```

- Extend `reduceLiveEvent`:

```ts
	case "tool_execution_start":
	case "tool_execution_update":
	case "tool_execution_end":
		return applyToolExecution(event.type, event, trace);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add live.ts tests/live.test.mjs
git commit -m "feat(watch): toolOutput segments from live tool execution events"
```

---

## Task 5: Ring-buffer cap with dropped counter

**Files:**
- Modify: `live.ts` (introduce `enforceCap` + call sites)
- Test: `tests/live.test.mjs`

Cap enforcement is deliberately absent so far — Tasks 2–4 only *track* `bytes`.
This task introduces the eviction policy.

- [ ] **Step 1: Write the failing tests** (append)

```js
test("ring buffer evicts oldest segments once over the byte cap", () => {
	let t = emptyLiveTrace();
	const chunk = "x".repeat(4096);
	for (let i = 0; i < 20; i++) {
		t = reduceLiveEvent(msgu({ type: "text_start", contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: chunk, contentIndex: i }), t);
		t = reduceLiveEvent(msgu({ type: "text_end", content: chunk, contentIndex: i }), t);
	}
	// 20 × ~4KB > 64KB cap → oldest segments evicted
	assert.ok(t.dropped > 0, "expected dropped > 0");
	assert.ok(t.bytes <= LIVE_TRACE_CAP_BYTES || t.segments.length === 0, "bytes over cap with segments remaining");
	// the newest segment survives
	assert.ok(t.segments.length > 0);
	assert.equal(t.segments[t.segments.length - 1].text, chunk);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `dropped` is 0 and `bytes` exceeds the cap (no eviction logic exists yet).

- [ ] **Step 3: Introduce cap enforcement**

In `live.ts`, add the helper (after `segmentBytes`):

```ts
/** Evict whole segments from the head while over cap. Never evicts `pending`. */
function enforceCap(trace: LiveTrace): void {
	while (trace.bytes > LIVE_TRACE_CAP_BYTES && trace.segments.length > 0) {
		const head = trace.segments.shift()!;
		trace.bytes = Math.max(0, trace.bytes - segmentBytes(head));
		trace.dropped++;
	}
}
```

And call it at the four points where bytes grow:

- end of `appendStreamDelta` (after `trace.bytes += …`):

```ts
	trace.pending.text += delta;
	trace.bytes += Buffer.byteLength(delta, "utf8");
	enforceCap(trace);
```

- end of `sealPending` (after the `trace.segments.push(...)`):

```ts
	// Bytes for pending text were already counted when appended.
	enforceCap(trace);
```

- in `scanToolCalls`, after `trace.bytes += segmentBytes({ kind: "toolCall", name, args });`:

```ts
		trace.bytes += segmentBytes({ kind: "toolCall", name, args });
		enforceCap(trace);
```

- in `appendToolOutput`, after `trace.bytes += Buffer.byteLength(delta, "utf8");`:

```ts
	seg.text += delta;
	trace.bytes += Buffer.byteLength(delta, "utf8");
	enforceCap(trace);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add live.ts tests/live.test.mjs
git commit -m "feat(watch): enforce ring-buffer byte cap, keep dropped counter"
```

---

## Task 6: Trace renderer — wrap, style, window

**Files:**
- Modify: `live.ts` (add `wrapToWidth`, `traceToLines`, `buildTraceView`)
- Test: `tests/live.test.mjs`

- [ ] **Step 1: Write the failing tests** (append)

```js
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
	t = reduceLiveEvent(msgu({ type: "text_start" }), t); // seal thinking
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "hi" }), t);
	t = reduceLiveEvent(msgu({ type: "toolcall_end" }, { role: "assistant", content: [toolPart("bash", '{"command":"ls"}')] }), t);
	t = reduceLiveEvent(execEv("tool_execution_start"), t);
	t = reduceLiveEvent(execEv("tool_execution_update", { partialResult: "out" }), t);
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, [
		`<dim>⠿ plan</dim>`,
		`<toolOutput>hi</toolOutput>`,
		`<accent>→ bash ${JSON.stringify({ command: "ls" })}</accent>`,
		`<dim>└ out</dim>`,
	]);
});

test("traceToLines shows the live pending stream as a tail line", () => {
	let t = emptyLiveTrace();
	t = reduceLiveEvent(msgu({ type: "text_delta", delta: "stream" }), t);
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, ["<toolOutput>stream</toolOutput>"]);
});

test("traceToLines marks dropped segments", () => {
	const t = { segments: [], bytes: 0, dropped: 3, pending: null, lastToolIndex: -1 };
	const lines = traceToLines(t, { width: 60, style, formatToolCall: fmtCall });
	assert.deepEqual(lines, ["<muted>⋯ 3 earlier segments dropped</muted>"]);
});

test("buildTraceView windows to height; linesBack 0 = tail", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 8; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view = buildTraceView(t, { width: 60, height: 3, linesBack: 0, style, formatToolCall: fmtCall });
	assert.equal(view.length, 3);
	// tail shows the last three text lines (no pending after seal)
	assert.ok(view[2].includes("line 8"));
	assert.ok(view[0].includes("line 6"));
});

test("buildTraceView linesBack scrolls back from the tail and clamps", () => {
	let t = emptyLiveTrace();
	for (let i = 1; i <= 3; i++) {
		t = reduceLiveEvent(msgu({ type: "text_delta", delta: `line ${i}\n` }), t);
	}
	const view = buildTraceView(t, { width: 60, height: 2, linesBack: 999, style, formatToolCall: fmtCall });
	assert.equal(view.length, 2);
	assert.ok(view[0].includes("line 1"));
	assert.ok(view[1].includes("line 2"));
});

test("buildTraceView pads short traces to height", () => {
	const view = buildTraceView(emptyLiveTrace(), { width: 60, height: 3, linesBack: 0, style, formatToolCall: fmtCall });
	assert.deepEqual(view, ["", "", ""]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `wrapToWidth`/`traceToLines`/`buildTraceView` not exported.

- [ ] **Step 3: Implement the renderer**

In `live.ts` (append; `StyleFn`/`FormatToolCallFn` already declared):

```ts
/** Wrap raw text to a width, preserving existing newlines (no ANSI handling — style after). */
export function wrapToWidth(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length <= width) {
			out.push(line);
			continue;
		}
		for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
	}
	return out;
}

/**
 * Full unwrapped/styled line list for a trace. `style` is applied per line so
 * ANSI sequences stay well-formed; `formatToolCall` renders tool calls.
 */
export function traceToLines(
	trace: LiveTrace,
	opts: { width: number; style: StyleFn; formatToolCall: FormatToolCallFn },
): string[] {
	const { width, style, formatToolCall } = opts;
	const lines: string[] = [];
	if (trace.dropped > 0) {
		lines.push(style("muted", `⋯ ${trace.dropped} earlier segment${trace.dropped === 1 ? "" : "s"} dropped`));
	}
	const renderText = (color: string, prefix: string, text: string) => {
		let first = true;
		for (const raw of wrapToWidth(text, Math.max(1, width - prefix.length))) {
			lines.push(style(color, (first ? prefix : "") + raw));
			first = false;
		}
	};
	for (const seg of trace.segments) {
		if (seg.kind === "thinking") renderText("dim", "⠿ ", seg.text);
		else if (seg.kind === "text") renderText("toolOutput", "", seg.text);
		else if (seg.kind === "toolCall") lines.push(formatToolCall(seg.name, seg.args, style));
		else renderText(seg.isError ? "error" : "dim", "└ ", seg.text);
	}
	if (trace.pending && trace.pending.text.trim()) {
		renderText(
			trace.pending.kind === "thinking" ? "dim" : "toolOutput",
			trace.pending.kind === "thinking" ? "⠿ " : "",
			trace.pending.text,
		);
	}
	return lines;
}

/**
 * Visible window of the trace: exactly `height` lines. `linesBack` = lines
 * scrolled up from the live tail (0 = follow the tail), clamped to content.
 */
export function buildTraceView(
	trace: LiveTrace,
	opts: {
		width: number;
		height: number;
		linesBack: number;
		style: StyleFn;
		formatToolCall: FormatToolCallFn;
	},
): string[] {
	const { height, linesBack } = opts;
	const lines = traceToLines(trace, opts);
	const visible: string[] = [];
	if (lines.length > height) {
		const maxBack = lines.length - height;
		const back = Math.max(0, Math.min(linesBack, maxBack));
		const start = lines.length - height - back;
		for (let i = 0; i < height; i++) visible.push(lines[start + i]);
	} else {
		for (let i = 0; i < lines.length; i++) visible.push(lines[i]);
		while (visible.length < height) visible.push("");
	}
	return visible;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: PASS. Note the `line N` tests rely on text segments sealing — the `text_delta` without `text_start` calls `appendStreamDelta` which seals nothing prior and starts a pending stream; the final `buildTraceView` runs against an unsealed pending, and `traceToLines` renders pending too — each delta appends to the same pending, so the content is `line 1\nline 2\n…line 8\n` rendered as 8 lines. This works.

- [ ] **Step 5: Commit**

```bash
git add live.ts tests/live.test.mjs
git commit -m "feat(watch): pure trace renderer — wrapToWidth, traceToLines, buildTraceView"
```

---

## Task 7: Capture wiring — `runtime.ts`, `process.ts`, `watch.ts` stub, test script, tsconfig

**Files:**
- Modify: `runtime.ts` (import type + `Task.live`)
- Modify: `process.ts` (init trace; per-line reduce; auto-close hook)
- Create: `watch.ts` (minimal stub so the commit is green; full module in Task 8)
- Modify: `package.json` (test script)
- Modify: `tsconfig.json` (include)

- [ ] **Step 1: Add `Task.live` to the registry**

`runtime.ts` — add the type import at the top (after the existing `./core.ts` import):

```ts
import type { LiveTrace } from "./live.ts";
```

and add the field to `Task` (after `messages: MessageLike[];`):

```ts
	/** Live streaming trace (thinking/text/tool activity) for the watch pane. */
	live: LiveTrace;
```

- [ ] **Step 2: Feed child stdout into the live trace and init in spawn**

`process.ts` — imports:

```ts
import { applyLiveEvent, emptyLiveTrace } from "./live.ts";
import { maybeAutoCloseWatch } from "./watch.ts";
```

In `spawnTask`, add to the `task` literal (after `messages: [],`):

```ts
		live: emptyLiveTrace(),
```

Replace the entire stdout handler so it feeds the live trace before the message parser:

```ts
		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				task.live = applyLiveEvent(line, task.live);
				applyEventLine(line, task);
				job?.emit?.(getFinalOutput(task.messages) || "(running...)", jobDetails(job));
			}
		});
```

In `finalizeTask`, after `updateStatusWidget();`:

```ts
	maybeAutoCloseWatch();
```

- [ ] **Step 3: Create the `watch.ts` stub** (full module in Task 8)

```ts
/**
 * watch.ts — Keybind-toggled overlay watch pane for running subagents.
 * (Full implementation in Task 8; this stub keeps Task 7 green.)
 */

export function maybeAutoCloseWatch(): void {}
```

- [ ] **Step 4: Register the new test file and typecheck scope**

`package.json`:

```json
"test": "node --test tests/core.test.mjs tests/live.test.mjs",
```

`tsconfig.json` — `include` gains:

```json
"include": ["index.ts", "agents.ts", "core.ts", "live.ts", "watch.ts", "runtime.ts", "process.ts", "jobs.ts", "tui.ts", "tools/*.ts"]
```

- [ ] **Step 5: Verify**

```bash
npm test
npm run typecheck
```

Expected: tests PASS (both files); `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add runtime.ts process.ts watch.ts package.json tsconfig.json
git commit -m "feat(watch): capture live traces from child stdout (Task.live, per-line reduce)"
```

---

## Task 8: Watch pane module — `watch.ts` + `tui.ts` tui/theme exports

**Files:**
- Modify: `watch.ts` (replace the Task 7 stub with the full module)
- Modify: `tui.ts` (export `getWidgetTui`/`getWidgetTheme`, latch theme in the widget factory)
- (This is TUI glue; no `node --test` coverage — gates are `npm run typecheck` + manual smoke.)

- [ ] **Step 1: Replace the stub with the full `watch.ts` module**

Overwrite `watch.ts` entirely:

```ts
/**
 * watch.ts — Keybind-toggled overlay watch pane for running subagents.
 *
 * The pane is a non-capturing display surface (tui.showOverlay), refreshed on
 * a ~150ms ticker; all pane keys are handled here via ui.onTerminalInput
 * (see index.ts) — no overlay focus capture, no editor interference.
 */

import { matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { buildTraceView, emptyLiveTrace, type LiveTrace } from "./live.ts";
import { formatElapsed, formatModelTag } from "./core.ts";
import { tasks, type Task } from "./runtime.ts";
import { formatToolCall, getWidgetTheme, getWidgetTui } from "./tui.ts";

const WATCH_KEY = "shift+ctrl+w";
const TICK_MS = 150;
const SCROLL_PAGE = 10;

interface WatchState {
	taskId: string;
	/** Lines scrolled up from the live tail (0 = tail). */
	linesBack: number;
}

let watchHandle: OverlayHandle | undefined;
let watchState: WatchState | undefined;
let watchTimer: NodeJS.Timeout | undefined;

export function isWatchOpen(): boolean {
	return watchState !== undefined;
}

function runningTasks(): Task[] {
	return [...tasks.values()].filter((t) => t.status === "running");
}

/** Toggle the watch pane; no-op when no subagent is running. */
export function toggleWatch(): void {
	const tui = getWidgetTui();
	if (!tui) return;
	if (watchState) {
		closeWatch();
		return;
	}
	const running = runningTasks();
	if (running.length === 0) return;
	watchState = { taskId: running[0].id, linesBack: 0 };
	const component = {
		render: (width: number) => renderWatchPane(tui, width),
		invalidate: () => {},
	};
	watchHandle = tui.showOverlay(component, {
		anchor: "bottom-center",
		maxHeight: "90%",
		width: "98%",
		nonCapturing: true,
	});
	startWatchTicker(tui);
	tui.requestRender();
}

/** Close the watch pane (also called on session shutdown). */
export function closeWatch(): void {
	watchHandle?.hide();
	watchHandle = undefined;
	watchState = undefined;
	stopWatchTicker();
}

/** Session teardown: close and drop all watch state. */
export function disposeWatch(): void {
	closeWatch();
}

/** Called from process.ts after task finalize: close when nothing is running. */
export function maybeAutoCloseWatch(): void {
	if (watchState && runningTasks().length === 0) closeWatch();
}

/**
 * Raw terminal input handler wired from index.ts. Consumes only watch-pane
 * keys; everything else passes through to the app/editor unchanged.
 */
export function handleWatchInput(data: string): { consume?: boolean } | undefined {
	if (!watchState) {
		if (matchesKey(data, WATCH_KEY)) {
			toggleWatch();
			return { consume: true };
		}
		return undefined;
	}
	const state = watchState;
	if (matchesKey(data, "escape") || matchesKey(data, WATCH_KEY)) {
		closeWatch();
		return { consume: true };
	}
	if (matchesKey(data, "up")) {
		state.linesBack++;
		return { consume: true };
	}
	if (matchesKey(data, "down")) {
		state.linesBack = Math.max(0, state.linesBack - 1);
		return { consume: true };
	}
	if (matchesKey(data, "pageUp")) {
		state.linesBack += SCROLL_PAGE;
		return { consume: true };
	}
	if (matchesKey(data, "pageDown")) {
		state.linesBack = Math.max(0, state.linesBack - SCROLL_PAGE);
		return { consume: true };
	}
	if (matchesKey(data, "end")) {
		state.linesBack = 0;
		return { consume: true };
	}
	if (matchesKey(data, "tab")) {
		cycleAgent(state);
		return { consume: true };
	}
	return undefined;
}

function cycleAgent(state: WatchState): void {
	const running = runningTasks();
	if (running.length === 0) return;
	const idx = running.findIndex((t) => t.id === state.taskId);
	const next = running[(idx + 1) % running.length];
	state.taskId = next.id;
	state.linesBack = 0;
}

function startWatchTicker(tui: TUI): void {
	stopWatchTicker();
	watchTimer = setInterval(() => tui.requestRender(), TICK_MS);
	watchTimer.unref?.();
}

function stopWatchTicker(): void {
	if (watchTimer) {
		clearInterval(watchTimer);
		watchTimer = undefined;
	}
}

function renderWatchPane(tui: TUI, width: number): string[] {
	const theme = getWidgetTheme();
	if (!theme) return [];
	const state = watchState ?? { taskId: "", linesBack: 0 };
	let task = tasks.get(state.taskId);
	const running = runningTasks();
	if (running.length > 0 && (!task || task.status !== "running")) {
		task = running[0];
		state.taskId = task.id;
		state.linesBack = 0;
	}
	const paneH = Math.max(6, Math.floor(tui.terminal.rows * 0.9));
	const header = buildHeader(task, running, state, theme);
	const footer = buildFooter(state, theme);
	const trace: LiveTrace = task ? task.live : emptyLiveTrace();
	const content = buildTraceView(trace, {
		width,
		height: Math.max(1, paneH - 2),
		linesBack: state.linesBack,
		style: (color, text) => theme.fg(color, text),
		formatToolCall,
	});
	return [header, ...content, footer];
}

function buildHeader(task: Task | undefined, running: Task[], state: WatchState, theme: any): string {
	const pos = running.findIndex((t) => t.id === state.taskId);
	const label = task ? theme.fg("accent", task.agent) : theme.fg("muted", "—");
	const sel = running.length > 0 ? theme.fg("accent", `${pos + 1}/${running.length}`) : "";
	const elapsed = task ? theme.fg("dim", formatElapsed((Date.now() - task.startedAt) / 1000)) : "";
	const model = task ? theme.fg("dim", formatModelTag(task.model).trim()) : "";
	const status = task?.status === "running" ? theme.fg("warning", "● watching") : theme.fg("success", "✓ done");
	const meta = [label, sel, elapsed, model].filter(Boolean).join(theme.fg("dim", " · "));
	return `${status}  ${meta}`;
}

function buildFooter(state: WatchState, theme: any): string {
	const left =
		state.linesBack > 0
			? theme.fg("muted", `↑ ${state.linesBack} above`)
			: theme.fg("success", "● live");
	const hints = theme.fg("muted", "  ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close");
	return left + hints;
}
```

- [ ] **Step 2: Export the widget's tui + theme from `tui.ts`**

`tui.ts` — module state and getters. Add `widgetTheme` next to the existing `widgetTui`:

```ts
let widgetTui: TUI | undefined;
let widgetTheme: any | undefined;
let widgetRegistered = false;
let widgetTimer: NodeJS.Timeout | undefined;
```

Add getters (near `setUi`):

```ts
/** TUI instance latched by the status widget (used by the watch pane). */
export function getWidgetTui(): TUI | undefined {
	return widgetTui;
}

/** Theme latched by the status widget (used by the watch pane). */
export function getWidgetTheme(): any {
	return widgetTheme;
}
```

Latch the theme in the widget factory and unset it on dispose. Replace the factory body in `updateStatusWidget`:

```ts
		uiRef.setWidget(STATUS_WIDGET_KEY, (tui, theme) => {
			widgetTui = tui;
			widgetTheme = theme;
			return {
				render: (width) => runningTaskLines(theme, width),
				invalidate: () => {},
				dispose: () => {
					widgetTui = undefined;
					widgetTheme = undefined;
					widgetRegistered = false;
					stopWidgetTimer();
				},
			};
		});
```

And in `disposeWidget()`, reset the theme too:

```ts
function disposeWidget(): void {
	uiRef = undefined;
	widgetTui = undefined;
	widgetTheme = undefined;
	widgetRegistered = false;
	stopWidgetTimer();
}
```

- [ ] **Step 3: Typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: `tsc --noEmit` exits 0; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add watch.ts tui.ts
git commit -m "feat(watch): overlay watch pane — toggle, keys, ticker, header/footer render"
```

---

## Task 9: Integration — `index.ts` input listener + teardown, `tui.ts` hint

**Files:**
- Modify: `index.ts` (input listener on session_start; `disposeWatch` on shutdown)
- Modify: `tui.ts` (widget hint line only — the tui/theme exports were added in Task 8)

- [ ] **Step 1: Wire the input listener and teardown**

`index.ts` — imports:

```ts
import { disposeWatch, handleWatchInput } from "./watch.ts";
```

In `session_start` (inside `if (!ctx.hasUI) return;` block, after `setUi(ctx.ui);`):

```ts
		ctx.ui.onTerminalInput((data) => handleWatchInput(data));
```

In `session_shutdown`, after `disposeWidget();`:

```ts
		disposeWatch();
```

- [ ] **Step 2: Add the hint to the compact widget**

`tui.ts` — in `runningTaskLines`, change the header line push from:

```ts
	const lines: string[] = [
		theme.fg("warning", `⏳ ${running.length} subagent${running.length === 1 ? "" : "s"} running`),
	];
```

to:

```ts
	const lines: string[] = [
		theme.fg("warning", `⏳ ${running.length} subagent${running.length === 1 ? "" : "s"} running`) +
			theme.fg("muted", " · shift+ctrl+w to watch"),
	];
```

(The existing `lines.map((line) => truncateToWidth(line, width))` already truncates the combined line.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck
npm test
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add index.ts tui.ts
git commit -m "feat(watch): wire keybind + teardown in index.ts; add widget hint"
```

---

## Task 10: Manual smoke test (TUI)

**Goal:** Verify the pane end-to-end in a real session. Requires the dev symlink (`~/.pi/agent/extensions/subagent` → repo) and `/reload` in pi.

- [ ] **Step 1: Reload pi and spawn a long-running background subagent**

In a pi session (TUI):

```text
/reload
Use subagent { agent: "researcher", task: "Explore this repo and write a detailed report on its architecture, reading at least 3 files", wait: false }
```

- [ ] **Step 2: Open the watch pane**

While the subagent runs, press `shift+ctrl+w`. Expected: a bottom-anchored pane appears with header `● watching: researcher · 1/1 … · ● live`, dim thinking lines (`⠿ …`), `→ tool` call lines, and `└ …` dim tool-output lines; content refreshes live (~150 ms).

- [ ] **Step 3: Exercise the keys**

| Key | Expected |
|-----|----------|
| `↑` | scrolls back a line; footer shows `↑ N above` |
| `↓` / `End` | returns to `● live` tail |
| `PgUp` / `PgDn` | page up/down by 10 |
| `Tab` | cycles agents (spawn a second subagent first; header shows `2/2`) |
| `Esc` | closes the pane; editor focus/behavior unchanged; pressing it again (pane closed) interrupts as before |
| typing letters while open | characters still reach the editor (non-capturing) |

- [ ] **Step 4: Auto-close**

Let the tasks finish. Expected: pane closes itself on the last completion; the standard completion card appears.

- [ ] **Step 5: Edge checks**

- `shift+ctrl+w` with nothing running: no-op (no pane, no error).
- `subagent_status` output unchanged (no live reasoning leaks into model context).

---

## Task 11: Documentation — `README.md`, `AGENTS.md`

**Files:**
- Modify: `README.md` (Watch pane section)
- Modify: `AGENTS.md` (module layout)

- [ ] **Step 1: Add the Watch pane section to `README.md`** (after the "Status widget" subsection, before "Agent definitions")

```markdown
### Watch pane

While subagents run, press `shift+ctrl+w` to open a live watch pane showing a
subagent's reasoning stream in real time — thinking (dim), visible text, tool
calls, and in-progress tool output:

```
● watching: researcher · 1/2  3m 12s · claude-opus-4-5
  ⠿ let me check where settings are read…
  → grep pattern="modelTiers" in src/
  └ pages… done, 1 hit
● live   ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close
```

- `↑↓` scroll the retained history, `PgUp`/`PgDn` page, `Tab` cycles running
  agents, `End` jumps back to the live tail, `Esc` (or `shift+ctrl+w`) closes.
- The pane does not capture focus — you can keep typing in the editor while
  it is open.
- Reasoning is buffered per task in memory only (last 64 KB kept) and is
  never fed back into the conversation or model context; completed results
  remain just as before via `subagent_wait` / the completion card.
- The pane closes automatically when the last watched agent finishes.
- TUI-only — print/JSON modes are unaffected.
```

- [ ] **Step 2: Update `AGENTS.md` module layout**

Replace the `runtime.ts` bullet's parenthetical and add the two new modules:

```markdown
- `runtime.ts` — in-memory task/job registry, waiters, completion checks
  (type-only import from `live.ts`; safe to import from anywhere)
- `live.ts` — pure live-trace state: segment reducer over child stdout
  (`message_update`/`tool_execution_*`) + trace→lines renderer (zero pi
  imports; tested with `node --test`)
- `process.ts` — child pi process lifecycle (spawn/kill/finalize)
- `jobs.ts` — job orchestration: chain runner, concurrency limiter,
  result builders, model-tier context
- `tui.ts` — TUI rendering helpers + persistent status widget
- `watch.ts` — keybind-toggled watch pane: overlay component, keys,
  ticker (depends on runtime + live + core + tui; never on process/jobs)
- `tools/*.ts` — one file per registered tool (`defineTool`)
```

Also update the dependency-graph line accordingly:

```markdown
- Keep the dependency graph acyclic: live → runtime → process → jobs → tools;
  tui depends on runtime + core; watch depends on runtime + live + core + tui.
```

- [ ] **Step 3: Verify + commit**

```bash
npm test
npm run typecheck
git add README.md AGENTS.md
git commit -m "docs(watch): watch pane README section + AGENTS.md module layout"
```

---

## Self-review notes

- **Spec coverage:** live-state core (spec §1) → Tasks 2–5; renderer (spec §3) → Task 6; capture (spec §2) → Tasks 7–8; watch pane (spec §3–4) → Tasks 8–9; retention 64 KB → Task 5 (+ `LIVE_TRACE_CAP_BYTES`); auto-close → Task 8 `maybeAutoCloseWatch`; teardown → Task 9; docs → Task 11; spike → Task 1. Rejected/out-of-scope items (chat-streaming, status-tool enrichment, tails in the compact widget) are intentionally absent.
- **Red-first integrity:** cap enforcement is intentionally absent in Tasks 2–4 (bytes are only *tracked*) so Task 5's test fails before `enforceCap` is introduced; Task 7 ships a `watch.ts` stub so its commit is green and Task 8's typecheck gate resolves against the real exports added in the same task.
- **Placeholders:** none — every code step includes the full code; every verification step names the exact command and expected outcome.
- **Type consistency:** `LiveTrace`/`TraceSegment`/`StyleFn`/`FormatToolCallFn` defined once (Task 2) and used unchanged by `traceToLines`/`buildTraceView` (Task 6) and `watch.ts` (Task 8). `buildTraceView` opts use `linesBack` everywhere (Task 6 definition matches Task 8 call site). `handleWatchInput` return type `{ consume?: boolean } | undefined` matches `TerminalInputHandler`. `maybeAutoCloseWatch` name is consistent between `watch.ts` and `process.ts`; `getWidgetTui`/`getWidgetTheme` are exported by `tui.ts` in the same task (Task 8) that `watch.ts` starts importing them.