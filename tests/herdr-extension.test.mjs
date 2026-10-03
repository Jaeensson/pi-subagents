import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "subagent-herdr-entry-"));
process.env.HOME = home;
for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH"]) delete process.env[key];
const agentDir = path.join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagent: { herdr: { enabled: false, viewers: false } } }));

const { default: extension } = await import("../index.ts");
const { tasks, jobs, clearRegistry } = await import("../runtime.ts");

function harness(createMonitor) {
  const hooks = new Map();
  const pi = {
    on: (event, callback) => hooks.set(event, callback),
    registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
  };
  extension(pi, { createMonitor });
  return hooks;
}

test("extension creates an idle monitor without startup resources, starts before the no-UI return, and binds session tasks", async () => {
  const calls = [];
  let deps;
  const hooks = harness((received) => {
    deps = received;
    return { start: (...args) => calls.push(["start", ...args]), applyOptions: (...args) => calls.push(["apply", ...args]), stop: () => { calls.push(["stop"]); return undefined; } };
  });
  assert.equal(calls.length, 0);
  assert.equal(deps, undefined);
  const started = await hooks.get("session_start")({ reason: "new" }, { cwd: "/tmp", hasUI: false, sessionManager: { getSessionId: () => "session-a" } });
  assert.equal(started, undefined);
  assert.equal(calls[0][0], "start");
  assert.equal(calls[0][1], "session-a");
  assert.deepEqual(calls[0][3], { enabled: false, viewers: false });
  assert.equal(typeof deps.getTasks, "function");
  const own = { id: "own", jobId: "owned", status: "running" };
  const other = { id: "other", jobId: "foreign", status: "running" };
  tasks.set(own.id, own); tasks.set(other.id, other);
  jobs.set("owned", { parentSessionId: "session-a" });
  jobs.set("foreign", { parentSessionId: "session-b" });
  assert.deepEqual(deps.getTasks(), [own]);
  await hooks.get("session_start")({ reason: "resume" }, { cwd: "/tmp/next", hasUI: false, sessionManager: { getSessionId: () => "session-b" } });
  assert.deepEqual(calls.map((call) => call[0]), ["start", "stop", "start"]);
  clearRegistry();
});

test("shutdown starts the durable interruption sweep before bounding a stuck monitor stop", async () => {
  const hooks = harness(() => ({ start() {}, applyOptions() {}, stop: () => new Promise(() => {}) }));
  await hooks.get("session_start")({ reason: "new" }, { cwd: "/tmp", hasUI: false, sessionManager: { getSessionId: () => "shutdown-session" } });
  const task = { id: "shutdown-task", jobId: "shutdown-job", status: "running", dispatchState: "running" };
  tasks.set(task.id, task);
  const run = hooks.get("session_shutdown")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.status, "interrupted", "durable sweep runs while monitor cleanup is pending");
  await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown hung")), 2600))]);
  assert.equal(task.status, "interrupted");
  clearRegistry();
});

test("session preference read is isolated from inherited developer routing", () => {
  const saved = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.subagent.herdr, { enabled: false, viewers: false });
});

test.after(() => rmSync(home, { recursive: true, force: true }));
