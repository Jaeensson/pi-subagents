// Test fixture only: runs in the launcher's own pane, never calls a model.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

async function until(read, label, timeout = 15000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  throw new Error(`timed out: ${label}`);
}

export async function runSmokeDriver() {
  const { HERDR_SMOKE_ROOT: root, HERDR_SMOKE_SESSION: session, HERDR_SMOKE_SOCKET: socket, HERDR_SMOKE_PANE: parentId, HERDR_SMOKE_BINARY: binary } = process.env;
  assert.match(session ?? "", /^ps-[a-f0-9]{32}$/);
  assert.ok(root && socket?.startsWith(root + path.sep), "private assigned socket required");
  assert.equal(process.env.HERDR_ENV, "1");
  assert.equal(process.env.HERDR_SOCKET_PATH, socket, "own socket only");
  assert.equal(process.env.HERDR_PANE_ID, parentId, "own assigned pane only");
  assert.equal(process.env.PI_CODING_AGENT_DIR, path.join(root, "agent"));
  const config = process.env.HERDR_CONFIG_PATH;
  for (const key of Object.keys(process.env)) if (key.startsWith("HERDR_")) delete process.env[key];
  const gate = { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: parentId, HERDR_BIN_PATH: binary, HERDR_CONFIG_PATH: config };
  // A realistic agent dir carries a readable settings.json; the product's
  // persistence layer deliberately never creates one from scratch. Seed a
  // minimal valid object (defaults apply) so settings toggles exercise real
  // persistence in the private agent dir.
  const settingsPath = path.join(root, "agent", "settings.json");
  try { await fs.writeFile(settingsPath, "{}\n", { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  // Agent-dir is set before any SDK or extension import (SDK caches its paths).
  const sdk = await import("@earendil-works/pi-coding-agent");
  assert.equal(sdk.getAgentDir(), path.join(root, "agent"));
  sdk.initTheme();
  const { default: extension } = await import("../index.ts");
  const { createHerdrMonitor, nodeMonitorClock } = await import("../herdr-monitor.ts");
  const { createViewerManager } = await import("../herdr-viewers.ts");
  const { createSnapshotStore } = await import("../herdr-files.ts");
  const { spawnTask } = await import("../process.ts");
  const runtime = await import("../runtime.ts");
  const { writeManifest } = await import("../store.ts");
  const checks = [], hooks = new Map(), messages = [], transports = [], cliObservations = new Map();
  let command, monitorCommands = 0, monitoringTimers = 0, stores = 0, frozen = false;
  const execute = async (args, options = { env: { ...process.env, ...gate }, timeout: 2000, maxBuffer: 128 * 1024 }) => {
    assert.equal(options.env.HERDR_SOCKET_PATH, socket);
    return String((await promisify(execFile)(binary, ["--session", session, ...args], options)).stdout);
  };
  const call = async args => {
    try {
      const stdout = await execute(args);
      const response = JSON.parse(stdout);
      assert.ok(response.id && response.result && !response.error, stdout);
      return response.result;
    } catch (error) { throw new Error(`CLI ${JSON.stringify(args)}: ${error.message}; ${error.stderr ?? ""}`); }
  };
  const snapshot = async () => (await call(["api", "snapshot"])).snapshot;
  const pane = async id => (await call(["pane", "get", id])).pane;
  const text = id => execute(["pane", "read", id, "--source", "recent-unwrapped", "--lines", "100"]);
  const semantic = p => ({ agent: p.agent ?? null, status: p.agent_status, session: p.agent_session ?? null });
  const focus = s => [s.focused_workspace_id, s.focused_tab_id, s.focused_pane_id];
  const clock = { ...nodeMonitorClock,
    setTimeout(fn, ms) { monitoringTimers++; return nodeMonitorClock.setTimeout(fn, ms); },
    setInterval(fn, ms) { monitoringTimers++; return nodeMonitorClock.setInterval(fn, ms); },
  };
  extension({
    on: (name, fn) => hooks.set(name, fn), registerTool() {}, registerMessageRenderer() {},
    registerCommand: (_name, value) => { command = value; }, sendMessage: (...args) => messages.push(args),
  }, { createMonitor: deps => createHerdrMonitor({ ...deps, clock,
    adapterFactory: context => {
      monitorCommands++;
      return deps.adapterFactory(context, async (_binary, args, options) => {
        if (args[0] === "pane" && ["report-agent", "report-agent-session", "release-agent"].includes(args[1])) {
          assert.notEqual(args[2], parentId, "integration must never control parent lifecycle");
        }
        const stdout = await execute(args, options);
        const kind = args.slice(0, 2).join(" ");
        if (!cliObservations.has(kind)) cliObservations.set(kind, { args: args.slice(0, 3), stdout: stdout.slice(0, 240) });
        return stdout; // real adapter parsing, including failures, remains unchanged
      });
    },
    viewerFactory: host => createViewerManager(host, {
      storeFactory: () => {
        stores++;
        assert.ok(stores <= 4, "at most four physical transports");
        const store = createSnapshotStore({ tempRoot: root });
        const transport = { store, disposed: false };
        transports.push(transport);
        return { ...store,
          async openSlot(identity) { transport.identity = { ...identity }; transport.paths = await store.openSlot(identity); return transport.paths; },
          publish: (...args) => frozen ? Promise.resolve() : store.publish(...args),
          async dispose() { await store.dispose(); transport.disposed = true; },
        };
      },
    }),
  }) });
  const start = () => hooks.get("session_start")({ reason: "startup" }, { cwd: root, hasUI: false, sessionManager: { getSessionId: () => "smoke-parent" } });
  const toggle = async index => {
    let component;
    const theme = { fg: (_color, value) => value, bold: value => value, dim: value => value };
    const dialog = command.handler("", { mode: "tui", hasUI: true, scopedModels: [], modelRegistry: { getAvailable: () => [] },
      ui: { notify(message) { throw new Error(message); }, custom: factory => new Promise(resolve => { component = factory({ requestRender() {} }, theme, {}, resolve); }) } });
    assert.ok(component, "settings dialog opened");
    for (let i = 0; i < index; i++) component.handleInput("\x1b[B");
    component.handleInput(" "); component.handleInput("\x1b");
    await dialog;
  };
  const readTransport = async transport => JSON.parse(await fs.readFile(transport.paths.snapshotPath, "utf8"));
  const viewerPanes = async () => (await snapshot()).panes.filter(p => p.agent === "pi-subagent-viewer");
  const fixtures = [];
  try {
    await start();
    assert.equal(monitorCommands, 0); assert.equal(monitoringTimers, 0); assert.equal(stores, 0);
    checks.push("outside-gate");
    Object.assign(process.env, gate);
    const ordinary = semantic(await pane(parentId)), originalFocus = focus(await snapshot());
    await start();
    const jobId = "smoke-batch";
    const job = { id: jobId, parentSessionId: "smoke-parent", mode: "parallel", status: "running", tasks: [], notifyOnComplete: true, notified: false, finished: false, chainRunnerDone: false, pendingSpawns: 0, persistenceReady: Promise.resolve(true) };
    runtime.jobs.set(jobId, job);
    await writeManifest(runtime.getJobsRoot(), "smoke-parent", { version: 1, jobId, parentSessionId: "smoke-parent", mode: "parallel", createdAt: Date.now(), updatedAt: Date.now(), notifyOnComplete: true, status: "running", tasks: [] });
    const child = async index => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = null; proc.signalCode = null;
      const close = (code = 0, signal = null) => { if (proc.exitCode !== null) return; proc.exitCode = code; proc.signalCode = signal; proc.emit("close", code, signal); };
      // Real shutdown ownership calls only this fake kill. It must settle close;
      // there is deliberately no fake OS pid and no process.kill call.
      proc.kill = signal => { queueMicrotask(() => close(143, signal)); return true; };
      const task = await spawnTask({ name: "worker", source: "user", systemPrompt: "", tools: [], extensions: [] }, `Smoke task ${index}`, root, jobId,
        { taskId: `smoke-${index}`, name: `smoke-${index}`, modelCtx: { catalog: [] }, spawnProcess: () => proc });
      const emit = event => proc.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
      // Real providers stream the full final text as deltas; message_end only
      // seals streams and reconciles tool calls, so every retained marker must
      // be genuinely streamed text (trace-content contract). Task 1 is later
      // completed first, so its streamed text carries the retention marker.
      const streamedText = [`text-${index}`, ...(index === 1 ? [" retained-complete-1"] : [])];
      for (const kind of ["thinking", "text"]) {
        const parts = kind === "thinking" ? [`thinking-${index}`] : streamedText;
        emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_start`, contentIndex: kind === "thinking" ? 0 : 1 } });
        for (const part of parts) emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_delta`, delta: part, contentIndex: kind === "thinking" ? 0 : 1 } });
        emit({ type: "message_update", assistantMessageEvent: { type: `${kind}_end`, contentIndex: kind === "thinking" ? 0 : 1 } });
      }
      emit({ type: "tool_execution_start", toolCallId: `tool-${index}`, toolName: "read", args: { path: `fixture-${index}` } });
      emit({ type: "tool_execution_end", toolCallId: `tool-${index}`, toolName: "read", result: { content: [{ type: "text", text: `tool-output-${index}` }] }, isError: false });
      const fixture = { task, proc, emit, close, finalText: streamedText.join("") };
      fixtures.push(fixture); return fixture;
    };
    for (let i = 1; i <= 4; i++) await child(i);
    const viewers = await until(async () => { const values = await viewerPanes(); return values.length === 4 && values.every(p => p.agent_status === "working") && values; }, "four real viewer helpers");
    assert.equal(transports.length, 4);
    assert.equal(new Set(transports.map(t => path.dirname(t.paths.snapshotPath))).size, 4, "private per-position roots");
    for (const viewer of viewers) {
      await until(async () => /thinking-\d/.test(await text(viewer.pane_id)) && /tool-output-\d/.test(await text(viewer.pane_id)), "rendered thinking/text/tool output");
      const info = (await call(["pane", "process-info", "--pane", viewer.pane_id])).process_info;
      assert.equal(info.foreground_processes.length, 1);
      assert.match(info.foreground_processes[0].name, /node/);
    }
    assert.deepEqual(semantic(await pane(parentId)), ordinary, "ordinary parent native identity unchanged");
    assert.deepEqual(focus(await snapshot()), originalFocus, "no focus stealing");
    assert.match((await pane(parentId)).tokens.subagent_summary, /^running 4 · queued 0/);
    checks.push("four-viewers", "ordinary-parent", "no-focus-steal");
    // Test-only parent lifecycle authority. Integration itself must never report
    // a parent lifecycle/session or release it. Preserve each fixture identity.
    let reporterSeq = 1;
    for (const state of ["idle", "working", "blocked"]) {
      await execute(["pane", "report-agent", parentId, "--source", "smoke-parent-reporter", "--seq", String(reporterSeq++), "--agent", "pi", "--state", state, "--agent-session-id", "smoke-native-session"]);
      const native = semantic(await pane(parentId));
      runtime.notifyStatusChanged();
      await until(async () => (await pane(parentId)).tokens?.subagent_summary?.includes("running 4"), "parent metadata refresh");
      assert.deepEqual(semantic(await pane(parentId)), native, `${state} parent state/session not overwritten`);
    }
    checks.push("custom-parent-native-identity");
    const first = fixtures[0];
    const snapshots = await Promise.all(transports.map(readTransport));
    const reused = transports[snapshots.findIndex(s => s.task.id === first.task.id)];
    assert.ok(reused, "transport assigned to first real task");
    const before = await readTransport(reused);
    const peerTransports = transports.filter(t => t !== reused);
    const peers = await Promise.all(peerTransports.map(async t => ({ nonce: t.identity.nonce, pid: (await t.store.readIdentity(t.identity.slotId)).pid })));
    // message_end content mirrors the concatenated streamed text, like a real
    // provider; no content is invented that was never streamed.
    first.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: first.finalText }], stopReason: "stop" } });
    first.close();
    await until(() => first.task.status === "completed" && !first.task.finalizing, "real JSON child finalization");
    const completedPane = await until(async () => { const values = await viewerPanes(); return values.find(p => p.agent_status !== "working"); }, "completed viewer retained");
    await until(async () => (await text(completedPane.pane_id)).includes("retained-complete-1"), "retained final output");
    await child(5);
    await until(async () => (await readTransport(reused)).task.id === "smoke-5" && (await text(completedPane.pane_id)).includes("text-5"), "physical viewer reuse");
    const after = await readTransport(reused);
    assert.equal(after.nonce, before.nonce); assert.ok(after.seq > before.seq);
    assert.equal((await viewerPanes()).length, 4, "no fifth viewer");
    for (let i = 0; i < peerTransports.length; i++) {
      const peer = peerTransports[i];
      assert.equal(peer.identity.nonce, peers[i].nonce);
      assert.equal((await peer.store.readIdentity(peer.identity.slotId)).pid, peers[i].pid, "healthy peer retained");
    }
    checks.push("retained-output", "reuse");
    const alive = fixtures.slice(1).map(f => f.proc);
    const native = semantic(await pane(parentId));
    await toggle(5); // viewers false, through the registered /subagents dialog
    await until(async () => !(await snapshot()).panes.some(p => viewers.some(v => v.pane_id === p.pane_id)), "viewers:false closes owned panes");
    assert.ok(alive.every(p => p.exitCode === null));
    assert.match((await pane(parentId)).tokens.subagent_summary, /^running 4/);
    await toggle(4); // enabled false
    await until(async () => !(await pane(parentId)).tokens?.subagent_summary, "enabled:false clears integration token");
    assert.ok(alive.every(p => p.exitCode === null));
    assert.deepEqual(semantic(await pane(parentId)), native);
    assert.deepEqual(focus(await snapshot()), originalFocus);
    checks.push("switches");
    // Reactivate a fresh pool; each old store must have completed disposal.
    await until(() => transports.every(t => t.disposed), "old per-position stores disposed");
    stores = 0;
    await toggle(5); await toggle(4);
    const secondViewers = await until(async () => { const values = await viewerPanes(); return values.length === 4 && values.every(p => p.agent_status === "working") && values; }, "reactivated helpers");
    frozen = true; // simulate producer heartbeat loss at the real file boundary
    for (const viewer of secondViewers) {
      await until(async () => /disconnected/i.test(await text(viewer.pane_id)), "heartbeat disconnected rendering", 18000);
      await until(async () => {
        const info = (await call(["pane", "process-info", "--pane", viewer.pane_id])).process_info;
        return info.foreground_processes.every(p => !/node/.test(p.name));
      }, "viewer exits after producer loss", 35000);
    }
    assert.ok(alive.every(p => p.exitCode === null));
    checks.push("heartbeat-loss");
  } catch (error) {
    error.message += `; CLI observations=${JSON.stringify([...cliObservations.values()])}`;
    throw error;
  } finally {
    await hooks.get("session_shutdown")();
    assert.ok(fixtures.every(f => f.proc.exitCode !== null), "shutdown settles only fake children");
  }
  console.log(`HERDR_SMOKE_OK:${JSON.stringify(checks)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSmokeDriver().catch(error => { console.error(`HERDR_SMOKE_FAILED:${String(error.stack).replace(/[\r\n]+/g, " | ")}`); process.exitCode = 1; });
}
