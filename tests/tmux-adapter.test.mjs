import assert from "node:assert/strict";
import test from "node:test";
import { getTmuxContext, parseTmuxVersion, createTmuxAdapter } from "../tmux-adapter.ts";

const context = getTmuxContext({ TMUX: "/tmp/t,1,0", TMUX_PANE: "%1" });

// Every MuxAdapter op, with the arguments each one needs.
const operations = [
  ["currentPane", []],
  ["pane", ["%1"]],
  ["processInfo", ["%1"]],
  ["panes", ["$0"]],
  ["createTab", ["$0", "/work"]],
  ["splitPane", ["%1", "right", "/work"]],
  ["runViewer", ["%1", { argv: ["true"], shellCommand: "true" }]],
  ["metadata", ["%1", { source: "s", seq: "1" }]],
  ["viewerState", ["%1", "idle", "s", "1"]],
  ["releaseViewer", ["%1", "s", "1"]],
  ["notify", ["title", "body"]],
  ["closePane", ["%1"]],
  ["closeTab", ["@1"]],
];

// The presentation ops stay unavailable stubs until Task 8 implements them.
const stubs = [
  ["processInfo", ["%1"]],
  ["metadata", ["%1", { source: "s", seq: "1" }]],
  ["viewerState", ["%1", "idle", "s", "1"]],
  ["releaseViewer", ["%1", "s", "1"]],
  ["notify", ["title", "body"]],
];

// Records real commands while answering the version probe with a supported tmux.
const withVersion = (calls, output) => createTmuxAdapter(context, async (_binary, args) => {
  if (args.includes("-V")) return "tmux 3.7c";
  calls.push(args);
  return output;
});

test("tmux context requires TMUX and TMUX_PANE and records the socket", () => {
  assert.equal(getTmuxContext({ TMUX: "/tmp/tmux-1000/default,42,0" }), undefined);
  assert.equal(getTmuxContext({ TMUX_PANE: "%9" }), undefined);
  assert.equal(getTmuxContext({ TMUX: "", TMUX_PANE: "%9" }), undefined);
  assert.deepEqual(getTmuxContext({ TMUX: "/tmp/tmux-1000/default,42,0", TMUX_PANE: "%9" }),
    { backend: "tmux", binary: "tmux", endpoint: "/tmp/tmux-1000/default", callerPaneId: "%9" });
  assert.equal(getTmuxContext({ TMUX: "/tmp/t,1,0", TMUX_PANE: "%9", PI_TMUX_BIN: " /opt/tmux " }).binary, "/opt/tmux");
});

test("tmux version parses plain and next builds", () => {
  assert.deepEqual(parseTmuxVersion("tmux 3.7c"), { major: 3, minor: 7 });
  assert.deepEqual(parseTmuxVersion("tmux next-3.8"), { major: 3, minor: 8 });
  assert.deepEqual(parseTmuxVersion("tmux 3.2"), { major: 3, minor: 2 });
  assert.deepEqual(parseTmuxVersion("tmux 4.0a\n"), { major: 4, minor: 0 });
  assert.equal(parseTmuxVersion("garbage"), undefined);
  assert.equal(parseTmuxVersion(""), undefined);
  assert.equal(parseTmuxVersion("tmux master"), undefined);
});

test("below the 3.2 floor the first operation reports unavailable after only the version probe", async () => {
  const calls = [];
  const exec = async (_b, args) => { calls.push(args); return "tmux 3.1c\n"; };
  const adapter = createTmuxAdapter(context, exec);
  const result = await adapter.currentPane();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.equal(result.error, "tmux 3.1 is below the 3.2 floor");
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});

test("below the 3.2 floor every operation stays unavailable and issues no command but the probe", async () => {
  const calls = [];
  const exec = async (_b, args) => { calls.push(args); return "tmux next-3.1"; };
  const adapter = createTmuxAdapter(context, exec);
  for (const [name, args] of operations) {
    const result = await adapter[name](...args);
    assert.equal(result.ok, false, `${name} should fail below the floor`);
    assert.equal(result.reason, "unavailable", `${name} should be unavailable`);
    assert.equal(result.error, "tmux 3.1 is below the 3.2 floor");
  }
  const scoped = adapter.scoped(() => true);
  assert.equal((await scoped.pane("%1")).reason, "unavailable");
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});

test("an unparseable version is unavailable after only the probe", async () => {
  const calls = [];
  const adapter = createTmuxAdapter(context, async (_b, args) => { calls.push(args); return "tmux master"; });
  const result = await adapter.notify("a", "b");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});

test("at or above the floor the presentation operations remain complete not-implemented stubs", async () => {
  const calls = [];
  const exec = async (_b, args, options) => {
    assert.deepEqual(args, ["-S", "/tmp/t", "-V"]);
    assert.ok(options.timeout >= 1000);
    calls.push(args);
    return "tmux 3.7c";
  };
  const adapter = createTmuxAdapter(context, exec);
  for (const [name, args] of stubs) {
    const result = await adapter[name](...args);
    assert.equal(result.ok, false, `${name} is still a stub`);
    assert.equal(result.reason, "unavailable");
    assert.equal(result.error, `tmux ${name} is not implemented`);
  }
  assert.equal((await adapter.scoped(() => true).notify("a", "b")).reason, "unavailable");
  // The probe runs once and is cached for every operation.
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});

test("a version-probe failure is a bounded unavailable result, not an exception", async () => {
  const adapter = createTmuxAdapter(context, async () => { throw new Error("tmux is not installed"); });
  const result = await adapter.pane("%1");
  assert.deepEqual(result, { ok: false, reason: "unavailable", error: "tmux is not installed" });
});

test("currentPane prints the caller pane triple through the socket", async () => {
  const calls = [];
  const adapter = createTmuxAdapter(context, async (_binary, args) => {
    if (args.includes("-V")) return "tmux 3.7c";
    calls.push(args);
    return "%3 @4 $0";
  });
  assert.deepEqual((await adapter.currentPane()).value, { paneId: "%3", tabId: "@4", workspaceId: "$0" });
  assert.deepEqual(calls.at(-1), ["-S", "/tmp/t", "display-message", "-p", "-t", "%1", "#{pane_id} #{window_id} #{session_id}"]);
  assert.deepEqual((await adapter.currentPane("%2")).value, { paneId: "%3", tabId: "@4", workspaceId: "$0" });
  assert.deepEqual(calls.at(-1), ["-S", "/tmp/t", "display-message", "-p", "-t", "%2", "#{pane_id} #{window_id} #{session_id}"]);
});

test("pane asserts the returned pane id matches the requested pane", async () => {
  const calls = [];
  const adapter = withVersion(calls, "%3 @4 $0");
  assert.deepEqual((await adapter.pane("%3")).value, { paneId: "%3", tabId: "@4", workspaceId: "$0" });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "display-message", "-p", "-t", "%3", "#{pane_id} #{window_id} #{session_id}"]);
  const mismatch = withVersion([], "%9 @4 $0");
  const result = await mismatch.pane("%3");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("panes lists every pane in the session", async () => {
  const calls = [];
  const adapter = withVersion(calls, "%1 @2 $0\n%3 @4 $0\n");
  assert.deepEqual((await adapter.panes("$0")).value, [
    { paneId: "%1", tabId: "@2", workspaceId: "$0" },
    { paneId: "%3", tabId: "@4", workspaceId: "$0" },
  ]);
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "list-panes", "-s", "-t", "$0", "-F", "#{pane_id} #{window_id} #{session_id}"]);
});

test("createTab creates a detached window and reports its root pane", async () => {
  const calls = [];
  const adapter = withVersion(calls, "@7 %8");
  const result = await adapter.createTab("$0", "/work");
  assert.deepEqual(result.value, { tabId: "@7", rootPane: { paneId: "%8", tabId: "@7", workspaceId: "$0" } });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "new-window", "-d", "-t", "$0:", "-c", "/work", "-n", "Subagents", "-P", "-F", "#{window_id} #{pane_id}"]);
});

test("splitPane detaches in the requested direction and resolves the pane triple", async () => {
  const calls = [];
  const adapter = createTmuxAdapter(context, async (_binary, args) => {
    if (args.includes("-V")) return "tmux 3.7c";
    calls.push(args);
    return args.includes("split-window") ? "%9" : "%9 @7 $0";
  });
  assert.deepEqual((await adapter.splitPane("%8", "right", "/work")).value, { paneId: "%9", tabId: "@7", workspaceId: "$0" });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "split-window", "-d", "-h", "-t", "%8", "-c", "/work", "-P", "-F", "#{pane_id}"]);
  assert.deepEqual(calls[1], ["-S", "/tmp/t", "display-message", "-p", "-t", "%9", "#{pane_id} #{window_id} #{session_id}"]);
  assert.deepEqual((await adapter.splitPane("%8", "down", "/work")).value, { paneId: "%9", tabId: "@7", workspaceId: "$0" });
  assert.deepEqual(calls[2], ["-S", "/tmp/t", "split-window", "-d", "-v", "-t", "%8", "-c", "/work", "-P", "-F", "#{pane_id}"]);
});

test("runViewer respawns with direct argv, never a shell string", async () => {
  const calls = [];
  const adapter = withVersion(calls, "");
  const result = await adapter.runViewer("%8", { argv: ["/n/node", "/mux-viewer.mjs", "--slot", "0"], shellCommand: "/n/node '/mux-viewer.mjs' --slot '0'" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "respawn-pane", "-k", "-t", "%8", "/n/node", "/mux-viewer.mjs", "--slot", "0"]);
});

test("closePane and closeTab kill the exact pane and window", async () => {
  const calls = [];
  const adapter = withVersion(calls, "");
  assert.equal((await adapter.closePane("%8")).ok, true);
  assert.equal((await adapter.closeTab("@7")).ok, true);
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "kill-pane", "-t", "%8"]);
  assert.deepEqual(calls[1], ["-S", "/tmp/t", "kill-window", "-t", "@7"]);
});

test("a vanished pane target is reported as missing", async () => {
  const adapter = createTmuxAdapter(context, async (_binary, args) => {
    if (args.includes("-V")) return "tmux 3.7c";
    throw Object.assign(new Error("Command failed: tmux display-message\ncan't find pane: %9"), { stderr: "can't find pane: %9" });
  });
  const result = await adapter.currentPane("%9");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
});
