import test from "node:test";
import assert from "node:assert/strict";
import { runViewer } from "../herdr-viewer.mjs";

const identity = { activationId: "a", slotId: 0, nonce: "n" };
const snapshot = (seq, heartbeatAt = 1000) => JSON.stringify({ version: 1, ...identity, seq, heartbeatAt, task: { id: "t", generation: 1, name: "Task", agent: "worker", status: "running", startedAt: 1 }, segments: [{ kind: "text", text: "hello界🙂" }], truncated: false });
function harness(initial = snapshot(1)) {
  let now = 1000; let raw = initial; let reads = 0;
  const timers = new Map(); let nextTimer = 0; const frames = []; const identities = []; let pending = Promise.resolve();
  const deps = { readFile: async p => { assert.equal(p, "/snapshot"); reads++; if (raw === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return raw; },
    writeIdentity: async (p, value) => { assert.equal(p, "/identity"); identities.push(value); },
    wallNow: () => now, monotonicNow: () => now,
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id),
    output: { size: () => ({ columns: 30, rows: 5 }), write: frame => frames.push(frame) }, pid: 42 };
  return { deps, frames, identities, timers, get reads() { return reads; }, set raw(value) { raw = value; }, advance(ms) { now += ms; for (const { fn } of [...timers.values()]) pending = Promise.resolve(fn()).catch(() => {}); return pending; }, now: () => now };
}

test("does not read before polling and accepts a fresh sequence with identity heartbeat", async () => {
  const h = harness(); const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  assert.equal(h.reads, 0);
  await h.advance(0);
  assert.ok(h.frames.at(-1).includes("Task"));
  assert.deepEqual(h.identities.at(-1), { version: 1, ...identity, pid: 42, heartbeatAt: 1000 });
  assert.ok(h.frames.at(-1).includes("hello"));
  await viewer.stop(); assert.equal(h.timers.size, 0);
});

test("uses monotonic freshness, signals disconnect, recovers only for a new sequence and exits", async () => {
  const h = harness(); const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  await h.advance(10_000);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  h.raw = snapshot(1, h.now() + 100_000);
  await h.advance(250);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  h.raw = snapshot(2, h.now() - 100_000);
  await h.advance(250);
  assert.ok(h.frames.at(-1).includes("running"));
  await h.advance(30_000);
  assert.equal(h.timers.size, 0);
  await viewer.stop();
});

test("isolates malformed and rejected storage and sanitizes Unicode terminal output", async () => {
  const h = harness('{bad');
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  assert.equal(h.frames.length, 0);
  h.raw = snapshot(2).replace("hello界🙂", "\\u001b]52;c;x\\u0007界🙂");
  h.deps.output.size = () => ({ columns: 7, rows: 20 });
  await h.advance(250);
  assert.ok(h.frames.at(-1).includes("界"));
  assert.ok(!h.frames.at(-1).includes("\u001b]"));
  h.deps.writeIdentity = async () => { throw new Error("storage unavailable"); };
  await h.advance(2000);
  await viewer.stop(); assert.equal(h.timers.size, 0);
});
