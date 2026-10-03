import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "subagent-ui-"));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH"]) delete process.env[key];
mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
  defaultModel: "sonnet",
  subagent: { modelTiers: { fast: "anthropic/haiku" } },
}));

const codingAgent = await import("@earendil-works/pi-coding-agent");
codingAgent.initTheme();
const { registerSubagentsCommand } = await import("../command-subagents.ts");
const { TraceRenderer } = await import("../watch-render.ts");
const { emptyLiveTrace } = await import("../live.ts");
const { tasks, jobs, incRunningCount, clearRegistry, notifyStatusChanged, setStatusChangedHook } = await import("../runtime.ts");
const { default: subagentExtension } = await import("../index.ts");
const { setUi, updateStatusWidget, disposeWidget } = await import("../tui.ts");
const { toggleWatch, disposeWatch } = await import("../watch.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

function commandHarness(mode = "tui", onHerdrOptionsChange) {
  let handler;
  const notices = [];
  let component;
  let done;
  const pi = { registerCommand: (_name, command) => { handler = command.handler; } };
  registerSubagentsCommand(pi, onHerdrOptionsChange);
  const ctx = {
    mode,
    hasUI: true,
    model: { id: "sonnet" },
    scopedModels: [],
    modelRegistry: { getAvailable: () => [
      { id: "sonnet", provider: "anthropic", cost: { input: 3 }, contextWindow: 100000 },
      { id: "haiku", provider: "anthropic", cost: { input: 1 }, contextWindow: 100000 },
    ] },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      custom: (factory) => new Promise((resolve) => {
        done = resolve;
        component = factory({ requestRender() {} }, theme, {}, resolve);
      }),
    },
  };
  return { invoke: () => handler("", ctx), notices, component: () => component, done: (v) => done?.(v) };
}

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  dim: (text) => text,
};

test.beforeEach(() => writeFileSync(path.join(home, ".pi", "agent", "settings.json"), JSON.stringify({
  defaultModel: "sonnet", subagent: { modelTiers: { fast: "anthropic/haiku" } },
})));

test("picker arrows do not retarget ctrl-alt-l after cancel", async () => {
  const h = commandHarness();
  const running = h.invoke();
  const component = h.component();
  component.handleInput("\x1b[B"); // select fast
  component.handleInput("\r"); // open its model picker
  component.handleInput("\x1b[B"); // move inside picker
  component.handleInput("\x1b"); // cancel back to fast row
  component.handleInput("\x1b[108;7u"); // ctrl+alt+l
  component.handleInput("\x1b"); // close settings
  await running;
  const saved = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.equal(saved.subagent?.modelTiers?.fast, undefined);
  assert.equal(h.notices.some((n) => n.message.includes("Highlight a tier row")), false);
});

test("Herdr preferences persist and notify only after a successful save", async () => {
  const changes = [];
  const h = commandHarness("tui", (next) => {
    const saved = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
    assert.deepEqual(saved.subagent.herdr, next, "callback runs only after persistence");
    changes.push(next);
  });
  const running = h.invoke();
  const component = h.component();
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[B"); // Herdr monitoring row
  assert.match(component.render(100).join("\n"), /Herdr monitoring/);
  component.handleInput(" ");
  component.handleInput("\x1b");
  await running;
  const saved = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
  assert.deepEqual(changes, [{ enabled: false, viewers: true }]);
  assert.equal(saved.subagent.herdr.enabled, false);
  assert.equal(saved.subagent.herdr.viewers, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, false);
});

test("Herdr rows survive auto-tier toggles and clearing on a Herdr row preserves tier mappings", async () => {
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  const previous = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(previous);
  settings.subagent.modelTiers = { auto: true, fast: "anthropic/haiku" };
  writeFileSync(settingsPath, JSON.stringify(settings));
  const h = commandHarness();
  const running = h.invoke();
  const component = h.component();
  assert.match(component.render(100).join("\n"), /Herdr monitoring/);
  component.handleInput("\r"); // toggle auto off; tier rows appear
  assert.match(component.render(100).join("\n"), /Herdr monitoring/);
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[B"); // Herdr monitoring after tiers
  component.handleInput("\x1b[108;7u"); // must not clear a model tier
  component.handleInput("\x1b");
  await running;
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(after.subagent.modelTiers.fast, "anthropic/haiku");
  writeFileSync(settingsPath, previous);
});

test("failed Herdr preference writes do not invoke the active-options callback", async () => {
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  const previous = readFileSync(settingsPath, "utf8");
  writeFileSync(settingsPath, "not json");
  const changes = [];
  const h = commandHarness("tui", (next) => changes.push(next));
  const running = h.invoke();
  const component = h.component();
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[B");
  component.handleInput(" ");
  h.done(true); // baseline lacks the Herdr row; never hang while asserting its missing behavior
  await running;
  assert.equal(changes.length, 0);
  assert.match(h.notices[0].message, /Could not save settings/);
  writeFileSync(settingsPath, previous);
});

// Break caught: tying viewers to monitoring or treating Herdr rows as tier-picker submenus.
test("viewer preference saves independently and remains visible when monitoring is disabled", async () => {
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ subagent: { modelTiers: { auto: true, fast: "anthropic/haiku" }, herdr: { enabled: false, viewers: true } } }));
  const changes = [];
  const h = commandHarness("tui", next => changes.push(next));
  const running = h.invoke(), component = h.component();
  assert.match(component.render(100).join("\n"), /Herdr viewers/);
  component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); // viewers with tiers hidden
  assert.match(component.render(100).join("\n"), /disabled|inactive/i);
  component.handleInput("\r"); // must toggle, never enter a tier submenu
  component.handleInput("\x1b[108;7u"); // Herdr highlight cannot clear fast
  component.handleInput("\x1b"); await running;
  assert.deepEqual(changes, [{ enabled: false, viewers: false }]);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.deepEqual(saved.subagent.herdr, { enabled: false, viewers: false });
  assert.equal(saved.subagent.modelTiers.fast, "anthropic/haiku");
});

// Break caught: mutating dialog preferences despite a failed save.
test("failed viewer save preserves the displayed active preference and stored independent switches", async () => {
  const settingsPath = path.join(home, ".pi", "agent", "settings.json");
  const original = JSON.stringify({ subagent: { herdr: { enabled: true, viewers: true } } });
  writeFileSync(settingsPath, original);
  const changes = [], h = commandHarness("tui", next => changes.push(next));
  const running = h.invoke(), component = h.component();
  for (let i = 0; i < 5; i++) component.handleInput("\x1b[B");
  const before = component.render(100).join("\n");
  assert.match(before, /Herdr viewers/);
  // A corrupt concurrent write is rejected, not overwritten.
  writeFileSync(settingsPath, "not json");
  component.handleInput(" ");
  assert.equal(component.render(100).join("\n"), before, "active preferences stay unchanged on failed persistence");
  assert.deepEqual(changes, []);
  assert.equal(readFileSync(settingsPath, "utf8"), "not json");
  h.done(true); await running;
  writeFileSync(settingsPath, original);
});

test("/subagents reports that RPC/print modes cannot host its terminal dialog", async () => {
  const h = commandHarness("rpc");
  let warning = "";
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { warning += String(chunk); return true; };
  try { await h.invoke(); } finally { process.stderr.write = originalWrite; }
  assert.match(warning, /requires TUI mode/i);
  assert.equal(h.component(), undefined);
});

test("trace renderer invalidation rebuilds cached markdown after theme changes", () => {
  let color = "old";
  const renderer = new TraceRenderer({
    width: 20,
    style: (token, text) => `${color}:${token}:${text}`,
    formatToolCall: () => "",
    markdownTheme: {
      heading: (text) => `${color}:${text}`,
      link: (text) => text, linkUrl: (text) => text, code: (text) => text,
      codeBlock: (text) => text, codeBlockBorder: (text) => text, quote: (text) => text,
      quoteBorder: (text) => text, hr: (text) => text, listBullet: (text) => text,
      bold: (text) => text, italic: (text) => text, strikethrough: (text) => text,
      underline: (text) => text,
    },
  });
  const trace = emptyLiveTrace();
  trace.segments.push({ kind: "text", text: "# cached words" });
  const before = renderer.lines(trace).join("\n");
  color = "new";
  renderer.invalidate();
  const after = renderer.lines(trace).join("\n");
  assert.notEqual(after, before);
  assert.match(after, /new/);
});

test("watch overlay lines fit narrow widths with wide Unicode", () => {
  const themeProxy = { fg: (_color, text) => text, bold: (text) => text };
  let widget;
  const tui = {
    terminal: { rows: 30, columns: 80 },
    requestRender() {},
    showOverlay(component) { this.component = component; return { hide() {} }; },
  };
  const task = {
    id: "ui-width-test", jobId: "ui-width-job", agent: "漢字🙂", task: "watch wide text",
    status: "running", dispatchState: "running", startedAt: Date.now(), messages: [],
    live: { ...emptyLiveTrace(), pending: { kind: "text", text: "🙂漢字界 wide words" } },
    usage: { contextTokens: 0 }, model: "model", contextWindow: 1000,
  };
  tasks.set(task.id, task);
  jobs.set(task.jobId, { id: task.jobId, status: "running", mode: "single" });
  incRunningCount();
  setUi({ setWidget(_key, factory) { widget = factory?.(tui, themeProxy); } });
  updateStatusWidget();
  assert.match(widget.render(80).join("\n"), /running/);
  task.dispatchState = "queued";
  assert.match(widget.render(80).join("\n"), /queued/);
  toggleWatch();
  assert.match(tui.component.render(80).join("\n"), /queued/);
  tui.component.invalidate();
  for (const width of [1, 2, 3, 4, 5, 7, 11, 20]) {
    for (const line of tui.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)} (${visibleWidth(line)})`);
    }
  }
  disposeWatch();
  disposeWidget();
  clearRegistry();
});

test("task status changes register the widget and make ctrl-alt-s open the watch pane", async () => {
  const hooks = new Map();
  let widget;
  let terminalInput;
  let overlay;
  const tui = {
    terminal: { rows: 30, columns: 80 },
    requestRender() {},
    showOverlay(component) { overlay = component; return { hide() {} }; },
  };
  const ui = {
    onTerminalInput(handler) { terminalInput = handler; },
    setWidget(_key, factory) { widget = factory?.(tui, theme); },
  };
  subagentExtension({
    on(event, handler) { hooks.set(event, handler); },
    registerMessageRenderer() {},
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
  });
  await hooks.get("session_start")(
    { reason: "startup" },
    { hasUI: true, sessionManager: { getSessionId: () => "watch-hook-test" }, ui },
  );
  const task = {
    id: "watch-hook-task", jobId: "watch-hook-job", agent: "worker", task: "follow progress",
    status: "running", dispatchState: "running", startedAt: Date.now(), messages: [], live: emptyLiveTrace(),
    usage: { contextTokens: 0 }, model: "model", contextWindow: 1000,
  };
  tasks.set(task.id, task);
  jobs.set(task.jobId, { id: task.jobId, status: "running", mode: "single" });
  incRunningCount();

  try {
    notifyStatusChanged();
    assert.ok(widget, "a running task must register the status widget");
    assert.match(widget.render(80).join("\n"), /ctrl\+alt\+s to watch/);
    terminalInput("\x1b[115;7u");
    assert.ok(overlay, "ctrl-alt-s must open the live watch pane");
    assert.match(overlay.render(80).join("\n"), /worker/);
  } finally {
    disposeWatch();
    disposeWidget();
    clearRegistry();
    setStatusChangedHook(undefined);
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
