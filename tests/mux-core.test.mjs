import test from "node:test";
import assert from "node:assert/strict";
import {
  getHerdrContext, attemptKey, summarizeTasks, formatSummary, projectSnapshot,
  encodeSnapshot, chooseSlot, SNAPSHOT_MAX_BYTES,
} from "../mux-core.ts";

function task(overrides = {}) {
  return {
    id: "task-1", jobId: "job-1", agent: "worker", task: "original-secret-task-prompt",
    cwd: "/tmp", status: "running", startedAt: 10, exitCode: 0, messages: [],
    live: { segments: [], bytes: 0, dropped: 0, pending: null, emittedToolIndices: new Set(), messageSealed: false },
    stderr: "", usage: {}, processGeneration: 1, ...overrides,
  };
}
const identity = { activationId: "activation", slotId: 0, nonce: "nonce" };

test("context gate and attempt identity", () => {
  assert.equal(getHerdrContext({ HERDR_ENV: "0" }), undefined);
  assert.equal(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }), undefined);
  assert.deepEqual(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }), { binary: "herdr", socketPath: "/s", callerPaneId: "p" });
  assert.equal(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s", HERDR_BIN_PATH: "/bin/herdr" }).binary, "/bin/herdr");
  assert.equal(attemptKey(task({ id: "x", processGeneration: 2 })), "x:2");
  assert.notEqual(attemptKey(task({ processGeneration: 2 })), attemptKey(task({ processGeneration: 3 })));
});

test("summaries include setup work and slot choice protects executing slots", () => {
  const counts = summarizeTasks([task(), task({ id: "q1", setupPending: true }), task({ id: "q2", dispatchState: "queued" }), task({ id: "done", status: "completed" })]);
  assert.equal(counts.executing, 1); assert.equal(counts.queued, 2); assert.equal(counts.completed, 1);
  assert.equal(typeof formatSummary(counts), "string");
  assert.equal(chooseSlot(Array.from({ length: 4 }, (_, index) => ({ index, phase: "ready", taskStatus: "running", availableSince: index }))).kind, "full");
  assert.deepEqual(chooseSlot([
    { index: 0, phase: "reserved", availableSince: 0 },
    { index: 1, phase: "ready", taskStatus: "completed", availableSince: 1 },
    { index: 2, phase: "ready", taskStatus: "paused", availableSince: 0 },
    { index: 3, phase: "ready", taskStatus: "paused", availableSince: 10 },
  ]), { kind: "reuse", index: 2 });
});

test("oldest ready slot precedes empty panes and status never overrides age", () => {
  assert.deepEqual(chooseSlot([
    { index: 0, phase: "empty", availableSince: 0 },
    { index: 1, phase: "ready", taskStatus: "completed", availableSince: 1 },
    { index: 2, phase: "ready", taskStatus: "paused", availableSince: 9 },
    { index: 3, phase: "unavailable", availableSince: 0 },
  ]), { kind: "reuse", index: 1 });
  assert.deepEqual(chooseSlot([
    { index: 0, phase: "ready", taskStatus: "completed", availableSince: 1 },
    { index: 1, phase: "ready", taskStatus: "paused", availableSince: 9 },
  ]), { kind: "reuse", index: 0 });
});

test("snapshots project bounded display-only content without mutating live state", () => {
  const live = { segments: [{ kind: "toolCall", name: "run", args: { secret: "x" } }], bytes: 1, dropped: 0, pending: { kind: "text", text: "pending" }, emittedToolIndices: new Set(), messageSealed: false };
  const t = task({ live, name: "\u001b[31m" + "n".repeat(500), live: { ...live, segments: [{ kind: "toolCall", name: "run", args: { value: "a".repeat(200000) } }] } });
  const before = JSON.stringify(t.live, (_, v) => v instanceof Set ? [] : v);
  const snapshot = projectSnapshot(t, identity, 0, 100);
  const encoded = encodeSnapshot(snapshot);
  assert.ok(Buffer.byteLength(encoded) <= SNAPSHOT_MAX_BYTES);
  assert.equal(JSON.parse(encoded).truncated, true);
  assert.doesNotMatch(encoded, /original-secret-task-prompt/);
  assert.equal(JSON.stringify(t.live, (_, v) => v instanceof Set ? [] : v), before);
  assert.equal(snapshot.task.status, "running");
  assert.ok(snapshot.segments.length <= 1);
  assert.throws(() => projectSnapshot(task(), identity, Number.MAX_SAFE_INTEGER + 1, 100), /sequence/i);
});

test("oversized lone segment retains the latest UTF-8-safe tail within the serialized cap", () => {
  const text = "A".repeat(140000) + "LATEST-TAIL🙂";
  const snapshot = projectSnapshot(task({ live: { segments: [{ kind: "text", text }], pending: null } }), identity, 1, 100);
  const encoded = encodeSnapshot(snapshot);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= SNAPSHOT_MAX_BYTES);
  assert.equal(JSON.parse(encoded).truncated, true);
  assert.ok(snapshot.segments.length > 0);
  assert.ok(snapshot.segments.at(-1).text.endsWith("LATEST-TAIL🙂"));
  assert.doesNotThrow(() => JSON.parse(encoded));
});

test("snapshot keeps latest content, pending segment, and nonnegative age inputs", () => {
  const snapshot = projectSnapshot(task({ startedAt: 200, live: { segments: [{ kind: "text", text: "old" }, { kind: "text", text: "latest" }], pending: { kind: "thinking", text: "thinking" } } }), identity, 1, 100);
  assert.deepEqual(snapshot.segments.map(s => s.text), ["old", "latest", "thinking"]);
  assert.equal(snapshot.heartbeatAt, 100);
});

test("snapshots project context tokens and window only when finite and nonnegative", () => {
  const full = projectSnapshot(task({ model: "opus-4", usage: { contextTokens: 12345 }, contextWindow: 200000 }), identity, 1, 100);
  assert.equal(full.task.model, "opus-4");
  assert.equal(full.task.contextTokens, 12345);
  assert.equal(full.task.contextWindow, 200000);
  const bare = projectSnapshot(task(), identity, 1, 100);
  assert.equal(bare.task.contextTokens, undefined);
  assert.equal(bare.task.contextWindow, undefined);
  const bad = projectSnapshot(task({ usage: { contextTokens: -1 }, contextWindow: Number.NaN }), identity, 1, 100);
  assert.equal(bad.task.contextTokens, undefined);
  assert.equal(bad.task.contextWindow, undefined);
});
