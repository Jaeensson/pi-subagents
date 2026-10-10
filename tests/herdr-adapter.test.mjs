import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildViewerCommand, classifyOccupant, createHerdrAdapter } from "../herdr-adapter.ts";

const context = { backend: "herdr", binary: "herdr", endpoint: "/tmp/socket", callerPaneId: "caller" };
// Installed 0.8.2 envelopes: success_response requires id/result, not ok.
const ok = (value, type = value.pane ? "pane_info" : value.panes ? "pane_list" : value.process_info ? "pane_process_info" : value.tab ? "tab_created" : "ok") => JSON.stringify({ id: "cli:test", result: { type, ...value } });
const errorEnvelope = (code, message = "gone") => JSON.stringify({ id: "cli:test", error: { code, message } });
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

test("createTab passes the literal display label in exact external argv", async () => {
  const r = runner([ok({ tab: { tab_id: "t" }, root_pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.equal((await api.createTab("w", "/work")).ok, true);
  assert.deepEqual(r.calls[0].args, ["tab", "create", "--workspace", "w", "--cwd", "/work", "--no-focus", "--label", "π subagents"]);
});

test("pane not found is missing, malformed creation is invalid, and tab creation avoids focus", async () => {
  const r = runner([errorEnvelope("pane_not_found"), ok({ tab: { tab_id: "t" } })]);
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

test("viewer launch round-trips literal executable and argv; decodes cmd and PowerShell", () => {
  const identity = { activationId: "a'$(x) ; &", slotId: 3, nonce: "x%$(y) ' \"" };
  const dir = mkdtempSync(join(tmpdir(), "herdr quoting ' $() % "));
  try {
    const node = join(dir, "node executable ' $() %");
    const script = join(dir, "argv printer ' $() %.mjs");
    symlinkSync(process.execPath, node);
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(1)));\n");
    chmodSync(script, 0o600);
    const snapshot = join(dir, "snapshot ' $() % & ;");
    const identityPath = join(dir, "identity ' $() % & ;");
    const expected = [script, "--snapshot", snapshot, "--identity", identityPath, "--activation", identity.activationId, "--slot", "3", "--nonce", identity.nonce];
    const command = buildViewerCommand(node, script, snapshot, identityPath, identity, "posix");
    const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    // Fish parses the same single-quote grammar: 'a'\''b' concatenates to a'b.
    const fishCommand = buildViewerCommand(node, script, snapshot, identityPath, identity, "fish");
    assert.equal(fishCommand, command);
    const fishProbe = spawnSync("fish", ["-c", "echo ok"], { encoding: "utf8" });
    if (fishProbe.status === 0) {
      const fished = spawnSync("fish", ["-c", fishCommand], { encoding: "utf8" });
      assert.equal(fished.status, 0, fished.stderr);
      assert.deepEqual(JSON.parse(fished.stdout), expected);
    }
    const windows = ["C:\\node path\\node's %$().exe", "C:\\viewer path\\script's %$().mjs", "C:\\snap path\\it's %$()", "C:\\id path\\it's %$()"];
    for (const shell of ["cmd", "powershell"]) {
      const launch = buildViewerCommand(...windows, identity, shell);
      assert.match(launch, /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
      const decoded = Buffer.from(launch.split(" ").at(-1), "base64").toString("utf16le");
      // Decode the constrained PowerShell single-quoted literal grammar, not regex presence checks.
      const literals = []; let rest = decoded.slice(2);
      while (rest.startsWith("'")) {
        const match = /^'((?:[^']|'')*)'/.exec(rest);
        assert.ok(match); literals.push(match[1].replaceAll("''", "'"));
        rest = rest.slice(match[0].length);
        if (rest.startsWith(" ")) rest = rest.slice(1);
      }
      assert.equal(rest, "; exit $LASTEXITCODE");
      assert.deepEqual(literals, [windows[0], windows[1], "--snapshot", windows[2], "--identity", windows[3], "--activation", identity.activationId, "--slot", "3", "--nonce", identity.nonce]);
    }
    assert.equal(buildViewerCommand(node, script, snapshot, identityPath, identity, "unsupported"), undefined);
    for (const shell of ["posix", "fish", "cmd", "powershell"]) {
      for (const control of ["\0", "\n", "\r", "\t", "\x1b", "\x7f", "\x80", "\x85", "\x9b", "\x9f"]) {
        for (let index = 0; index < 4; index++) {
          const paths = [node, script, snapshot, identityPath]; paths[index] += control;
          assert.equal(buildViewerCommand(...paths, identity, shell), undefined);
        }
        for (const field of ["activationId", "nonce"]) assert.equal(buildViewerCommand(node, script, snapshot, identityPath, { ...identity, [field]: control }, shell), undefined);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("known void actions accept empty stdout while reads and creation remain strict", async () => {
  const actions = [
    ["runViewer", "pane-run"],
    ["metadata", "pane-metadata"],
    ["viewerState", "pane-report-agent"],
    ["releaseViewer", "pane-release-agent"],
    ["notify", "notification-show"],
    ["closePane", "pane-close"],
    ["closeTab", "tab-close"],
  ];
  for (const [name] of actions) {
    for (const stdout of ["", " \n\t"]) {
      const api = createHerdrAdapter(context, async () => stdout);
      const result = name === "runViewer" ? await api.runViewer("p", { argv: ["node", "viewer"], shellCommand: "node viewer" })
        : name === "metadata" ? await api.metadata("p", { source: "s", seq: "1" })
        : name === "viewerState" ? await api.viewerState("p", "idle", "s", "1")
        : name === "releaseViewer" ? await api.releaseViewer("p", "s", "1")
        : name === "notify" ? await api.notify("title", "body")
        : name === "closePane" ? await api.closePane("p") : await api.closeTab("t");
      assert.deepEqual(result, { ok: true, value: undefined }, `${name}: ${JSON.stringify(stdout)}`);
    }
  }
  assert.equal((await createHerdrAdapter(context, async () => "").pane("p")).reason, "invalid");
  assert.equal((await createHerdrAdapter(context, async () => "").createTab("w", "/tmp")).reason, "invalid");
});

test("void actions reject malformed nonempty stdout and structured or execution errors", async () => {
  for (const output of ["not json", "{\"id\":\"x\",\"result\":{}}", errorEnvelope("permission_denied", "denied")]) {
    const result = await createHerdrAdapter(context, async () => output).closePane("p");
    assert.equal(result.ok, false, output);
  }
  for (const error of [
    Object.assign(new Error("exit 1"), { code: 1, stderr: errorEnvelope("permission_denied", "denied") }),
    Object.assign(new Error("exit 2"), { code: 2, stderr: "execution detail" }),
  ]) {
    const result = await createHerdrAdapter(context, async () => { throw error; }).closePane("p");
    assert.equal(result.reason, "unavailable");
  }
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

const viewerIdentity = { version: 1, activationId: "activation", slotId: 2, nonce: "nonce", pid: 42, heartbeatAt: 1000 };
const viewerArgv = ["node", "/viewer.mjs", "--snapshot", "/s", "--identity", "/i", "--activation", "activation", "--slot", "2", "--nonce", "nonce"];

test("finding 1: additional foreground participants cannot authorize destruction", () => {
  for (const argv of [undefined, viewerArgv]) {
    const processes = [{ pid: 42, name: "node", argv }, { pid: 43, name: "editor" }];
    assert.equal(classifyOccupant({ paneId: "p", foregroundProcesses: processes }, viewerIdentity, "/viewer.mjs", 2000), "foreign");
  }
});

test("finding 2: flag values must bind exactly once and freshness must be finite", () => {
  const classify = (argv, identity = viewerIdentity, now = 2000) => classifyOccupant({ paneId: "p", foregroundProcesses: [{ pid: 42, name: "node", argv }] }, identity, "/viewer.mjs", now);
  assert.equal(classify(viewerArgv), "owned");
  for (const [flag, value] of [["--activation", "activation"], ["--slot", "2"], ["--nonce", "nonce"]]) {
    const wrong = [...viewerArgv]; wrong[wrong.indexOf(flag) + 1] = "wrong"; wrong.push(value);
    assert.equal(classify(wrong), "foreign", flag);
    assert.equal(classify([...viewerArgv, flag, "wrong"]), "foreign", `duplicate ${flag}`);
  }
  assert.equal(classify(["node", "/other.mjs", ...viewerArgv.slice(2), "/viewer.mjs"]), "foreign");
  for (const heartbeatAt of [NaN, Infinity, -Infinity, 2001, -8000]) assert.equal(classify(undefined, { ...viewerIdentity, heartbeatAt }), "unknown");
  assert.equal(classify(undefined, viewerIdentity, NaN), "unknown");
});

test("finding 3: same-pane waiters count toward shared32, with raw/scoped cleanup FIFO", async () => {
  const calls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const api = createHerdrAdapter(context, async (_, args) => { calls.push(args); await gate; return ok({}); });
  const scoped = api.scoped(() => true);
  const first = api.metadata("p", { source: "a", seq: "1" });
  const blockers = ["q", "r", "s"].map(id => api.closePane(id));
  const pending = Array.from({ length: 32 }, (_, i) => (i % 2 ? scoped : api).metadata("p", { source: i % 2 ? "b" : "a", seq: String(i + 2) }));
  const overflow = api.closePane("p");
  let overflowResult; void overflow.then(result => { overflowResult = result; });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(overflowResult?.reason, "unavailable"); assert.equal(calls.length, 4); }
  finally { release(); await Promise.all([first, ...blockers, ...pending, overflow]); }
  assert.deepEqual(calls.filter(args => args[2] === "p").map(args => args[args.indexOf("--seq") + 1]), Array.from({ length: 33 }, (_, i) => String(i + 1)));
  const order = [];
  const ordered = createHerdrAdapter(context, async (_, args) => { order.push(args); return ok({}); });
  const scope = ordered.scoped(() => true);
  await Promise.all([scope.metadata("p", { source: "a", seq: "1" }), ordered.viewerState("p", "idle", "b", "2"), ordered.releaseViewer("p", "b", "3"), scope.closePane("p")]);
  assert.deepEqual(order.map(args => args[1]), ["report-metadata", "report-agent", "release-agent", "report-metadata", "close"]);
});

test("finding 4: captured installed success and JSON stderr errors parse without ok", async () => {
  // Consumed-field projection of the controller's read-only 0.8.2 capture.
  // Inline so the suite never depends on ignored local artifacts or a live CLI.
  const captured = JSON.stringify({ id: "cli:pane:current", result: { type: "pane_current", pane: { pane_id: "w9:p1", tab_id: "w9:t1", workspace_id: "w9" } } });
  const current = JSON.parse(captured).result.pane;
  const r = runner([captured, ok({ pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } }), Object.assign(new Error("exit 1"), { code: 1, stderr: errorEnvelope("pane_not_found") }), Object.assign(new Error("exit 1"), { code: 1, stderr: errorEnvelope("tab_not_found") }), Object.assign(new Error("exit 1"), { stderr: errorEnvelope("permission_denied", "denied") }), Object.assign(new Error("exit 2"), { stderr: "pane_not_found in prose is not structured" })]);
  const api = createHerdrAdapter(context, r.exec);
  assert.equal((await api.currentPane()).value?.paneId, current.pane_id);
  assert.equal((await api.pane("p")).ok, true);
  assert.equal((await api.pane("gone")).reason, "missing");
  assert.equal((await api.closeTab("gone")).reason, "missing");
  const denied = await api.closePane("p"); assert.equal(denied.reason, "unavailable"); assert.match(denied.error, /denied/);
  assert.equal((await api.closePane("p")).reason, "unavailable");
  for (const response of [{ result: { type: "ok" } }, { id: "x", result: [] }, { id: "x", result: {} }, { id: "x", error: { code: "pane_not_found" } }, { id: "x", result: { type: "ok" }, error: { code: "pane_not_found", message: "bad" } }]) {
    assert.equal((await createHerdrAdapter(context, async () => JSON.stringify(response)).closePane("p")).reason, "invalid");
  }
});

test("finding 5: malformed consumed process/list entries fail closed, not filtered", async () => {
  const valid = { pid: 42, name: "node", argv: viewerArgv };
  for (const bad of [null, {}, { pid: "43", name: "editor" }, { pid: -1, name: "editor" }, { pid: 43, name: 5 }, { pid: 43, name: "editor", argv: ["editor", 7] }, { pid: 43, name: "editor", argv: "editor" }]) {
    const api = createHerdrAdapter(context, async () => ok({ process_info: { pane_id: "p", foreground_processes: [valid, bad] } }));
    assert.equal((await api.processInfo("p")).reason, "invalid", JSON.stringify(bad));
  }
  for (const field of ["shell_pid", "foreground_process_group_id"]) {
    for (const value of ["42", -1, 2.5, 2 ** 32]) assert.equal((await createHerdrAdapter(context, async () => ok({ process_info: { pane_id: "p", foreground_processes: [valid], [field]: value } })).processInfo("p")).reason, "invalid");
  }
  assert.equal((await createHerdrAdapter(context, async () => ok({ process_info: { pane_id: "p", shell_pid: null, foreground_process_group_id: null, foreground_processes: [{ pid: 42, name: "node", argv: null }] } })).processInfo("p")).ok, true);
  const pane = { pane_id: "p", tab_id: "t", workspace_id: "w" };
  for (const bad of [null, {}, { pane_id: "other", tab_id: "t", workspace_id: 3 }]) assert.equal((await createHerdrAdapter(context, async () => ok({ panes: [pane, bad] })).panes("w")).reason, "invalid");
});

test("all same-pane waiting and both release commands reserve shared capacity atomically", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  const api = createHerdrAdapter(context, async (_, args) => { calls.push(args); await gate; return ok({}); });
  const first = api.metadata("p", { source: "a", seq: "1" });
  const pending = Array.from({ length: 31 }, (_, i) => api.scoped(() => true).metadata("p", { source: "b", seq: String(i + 2) }));
  const rejected = api.releaseViewer("p", "b", "33");
  let rejection; void rejected.then(result => { rejection = result; });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(rejection?.reason, "unavailable");
    assert.equal(calls.length, 1);
    // The failed batch did not consume the final pending slot.
    pending.push(api.closePane("p"));
    assert.equal((await api.metadata("p", { source: "c", seq: "34" })).reason, "unavailable");
  } finally { release(); await Promise.all([first, ...pending, rejected]); }
  assert.equal(calls.length, 33);
  assert.equal(calls.at(-1)[1], "close");
  assert.equal(calls.some(args => args[1] === "release-agent"), false);
});

test("scopes skip stale dispatches but retain issued creation IDs for cleanup", async () => {
  let current = true; let calls = 0;
  const early = createHerdrAdapter(context, async () => { calls++; return ok({}); }).scoped(() => current);
  const notIssued = early.closePane("p"); current = false;
  assert.equal((await notIssued).reason, "unavailable");
  assert.equal(calls, 0);
  let release; const gate = new Promise(resolve => { release = resolve; });
  current = true;
  const api = createHerdrAdapter(context, async () => { calls++; await gate; return ok({ tab: { tab_id: "t" }, root_pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } }); });
  const issued = api.scoped(() => current).createTab("w", "/tmp");
  await new Promise(resolve => setImmediate(resolve)); current = false; release();
  assert.deepEqual(await issued, { ok: true, value: { tabId: "t", rootPane: { paneId: "p", tabId: "t", workspaceId: "w" } } });
});

test("failed lifecycle release still clears presentation before raw close", async () => {
  const r = runner([Object.assign(new Error("exit 1"), { stderr: errorEnvelope("permission_denied", "denied") })]);
  const api = createHerdrAdapter(context, r.exec);
  const released = api.scoped(() => true).releaseViewer("p", "viewer-source", "10");
  const closed = api.closePane("p");
  assert.equal((await released).reason, "unavailable"); assert.equal((await closed).ok, true);
  assert.deepEqual(r.calls.map(call => call.args[1]), ["release-agent", "report-metadata", "close"]);
});

test("viewer-only lifecycle report/release uses custom agent, source/seq and limited presentation clearing", async () => {
  const r = runner(); const api = createHerdrAdapter(context, r.exec);
  await api.viewerState("viewer", "working", "viewer-source", "10");
  await api.viewerState("viewer", "idle", "viewer-source", "11");
  await api.releaseViewer("viewer", "viewer-source", "12");
  assert.deepEqual(r.calls.map(call => call.args), [
    ["pane", "report-agent", "viewer", "--source", "viewer-source", "--seq", "10", "--agent", "pi-subagent-viewer", "--state", "working"],
    ["pane", "report-agent", "viewer", "--source", "viewer-source", "--seq", "11", "--agent", "pi-subagent-viewer", "--state", "idle"],
    ["pane", "release-agent", "viewer", "--source", "viewer-source", "--seq", "12", "--agent", "pi-subagent-viewer"],
    ["pane", "report-metadata", "viewer", "--source", "viewer-source", "--seq", "12", "--clear-token", "subagent_summary", "--clear-state-labels"],
  ]);
});
