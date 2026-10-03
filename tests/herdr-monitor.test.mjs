import test from "node:test";
import assert from "node:assert/strict";
import { createHerdrMonitor } from "../herdr-monitor.ts";
import { createHerdrAdapter } from "../herdr-adapter.ts";
import { checkJobComplete, emptyUsage, setMessageSender, subscribeRuntimeObservations } from "../runtime.ts";
import { emptyLiveTrace } from "../live.ts";

const enabled = { enabled: true, viewers: true };
const metadataOnly = { enabled: true, viewers: false };
const disabled = { enabled: false, viewers: false };
const env = { HERDR_ENV: "1", HERDR_PANE_ID: "original", HERDR_SOCKET_PATH: "/socket", HERDR_BIN_PATH: "/herdr" };
const ok = (value = {}) => JSON.stringify({ id: "cli:test", result: { type: "ok", ...value } });
const pane = id => ok({ pane: { pane_id: id, tab_id: "tab", workspace_id: "workspace" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Flush promise-only external ports, without wall-clock sleeps or real timers.
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function fakeClock() {
  let now = 1_000_000, next = 0;
  const timers = new Map();
  const clock = {
    wallNow: () => now, monotonicNow: () => now,
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: now + ms, interval: ms }); return id; },
    clearInterval: id => timers.delete(id),
  };
  return { ...clock, timers, advance(ms) {
    const end = now + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry; now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn();
    }
    now = end;
  } };
}
function task(id, overrides = {}) {
  return { id, jobId: "job", agent: "worker", agentSource: "test", task: "private task text", cwd: "/cwd", status: "running", startedAt: 1, exitCode: 0, messages: [], live: emptyLiveTrace(), stderr: "", usage: emptyUsage(), ...overrides };
}
function harness(overrides = {}) {
  const clock = fakeClock(), calls = [], warnings = [], hosts = [], reconciles = [], listeners = new Set();
  let tasks = overrides.tasks ?? [], currentParent = "parent", factoryCalls = 0, adapterCalls = 0, viewerStops = 0;
  const exec = async (binary, args, options) => {
    const call = { binary, args, options }; calls.push(call);
    if (overrides.exec) return overrides.exec(call);
    return args[1] === "current" ? pane(currentParent) : ok();
  };
  const deps = {
    env: overrides.env ?? env, clock, getTasks: () => tasks,
    subscribe: overrides.subscribe ?? (listener => { listeners.add(listener); return () => listeners.delete(listener); }),
    adapterFactory: context => { adapterCalls++; return overrides.adapterFactory ? overrides.adapterFactory(context) : createHerdrAdapter(context, exec); },
    warn: message => warnings.push(message),
    viewerFactory: host => {
      factoryCalls++; hosts.push(host);
      if (overrides.viewerFactory) return overrides.viewerFactory(host);
      return { reconcile: (tasks, parent) => reconciles.push({ tasks: [...tasks], parent }), stop: async () => { viewerStops++; } };
    },
  };
  if (overrides.noViewerFactory) delete deps.viewerFactory;
  const monitor = createHerdrMonitor(deps);
  return {
    monitor, clock, calls, warnings, hosts, reconciles, listeners,
    get factoryCalls() { return factoryCalls; }, get adapterCalls() { return adapterCalls; }, get viewerStops() { return viewerStops; },
    get metadata() { return calls.filter(c => c.args[1] === "report-metadata"); },
    get reports() { return this.metadata.filter(c => c.args.includes("--token")); },
    get notifications() { return calls.filter(c => c.args[0] === "notification"); },
    emit: event => { for (const listener of listeners) listener(event); },
    setTasks: next => { tasks = next; }, moveParent: id => { currentParent = id; },
  };
}
const arg = (call, flag) => call.args[call.args.indexOf(flag) + 1];
const finished = (id, notifyOnComplete = true) => ({ type: "job-finished", completion: { id, mode: "parallel", status: "completed", total: 3, unsuccessful: 1, notifyOnComplete } });
async function stop(h) { await h.monitor.stop(); assert.equal(h.clock.timers.size, 0); }

test("environment and enabled gates prevent even factories, subscriptions and stop timers", async () => {
  for (const gate of [{}, { ...env, HERDR_ENV: "0" }, { ...env, HERDR_PANE_ID: " " }, { ...env, HERDR_SOCKET_PATH: "" }]) {
    const h = harness({ env: gate, tasks: [task("t")] }); h.monitor.start("session", "/cwd", enabled);
    assert.equal(h.monitor.stop(), undefined); await flush();
    assert.equal(h.calls.length, 0); assert.equal(h.adapterCalls, 0); assert.equal(h.factoryCalls, 0);
    assert.equal(h.listeners.size, 0); assert.equal(h.clock.timers.size, 0);
  }
  const h = harness(); h.monitor.start("session", "/cwd", disabled);
  assert.equal(h.monitor.stop(), undefined); assert.equal(h.adapterCalls, 0); assert.equal(h.clock.timers.size, 0);
});

test("metadata-only monitoring counts dispatch queues, expires in fifteen seconds and refreshes at five", async () => {
  const h = harness({ tasks: [task("run"), task("queue", { dispatchState: "queued" }), task("setup", { setupPending: true }), task("pause", { status: "paused" }), task("done", { status: "completed" }), task("bad", { status: "failed" })] });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  assert.equal(h.factoryCalls, 0); assert.equal(h.reports.length, 1);
  assert.equal(arg(h.reports[0], "--ttl-ms"), "15000");
  assert.equal(arg(h.reports[0], "--token"), "subagent_summary=running 1 · queued 2 · paused 1 · completed 1 · unsuccessful 1");
  assert.equal(arg(h.reports[0], "--source"), "pi-subagent:session");
  assert.equal(h.calls.some(c => ["report-agent", "report-agent-session", "release-agent"].includes(c.args[1])), false);
  h.clock.advance(4999); await flush(); assert.equal(h.reports.length, 1);
  h.clock.advance(1); await flush(); assert.equal(h.reports.length, 2);
  assert.ok(BigInt(arg(h.reports[1], "--seq")) > BigInt(arg(h.reports[0], "--seq")));
  await stop(h); assert.equal(arg(h.metadata.at(-1), "--clear-token"), "subagent_summary");
});

test("empty registries have no presentation or refresh and removing all tasks clears own token", async () => {
  const h = harness(); h.monitor.start("session", "/cwd", enabled); await flush();
  assert.equal(h.metadata.length, 0); assert.equal(h.factoryCalls, 0); assert.equal(h.clock.timers.size, 0);
  h.setTasks([task("t")]); h.emit({ type: "status" }); h.clock.advance(0); await flush();
  assert.equal(h.reports.length, 1); assert.equal(h.factoryCalls, 1);
  h.setTasks([]); h.emit({ type: "status" }); h.clock.advance(0); await flush();
  assert.equal(arg(h.metadata.at(-1), "--clear-token"), "subagent_summary");
  assert.equal(h.clock.timers.size, 0); await stop(h);
});

test("trace bursts never generate central reports and status bursts coalesce latest state", async () => {
  const h = harness({ tasks: [task("t")] }); h.monitor.start("session", "/cwd", metadataOnly); await flush();
  for (let i = 0; i < 500; i++) h.emit({ type: "trace", taskId: "t", generation: 0 });
  h.clock.advance(0); await flush(); assert.equal(h.reports.length, 1);
  for (let i = 0; i < 500; i++) h.emit({ type: "status" });
  h.setTasks([task("t", { status: "completed" })]); h.clock.advance(0); await flush();
  assert.equal(h.reports.length, 2); assert.match(arg(h.reports[1], "--token"), /running 0 .*completed 1/);
  await stop(h);
});

test("refresh follows moved caller identity and clears old decoration without viewer lifecycle on parent", async () => {
  const h = harness({ tasks: [task("t")] }); h.monitor.start("session", "/cwd", enabled); await flush();
  assert.equal(h.hosts[0].parent.paneId, "parent");
  h.moveParent("moved"); h.clock.advance(5000); await flush();
  assert.equal(h.reports.at(-1).args[2], "moved");
  assert.ok(h.metadata.some(c => c.args[2] === "parent" && c.args.includes("--clear-token")));
  assert.equal(h.reconciles.at(-1).parent.paneId, "moved");
  assert.ok(h.calls.filter(c => c.args[1] === "current").every(c => c.options.env.HERDR_PANE_ID === "original"));
  await stop(h);
});

test("viewer creation failure warns once but metadata continues and factory is not retried", async () => {
  const h = harness({ tasks: [task("t")], viewerFactory: () => { throw new Error("viewer failed"); } });
  h.monitor.start("session", "/cwd", enabled); await flush();
  for (let i = 0; i < 3; i++) { h.clock.advance(5000); await flush(); }
  assert.equal(h.factoryCalls, 1); assert.equal(h.warnings.length, 1); assert.equal(h.reports.length, 4);
  await stop(h);
});

test("missing or malformed startup query fails once without refresh or status-triggered retry", async () => {
  const missing = Object.assign(new Error("exit 1"), { stderr: JSON.stringify({ id: "cli:test", error: { code: "pane_not_found", message: "gone" } }) });
  for (const response of ["not json", ok({ pane: { pane_id: "p" } }), new Error("offline"), missing]) {
    const h = harness({ tasks: [task("t")], exec: async () => { if (response instanceof Error) throw response; return response; } });
    h.monitor.start("session", "/cwd", enabled); await flush();
    h.emit({ type: "status" }); h.clock.advance(60_000); await flush();
    assert.equal(h.calls.length, 1); assert.equal(h.warnings.length, 1); assert.equal(h.factoryCalls, 0); assert.equal(h.clock.timers.size, 0);
    await stop(h);
  }
});

test("CLI error warnings cannot relay terminal escapes, controls or unbounded display text", async () => {
  const h = harness({ exec: async () => { throw new Error("\x1b]0;hostile title\x07\x1b[31moffline\x1b[0m\n\x00" + "x".repeat(1000)); } });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings[0], /[\x00-\x1f\x7f-\x9f]|hostile title/);
  assert.ok(h.warnings[0].length <= 80); await stop(h);
});

test("completions during held startup query are captured once, while silent jobs are suppressed", async () => {
  const query = deferred();
  const h = harness({ tasks: [task("t")], exec: async c => c.args[1] === "current" ? query.promise : ok() });
  h.monitor.start("session", "/cwd", metadataOnly);
  assert.equal(h.listeners.size, 1);
  h.emit(finished("job")); h.emit(finished("job")); h.emit(finished("silent", false)); await flush();
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.notifications[0].args, ["notification", "show", "Subagent batch completed · job", "--body", "3 tasks · 1 unsuccessful"]);
  query.resolve(pane("parent")); await flush(); await stop(h);
});

test("failed Herdr notifications never block authoritative Pi completion delivery", async () => {
  let delivered = 0;
  const h = harness({ subscribe: subscribeRuntimeObservations, exec: async c => {
    if (c.args[0] === "notification") throw new Error("offline");
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  setMessageSender(() => { delivered++; });
  try {
    h.monitor.start("session", "/cwd", metadataOnly); await flush();
    const job = { id: "pi-job", mode: "single", status: "running", tasks: [task("t", { status: "completed" })], notifyOnComplete: true, notified: false, finished: false, chainRunnerDone: false, pendingSpawns: 0 };
    checkJobComplete(job); checkJobComplete(job); await flush();
    assert.equal(delivered, 1); assert.equal(h.notifications.length, 1); assert.equal(h.warnings.length, 1);
  } finally { await stop(h); setMessageSender(() => {}); }
});

test("refresh failure cannot leave a timer alive after the last task is removed", async () => {
  let offline = false;
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (offline && c.args[1] === "current") throw new Error("offline");
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  offline = true; h.setTasks([]); h.clock.advance(5000); await flush();
  assert.equal(h.clock.timers.size, 0); assert.equal(h.warnings.length, 1);
  h.clock.advance(60_000); await flush(); assert.equal(h.calls.filter(c => c.args[1] === "current").length, 2);
  await stop(h);
});

test("tasks removed during an issued metadata report cannot create an empty viewer", async () => {
  const heldReport = deferred();
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (c.args.includes("--token")) return heldReport.promise;
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", enabled); await flush();
  h.setTasks([]); h.emit({ type: "status" }); heldReport.resolve(ok()); await flush();
  assert.equal(h.factoryCalls, 0);
  h.clock.advance(0); await flush(); assert.equal(arg(h.metadata.at(-1), "--clear-token"), "subagent_summary");
  await stop(h);
});

test("adapter factory failure is display-only and never starts timers or subscriptions", async () => {
  const h = harness({ tasks: [task("t")], adapterFactory: () => { throw new Error("unavailable adapter"); } });
  assert.doesNotThrow(() => h.monitor.start("session", "/cwd", enabled));
  assert.equal(h.warnings.length, 1); assert.equal(h.clock.timers.size, 0); assert.equal(h.listeners.size, 0);
  assert.equal(h.monitor.stop(), undefined);
});

test("disable invalidates a held lookup synchronously and fresh enable attaches existing tasks without history", async () => {
  const query = deferred(); let queryCount = 0;
  const h = harness({ tasks: [task("existing")], exec: async c => c.args[1] === "current" ? (++queryCount === 1 ? query.promise : pane("parent")) : ok() });
  h.monitor.start("session", "/cwd", enabled); await flush();
  h.monitor.applyOptions(disabled); assert.equal(h.listeners.size, 0);
  h.emit(finished("old")); h.monitor.applyOptions(enabled); await flush();
  assert.equal(h.adapterCalls, 1); assert.equal(h.reports.length, 1); assert.equal(h.reconciles[0].tasks[0].id, "existing");
  query.resolve(pane("late")); await flush();
  assert.equal(h.calls.some(c => c.args[2] === "late"), false); assert.equal(h.factoryCalls, 1); assert.equal(h.notifications.length, 0);
  await stop(h);
});

test("off/on keeps source and report ordering but replaces viewer activation and scope", async () => {
  const h = harness({ tasks: [task("t")] }); h.monitor.start("s".repeat(100), "/cwd", enabled); await flush();
  const firstHost = h.hosts[0]; h.monitor.applyOptions(disabled); h.monitor.applyOptions(enabled); await flush();
  assert.equal(h.adapterCalls, 1); assert.equal(firstHost.isCurrent(), false);
  assert.notEqual(h.hosts[1].activationId, firstHost.activationId); assert.equal(h.hosts[1].adapter, firstHost.adapter);
  assert.equal(h.viewerStops, 1);
  const sources = h.metadata.map(c => arg(c, "--source")); assert.ok(sources.every(s => s === sources[0] && s.length <= 80));
  const seqs = h.metadata.map(c => BigInt(arg(c, "--seq"))); assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  assert.ok(h.metadata[1].args.includes("--clear-token")); assert.ok(h.metadata[2].args.includes("--token"));
  assert.equal((await firstHost.adapter.scoped(firstHost.isCurrent).notify("stale", "no")).ok, false);
  await stop(h);
});

test("held old metadata, raw cleanup and fresh metadata remain ordered across off/on", async () => {
  const oldReport = deferred(); let held = true;
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (held && c.args.includes("--token")) return oldReport.promise;
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", enabled); await flush();
  assert.equal(h.factoryCalls, 0); assert.equal(h.reports.length, 1);
  h.monitor.applyOptions(disabled); h.monitor.applyOptions(enabled); await flush();
  assert.equal(h.reports.length, 1); assert.equal(h.adapterCalls, 1);
  held = false; oldReport.resolve(ok()); await flush();
  assert.deepEqual(h.metadata.map(c => c.args.includes("--clear-token") ? "clear" : "report"), ["report", "clear", "report"]);
  const seqs = h.metadata.map(c => BigInt(arg(c, "--seq"))); assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2]);
  assert.equal(h.factoryCalls, 1); await stop(h);
});

test("cleanup still queued at its deadline is skipped rather than clearing a newer activation", async () => {
  const oldReport = deferred(); let held = true;
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (held && c.args.includes("--token")) return oldReport.promise;
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  const cleanup = h.monitor.stop(); h.monitor.start("session", "/cwd", metadataOnly); await flush();
  h.clock.advance(2000); await cleanup;
  held = false; oldReport.resolve(ok()); await flush();
  assert.equal(h.metadata.some(c => c.args.includes("--clear-token")), false); assert.equal(h.reports.length, 2);
  assert.ok(BigInt(arg(h.reports[1], "--seq")) > BigInt(arg(h.reports[0], "--seq")));
  await stop(h);
});

test("repeated metadata and notification failures share one warning per activation", async () => {
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (c.args[1] === "current") return pane("parent");
    throw new Error("offline");
  } });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  for (let i = 0; i < 4; i++) { h.emit(finished(`failed-${i}`)); h.clock.advance(5000); await flush(); }
  assert.equal(h.warnings.length, 1); assert.equal(h.notifications.length, 4); assert.equal(h.reports.length, 5);
  h.monitor.applyOptions(disabled); h.monitor.applyOptions(metadataOnly); await flush();
  assert.equal(h.warnings.length, 2); await stop(h);
});

test("completion overflow is dropped with no deferred replay after the shared queue drains", async () => {
  const gate = deferred(); let active = 0, peak = 0;
  const h = harness({ exec: async c => {
    if (c.args[0] === "notification") { active++; peak = Math.max(peak, active); await gate.promise; active--; }
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", metadataOnly); await flush();
  for (let i = 0; i < 1000; i++) h.emit(finished(`burst-${i}`)); await flush();
  assert.equal(h.notifications.length, 4); assert.equal(h.warnings.length, 1);
  gate.resolve(); await flush();
  assert.equal(h.notifications.length, 36); assert.equal(peak, 4);
  // Four issued plus thirty-two waiting; overflow has no monitor-owned queue.
  assert.equal(h.notifications.length - peak, 32);
  h.clock.advance(60_000); await flush(); assert.equal(h.notifications.length, 36);
  h.emit(finished("burst-0")); await flush(); assert.equal(h.notifications.length, 36);
  await stop(h);
});

test("deduplication covers every eligible completion for the activation without a lifetime cutoff", async () => {
  const h = harness(); h.monitor.start("session", "/cwd", metadataOnly); await flush();
  // Drain each command so this exercises lifetime deduplication, not scheduler overflow.
  for (let i = 0; i < 300; i++) { h.emit(finished(`job-${i}`)); await flush(); }
  assert.equal(h.notifications.length, 300);
  assert.equal(arg(h.notifications[0], "--body"), "3 tasks · 1 unsuccessful");
  assert.match(h.notifications[0].args[2], /job-0$/);
  h.emit(finished("job-0")); h.emit(finished("job-299")); h.emit(finished("new-after-300")); await flush();
  assert.equal(h.notifications.length, 301);
  assert.match(h.notifications[300].args[2], /new-after-300$/);
  await stop(h);
});

test("notification display IDs are bounded and stripped of terminal controls", async () => {
  const h = harness(); h.monitor.start("session", "/cwd", metadataOnly); await flush();
  h.emit(finished("bad\x1b]0;title\x07\x1b[31m-id\x1b[0m"));
  h.emit(finished("x".repeat(200))); await flush();
  assert.equal(h.notifications.length, 2);
  for (const call of h.notifications) {
    assert.ok(call.args[2].length <= 80);
    assert.ok(call.args[4].length <= 80);
    assert.doesNotMatch(`${call.args[2]}${call.args[4]}`, /[\x00-\x1f\x7f-\x9f]/);
  }
  assert.match(h.notifications[0].args[2], /bad-id$/);
  assert.equal(h.notifications[1].args[2].length, 75);
  await stop(h);
});

test("no viewer factory port is required and viewer-only toggles keep central reporting active", async () => {
  const h = harness({ tasks: [task("t")], noViewerFactory: true });
  h.monitor.start("session", "/cwd", enabled); await flush(); assert.equal(h.reports.length, 1);
  h.monitor.applyOptions(metadataOnly); await flush();
  assert.equal(h.reports.length, 2); assert.equal(h.listeners.size, 1); assert.equal(h.adapterCalls, 1); assert.equal(h.factoryCalls, 0);
  await stop(h);
});

test("notification bursts and rapid toggles share four active/32 pending bounds and drop overflow", async () => {
  const gate = deferred(); let active = 0, peak = 0, admitted = 0;
  const h = harness({ tasks: [task("t")], exec: async c => {
    if (c.args[0] === "notification") { active++; peak = Math.max(peak, active); admitted++; await gate.promise; active--; }
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", enabled); await flush();
  for (let i = 0; i < 1000; i++) h.emit(finished(`burst-${i}`)); await flush();
  assert.equal(peak, 4); assert.equal(h.warnings.length, 1);
  for (let i = 0; i < 10; i++) { h.monitor.applyOptions(disabled); h.monitor.applyOptions(enabled); }
  for (let i = 0; i < 100; i++) {
    const event = finished(`new-${i}`); event.completion.total = 9; h.emit(event);
  }
  await flush(); assert.equal(h.adapterCalls, 1); assert.ok(peak <= 4);
  gate.resolve(); await flush();
  // Disabled scopes lose their queued notifications, rather than replaying after capacity frees.
  assert.ok(admitted <= 36); assert.ok(h.notifications.length <= 36); assert.ok(peak <= 4);
  assert.equal(h.notifications.filter(c => arg(c, "--body") === "3 tasks · 1 unsuccessful").length, 4);
  await stop(h);
});

test("stop synchronously fences pending work and cleanup has one overall two-second deadline", async () => {
  const never = deferred(); let held = false;
  const h = harness({ tasks: [task("t")], viewerFactory: () => ({ reconcile() {}, stop: () => never.promise }), exec: async c => {
    if (held) return never.promise;
    return c.args[1] === "current" ? pane("parent") : ok();
  } });
  h.monitor.start("session", "/cwd", enabled); await flush(); held = true;
  const cleanup = h.monitor.stop(); assert.ok(cleanup instanceof Promise);
  assert.equal(h.listeners.size, 0); assert.equal(h.hosts[0].isCurrent(), false);
  assert.equal(h.clock.timers.size, 1); assert.equal(h.monitor.stop(), undefined);
  h.emit(finished("late")); h.clock.advance(1999); let settled = false; void cleanup.then(() => { settled = true; }); await flush(); assert.equal(settled, false);
  h.clock.advance(1); await cleanup; assert.equal(h.clock.timers.size, 0); assert.equal(h.notifications.length, 0);
});
