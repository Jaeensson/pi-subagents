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
  ["runViewer", ["%1", "true"]],
  ["metadata", ["%1", { source: "s", seq: "1" }]],
  ["viewerState", ["%1", "idle", "s", "1"]],
  ["releaseViewer", ["%1", "s", "1"]],
  ["notify", ["title", "body"]],
  ["closePane", ["%1"]],
  ["closeTab", ["@1"]],
];

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

test("at or above the floor every operation is a complete not-implemented stub", async () => {
  const calls = [];
  const exec = async (_b, args, options) => {
    assert.deepEqual(args, ["-S", "/tmp/t", "-V"]);
    assert.ok(options.timeout >= 1000);
    calls.push(args);
    return "tmux 3.7c";
  };
  const adapter = createTmuxAdapter(context, exec);
  for (const [name, args] of operations) {
    const result = await adapter[name](...args);
    assert.equal(result.ok, false, `${name} is still a stub`);
    assert.equal(result.reason, "unavailable");
    assert.equal(result.error, `tmux ${name} is not implemented`);
  }
  assert.equal((await adapter.scoped(() => true).closePane("%1")).reason, "unavailable");
  // The probe runs once and is cached for every operation.
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});

test("a version-probe failure is a bounded unavailable result, not an exception", async () => {
  const adapter = createTmuxAdapter(context, async () => { throw new Error("tmux is not installed"); });
  const result = await adapter.pane("%1");
  assert.deepEqual(result, { ok: false, reason: "unavailable", error: "tmux is not installed" });
});
