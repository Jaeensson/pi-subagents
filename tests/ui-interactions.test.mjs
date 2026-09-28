import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(os.tmpdir(), "subagent-ui-"));
process.env.HOME = home;
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
const { tasks, jobs, incRunningCount, clearRegistry } = await import("../runtime.ts");
const { setUi, updateStatusWidget, disposeWidget } = await import("../tui.ts");
const { toggleWatch, disposeWatch } = await import("../watch.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

function commandHarness(mode = "tui") {
  let handler;
  const notices = [];
  let component;
  let done;
  const pi = { registerCommand: (_name, command) => { handler = command.handler; } };
  registerSubagentsCommand(pi);
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

test("/subagents reports that RPC/print modes cannot host its terminal dialog", async () => {
  const h = commandHarness("rpc");
  await h.invoke();
  assert.match(h.notices[0].message, /requires TUI mode/i);
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

test.after(() => rmSync(home, { recursive: true, force: true }));
