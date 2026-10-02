import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { buildViewerCommand, classifyOccupant, createHerdrAdapter } from "../herdr-adapter.ts";

const context = { binary: "herdr", socketPath: "/tmp/socket", callerPaneId: "caller" };
const ok = value => JSON.stringify({ ok: true, result: value });
function runner(responses = []) {
  const calls = [];
  const exec = async (binary, args, options) => { calls.push({ binary, args, options }); const response = responses.shift(); if (response instanceof Error) throw response; return response ?? ok({}); };
  return { calls, exec };
}

test("current pane passes explicit caller identity, socket and bounded options", async () => {
  const r = runner([ok({ pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.deepEqual(await api.currentPane("requested"), { ok: true, value: { paneId: "p", tabId: "t", workspaceId: "w" } });
  assert.deepEqual(r.calls[0].args, ["pane", "current", "--current"]);
  assert.equal(r.calls[0].options.env.HERDR_PANE_ID, "requested");
  assert.equal(r.calls[0].options.env.HERDR_SOCKET_PATH, "/tmp/socket");
  assert.equal(r.calls[0].options.timeout, 2000); assert.equal(r.calls[0].options.maxBuffer, 65536);
});

test("pane not found is missing, malformed creation is invalid, and tab creation avoids focus", async () => {
  const r = runner([JSON.stringify({ ok: false, error: { code: "pane_not_found", message: "gone" } }), ok({ tab: { tab_id: "t" } })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.equal((await api.pane("gone")).reason, "missing");
  assert.equal((await api.createTab("w", "/tmp")).reason, "invalid");
  assert.ok(r.calls[1].args.includes("--no-focus"));
});

test("explicit pane ID mismatches are invalid while current lookup accepts a moved pane", async () => {
  const r = runner([ok({ pane: { pane_id: "new", tab_id: "t", workspace_id: "w" } }), ok({ pane: { pane_id: "different", tab_id: "t", workspace_id: "w" } })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.equal((await api.currentPane("old-inherited-id")).value.paneId, "new");
  assert.equal((await api.pane("expected")).reason, "invalid");
});

test("parse workspace panes locally and do not pass a tab option", async () => {
  const r = runner([ok({ panes: [{ pane_id: "a", tab_id: "ta", workspace_id: "w" }, { pane_id: "b", tab_id: "tb", workspace_id: "other" }] })]);
  const result = await createHerdrAdapter(context, r.exec).panes("w");
  assert.deepEqual(result.value, [{ paneId: "a", tabId: "ta", workspaceId: "w" }]);
  assert.deepEqual(r.calls[0].args, ["pane", "list"]);
});

test("occupant classification requires fresh identity pid and rejects conflicting argv", () => {
  const identity = { version: 1, activationId: "a", slotId: 0, nonce: "n", pid: 42, heartbeatAt: 1000 };
  const base = { paneId: "p", foregroundProcesses: [{ pid: 42, name: "node" }] };
  assert.equal(classifyOccupant(base, identity, "/viewer.mjs", 2000), "owned");
  assert.equal(classifyOccupant({ ...base, foregroundProcesses: [{ pid: 43, name: "editor" }] }, identity, "/viewer.mjs", 2000), "foreign");
  assert.equal(classifyOccupant({ ...base, foregroundProcesses: [{ pid: 42, name: "node", argv: ["node", "/other"] }] }, identity, "/viewer.mjs", 2000), "foreign");
  assert.equal(classifyOccupant(base, identity, "/viewer.mjs", 12000), "unknown");
});

test("viewer launch command safely quotes literals and refuses unsupported shell", () => {
  const identity = { activationId: "a'$(x)", slotId: 3, nonce: "x%$(y)" };
  assert.equal(buildViewerCommand("/node path", "/viewer.mjs", "/snap's", "/id", identity, "unsupported"), undefined);
  const posix = buildViewerCommand("/node path", "/viewer.mjs", "/snap's", "/id", identity, "posix");
  assert.match(posix, /--snapshot/); assert.match(posix, /'\\''/);
  const win = buildViewerCommand("C:\\node.exe", "C:\\viewer.mjs", "C:\\snap%$(x)", "C:\\id", identity, "powershell");
  assert.match(win, /-EncodedCommand/);
  const encoded = win.split(" ").at(-1);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /--activation/);
  assert.match(decoded, /x%\$\(y\)/);
  const command = buildViewerCommand("/bin/echo", "/viewer.mjs", "/snap's", "/id", identity, "posix");
  const shell = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  assert.equal(shell.status, 0);
  assert.deepEqual(shell.stdout.trim().split(" "), ["/viewer.mjs", "--snapshot", "/snap's", "--identity", "/id", "--activation", "a'$(x)", "--slot", "3", "--nonce", "x%$(y)"]);
});

test("timeout and stderr remain unavailable, malformed stdout is invalid", async () => {
  const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", stderr: "timeout detail" });
  const r = runner([timeout, "not json", Object.assign(new Error("failed"), { stderr: "specific stderr" })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.equal((await api.closePane("p")).reason, "unavailable");
  assert.equal((await api.closePane("p")).reason, "invalid");
  const failed = await api.closePane("p");
  assert.equal(failed.reason, "unavailable"); assert.match(failed.error, /specific stderr/);
});

test("command scheduler bounds active work and rejects excess queued work; scoped stale work skips", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let active = 0, peak = 0, started = 0;
  const exec = async () => { active++; peak = Math.max(peak, active); started++; await gate; active--; return ok({ pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } }); };
  const api = createHerdrAdapter(context, exec); let current = true;
  const scoped = api.scoped(() => current);
  const pending = Array.from({ length: 37 }, () => scoped.pane("p"));
  await new Promise(resolve => setImmediate(resolve)); current = false; release();
  const result = await Promise.all(pending);
  assert.ok(peak <= 4); assert.ok(started <= 4); assert.ok(result.some(item => item.ok === false && item.reason === "unavailable"));
});
