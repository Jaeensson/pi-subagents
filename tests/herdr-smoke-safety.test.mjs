import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Break caught: import-time execution, file creation, server startup or timers.
test("importing either developer script is inert", async () => {
  const originals = [];
  for (const [object, names] of [[childProcess, ["spawn", "execFile"]], [fs, ["mkdtemp", "mkdir", "writeFile"]], [globalThis, ["setTimeout", "setInterval"]]]) {
    for (const name of names) { originals.push([object, name, object[name]]); object[name] = () => { assert.fail(`import called ${name}`); }; }
  }
  syncBuiltinESMExports();
  try {
    const launcher = await import("../scripts/herdr-monitor-smoke.mjs").catch(() => ({}));
    const driver = await import("../scripts/herdr-monitor-smoke-driver.mjs").catch(() => ({}));
    assert.equal(typeof launcher.runSmoke, "function", "missing inert launcher export");
    assert.equal(typeof driver.runSmokeDriver, "function", "missing inert driver export");
  } finally { for (const [object, name, value] of originals) object[name] = value; syncBuiltinESMExports(); }
});

const envelope = result => JSON.stringify({ id: "fixture:1", result });
async function fixture(t, { failure = false, failedStartup = false, stopRace = false, changedOwner = false, emptyAction = false, plainRead = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "herdr-smoke-safety-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let assigned, environment, server, running = false, deleted = false;
  const env = { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/inherited/default.sock", HERDR_SESSION: "default", HERDR_REMOTE: "user@host", HERDR_PANE_ID: "foreign-pane", HERDR_BIN_PATH: "foreign-binary" };
  const exec = async (binary, args, options) => {
    calls.push({ binary, args, env: options.env });
    assert.equal(binary, "fake-herdr");
    assert.ok(args.length > 0, "never bare attach");
    assert.ok(!Object.keys(options.env).some(k => k.startsWith("HERDR_") && k !== "HERDR_CONFIG_PATH"), "inherited routing removed");
    if (args[0] === "--default-config") return "[terminal]\n[update]\n[server]\n";
    assert.equal(args[0], "--session");
    assert.match(args[1], /^(?:pi-(?:subagent|sa)-smoke-|ps-)[a-f0-9-]+$/);
    if (assigned) assert.equal(args[1], assigned);
    const command = args.slice(2);
    if (command.join(" ") === "session list") return `name status directory socket\n${assigned && !deleted ? `${assigned} ${running ? "running" : "stopped"} ${environment.HOME}/.config/herdr/sessions/${assigned} ${environment.HOME}/.config/herdr/sessions/${assigned}/herdr.sock` : ""}\n`;
    if (command[0] === "workspace" && command[1] === "create") return envelope({ type: "workspace_created", workspace: { workspace_id: "own-workspace" }, tab: { tab_id: "own-tab" }, root_pane: { pane_id: "authoritative-parent", tab_id: "own-tab", workspace_id: "own-workspace" } });
    if (command[0] === "pane" && command[1] === "run") { assert.equal(command[2], "authoritative-parent"); return emptyAction ? "" : envelope({ type: "pane_run" }); }
    if (command[0] === "pane" && command[1] === "read") { if (changedOwner) environment = { ...environment, HOME: path.join(root, "impostor") }; }
    if (command[0] === "pane" && command[1] === "read") {
      const text = failure ? "HERDR_SMOKE_FAILED:fixture failure" : "HERDR_SMOKE_OK:" + JSON.stringify(["four-viewers", "reuse", "switches", "heartbeat-loss", "outside-gate"]);
      return plainRead ? text : envelope({ type: "pane_read", read: { text } });
    }
    if (command[0] === "session" && command[1] === "stop") { assert.equal(command[2], assigned); running = false; server.exitCode = 0; server.emit("close", 0); if (stopRace) throw new Error("socket already gone"); return "stopped"; }
    if (command[0] === "session" && command[1] === "delete") { assert.equal(command[2], assigned); deleted = true; return "deleted"; }
    assert.fail(`unexpected command ${command}`);
  };
  const spawnServer = (binary, args, spawnEnv) => {
    assert.equal(binary, "fake-herdr"); assert.equal(args[0], "--session"); assert.equal(args[2], "server");
    assigned = args[1]; environment = spawnEnv;
    assert.ok(spawnEnv.HOME.startsWith(root + path.sep));
    assert.ok(spawnEnv.PI_CODING_AGENT_DIR.startsWith(root + path.sep));
    assert.equal(spawnEnv.SHELL, "/bin/sh");
    assert.equal(spawnEnv.ENV, undefined); assert.equal(spawnEnv.BASH_ENV, undefined);
    server = new EventEmitter(); server.exitCode = failedStartup ? 1 : null; server.pid = 123;
    server.stderr = new EventEmitter(); server.kill = () => assert.fail("must use owned named session stop, not PID kill");
    running = !failedStartup;
    return server;
  };
  const { runSmoke } = await import("../scripts/herdr-monitor-smoke.mjs");
  return { run: () => runSmoke({ binary: "fake-herdr", env: { ...env, ENV: "/user/init", BASH_ENV: "/user/bashrc" }, exec, spawnServer, tempRoot: root }), calls, root, get assigned() { return assigned; } };
}

// Break caught: generated private routes exceed macOS's Unix socket capacity.
test("short private HOME leaves room for Herdr's longer internal server socket", { skip: process.platform === "win32" }, async () => {
  const { runSmoke } = await import("../scripts/herdr-monitor-smoke.mjs");
  await assert.rejects(runSmoke({ binary: "fake-herdr", tempRoot: "/tmp", env: {},
    exec: async (_binary, args) => args[0] === "--default-config" ? "" : "name status directory socket\n",
    spawnServer: (_binary, args, env) => {
      const internalSocket = path.join(env.HOME, ".config/herdr/sessions", args[1], "herdr-server.sock");
      assert.ok(Buffer.byteLength(internalSocket) < 104, `socket route too long: ${internalSocket}`);
      const server = new EventEmitter(); server.stderr = new EventEmitter(); server.exitCode = 1;
      return server;
    },
  }), /server exited/);
});

// Break caught: default/socket routing, predicted creation IDs, unowned cleanup.
test("launcher routes every command to its generated disposable session and removes private resources", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.sessionName, f.assigned);
  assert.ok(result.checks.includes("four-viewers"));
  assert.deepEqual(f.calls.filter(c => c.args[2] === "session" && ["stop", "delete"].includes(c.args[3])).map(c => c.args.slice(3)), [["stop", f.assigned], ["delete", f.assigned]]);
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Installed 0.8.2 pane run succeeds with empty stdout. The driver marker, not
// an action envelope, must prove completion; the extension adapter is separate.
test("launcher waits for driver evidence when pane run has empty successful stdout", async t => {
  const f = await fixture(t, { emptyAction: true });
  const result = await f.run();
  assert.ok(result.checks.includes("four-viewers"));
});

// Break caught: treating installed CLI terminal output as an API envelope.
test("launcher reads completion from plain CLI pane output", async t => {
  const f = await fixture(t, { plainRead: true });
  const result = await f.run();
  assert.ok(result.checks.includes("four-viewers"));
});

// Break caught: a stop race leaves an owned, already stopped session undeleted.
test("cleanup deletes an already-exited owned server after stop reports a missing socket", async t => {
  const f = await fixture(t, { stopRace: true });
  await f.run();
  assert.ok(f.calls.some(c => c.args[3] === "delete" && c.args[4] === f.assigned));
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Break caught: changed ownership between execution and cleanup gets stopped.
test("cleanup refuses stop/delete when authoritative session paths change", async t => {
  const f = await fixture(t, { changedOwner: true });
  await assert.rejects(f.run(), /ownership changed|unowned session route/);
  assert.equal(f.calls.some(c => ["stop", "delete"].includes(c.args[3])), false);
});

// Break caught: failure paths bypass owned-session cleanup.
test("driver failure still stops and deletes only the owned generated session", async t => {
  const f = await fixture(t, { failure: true });
  await assert.rejects(f.run(), /fixture failure/);
  assert.deepEqual(f.calls.filter(c => ["stop", "delete"].includes(c.args[3])).map(c => c.args.slice(3)), [["stop", f.assigned], ["delete", f.assigned]]);
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Break caught: a failed startup adopts a session listed by some other server.
test("failed startup never adopts or stops an existing named resource", async t => {
  const f = await fixture(t, { failedStartup: true });
  await assert.rejects(f.run(), /server exited/);
  assert.equal(f.calls.some(c => ["stop", "delete"].includes(c.args[3])), false);
  assert.deepEqual(await fs.readdir(f.root), []);
});
