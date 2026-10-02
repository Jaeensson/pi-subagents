import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSnapshotStore } from "../herdr-files.ts";
import { parseSnapshot } from "../herdr-viewer-render.mjs";

const identity = { activationId: "activation", slotId: 0, nonce: "nonce" };
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
