import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshotStore } from "../mux-files.ts";
import { parseSnapshot } from "../mux-viewer-render.mjs";

const identity = { activationId: "activation", slotId: 0, nonce: "nonce" };
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeFs(overrides = {}) {
  return { mkdtemp: async () => "/private", chmod: async () => {}, writeFile: async () => {},
    rename: async () => {}, rm: async () => {}, readFile: async () => { throw new Error("missing"); }, ...overrides };
}
const snapshot = seq => ({ version: 1, ...identity, seq, heartbeatAt: 1000, task: { id: "task", generation: 1, name: "Task", agent: "worker", status: "running", startedAt: 1 }, segments: [], truncated: false });

test("creates private bounded slot files lazily and publishes valid snapshots atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  try {
    const store = createSnapshotStore({ tempRoot: root });
    assert.equal((await fs.readdir(root)).length, 0);
    const paths = await store.openSlot(identity);
    assert.equal((await fs.stat(path.dirname(paths.snapshotPath))).mode & 0o777, 0o700);
    await store.publish(0, snapshot(1), () => true);
    const raw = await fs.readFile(paths.snapshotPath, "utf8");
    assert.ok(parseSnapshot(raw));
    assert.equal((await fs.stat(paths.snapshotPath)).mode & 0o777, 0o600);
    await store.dispose();
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("coalesces a held write to the newest publication and removes files on dispose", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  let unblock; let began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const base = fs.writeFile;
  const io = { mkdtemp: fs.mkdtemp, chmod: fs.chmod, rename: fs.rename, rm: fs.rm, readFile: fs.readFile,
    async writeFile(...args) { began(); await gate; return base(...args); } };
  try {
    const store = createSnapshotStore({ tempRoot: root, fs: io });
    const paths = await store.openSlot(identity);
    const first = store.publish(0, snapshot(1), () => true);
    await started;
    const second = store.publish(0, snapshot(2), () => true);
    const third = store.publish(0, snapshot(3), () => true);
    unblock();
    await Promise.all([first, second, third]);
    assert.equal(JSON.parse(await fs.readFile(paths.snapshotPath, "utf8")).seq, 3);
    await store.dispose();
    assert.equal((await fs.readdir(root)).length, 0);
  } finally { unblock(); await fs.rm(root, { recursive: true, force: true }); }
});

test("disposal during held private-directory creation waits and removes the resulting directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  let unblock; let began;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const io = { ...fs, async mkdtemp(prefix) { began(); await gate; return fs.mkdtemp(prefix); } };
  try {
    const store = createSnapshotStore({ tempRoot: root, fs: io });
    const opening = store.openSlot(identity);
    await started;
    const disposing = store.dispose();
    unblock();
    await assert.rejects(opening, /disposed/);
    await disposing;
    assert.deepEqual(await fs.readdir(root), []);
  } finally { unblock(); await fs.rm(root, { recursive: true, force: true }); }
});

test("removes atomic temporary files after stale or failed writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  try {
    const store = createSnapshotStore({ tempRoot: root });
    const paths = await store.openSlot(identity);
    await store.publish(0, snapshot(1), () => false);
    assert.deepEqual(await fs.readdir(path.dirname(paths.snapshotPath)), []);
    await store.dispose();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("concurrent conflicting opens cannot overwrite the established slot identity", async () => {
  const directory = deferred();
  const store = createSnapshotStore({ fs: fakeFs({ mkdtemp: () => directory.promise }) });
  const first = store.openSlot(identity);
  const second = store.openSlot({ ...identity, nonce: "other" });
  const outcomes = Promise.allSettled([first, second]);
  directory.resolve("/private");
  const results = await outcomes;
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /identity mismatch/);
  assert.deepEqual(await store.openSlot(identity), results[0].value);
  await assert.rejects(store.openSlot({ ...identity, nonce: "other" }), /identity mismatch/);
  await store.dispose();
});

test("cleans a created directory when chmod rejects, including concurrent disposal", async () => {
  const permission = deferred(); const removed = [];
  const failure = new Error("chmod denied");
  const store = createSnapshotStore({ fs: fakeFs({ chmod: () => permission.promise,
    rm: async (file, options) => removed.push([file, options]) }) });
  const opening = store.openSlot(identity);
  const rejected = assert.rejects(opening, error => error === failure);
  const disposing = store.dispose();
  permission.reject(failure);
  await Promise.all([rejected, disposing]);
  assert.deepEqual(removed, [["/private", { recursive: true, force: true }]]);
});

test("publication propagates injected write, chmod and rename failures and cleans temporary files", async () => {
  for (const operation of ["writeFile", "chmod", "rename"]) {
    const failure = new Error(`${operation}: disk full`); const removed = [];
    let fail = false;
    const store = createSnapshotStore({ fs: fakeFs({
      [operation]: async () => { if (fail) throw failure; },
      rm: async file => removed.push(file),
    }) });
    await store.openSlot(identity);
    fail = true;
    await assert.rejects(store.publish(0, snapshot(1), () => true), error => error === failure);
    assert.equal(removed.length, 1);
    assert.match(path.basename(removed[0]), /^\.tmp-/);
    await store.dispose();
  }
});

test("default atomic path preserves the last snapshot and removes temp files after a failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  const store = createSnapshotStore({ tempRoot: root });
  try {
    const paths = await store.openSlot(identity);
    await store.publish(0, snapshot(1), () => true);
    let checks = 0;
    await assert.rejects(store.publish(0, snapshot(2), () => {
      if (++checks === 2) throw new Error("activation check failed");
      return true;
    }), /activation check failed/);
    assert.equal(JSON.parse(await fs.readFile(paths.snapshotPath, "utf8")).seq, 1);
    assert.deepEqual(await fs.readdir(path.dirname(paths.snapshotPath)), ["slot-0.json"]);
    await store.dispose();
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await store.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("held I/O retains only active and latest pending completions during a publication flood", async () => {
  const write = deferred(); const started = deferred(); const sequences = [];
  const store = createSnapshotStore({ fs: fakeFs({ writeFile: async (_file, raw) => {
    sequences.push(JSON.parse(raw).seq); started.resolve(); await write.promise;
  } }) });
  await store.openSlot(identity);
  let completed = 0;
  const publications = [store.publish(0, snapshot(1), () => true).then(() => completed++)];
  await started.promise;
  for (let seq = 2; seq <= 1000; seq++) publications.push(store.publish(0, snapshot(seq), () => true).then(() => completed++));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(completed, 998);
  assert.deepEqual(sequences, [1]);
  write.resolve(); await Promise.all(publications);
  assert.deepEqual(sequences, [1, 1000]);
  assert.equal(completed, 1000);
  await store.dispose();
});

test("a held write failure rejects active and latest pending work without unhandled drain rejection", async () => {
  const write = deferred(); const started = deferred(); const failure = new Error("disk full");
  const store = createSnapshotStore({ fs: fakeFs({ writeFile: () => { started.resolve(); return write.promise; } }) });
  await store.openSlot(identity);
  const first = store.publish(0, snapshot(1), () => true);
  await started.promise;
  const latest = store.publish(0, snapshot(2), () => true);
  const results = Promise.allSettled([first, latest]);
  write.reject(failure);
  for (const result of await results) {
    assert.equal(result.status, "rejected"); assert.equal(result.reason, failure);
  }
  await store.dispose();
});

test("dispose settles pending work but every disposal waits for held writes and temp cleanup", async () => {
  const write = deferred(); const started = deferred(); const removed = []; let renamed = false;
  const store = createSnapshotStore({ fs: fakeFs({
    writeFile: () => { started.resolve(); return write.promise; }, rename: async () => { renamed = true; },
    rm: async (file, options) => removed.push([file, options]),
  }) });
  await store.openSlot(identity);
  const active = store.publish(0, snapshot(1), () => true);
  await started.promise;
  const pending = store.publish(0, snapshot(2), () => true);
  let disposed = 0;
  const first = store.dispose().then(() => disposed++);
  const second = store.dispose().then(() => disposed++);
  await pending;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(disposed, 0);
  write.resolve(); await Promise.all([active, first, second]);
  assert.equal(disposed, 2);
  assert.equal(renamed, false);
  assert.match(path.basename(removed[0][0]), /^\.tmp-/);
  assert.deepEqual(removed[1], ["/private", { recursive: true, force: true }]);
});

test("rejects excess slots without creating unbounded private files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-files-test-"));
  const store = createSnapshotStore({ tempRoot: root });
  try {
    for (let slotId = 0; slotId < 4; slotId++) await store.openSlot({ ...identity, slotId });
    await assert.rejects(store.openSlot({ ...identity, slotId: 4 }));
    await store.dispose();
    assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
