import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runViewer } from "../herdr-viewer.mjs";

const identity = { activationId: "a", slotId: 0, nonce: "n" };
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const snapshot = (seq, heartbeatAt = 1000) => JSON.stringify({ version: 1, ...identity, seq, heartbeatAt, task: { id: "t", generation: 1, name: "Task", agent: "worker", status: "running", startedAt: 1 }, segments: [{ kind: "text", text: "hello界🙂" }], truncated: false });
function harness(initial = snapshot(1)) {
  let now = 1000; let raw = initial; let reads = 0;
  const timers = new Map(); let nextTimer = 0; const frames = []; const identities = [];
  const deps = { readFile: async p => { assert.equal(p, "/snapshot"); reads++; if (raw === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return raw; },
    writeIdentity: async (p, value) => { assert.equal(p, "/identity"); identities.push(value); },
    wallNow: () => now, monotonicNow: () => now,
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id),
    output: { size: () => ({ columns: 30, rows: 5 }), write: frame => frames.push(frame) }, pid: 42 };
  return { deps, frames, identities, timers, get reads() { return reads; }, set raw(value) { raw = value; }, async advance(ms) { now += ms; for (const { fn } of [...timers.values()]) void fn(); await flush(); }, now: () => now };
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

test("stop fences a held read before it can render or start an identity write", async () => {
  const h = harness(); const read = deferred(); const started = deferred();
  h.deps.readFile = () => { started.resolve(); return read.promise; };
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  const polling = h.advance(0);
  await started.promise;
  await viewer.stop();
  const writesAtStop = h.identities.length;
  read.resolve(snapshot(1));
  await polling;
  await flush();
  assert.equal(h.frames.length, 0);
  assert.equal(h.identities.length, writesAtStop);
  assert.equal(h.timers.size, 0);
});

test("every stop call waits for an already started identity write", async () => {
  const h = harness(); const write = deferred(); const started = deferred();
  h.deps.writeIdentity = () => { started.resolve(); return write.promise; };
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  const polling = h.advance(0);
  await started.promise;
  let stopped = 0;
  const first = viewer.stop().then(() => stopped++);
  const second = viewer.stop().then(() => stopped++);
  await flush();
  assert.equal(stopped, 0);
  assert.equal(h.timers.size, 0);
  write.reject(new Error("disk full"));
  await Promise.all([first, second, polling]);
  assert.equal(stopped, 2);
});

test("deadlines and resize run while one read is held; late reads cannot resurrect expiry", async () => {
  const h = harness(); const read = deferred(); let reads = 0; let held = false;
  h.deps.readFile = () => { reads++; return held ? read.promise : Promise.resolve(snapshot(1)); };
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  held = true;
  await h.advance(250);
  for (let i = 0; i < 39; i++) await h.advance(250);
  assert.equal(reads, 2);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  const disconnectedFrame = h.frames.at(-1);
  h.deps.output.size = () => ({ columns: 15, rows: 10 });
  await h.advance(250);
  assert.notEqual(h.frames.at(-1), disconnectedFrame);
  await h.advance(20_750);
  assert.equal(h.timers.size, 0);
  const frames = h.frames.length; const writes = h.identities.length;
  read.resolve(snapshot(2)); await flush();
  assert.equal(h.frames.length, frames);
  assert.equal(h.identities.length, writes);
  await viewer.stop();
});

test("a held identity write neither blocks deadlines nor queues more writes", async () => {
  const h = harness(); const write = deferred(); let writes = 0;
  h.deps.writeIdentity = () => { writes++; return write.promise; };
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  for (let i = 0; i < 40; i++) await h.advance(250);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  await h.advance(20_000);
  assert.equal(h.timers.size, 0);
  assert.equal(writes, 1);
  write.resolve(); await viewer.stop();
});

test("acceptance samples time after validation and refuses an already expired read even without another tick", async () => {
  for (const delay of [4_000, 31_000]) {
    const h = harness(); const read = deferred();
    h.deps.readFile = () => read.promise;
    const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
    await h.advance(0);
    // Move the injected clock without firing the interval.
    const timers = [...h.timers]; h.timers.clear();
    await h.advance(delay);
    for (const [id, timer] of timers) h.timers.set(id, timer);
    read.resolve(snapshot(1)); await flush();
    if (delay === 31_000) {
      assert.equal(h.frames.length, 0);
      assert.equal(h.timers.size, 0);
    } else {
      await h.advance(6_000);
      assert.match(h.frames.at(-1), /running/);
      await h.advance(4_000);
      assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
    }
    await viewer.stop();
  }
});

test("retains accepted content for disconnection and resize after missing or malformed reads", async () => {
  for (const unreadable of [undefined, "{bad"]) {
    const h = harness();
    const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
    await h.advance(0);
    h.raw = unreadable;
    await h.advance(10_000);
    assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
    const beforeResize = h.frames.at(-1);
    h.deps.output.size = () => ({ columns: 15, rows: 10 });
    await h.advance(250);
    assert.notEqual(h.frames.at(-1), beforeResize);
    assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
    assert.match(h.frames.at(-1), /hello/);
    await viewer.stop();
  }
});

test("heartbeat-only sequences renew freshness without duplicate frame writes", async () => {
  const h = harness();
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  h.raw = snapshot(2, 3000);
  await h.advance(2000);
  assert.equal(h.frames.length, 1);
  await h.advance(8000);
  assert.equal(h.frames.length, 1);
  assert.match(h.frames.at(-1), /running/);
  await h.advance(2000);
  assert.equal(h.frames.length, 2);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  await viewer.stop();
});

test("unknown versions, wrong ownership and old sequences cannot renew the deadline", async () => {
  const invalid = [
    { version: 2, seq: 2 }, { activationId: "other", seq: 2 }, { nonce: "other", seq: 2 },
    { slotId: 1, seq: 2 }, { seq: 0 }, { seq: 1 },
  ];
  for (const changes of invalid) {
    const h = harness();
    const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
    await h.advance(0);
    h.raw = JSON.stringify({ ...JSON.parse(snapshot(2)), ...changes });
    await h.advance(10_000);
    assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
    await h.advance(20_000);
    assert.equal(h.timers.size, 0);
    await viewer.stop();
  }
});

test("wall-clock jumps affect only identity timestamps, not freshness", async () => {
  const h = harness(); let wall = 1000;
  h.deps.wallNow = () => wall;
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  wall = -5000; await h.advance(2000);
  assert.equal(h.identities.at(-1).heartbeatAt, -5000);
  assert.match(h.frames.at(-1), /running/);
  wall = 1e12; await h.advance(8000);
  assert.equal(h.identities.at(-1).heartbeatAt, 1e12);
  assert.match(h.frames.at(-1).replace(/\n/g, " "), /disconnected/i);
  await h.advance(20_000);
  assert.equal(h.timers.size, 0);
  await viewer.stop();
});

test("default identity writer is private and cleans temporary files when atomic rename fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-viewer-test-"));
  try {
    const h = harness(); const deps = { ...h.deps }; delete deps.writeIdentity;
    const identityPath = path.join(root, "identity.json");
    const viewer = runViewer({ snapshotPath: "/snapshot", identityPath, identity }, deps);
    await h.advance(0);
    await viewer.stop(); // Waits for the real filesystem write and cleanup.
    assert.deepEqual(JSON.parse(await fs.readFile(identityPath, "utf8")), { version: 1, ...identity, pid: 42, heartbeatAt: 1000 });
    assert.equal((await fs.stat(identityPath)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(root), ["identity.json"]);
    await fs.rm(identityPath);
    await fs.mkdir(identityPath); // A directory target deterministically rejects rename.
    const failed = harness(); const failureDeps = { ...failed.deps }; delete failureDeps.writeIdentity;
    const failedViewer = runViewer({ snapshotPath: "/snapshot", identityPath, identity }, failureDeps);
    await failed.advance(0);
    await failedViewer.stop();
    assert.equal(failed.timers.size, 0);
    assert.deepEqual(await fs.readdir(root), ["identity.json"]);
    assert.ok((await fs.stat(identityPath)).isDirectory());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("isolates malformed and rejected storage and sanitizes Unicode terminal output", async () => {
  const h = harness('{bad');
  let rejectWrites = false; let rejectedWrites = 0;
  const writeIdentity = h.deps.writeIdentity;
  h.deps.writeIdentity = async (...args) => {
    if (rejectWrites) { rejectedWrites++; throw new Error("storage unavailable"); }
    return writeIdentity(...args);
  };
  const viewer = runViewer({ snapshotPath: "/snapshot", identityPath: "/identity", identity }, h.deps);
  await h.advance(0);
  assert.equal(h.frames.length, 0);
  h.raw = snapshot(2).replace("hello界🙂", "\\u001b]52;c;x\\u0007界🙂");
  h.deps.output.size = () => ({ columns: 7, rows: 20 });
  await h.advance(250);
  assert.ok(h.frames.at(-1).includes("界"));
  assert.ok(!h.frames.at(-1).includes("\u001b]"));
  rejectWrites = true;
  await h.advance(2000);
  assert.equal(rejectedWrites, 1);
  await viewer.stop(); assert.equal(h.timers.size, 0);
});
