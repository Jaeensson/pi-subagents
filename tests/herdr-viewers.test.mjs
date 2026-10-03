import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createViewerManager, resolveViewerNode } from "../herdr-viewers.ts";
import { createHerdrAdapter } from "../herdr-adapter.ts";
import { createSnapshotStore } from "../herdr-files.ts";
import { emptyLiveTrace } from "../live.ts";
import { runViewer } from "../herdr-viewer.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((y, n) => { resolve = y; reject = n; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
function clock() {
  let now = 1000, id = 0; const timers = new Map();
  return { wallNow: () => now, monotonicNow: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: key => timers.delete(key),
    setInterval(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms, ms }); return key; },
    clearInterval: key => timers.delete(key),
    async advance(ms) { const end = now + ms; while (true) { const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; if (next[1].ms) next[1].at += next[1].ms; else timers.delete(next[0]); next[1].fn(); await flush(); } now = end; await flush(); },
    timers,
  };
}
const task = (id, overrides = {}) => ({ id, jobId: "j", agent: "worker", agentSource: "user", task: "secret prompt", cwd: "/tmp", status: "running", startedAt: 1, exitCode: 0, messages: [], stderr: "", usage: {}, processGeneration: 1, live: emptyLiveTrace(), ...overrides });
const ref = (id, tab = "owned") => ({ paneId: id, tabId: tab, workspaceId: "w" });
const envelope = value => JSON.stringify({ id: "cli:test", result: { type: "test", ...value } });
const wire = p => ({ pane_id: p.paneId, tab_id: p.tabId, workspace_id: p.workspaceId });
function harness(options = {}) {
  const time = clock(), calls = [], panes = new Map(), moved = new Map(), occupants = new Map(), identities = new Map(), snapshots = [], writes = [];
  const creation = options.creation; let current = true, tabs = 0, splits = 0, nonce = 0, disposed = false;
  let publications = 0;
  const store = options.realStore ? createSnapshotStore({ tempRoot: options.realStore, fs: options.transportFs }) : options.store ?? {
    async openSlot(identity) { identities.set(identity.slotId, { version: 1, ...identity, pid: 100 + identity.slotId, heartbeatAt: time.wallNow() }); return { snapshotPath: `/private/slot-${identity.slotId}.json`, identityPath: `/private/id-${identity.slotId}.json` }; },
    async publish(slot, snapshot, guard) { writes.push(snapshot); publications++; if (options.write) await options.write.promise; if (options.holdPublication === publications) await options.publicationGate.promise; if (options.failPublication === publications) throw new Error("disk full"); if (options.diskFail || options.failSlot === slot) throw new Error("disk full"); if (!disposed && guard()) snapshots.push(snapshot); },
    async readIdentity(slot) { if (options.delayedIdentity && time.wallNow() < 1250) return; const i = identities.get(slot); return i && { ...i, heartbeatAt: options.stale ? 0 : time.wallNow() }; },
    async dispose() { disposed = true; },
  };
  const api = createHerdrAdapter({ binary: "fake-herdr", socketPath: "/socket", callerPaneId: "parent" }, async (_, args, env) => {
    calls.push({ args, caller: env.env.HERDR_PANE_ID, at: time.wallNow() });
    if (options.holdVerb === args[1]) await options.hold.promise;
    if (options.onCommand) await options.onCommand(args);
    if (args[0] === "tab" && args[1] === "create") { tabs++; if (creation) await creation.promise; const p = ref("p0"); panes.set(p.paneId, p); return envelope({ tab: { tab_id: "owned" }, root_pane: wire(p) }); }
    if (args[1] === "split") { const p = ref(`p${++splits}`); if (options.splitGate) await options.splitGate.promise; panes.set(p.paneId, p); return envelope({ pane: wire(p) }); }
    if (args[1] === "current") { const id = env.env.HERDR_PANE_ID; const p = id === "parent" ? ref("parent", "parent-tab") : panes.get(moved.get(id) ?? id); if (!p) return JSON.stringify({ id: "x", error: { code: options.lookupFailure ?? "pane_not_found", message: "lookup failed" } }); return envelope({ pane: wire(p) }); }
    if (args[1] === "process-info") { const id = args.at(-1); const custom = occupants.get(id); return envelope({ process_info: { pane_id: id, shell_pid: 7, foreground_processes: custom ?? [{ pid: 7, name: options.shell ?? "bash" }] } }); }
    if (args[1] === "run") {
      const id = args[2]; const slot = Number(/--slot' '(\d+)'/.exec(args[3])?.[1]);
      occupants.set(id, [{ pid: 100 + slot, name: "node" }]);
      if (options.realStore) {
        // Decode exactly the constrained Bourne single-quote grammar emitted by the real builder.
        const argv = [...args[3].matchAll(/'((?:[^']|'\\'')*)'/g)].map(m => m[1].replaceAll("'\\''", "'"));
        const value = flag => argv[argv.indexOf(flag) + 1];
        const viewer = runViewer({ snapshotPath: value("--snapshot"), identityPath: value("--identity"), identity: { activationId: value("--activation"), slotId: Number(value("--slot")), nonce: value("--nonce") } }, {
          ...(options.transportFs ? { readFile: file => options.transportFs.readFile(file), writeIdentity: (file, value) => options.transportFs.writeFile(file, JSON.stringify(value)) } : {}),
          pid: 100 + slot, wallNow: time.wallNow, monotonicNow: time.monotonicNow,
          setInterval: time.setInterval, clearInterval: time.clearInterval,
          output: { size: () => ({ columns: 80, rows: 24 }), write: frame => options.frames.push(frame) },
        }); options.viewers.push(viewer);
      }
    }
    if (args[0] === "pane" && args[1] === "list") return envelope({ panes: [...panes.values()].map(wire) });
    if (args[0] === "pane" && args[1] === "close") panes.delete(args[2]);
    return envelope({});
  });
  const manager = createViewerManager({ adapter: api, parent: ref("parent", "parent-tab"), cwd: "/tmp", activationId: "a", isCurrent: () => current, warn: message => calls.push({ warning: message }) }, { clock: time, storeFactory: () => store, resolveNode: async () => options.noNode ? undefined : "/node ' $()", viewerScriptPath: "/viewer ' $().mjs", nonce: () => `n${++nonce}`, execPath: "/bun" });
  return { manager, time, calls, panes, moved, occupants, identities, snapshots, writes, disable: () => { current = false; }, counts: () => ({ tabs, splits }), parent: ref("parent", "parent-tab") };
}
const commands = (h, verb) => h.calls.filter(c => c.args?.[1] === verb);

test("reserves four synchronously, creates one no-focus 2x2 tab, never allocates queued tasks or evicts executing viewers", async () => {
  const gate = deferred(), h = harness({ creation: gate });
  const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, i >= 4 ? { dispatchState: "queued" } : {}));
  h.manager.reconcile(tasks, h.parent); h.manager.reconcile(tasks, h.parent); await flush();
  assert.equal(h.counts().tabs, 1); gate.resolve(); await flush();
  assert.deepEqual(h.counts(), { tabs: 1, splits: 3 });
  assert.deepEqual(commands(h, "split").map(c => [c.args[2], c.args[4]]), [["p0", "right"], ["p0", "down"], ["p1", "down"]]);
  assert.equal(commands(h, "run").length, 4);
  h.manager.reconcile([...tasks, task("extra")], h.parent); await flush(); assert.equal(commands(h, "run").length, 4);
  assert.ok([...commands(h, "create"), ...commands(h, "split")].every(c => c.args.includes("--no-focus")));
  assert.equal(h.calls.some(c => c.args?.includes("focus") || c.args?.includes("kill")), false);
  await h.manager.stop();
});

test("reuses oldest inactive viewer before empty, replaces full DTO/content and retains physical nonce sequence", async () => {
  const h = harness(), old = task("old", { model: "old-model", live: { ...emptyLiveTrace(), segments: [{ kind: "text", text: "prior-slot-occupant" }] } });
  h.manager.reconcile([old], h.parent); await flush(); const first = h.snapshots.at(-1);
  old.status = "completed"; old.finishedAt = 1200; h.manager.reconcile([old], h.parent); await h.time.advance(250);
  const fresh = task("new", { processGeneration: 3 }); h.manager.reconcile([old, fresh], h.parent); await h.time.advance(250);
  const last = h.snapshots.at(-1);
  assert.equal(last.task.id, "new"); assert.equal(last.task.generation, 3); assert.ok(last.seq > first.seq); assert.equal(last.nonce, first.nonce);
  assert.equal(last.task.model, undefined); assert.equal(last.task.finishedAt, undefined); assert.doesNotMatch(JSON.stringify(last), /prior-slot-occupant/);
  assert.deepEqual(h.counts(), { tabs: 1, splits: 0 }); assert.equal(commands(h, "run").length, 1);
  await h.manager.stop();
});

test("late creation after disable rolls back safely without launching or adopting user panes", async () => {
  const creation = deferred(), h = harness({ creation }); h.manager.reconcile([task("t")], h.parent); await flush();
  h.disable(); await h.manager.stop(); h.panes.set("user", ref("user")); creation.resolve(); await flush();
  assert.equal(commands(h, "run").length, 0); assert.deepEqual(commands(h, "close").map(c => c.args[2]), ["p0"]); assert.equal(h.panes.has("user"), true);
  assert.equal(h.calls.some(c => c.args?.[0] === "tab" && c.args[1] === "close"), false);
});

test("held old publication cannot overwrite resumed generation", async () => {
  const write = deferred(), h = harness({ write }), t = task("same"); h.manager.reconcile([t], h.parent); await flush();
  t.processGeneration = 2; t.live.segments = [{ kind: "text", text: "resumed" }]; h.manager.reconcile([t], h.parent); write.resolve(); await h.time.advance(500);
  assert.equal(h.snapshots.some(s => s.task.generation === 1), false); assert.equal(h.snapshots.at(-1).task.generation, 2);
  await h.manager.stop();
});

test("moved viewer resolves original identity for reports/reuse/cleanup and never adopts destination tab", async () => {
  const h = harness(), t = task("t"); h.manager.reconcile([t], h.parent); await flush();
  h.moved.set("p0", "live"); h.panes.delete("p0"); h.panes.set("live", ref("live", "destination")); h.occupants.set("live", [{ pid: 100, name: "node" }]); h.panes.set("user", ref("user", "destination"));
  t.status = "paused"; h.manager.reconcile([t], h.parent); await h.time.advance(250); h.manager.reconcile([t, task("new")], h.parent); await h.time.advance(250); await h.manager.stop();
  assert.ok(commands(h, "current").filter(c => c.caller === "p0").length >= 3);
  assert.equal(commands(h, "report-agent").at(-1).args[2], "live"); assert.equal(commands(h, "release-agent").at(-1).args[2], "live");
  assert.equal(h.panes.has("user"), true); assert.equal(h.calls.some(c => c.args?.[0] === "tab" && c.args[1] === "close" && c.args[2] === "destination"), false);
});

for (const occupant of ["unknown", "foreign", "mismatched-identity"]) test(`${occupant} occupant forbids relaunch/release/destruction`, async () => {
  const h = harness(), t = task("t"); h.manager.reconcile([t], h.parent); await flush();
  if (occupant === "unknown") h.occupants.set("p0", []);
  if (occupant === "foreign") h.occupants.set("p0", [{ pid: 800, name: "editor" }]);
  if (occupant === "mismatched-identity") { h.identities.get(0).nonce = "wrong"; }
  t.status = "completed"; h.manager.reconcile([t, task("new")], h.parent); await h.time.advance(250); await h.manager.stop();
  assert.equal(commands(h, "run").length, 1); assert.equal(commands(h, "release-agent").length, 0); assert.equal(commands(h, "close").length, 0);
});

test("explicit missing suppresses manually closed attempt instead of recreating it", async () => {
  const h = harness(), t = task("t"); h.manager.reconcile([t], h.parent); await flush(); h.panes.delete("p0");
  await h.time.advance(2000); for (let i = 0; i < 8; i++) h.manager.reconcile([t], h.parent); await flush();
  assert.deepEqual(h.counts(), { tabs: 1, splits: 0 }); await h.manager.stop();
});

for (const shell of ["fish", "unknown"]) test(`does not guess ${shell} shell launch`, async () => {
  const h = harness({ shell }); h.manager.reconcile([task("t")], h.parent); await flush(); assert.equal(commands(h, "run").length, 0); assert.equal(commands(h, "close").length, 0); await h.manager.stop();
});

test("publication is throttled to four per second and retained output gets two-second heartbeats", async () => {
  const h = harness(), t = task("t"); h.manager.reconcile([t], h.parent); await flush();
  for (let i = 0; i < 20; i++) { t.live.pending = { kind: "text", text: String(i) }; h.manager.reconcile([t], h.parent); await h.time.advance(50); }
  const times = h.writes.map(s => s.heartbeatAt); for (const at of times) assert.ok(times.filter(t => t >= at && t < at + 1000).length <= 4);
  t.status = "completed"; h.manager.reconcile([t], h.parent); await h.time.advance(250); const count = h.writes.length; const last = h.writes.at(-1).heartbeatAt;
  await h.time.advance(4000); assert.equal(h.writes.length, count + 2); assert.equal(h.writes.at(-1).heartbeatAt, last + 4000);
  await h.manager.stop(); assert.equal(h.time.timers.size, 0);
});

test("held reuse publication must reinspect ownership before reporting the new task", async () => {
  const publicationGate = deferred(), h = harness({ holdPublication: 2, publicationGate }), t = task("old"); h.manager.reconcile([t], h.parent); await flush();
  t.status = "completed"; h.manager.reconcile([t, task("new")], h.parent); await h.time.advance(250);
  h.occupants.set("p0", [{ pid: 900, name: "editor" }]); const reports = commands(h, "report-agent").length;
  publicationGate.resolve(); await flush(); assert.equal(commands(h, "report-agent").length, reports); await h.manager.stop(); assert.equal(commands(h, "close").length, 0);
});

test("a failed old-generation write disables the physical slot even after reassignment", async () => {
  const publicationGate = deferred(), h = harness({ holdPublication: 2, publicationGate, failPublication: 2 }), t = task("same"); h.manager.reconcile([t], h.parent); await flush();
  t.live.pending = { kind: "text", text: "old update" }; h.manager.reconcile([t], h.parent); await h.time.advance(250);
  t.processGeneration = 2; h.manager.reconcile([t], h.parent); publicationGate.resolve(); await h.time.advance(2000);
  assert.equal(h.writes.length, 2); assert.equal(t.status, "running"); await h.manager.stop();
});

test("a new attempt after a manually closed right viewer may use a fresh empty physical slot", async () => {
  const h = harness(), a = task("a"), b = task("b"); h.manager.reconcile([a, b], h.parent); await flush(); h.panes.delete("p1"); await h.time.advance(2000);
  b.processGeneration = 2; h.manager.reconcile([a, b], h.parent); await h.time.advance(500);
  assert.equal(commands(h, "run").length, 3); assert.equal(h.snapshots.at(-1).task.generation, 2); assert.equal(h.snapshots.at(-1).slotId, 2); await h.manager.stop();
});

test("snapshot disk failure disables only the affected viewer and never retries blind creation", async () => {
  const h = harness({ diskFail: true }), t = task("t"); h.manager.reconcile([t], h.parent); await flush(); await h.time.advance(5000); h.manager.reconcile([t], h.parent); await flush();
  assert.equal(h.writes.length, 1); assert.equal(commands(h, "run").length, 0); assert.equal(t.status, "running"); assert.deepEqual(h.counts(), { tabs: 1, splits: 0 }); await h.manager.stop();
});

test("one slot's disk failure does not dispose the healthy viewer's transport or change either child", async () => {
  const h = harness({ failSlot: 1 }), a = task("a"), b = task("b"); h.manager.reconcile([a, b], h.parent); await flush(); await h.time.advance(4000);
  assert.ok(h.writes.filter(s => s.slotId === 0).length >= 3); assert.equal(h.writes.filter(s => s.slotId === 1).length, 1);
  assert.equal(a.status, "running"); assert.equal(b.status, "running"); assert.equal(commands(h, "run").length, 1); await h.manager.stop();
});

test("foreign work appearing during lifecycle release forbids the subsequent pane close", async () => {
  const options = {}, h = harness(options); h.manager.reconcile([task("a")], h.parent); await flush();
  options.onCommand = async args => { if (args[1] === "release-agent") h.occupants.set("p0", [{ pid: 900, name: "editor" }]); };
  await h.manager.stop(); assert.equal(commands(h, "release-agent").length, 1); assert.equal(commands(h, "close").length, 0);
});

test("missing Node creates no layout or private files", async () => {
  const h = harness({ noNode: true }); h.manager.reconcile([task("t")], h.parent); await flush(); assert.deepEqual(h.counts(), { tabs: 0, splits: 0 }); assert.equal(h.writes.length, 0); await h.manager.stop();
});

test("initial layout must not require a viewer identity before the helper has written one", async () => {
  const splitGate = deferred(), h = harness({ delayedIdentity: true, splitGate }); h.manager.reconcile([task("a"), task("b"), task("c"), task("d")], h.parent); await flush();
  splitGate.resolve(); await flush(); await h.time.advance(1000); assert.deepEqual(h.counts(), { tabs: 1, splits: 3 }); assert.equal(commands(h, "run").length, 4); await h.manager.stop();
});

test("real transport/helper handshake does not prevent four initial shell splits", async () => {
  const files = new Map(), viewers = [], frames = [];
  const transportFs = { mkdtemp: async () => "/private", chmod: async () => {},
    writeFile: async (file, raw) => { files.set(file, raw); },
    readFile: async file => { if (!files.has(file)) throw new Error("missing"); return files.get(file); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    rm: async (file, options) => { if (options?.recursive) files.clear(); else files.delete(file); },
  };
  const h = harness({ realStore: "/private", transportFs, viewers, frames });
  try {
    h.manager.reconcile([task("a"), task("b"), task("c"), task("d")], h.parent); await flush();
    await h.time.advance(1000);
    assert.deepEqual(h.counts(), { tabs: 1, splits: 3 }); assert.equal(commands(h, "run").length, 4);
    assert.equal(commands(h, "report-agent").length, 4); assert.ok(frames.some(frame => frame.includes("worker")));
    await h.manager.stop(); assert.equal(files.size, 0);
  } finally { await h.manager.stop(); await Promise.all(viewers.map(v => v.stop())); }
});

test("late split after stop is inspected and rolled back without launching it", async () => {
  const splitGate = deferred(), h = harness({ splitGate });
  h.manager.reconcile([task("a"), task("b")], h.parent); await flush(); await h.manager.stop(); splitGate.resolve(); await flush();
  assert.equal(commands(h, "run").some(c => c.args[2] === "p1"), false);
  assert.ok(commands(h, "close").some(c => c.args[2] === "p1"));
});

test("cleanup budget is total two seconds and queued destructive commands skip after expiry", async () => {
  const hold = deferred();
  const blocked = harness({ holdVerb: "process-info", hold }); blocked.manager.reconcile([task("t")], blocked.parent); await flush();
  let complete = false; const stopping = blocked.manager.stop().then(() => { complete = true; });
  await blocked.time.advance(1999); assert.equal(complete, false); await blocked.time.advance(1); assert.equal(complete, true);
  hold.resolve(); await stopping; await flush(); assert.equal(commands(blocked, "close").length, 0); assert.equal(commands(blocked, "run").length, 0); assert.equal(blocked.time.timers.size, 0);
});

test("handshake expires within two seconds with no leaked polling timer or blind retry", async () => {
  const h = harness({ store: { openSlot: async () => ({ snapshotPath: "/s", identityPath: "/i" }), publish: async () => {}, readIdentity: async () => undefined, dispose: async () => {} } });
  h.manager.reconcile([task("t")], h.parent); await flush(); await h.time.advance(2000); await h.time.advance(5000);
  assert.equal(commands(h, "run").length, 1); assert.equal(commands(h, "report-agent").length, 0); await h.manager.stop(); assert.equal(h.time.timers.size, 0);
});

test("stop cancels pending handshake timers synchronously", async () => {
  const h = harness({ store: { openSlot: async () => ({ snapshotPath: "/s", identityPath: "/i" }), publish: async () => {}, readIdentity: async () => undefined, dispose: async () => {} } });
  h.manager.reconcile([task("t")], h.parent); await flush(); await h.manager.stop(); assert.equal(h.time.timers.size, 0);
});

test("stale heartbeat forbids reporting and cleanup even with the matching PID", async () => {
  const h = harness({ stale: true }); h.manager.reconcile([task("t")], h.parent); await flush(); await h.time.advance(10000); const reports = commands(h, "report-agent").length;
  await h.time.advance(10000); assert.equal(commands(h, "report-agent").length, reports); await h.manager.stop(); assert.equal(commands(h, "release-agent").length, 0); assert.equal(commands(h, "close").length, 0);
});

test("layout never splits an owned viewer after it moves into a destination tab", async () => {
  const h = harness(); h.manager.reconcile([task("a")], h.parent); await flush();
  h.moved.set("p0", "moved"); h.panes.delete("p0"); h.panes.set("moved", ref("moved", "unowned")); h.occupants.set("moved", [{ pid: 100, name: "node" }]);
  h.manager.reconcile([task("a"), task("b")], h.parent); await flush(); assert.equal(commands(h, "split").length, 0); await h.manager.stop();
});

test("Node resolver prefers real parent Node and searches executable Node only for Bun/standalone", async () => {
  assert.equal(await resolveViewerNode(process.execPath, { PATH: "" }, process.platform), process.execPath);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "node-discovery-"));
  try { assert.equal(await resolveViewerNode("/missing/bun", { PATH: dir }, process.platform), undefined); await fs.symlink(process.execPath, path.join(dir, "node")); assert.equal(await resolveViewerNode("/missing/standalone", { PATH: dir }, process.platform), path.join(dir, "node")); } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
