import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "subagent-herdr-entry-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH"]) delete process.env[key];
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(agentDir, { recursive: true });
const settingsPath = path.join(agentDir, "settings.json");
const save = settings => writeFileSync(settingsPath, JSON.stringify(settings));
save({});

const codingAgent = await import("@earendil-works/pi-coding-agent");
codingAgent.initTheme();
const { default: extension } = await import("../index.ts");
const { jobs, clearRegistry, getJobsRoot, waitForJob } = await import("../runtime.ts");
const { spawnTask, shutdownTaskProcesses, resumeTaskSpawning } = await import("../process.ts");
const { createHerdrMonitor } = await import("../mux-monitor.ts");
const { createHerdrAdapter } = await import("../herdr-adapter.ts");
const { createViewerManager } = await import("../mux-viewers.ts");
const { readManifest, writeManifest } = await import("../store.ts");
const theme = { fg: (_color, text) => text, bold: text => text, dim: text => text };
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Hold one actual async GC/recovery operation beneath the entry hook, only in
// this test's private jobs root. A second startup may finish while this one waits.
function holdRecovery() {
  const root = getJobsRoot(), bucket = path.join(root, "held-empty-bucket");
  assert.ok(root.startsWith(agentDir + path.sep));
  mkdirSync(bucket, { recursive: true });
  const entered = deferred(), released = deferred(), original = fs.promises.rmdir;
  let holding = true;
  fs.promises.rmdir = async (target, ...args) => {
    if (holding && target === bucket) {
      holding = false;
      entered.resolve();
      await released.promise;
    }
    return original(target, ...args);
  };
  return { entered: entered.promise, release: released.resolve,
    restore() { released.resolve(); fs.promises.rmdir = original; } };
}
async function completeTask(fixture, code = 0) {
  fixture.close(code);
  assert.equal(await waitForJob(fixture.job.id), true);
}
async function toggleMonitoring(h) {
  let component;
  const dialog = h.command().handler("", {
    mode: "tui", hasUI: true, model: undefined, scopedModels: [], modelRegistry: { getAvailable: () => [] },
    ui: { notify() {}, custom: factory => new Promise(resolve => { component = factory({ requestRender() {} }, theme, {}, resolve); }) },
  });
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
  component.handleInput(" "); component.handleInput("\x1b");
  await dialog; await flush();
}
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.fail("expected lifecycle progress while cleanup was held");
}
function clock() {
  let now = 1000, id = 0;
  const timers = new Map();
  return {
    timers, wallNow: () => now, monotonicNow: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: key => timers.delete(key),
    setInterval(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms, ms }); return key; },
    clearInterval: key => timers.delete(key),
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        if (next[1].ms) next[1].at += next[1].ms; else timers.delete(next[0]);
        next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}
function harness(createMonitor) {
  const hooks = new Map(), messages = [];
  let command;
  const pi = {
    on: (event, callback) => hooks.set(event, callback), registerTool() {}, registerMessageRenderer() {},
    registerCommand: (_name, value) => { command = value; }, sendMessage: (...args) => messages.push(args),
  };
  if (createMonitor) extension(pi, { createMonitor }); else extension(pi);
  return {
    messages, command: () => command,
    start: (sessionId = "session-a", extra = {}) => hooks.get("session_start")({ reason: "resume" }, Object.defineProperties({
      cwd: home, hasUI: false, sessionManager: { getSessionId: () => sessionId },
    }, Object.getOwnPropertyDescriptors(extra))),
    shutdown: () => hooks.get("session_shutdown")(),
  };
}
async function childFixture(id, sessionId = "session-a", onKill) {
  const job = {
    id, parentSessionId: sessionId, mode: "single", status: "running", tasks: [], notifyOnComplete: true,
    notified: false, finished: false, chainRunnerDone: false, pendingSpawns: 0, persistenceReady: Promise.resolve(true),
  };
  jobs.set(id, job);
  await writeManifest(getJobsRoot(), sessionId, {
    version: 1, jobId: id, parentSessionId: sessionId, mode: "single", createdAt: Date.now(), updatedAt: Date.now(),
    notifyOnComplete: true, status: "running", tasks: [],
  });
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  const close = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit("close", code, signal); };
  child.kill = signal => { try { onKill?.(signal); } finally { queueMicrotask(() => close(143, signal)); } return true; };
  const task = await spawnTask({ name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] },
    "private work", home, id, { taskId: `${id}-task`, modelCtx: { catalog: [] }, spawnProcess: () => child });
  return { job, task, child, close };
}
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "parent", HERDR_SOCKET_PATH: "/fake-socket", HERDR_BIN_PATH: "fake-herdr" };
const envelope = value => JSON.stringify({ id: "test:cli", result: { type: "ok", ...value } });
const wire = (id, tab = "parent-tab") => ({ pane_id: id, tab_id: tab, workspace_id: "workspace" });
const argument = (args, flag) => args[args.indexOf(flag) + 1];
function composition({ holdFirstReport = false, viewers = false } = {}) {
  const time = clock(), calls = [], held = deferred(), identities = new Map(), snapshots = [], applied = [];
  let deps, factories = 0, adapters = 0, viewerCreated = false, viewerRunning = false, disposed = 0, nextLookup;
  const h = harness(received => {
    factories++; deps = received;
    const monitor = createHerdrMonitor({ ...received, env, clock: time,
      adapterFactory(context) {
        adapters++;
        return createHerdrAdapter(context, async (_binary, args, options) => {
          calls.push(args);
          if (holdFirstReport && args.includes("--token") && calls.filter(c => c.includes("--token")).length === 1) await held.promise;
          if (args[1] === "current") {
            if (nextLookup) { const gate = nextLookup; nextLookup = undefined; gate.entered.resolve(); await gate.held.promise; }
            return envelope({ pane: options.env.HERDR_PANE_ID === "parent" ? wire("parent") : wire("viewer", "viewer-tab") });
          }
          if (args[0] === "tab" && args[1] === "create") { viewerCreated = true; return envelope({ tab: { tab_id: "viewer-tab" }, root_pane: wire("viewer", "viewer-tab") }); }
          if (args[1] === "process-info") return envelope({ process_info: { pane_id: argument(args, "--pane"), shell_pid: 7,
            foreground_processes: [{ pid: viewerRunning ? 100 : 7, name: viewerRunning ? "node" : "bash" }] } });
          if (args[1] === "run") viewerRunning = true;
          if (args[0] === "pane" && args[1] === "close") viewerCreated = false;
          if (args[1] === "list") return envelope({ panes: viewerCreated ? [wire("viewer", "viewer-tab")] : [] });
          return envelope({});
        });
      },
      // Keep the real pool/ownership logic; replace only Node discovery and snapshot I/O.
      ...(viewers ? { viewerFactory: host => createViewerManager(host, {
        clock: time, resolveNode: async () => "/node", viewerScriptPath: "/viewer.mjs",
        storeFactory: () => ({
          async openSlot(identity) { identities.set(identity.slotId, { version: 1, ...identity, pid: 100, heartbeatAt: 1000 }); return { snapshotPath: "/private/snapshot", identityPath: "/private/identity" }; },
          async publish(_slot, snapshot, guard) { if (guard()) snapshots.push(snapshot); },
          async readIdentity(slot) { return { ...identities.get(slot), heartbeatAt: time.wallNow() }; },
          async dispose() { disposed++; },
        }),
      }) } : {}),
    });
    return { ...monitor, applyOptions(next) { applied.push({ ...next }); monitor.applyOptions(next); } };
  });
  return { ...h, calls, time, held, snapshots, applied,
    holdLookup() { const entered = deferred(), held = deferred(); nextLookup = { entered, held }; return { entered: entered.promise, release: held.resolve }; },
    get deps() { return deps; }, get factories() { return factories; },
    get adapters() { return adapters; }, get disposed() { return disposed; } };
}

test.beforeEach(() => { save({}); clearRegistry(); resumeTaskSpawning(); });
test.afterEach(async () => { await shutdownTaskProcesses(5, 100); clearRegistry(); });

// Break caught: eager activation, no non-TUI activation, or a supplier using all runtime tasks.
test("factory creates one idle controller; non-TUI start reads preferences and mutable session binding filters real tasks", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition();
  try {
    assert.equal(h.factories, 1, "construct the idle controller at extension factory time");
    assert.equal(h.calls.length, 0, "factory-time CLI commands");
    assert.equal(h.time.timers.size, 0, "factory-time monitoring timers");
    assert.equal(h.adapters, 0, "factory-time executable discovery/adapters");
    let guarded = false;
    await h.start("session-a", { get hasUI() { guarded = true; assert.equal(h.adapters, 1, "start precedes hasUI guard"); return false; } });
    assert.equal(guarded, true);
    const own = await childFixture("owned"), foreign = await childFixture("foreign", "session-b");
    assert.deepEqual(h.deps.getTasks(), [own.task]);
    await h.time.advance(0);
    assert.match(argument(h.calls.find(c => c.includes("--token")), "--token"), /^subagent_summary=running 1 · queued 0/);
    await h.start("session-b"); await flush();
    assert.deepEqual(h.deps.getTasks(), [foreign.task]);
    assert.equal(h.factories, 1, "reuse the controller across starts");
    assert.equal(h.adapters, 1, "same-context raw scheduler is shared");
  } finally { await h.shutdown(); }
});

// Break caught: rebuilding the monitor loses its raw scheduler and sequence across starts.
test("same-session restart serializes held old report, cleanup, and newer report with increasing sequences", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition({ holdFirstReport: true });
  try {
    await h.start(); await childFixture("ordered"); await h.time.advance(0);
    assert.equal(h.calls.filter(c => c.includes("--token")).length, 1, "old report issued");
    await h.start(); await flush();
    assert.equal(h.calls.filter(c => c.includes("--token")).length, 1, "new report waits for old same-pane command");
    h.held.resolve(); await flush();
    const patches = h.calls.filter(c => c[1] === "report-metadata");
    assert.deepEqual(patches.map(c => c.includes("--clear-token") ? "clear" : "report"), ["report", "clear", "report"]);
    assert.deepEqual(patches.map(c => argument(c, "--seq")), ["1000001", "1000002", "1000003"]);
    assert.equal(h.adapters, 1);
  } finally { h.held.resolve(); await h.shutdown(); }
});

// Break caught: rebinding the supplier before recovery publishes B counts under A's source.
test("held session recovery keeps pending A lookup and refresh on A counts until B activation commits", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition(); let recovery, lookup, starting;
  try {
    await h.start();
    await childFixture("recovery-a");
    const b = await childFixture("recovery-b", "session-b");
    await completeTask(b, 1);
    await h.time.advance(0);
    lookup = h.holdLookup();
    await h.time.advance(5000); await lookup.entered;
    recovery = holdRecovery();
    starting = h.start("session-b"); await recovery.entered;
    const before = h.calls.length;
    lookup.release(); await flush();
    await h.time.advance(5000);
    const reports = h.calls.slice(before).filter(c => c.includes("--token"));
    assert.equal(reports.length, 2, "pending A lookup and subsequent A refresh both publish");
    assert.deepEqual(reports.map(c => [argument(c, "--source"), argument(c, "--token")]), [
      ["pi-subagent:session-a", "subagent_summary=running 1 · queued 0 · paused 0 · completed 0 · unsuccessful 0"],
      ["pi-subagent:session-a", "subagent_summary=running 1 · queued 0 · paused 0 · completed 0 · unsuccessful 0"],
    ]);
    recovery.release(); await starting; await flush();
    const latest = h.calls.filter(c => c.includes("--token")).at(-1);
    assert.equal(argument(latest, "--source"), "pi-subagent:session-b");
    assert.equal(argument(latest, "--token"), "subagent_summary=running 0 · queued 0 · paused 0 · completed 0 · unsuccessful 1");
    assert.equal(h.factories, 1); assert.equal(h.adapters, 1);
  } finally { lookup?.release(); recovery?.restore(); await starting; await h.shutdown(); }
});

// Break caught: an older held startup reactivates monitoring after a newer startup commits.
test("superseded held startup cannot replace the newer optional monitor binding", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition(); let recovery, starting;
  try {
    await h.start(); await childFixture("supersede-a");
    const c = await childFixture("supersede-c", "session-c"); await completeTask(c, 1);
    await h.time.advance(0);
    recovery = holdRecovery(); starting = h.start("session-b"); await recovery.entered;
    await h.start("session-c"); await flush();
    const before = h.calls.length, timers = h.time.timers.size;
    recovery.release(); await starting; await flush();
    assert.equal(h.calls.length, before, "stale startup creates no commands or cleanup");
    assert.equal(h.time.timers.size, timers, "stale startup creates no monitoring timers");
    await h.time.advance(5000);
    const latest = h.calls.filter(c => c.includes("--token")).at(-1);
    assert.equal(argument(latest, "--source"), "pi-subagent:session-c");
    assert.equal(argument(latest, "--token"), "subagent_summary=running 0 · queued 0 · paused 0 · completed 0 · unsuccessful 1");
    assert.equal(h.adapters, 1); assert.equal(h.factories, 1);
  } finally { recovery?.restore(); await starting; await h.shutdown(); }
});

// Break caught: a held startup can start new resources after shutdown has stopped the controller.
test("shutdown invalidates held startup without skipping its native UI wiring", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition(); let recovery, starting, input;
  try {
    await h.start(); const a = await childFixture("held-shutdown-a"); await h.time.advance(0);
    recovery = holdRecovery();
    starting = h.start("session-b", { hasUI: true, ui: { onTerminalInput(fn) { input = fn; }, setWidget() {} } });
    await recovery.entered; await h.shutdown(); await flush();
    assert.equal(a.child.signalCode, "SIGTERM"); assert.equal(a.task.status, "interrupted");
    assert.equal(h.time.timers.size, 0);
    const before = h.calls.length;
    recovery.release(); await starting; await flush();
    assert.equal(typeof input, "function", "generation guard does not suppress native UI startup");
    assert.equal(h.calls.length, before, "late startup creates no new CLI resources");
    assert.equal(h.time.timers.size, 0, "late startup creates no new timers");
  } finally { recovery?.restore(); await starting; await h.shutdown(); }
});

// Break caught: real monitor.stop retains toggle binding, so a late saved preference can reactivate it.
test("late saved option changes during held recovery cannot reactivate a shutdown controller", async () => {
  save({ subagent: { herdr: { enabled: true, viewers: false } } });
  const h = composition(); let recovery, starting;
  try {
    await h.start(); await childFixture("late-options-a"); await h.time.advance(0);
    recovery = holdRecovery(); starting = h.start("session-b"); await recovery.entered;
    await h.shutdown(); await flush();
    const before = h.calls.length;
    await toggleMonitoring(h); await toggleMonitoring(h);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagent.herdr, { enabled: true, viewers: false });
    assert.equal(h.calls.length, before, "saved preferences must not allocate commands while unbound");
    assert.equal(h.time.timers.size, 0, "saved preferences must not allocate timers while unbound");
    assert.equal(h.applied.length, 0, "entry does not pass late changes to retained monitor binding");
    recovery.release(); await starting; await flush();
    assert.equal(h.calls.length, before); assert.equal(h.time.timers.size, 0);
  } finally { recovery?.restore(); await starting; await h.shutdown(); }
});

// Break caught: entry factory/default path creates resources outside the environment gate.
test("production default-on outside Herdr creates no CLI calls, viewer files, or integration/cleanup timers", async () => {
  const bin = path.join(home, "bin"), log = path.join(home, "unexpected-cli");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "herdr"), `#!/bin/sh\nprintf invoked >> '${log}'\nexit 1\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const directories = () => readdirSync(os.tmpdir()).filter(n => n.startsWith("pi-herdr-viewer-"));
  const before = directories(), timers = [];
  const oldTimeout = globalThis.setTimeout, oldInterval = globalThis.setInterval;
  globalThis.setTimeout = (...args) => { timers.push(args[1]); return oldTimeout(...args); };
  globalThis.setInterval = (...args) => { timers.push(args[1]); return oldInterval(...args); };
  try {
    const h = harness();
    assert.equal(timers.length, 0, "no factory timers");
    await h.start(); await h.shutdown(); await h.shutdown();
    assert.equal(timers.length, 0, "no integration timer including a final guard for undefined stop");
    assert.equal(existsSync(log), false);
    assert.deepEqual(directories(), before);
  } finally { globalThis.setTimeout = oldTimeout; globalThis.setInterval = oldInterval; process.env.PATH = previousPath; }
});

// Break caught: awaiting stop before the durable/child sweep, or clearing registry instead of reaping owned children.
test("shutdown durably interrupts and reaps a spawnTask fake child while monitor cleanup is held", async () => {
  const held = deferred(); let stopping = false, stoppingAtKill = false, settled = false, durableAtKill;
  const h = harness(() => ({ start() {}, applyOptions() {}, stop() { stopping = true; return held.promise; } }));
  await h.start();
  const f = await childFixture("shutdown-owned", "session-a", () => {
    durableAtKill = readManifest(getJobsRoot(), "session-a", "shutdown-owned").tasks[0].status;
    stoppingAtKill = stopping;
  });
  const running = h.shutdown().then(() => { settled = true; });
  try {
    await until(() => f.child.exitCode !== null);
    assert.equal(stoppingAtKill, true, "stop began before child reaping");
    assert.equal(durableAtKill, "interrupted", "manifest-first child reaping");
    assert.equal(f.task.status, "interrupted");
    assert.equal(f.child.signalCode, "SIGTERM", "actual spawnTask-owned child was reaped");
    assert.equal(settled, false, "cleanup still pending after child exit");
  } finally { held.resolve(); await running; }
});

// Break caught: no independent final timeout for a defective hanging stop.
test("a defective pending stop is bounded at the end of shutdown", async () => {
  const h = harness(() => ({ start() {}, applyOptions() {}, stop: () => new Promise(() => {}) }));
  await h.start();
  const started = performance.now();
  await h.shutdown();
  assert.ok(performance.now() - started >= 1900, "returned promise is awaited with independent guard");
  assert.ok(performance.now() - started < 2600, "defective cleanup cannot hang shutdown");
});

// Break caught: delayed rejection handling or unsafe repeated shutdown.
test("rejected stop is handled immediately and repeated shutdown still reaps children", async () => {
  let stops = 0;
  const h = harness(() => ({ start() {}, applyOptions() {}, stop() { stops++; return Promise.reject(new Error("cleanup rejected")); } }));
  let diagnostic = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => { diagnostic += String(chunk); return true; };
  try {
    await h.start();
    const f = await childFixture("reject-owned");
    await h.shutdown(); await h.shutdown();
    assert.equal(stops, 2, "repeated shutdown remains safe");
    assert.equal(f.child.signalCode, "SIGTERM");
    assert.equal(f.task.status, "interrupted");
    assert.match(diagnostic, /cleanup failed/);
  } finally { process.stderr.write = originalWrite; }
});

// Break caught: losing a controller whose start partially throws leaks its resources and skips native UI wiring.
test("partially throwing start is promptly stopped, sanitized, and retains native startup and later cleanup", async () => {
  const time = clock(); let stops = 0, input, resource;
  const h = harness(() => ({
    start() { resource = time.setInterval(() => {}, 100); throw new Error("\x1b]0;hostile\x07\x1b[31mfailed\n" + "x".repeat(200)); },
    applyOptions() {}, stop() { stops++; time.clearInterval(resource); return Promise.reject(new Error("stop failed")); },
  }));
  let diagnostic = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => { diagnostic += String(chunk); return true; };
  try {
    await h.start("session-a", { hasUI: true, ui: { onTerminalInput(fn) { input = fn; }, setWidget() {} } });
    await flush();
    assert.equal(stops, 1, "cleanup attempted immediately after start throws");
    assert.equal(time.timers.size, 0);
    assert.equal(typeof input, "function", "native terminal watch wiring survives start failure");
    assert.ok(diagnostic.length > 0 && diagnostic.length <= 161, "bounded diagnostics");
    for (const line of diagnostic.trimEnd().split("\n")) {
      assert.ok(line.length <= 80);
      assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]|hostile/);
    }
    await h.shutdown(); await h.shutdown();
    assert.equal(stops, 3, "retained failed candidate remains safe on later shutdown");
  } finally { process.stderr.write = originalWrite; }
});

// Break caught: command callback not forwarded to the bound controller, or viewers off disables metadata/children.
test("entry settings callback closes real viewer pool while central monitoring and spawned child remain active", async () => {
  const h = composition({ viewers: true });
  try {
    await h.start();
    assert.equal(typeof h.deps?.viewerFactory, "function", "entry supplies production viewer factory");
    const f = await childFixture("viewer-owned"); await h.time.advance(0);
    assert.equal(h.calls.filter(c => c[1] === "run").length, 1, "real pool launched through fake external CLI");
    assert.equal(h.snapshots[0].task.id, f.task.id);
    let component;
    const dialog = h.command().handler("", {
      mode: "tui", hasUI: true, model: undefined, scopedModels: [], modelRegistry: { getAvailable: () => [] },
      ui: { notify() {}, custom: factory => new Promise(resolve => { component = factory({ requestRender() {} }, theme, {}, resolve); }) },
    });
    for (let i = 0; i < 5; i++) component.handleInput("\x1b[B"); // viewers, not monitoring
    component.handleInput(" "); component.handleInput("\x1b"); await dialog; await flush();
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(saved.subagent.herdr, { enabled: true, viewers: false });
    assert.deepEqual(h.applied, [{ enabled: true, viewers: false }], "entry applies the successfully saved options exactly once");
    assert.equal(h.calls.filter(c => c[0] === "pane" && c[1] === "close").length, 1, "viewer cleanup reached owned pane");
    assert.equal(h.disposed, 1, "viewer transport disposed");
    assert.equal(f.task.status, "running"); assert.equal(f.child.exitCode, null);
    const reports = h.calls.filter(c => c.includes("--token")).length;
    await h.time.advance(5000);
    assert.ok(h.calls.filter(c => c.includes("--token")).length > reports, "monitor refresh remains active");
    assert.equal(h.calls.some(c => ["report-agent", "report-agent-session", "release-agent"].includes(c[1]) && c[2] === "parent"), false);
    f.close(); assert.equal(await waitForJob(f.job.id), true);
    assert.ok(h.messages.some(([m, delivery]) => m.customType === "subagent-batch-finished" && delivery.triggerTurn === true), "native Pi completion sender survives composition");
  } finally { await h.shutdown(); }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
