import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Break caught: import-time execution, file creation, server startup or timers.
test("importing either developer script is inert", async () => {
  const originals = [];
  for (const [object, names] of [[childProcess, ["spawn", "execFile"]], [fs, ["mkdtemp", "mkdir", "writeFile"]], [globalThis, ["setTimeout", "setInterval"]]]) {
    for (const name of names) { originals.push([object, name, object[name]]); object[name] = () => { assert.fail(`import called ${name}`); }; }
  }
  syncBuiltinESMExports();
  try {
    const launcher = await import("../scripts/tmux-monitor-smoke.mjs").catch(() => ({}));
    const driver = await import("../scripts/tmux-monitor-smoke-driver.mjs").catch(() => ({}));
    assert.equal(typeof launcher.runSmoke, "function", "missing inert launcher export");
    assert.equal(typeof driver.runSmokeDriver, "function", "missing inert driver export");
  } finally { for (const [object, name, value] of originals) object[name] = value; syncBuiltinESMExports(); }
});

const OK_MARKER = `TMUX_SMOKE_OK:${JSON.stringify(["outside-gate", "four-viewers", "window-chrome", "viewer-metadata", "parent-summary"])}`;

async function fixture(t, { noBinary = false, driverFailure = false, changedName = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tmux-smoke-safety-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  let assigned, socketPath, parent = "%0", serverUp = false;
  // Ambient routing is deliberately hostile: the smoke must never adopt it.
  const ambient = { ...process.env, TMUX: "/ambient/default.sock,1,0", TMUX_PANE: "%foreign", TMUX_TMPDIR: "/ambient-tmux",
    PI_SUBAGENT_MUX: "herdr", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/ambient/herdr.sock", PI_TMUX_BIN: "foreign-tmux" };
  const exec = async (binary, args, options) => {
    calls.push({ binary, args, env: options.env, timeout: options.timeout });
    assert.equal(binary, "fake-tmux");
    assert.equal(args[0], "-L", "every command must be scoped with -L");
    assert.match(args[1], /^pi-smoke-[a-f0-9]{32}$/, "disposable server name");
    if (assigned) assert.equal(args[1], assigned, "one server per run");
    else assigned = args[1];
    // Ambient routing and multiplexer identity must never reach a child command.
    assert.equal(options.env.TMUX, undefined, "ambient TMUX stripped");
    assert.equal(options.env.TMUX_PANE, undefined, "ambient TMUX_PANE stripped");
    assert.equal(options.env.PI_SUBAGENT_MUX, undefined, "ambient override stripped");
    assert.equal(options.env.HERDR_ENV, undefined, "ambient Herdr stripped");
    assert.ok(options.env.TMUX_TMPDIR.startsWith(root + path.sep), "private socket dir");
    assert.ok(options.env.PI_CODING_AGENT_DIR.startsWith(root + path.sep), "private agent dir");
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 5000, "bounded command timeout");
    const command = args.slice(2);
    if (command[0] === "-V") { if (noBinary) throw Object.assign(new Error("spawn fake-tmux ENOENT"), { code: "ENOENT" }); return "tmux 3.7c\n"; }
    if (command[0] === "start-server") { serverUp = true; return ""; }
    if (command[0] === "kill-server") { serverUp = false; return ""; }
    if (command[0] === "set-option") return "";
    if (command[0] === "new-session") { socketPath = path.join(options.env.TMUX_TMPDIR, `tmux-${process.getuid?.() ?? 0}`, args[1]); return `${parent} $0 @0\n`; }
    if (command[0] === "respawn-pane") { assert.equal(command[3], parent); return ""; }
    if (command[0] === "display-message") {
      const target = command[3]; const format = command[4];
      if (format === "#{socket_path}") return `${socketPath}\n`;
      if (format === "#{pane_dead}") return "0\n";
      if (format === "#{@pi_viewer_state}") return "working\n";
      if (format === "#{@pi_viewer_summary}") return "smoke-viewer\n";
      if (format === "#{@pi_subagent_summary}") return "running 4 · queued 0 · paused 0 · completed 0 · unsuccessful 0\n";
      assert.fail(`unexpected display-message format ${format} for ${target}`);
    }
    if (command[0] === "capture-pane") return driverFailure ? "TMUX_SMOKE_FAILED:fixture failure\n" : `${OK_MARKER}\n`;
    if (command[0] === "list-windows") return `@1 smoke\n@7 ${changedName ? "Renamed" : "π subagents · running 4 · queued 0"}\n`;
    if (command[0] === "list-panes") return "%1\n%2\n%3\n%4\n";
    if (command[0] === "show-options") {
      if (command.includes("pane-border-status")) return "top\n";
      if (command.includes("pane-border-format")) return " #{@pi_viewer_summary} \n";
      if (command.includes("automatic-rename")) return "off\n";
      assert.fail(`unexpected show-options ${command.join(" ")}`);
    }
    assert.fail(`unexpected command ${command.join(" ")}`);
  };
  const { runSmoke } = await import("../scripts/tmux-monitor-smoke.mjs");
  return { run: () => runSmoke({ binary: "fake-tmux", env: ambient, exec, tempRoot: root }), calls, root,
    get assigned() { return assigned; }, get serverUp() { return serverUp; },
    get killCalls() { return calls.filter(c => c.args[2] === "kill-server"); } };
}

// Break caught: inventing viewer panes or options without live evidence and
// leaking them because a teardown guard is missing.
test("successful launcher asserts the π subagents window and tears down its own server", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.ok(result.includes("outside-gate"));
  assert.ok(result.includes("window-present"));
  assert.ok(result.includes("launcher-window-options"));
  assert.ok(result.includes("launcher-viewer-options"));
  assert.ok(result.includes("launcher-parent-summary"));
  assert.equal(f.killCalls.length, 1, "exactly one kill-server");
  assert.equal(f.killCalls[0].args[1], f.assigned);
  assert.equal(f.serverUp, false, "no lingering disposable server");
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Break caught: a missing tmux binary being reported as a passing smoke.
test("launcher refuses without an installed tmux", async t => {
  const f = await fixture(t, { noBinary: true });
  await assert.rejects(f.run(), /tmux.*(?:not installed|unusable)/i);
  assert.equal(f.killCalls.length, 0, "nothing to tear down before the server exists");
});

// Break caught: a driver failure bypassing owned-server teardown.
test("driver failure still tears down only the disposable server", async t => {
  const f = await fixture(t, { driverFailure: true });
  await assert.rejects(f.run(), /fixture failure/);
  assert.equal(f.killCalls.length, 1);
  assert.equal(f.serverUp, false);
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Break caught: trusting an unrelated window as the integration's output.
test("launcher rejects a missing π subagents window", async t => {
  const f = await fixture(t, { changedName: true });
  await assert.rejects(f.run(), /subagents window/i);
  assert.equal(f.killCalls.length, 1, "even a failed assertion still tears down");
  assert.deepEqual(await fs.readdir(f.root), []);
});

// Break caught: a smoke that quietly calls a provider instead of fixtures.
test("the smoke driver drives fixture children and never spawns a model", async () => {
  const source = await fs.readFile(fileURLToPath(new URL("../scripts/tmux-monitor-smoke-driver.mjs", import.meta.url)), "utf8");
  assert.ok(source.includes("spawnProcess"), "driver must inject fixture child processes");
  assert.ok(!/spawn\s*\(\s*["'`]pi["'`]/.test(source), "driver must not spawn pi");
  assert.ok(!/["'`]--mode["'`]\s*,\s*["'`]json["'`]/.test(source), "driver must not invoke pi JSON mode");
  assert.ok(!/\bmodelOverride\b|resolveModel\s*\(/.test(source), "driver must not resolve models");
});
