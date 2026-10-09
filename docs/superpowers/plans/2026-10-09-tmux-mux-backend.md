# tmux mux backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tmux as a display-only multiplexer backend for pi-subagent by refactoring the existing Herdr subsystem into a shared `mux-*` layer and implementing a tmux `MuxAdapter`.

**Architecture:** The Herdr monitor, viewer pool, snapshot store, snapshot DTO, renderer, and standalone viewer are already backend-agnostic; only detection, command translation, and viewer-launch construction are Herdr-specific. Rename the generic modules to `mux-*`, extract a `MuxAdapter` interface plus a shared bounded command queue, and add `tmux-adapter.ts`. Subagents stay piped `pi --mode json` children; tmux is observability only.

**Tech Stack:** TypeScript (erasable-syntax), Node `node:test`, tmux CLI (floor 3.2).

**Spec:** `docs/superpowers/specs/2026-10-09-tmux-mux-backend-design.md`

## Global Constraints

- tmux floor is **3.2**; parse `tmux -V`, tolerate `tmux next-*`, disable with one warning below the floor.
- Every tmux command passes `-S <socket-from-$TMUX>`; never touch another tmux server.
- Settings keep `subagent.herdr` verbatim; add `subagent.tmux { enabled, viewers }`. All four default `true`; only booleans accepted.
- Outside a multiplexer: no commands, viewer processes, files, or timers.
- Format values: strip control characters, escape every `#` to `##`. Values are written into tmux user options that formats expand.
- No `remain-on-exit`; viewers self-heal.
- Detection precedence: `PI_SUBAGENT_MUX` override → Herdr → tmux.
- Subagents remain piped children; never host them as interactive pane processes.
- `core.ts`-style purity: `mux-core.ts`, `mux-adapter.ts`, `mux-files.ts`, `mux-detection.ts`, `mux-settings.ts` use erasable TypeScript and no runtime pi imports.
- The dependency graph stays acyclic; each task ends with `npm test` and `npm run typecheck` green and one commit.
- Do not stage `flake.lock` or `openspec/`; stage only the files a task names.

## Review Focus

Inputs/conditions the spec implies but no task's product code names, most likely to bite a user first. Each has a test in the owning task.

1. **tmux older than 3.2** → one bounded warning, monitoring off, no viewers/files/timers. (Task 6)
2. **A user-option value containing `#(...)` or `#{...}`** → rendered literally, never executed. (Task 8)
3. **`$TMUX` set but `$TMUX_PANE` absent/empty** → inert, no commands. (Task 6)
4. **A second tmux server running** → never touched; all commands use `-S`. (Task 7, Task 11)
5. **Both Herdr and tmux environments present** → Herdr wins. (Task 4)
6. **The user closes a viewer pane mid-run** → that attempt's slot is relinquished, not recreated; later attempts may reuse a fresh transport. (Task 9)

---

## Task 1: Rename generic modules to `mux-*` (behavior-preserving)

**Files:**
- Rename: `herdr-core.ts`→`mux-core.ts`, `herdr-files.ts`→`mux-files.ts`, `herdr-viewers.ts`→`mux-viewers.ts`, `herdr-monitor.ts`→`mux-monitor.ts`, `herdr-viewer.mjs`→`mux-viewer.mjs`, `herdr-viewer-render.mjs`→`mux-viewer-render.mjs`
- Rename tests: `herdr-core.test.mjs`→`mux-core.test.mjs`, `herdr-files.test.mjs`→`mux-files.test.mjs`, `herdr-viewers.test.mjs`→`mux-viewers.test.mjs`, `herdr-monitor.test.mjs`→`mux-monitor.test.mjs`, `herdr-viewer.test.mjs`→`mux-viewer.test.mjs`, `herdr-viewer-render.test.mjs`→`mux-viewer-render.test.mjs`
- Modify: `index.ts`, `command-subagents.ts`, `scripts/herdr-monitor-smoke-driver.mjs`, `scripts/herdr-monitor-smoke.mjs`, all renamed modules and renamed tests (import paths only)

**Interfaces:**
- Consumes: nothing new.
- Produces: identical exports under new module names. `herdr-adapter.ts` and `herdr-settings.ts` keep their names and exports for now.

- [ ] **Step 1: Rename the six source modules and six test modules** with `git mv` (exact pairs above).
- [ ] **Step 2: Rewrite module specifiers** in the renamed files: `./herdr-core.ts`→`./mux-core.ts`, `./herdr-files.ts`→`./mux-files.ts`, `./herdr-viewers.ts`→`./mux-viewers.ts`, `./herdr-monitor.ts`→`./mux-monitor.ts`, `./herdr-viewer-render.mjs`→`./mux-viewer-render.mjs`; in `mux-viewers.ts` change the `new URL("./herdr-viewer.mjs", import.meta.url)` to `mux-viewer.mjs`; in `index.ts`, `command-subagents.ts`, both smoke scripts, and every renamed test, replace the module names.
- [ ] **Step 3: Verify the rename is complete**

Run: `grep -rn "herdr-core\|herdr-files\|herdr-viewers\|herdr-monitor\|herdr-viewer" --include="*.ts" --include="*.mjs" . | grep -v node_modules | grep -v herdr-adapter | grep -v herdr-settings`
Expected: only `herdr-monitor-smoke*` script filenames and comments, no code imports of the old generic modules.

- [ ] **Step 4: Run the suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS with no test logic changed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename generic Herdr modules to mux-*"
```

---

## Task 2: Extract `mux-adapter.ts` and rename the context type

**Files:**
- Create: `mux-adapter.ts`
- Modify: `mux-core.ts`, `herdr-adapter.ts`, `mux-monitor.ts`, `mux-viewers.ts`, `index.ts`

**Interfaces:**
- Consumes: `PaneRef`, `ViewerIdentity` from `mux-core.ts`.
- Produces:
  - `export type MuxBackend = "herdr" | "tmux"`
  - `export interface MuxContext { backend: MuxBackend; binary: string; endpoint: string; callerPaneId: string }` (in `mux-core.ts`)
  - `export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "unavailable" | "invalid"; error: string }`
  - `export interface ProcessInfo { paneId: string; shellPid?: number; foregroundProcessGroupId?: number; foregroundProcesses: Array<{ pid: number; name: string; argv?: string[] }> }`
  - `export interface MetadataPatch { source: string; seq: string; ttlMs?: number; tokens?: Record<string, string | null>; stateLabels?: Partial<Record<"idle"|"working"|"blocked"|"done"|"unknown", string>>; clearStateLabels?: boolean }`
  - `export interface MuxAdapter { currentPane(callerPaneId?: string): Promise<ApiResult<PaneRef>>; pane(id: string): Promise<ApiResult<PaneRef>>; processInfo(id: string): Promise<ApiResult<ProcessInfo>>; panes(workspaceId: string): Promise<ApiResult<PaneRef[]>>; createTab(workspaceId: string, cwd: string): Promise<ApiResult<{ tabId: string; rootPane: PaneRef }>>; splitPane(id: string, direction: "right" | "down", cwd: string): Promise<ApiResult<PaneRef>>; runViewer(id: string, command: string): Promise<ApiResult<void>>; metadata(id: string, patch: MetadataPatch): Promise<ApiResult<void>>; viewerState(id: string, state: "idle" | "working", source: string, seq: string): Promise<ApiResult<void>>; releaseViewer(id: string, source: string, seq: string): Promise<ApiResult<void>>; notify(title: string, body: string): Promise<ApiResult<void>>; closePane(id: string): Promise<ApiResult<void>>; closeTab(id: string): Promise<ApiResult<void>>; scoped(isCurrent: () => boolean): MuxAdapter }`
  - `export function classifyOccupant(processInfo: ProcessInfo, identity: ViewerIdentity, expectedScript: string, now: number): "owned" | "foreign" | "unknown"`

- [ ] **Step 1: Create `mux-adapter.ts`** moving `ApiResult`, `ProcessInfo`, `MetadataPatch`, and `classifyOccupant` out of `herdr-adapter.ts`, and declaring `MuxAdapter`. Rename `HerdrAdapter`→`MuxAdapter`, `HerdrContext`→`MuxContext` (declare `MuxContext` in `mux-core.ts`); keep `HerdrExec` in `herdr-adapter.ts`.
- [ ] **Step 2: Update consumers**: `herdr-adapter.ts` implements `MuxAdapter` and imports these from `mux-adapter.ts`; `mux-monitor.ts` and `mux-viewers.ts` import `MuxAdapter`/`ApiResult`/`ProcessInfo`/`MetadataPatch` from `mux-adapter.ts` and `MuxContext` from `mux-core.ts`; `index.ts` unchanged behavior.
- [ ] **Step 3: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS; no behavioral test changed.

- [ ] **Step 4: Commit**

```bash
git add mux-adapter.ts mux-core.ts herdr-adapter.ts mux-monitor.ts mux-viewers.ts index.ts
git commit -m "refactor: extract MuxAdapter interface and shared mux types"
```

---

## Task 3: Extract the shared bounded command queue

**Files:**
- Modify: `mux-adapter.ts`, `herdr-adapter.ts`
- Test: `tests/mux-adapter.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function createCommandQueue(limit?: number, capacity?: number): CommandQueue` where `interface CommandQueue { schedule<T>(work: Array<() => Promise<T>>, stale: () => boolean, key?: string): Promise<T[]> }`. Defaults `limit = 4`, `capacity = 32`. Stale admits are rejected with an error carrying `stale: true`; capacity overflow throws an error carrying `unavailable: true`.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createCommandQueue } from "../mux-adapter.ts";

test("command queue bounds four active and thirty-two pending", async () => {
  const q = createCommandQueue();
  const gates = Array.from({ length: 36 }, () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; });
  let started = 0;
  const calls = gates.map(g => q.schedule([async () => { started++; return g.p; }], () => false));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started, 4);
  await assert.rejects(() => calls[35], e => e.unavailable === true);
});

test("command queue skips stale work at admit and before dispatch", async () => {
  const q = createCommandQueue();
  let stale = true;
  await assert.rejects(() => q.schedule([async () => 1], () => stale), e => e.stale === true);
  stale = false;
  const ran = q.schedule([async () => 42], () => false, "pane-1");
  stale = true;
  assert.deepEqual(await ran, [42]);
});

test("command queue serializes one key and keeps others concurrent", async () => {
  const q = createCommandQueue();
  const order = [];
  const a = q.schedule([async () => { order.push("a1"); await new Promise(r => setTimeout(r, 5)); order.push("a2"); }], () => false, "p");
  const b = q.schedule([async () => { order.push("b1"); }], () => false, "p");
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a1", "a2", "b1"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mux-adapter.test.mjs`
Expected: FAIL — `createCommandQueue` is not exported.

- [ ] **Step 3: Move the queue into `createCommandQueue`** by lifting the existing closure in `createHerdrAdapter` (`active`, `queue`, `activeKeys`, `dispatch`, `schedule`, `staleError`) verbatim into `mux-adapter.ts`, parameterized by `limit` and `capacity`. Keep `herdr-adapter.ts` calling `queue.schedule(commands.map(args => () => invoke(args)), stale, key)` exactly as today so the existing scheduler tests in `tests/herdr-adapter.test.mjs` remain the behavior gate.
- [ ] **Step 4: Run the new test and the existing adapter tests**

Run: `node --test tests/mux-adapter.test.mjs tests/herdr-adapter.test.mjs`
Expected: PASS, including the pre-existing "bounds active work and rejects excess queued work" and "same-pane waiters count toward shared32" tests.

- [ ] **Step 5: Commit**

```bash
git add mux-adapter.ts herdr-adapter.ts tests/mux-adapter.test.mjs
git commit -m "refactor: extract shared bounded command queue"
```

---

## Task 4: `mux-detection.ts` and the monitor `detect` port

**Files:**
- Create: `mux-detection.ts`, `tests/mux-detection.test.mjs`
- Modify: `herdr-adapter.ts` (move `getHerdrContext` here), `mux-core.ts` (remove `getHerdrContext`), `mux-monitor.ts`, `index.ts`, `mux-core.test.mjs`

**Interfaces:**
- Consumes: `MuxContext` from `mux-core.ts`.
- Produces:
  - `export function getHerdrContext(env: NodeJS.ProcessEnv): MuxContext | undefined` (now in `herdr-adapter.ts`, returns `{ backend: "herdr", … }`)
  - `export function detectMux(env: NodeJS.ProcessEnv): { backend: MuxBackend; context: MuxContext } | undefined` in `mux-detection.ts`
  - `MonitorDeps` replaces `adapterFactory: (context: HerdrContext) => HerdrAdapter` with `detect: typeof detectMux` and `adapterFactory: (context: MuxContext) => MuxAdapter`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { detectMux } from "../mux-detection.ts";

test("herdr wins when both environments are present", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/s", TMUX: "/tmp/t,1,0", TMUX_PANE: "%9" };
  assert.equal(detectMux(env)?.backend, "herdr");
});

test("no multiplexer environment resolves to undefined", () => {
  assert.equal(detectMux({}), undefined);
  assert.equal(detectMux({ TMUX: "/tmp/t,1,0" }), undefined); // TMUX without TMUX_PANE
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mux-detection.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mux-detection.ts`** — Herdr branch only for now: `PI_SUBAGENT_MUX` override, then `getHerdrContext(env)`, returning `{ backend: "herdr", context }`; else `undefined`. Move `getHerdrContext` from `mux-core.ts` to `herdr-adapter.ts` and have it set `backend: "herdr"`. Change `mux-monitor.ts` `activate()` to call `deps.detect(deps.env)` and pass `context` to `deps.adapterFactory`. Update `index.ts` to pass `detect: detectMux`.
- [ ] **Step 4: Move the context-gate test** from `mux-core.test.mjs` to `mux-detection.test.mjs` (Herdr branch), then run

Run: `node --test tests/mux-detection.test.mjs tests/mux-monitor.test.mjs tests/herdr-extension.test.mjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mux-detection.ts herdr-adapter.ts mux-core.ts mux-monitor.ts index.ts tests/mux-detection.test.mjs tests/mux-core.test.mjs
git commit -m "refactor: add detectMux port and move Herdr context detection"
```

---

## Task 5: `mux-settings.ts` for both backends

**Files:**
- Create: `mux-settings.ts`, `tests/mux-settings.test.mjs`
- Delete: `herdr-settings.ts`, `tests/herdr-settings.test.mjs`
- Modify: `mux-monitor.ts`, `command-subagents.ts`, `index.ts`

**Interfaces:**
- Consumes: `MuxBackend` from `mux-adapter.ts`, `WriteSettingsResult`/`readSettingsJson`/`updateSettingsJson` from `settings.ts`.
- Produces:
  - `export type MuxOptions = { enabled: boolean; viewers: boolean }`
  - `export type MuxSettings = Record<MuxBackend, MuxOptions>`
  - `export function readMuxSettings(settingsPath: string): MuxSettings`
  - `export function writeMuxOptions(settingsPath: string, backend: MuxBackend, options: MuxOptions): WriteSettingsResult`
  - `MuxMonitor.start(sessionId: string, cwd: string, settings: MuxSettings): void` and `applyOptions(settings: MuxSettings): void`

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMuxSettings, writeMuxOptions } from "../mux-settings.ts";

test("mux settings default each backend's invalid values on", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mux-settings-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ subagent: { herdr: { enabled: "yes" }, tmux: { viewers: 0 } } }));
  assert.deepEqual(readMuxSettings(file), { herdr: { enabled: true, viewers: true }, tmux: { enabled: true, viewers: true } });
});

test("writeMuxOptions writes one backend and preserves the other, tiers, and unknown keys", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mux-settings-"));
  const file = path.join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ subagent: { modelTiers: { fast: "m" }, herdr: { enabled: false, viewers: false, custom: 1 }, tmux: { enabled: true, viewers: true } } }));
  assert.equal(writeMuxOptions(file, "tmux", { enabled: true, viewers: false }).ok, true);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.subagent.tmux, { enabled: true, viewers: false });
  assert.equal(saved.subagent.herdr.enabled, false);
  assert.equal(saved.subagent.herdr.custom, 1);
  assert.deepEqual(saved.subagent.modelTiers, { fast: "m" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mux-settings.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mux-settings.ts`** by generalizing `herdr-settings.ts`: read `subagent.herdr` and `subagent.tmux`, normalize each with the existing boolean fallbacks, and write only the named backend's key while preserving siblings. Delete `herdr-settings.ts` and its test; update `mux-monitor.ts` to use `MuxOptions`/`MuxSettings` (pick `settings[context.backend]`), and `index.ts` to read `readMuxSettings` once and pass it to `start`. Update `command-subagents.ts` imports to `mux-settings.ts` (the Herdr rows keep working; tmux rows come in Task 9).
- [ ] **Step 4: Run**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mux-settings.ts tests/mux-settings.test.mjs mux-monitor.ts command-subagents.ts index.ts
git rm herdr-settings.ts tests/herdr-settings.test.mjs
git commit -m "refactor: generalize settings to mux-settings for both backends"
```

---

## Task 6: tmux detection and version floor

**Files:**
- Create: `tmux-adapter.ts`, `tests/tmux-adapter.test.mjs`
- Modify: `mux-detection.ts`, `tests/mux-detection.test.mjs`

**Interfaces:**
- Consumes: `MuxContext`, `MuxBackend` from `mux-core.ts`/`mux-adapter.ts`; `ApiResult` from `mux-adapter.ts`.
- Produces:
  - `export function getTmuxContext(env: NodeJS.ProcessEnv): MuxContext | undefined` — requires `TMUX` and `TMUX_PANE`; `endpoint` is the socket path (first `$TMUX` field); `binary` is `env.PI_TMUX_BIN?.trim() || "tmux"`.
  - `export function parseTmuxVersion(output: string): { major: number; minor: number } | undefined`
  - `export type TmuxExec = (binary: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<string>`
  - `export function createTmuxAdapter(context: MuxContext, exec?: TmuxExec): MuxAdapter` (only the version probe and `unavailable` behavior in this task; remaining ops in Tasks 7–8)

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { getTmuxContext, parseTmuxVersion, createTmuxAdapter } from "../tmux-adapter.ts";

test("tmux context requires TMUX and TMUX_PANE and records the socket", () => {
  assert.equal(getTmuxContext({ TMUX: "/tmp/tmux-1000/default,42,0" }), undefined);
  assert.deepEqual(getTmuxContext({ TMUX: "/tmp/tmux-1000/default,42,0", TMUX_PANE: "%9" }),
    { backend: "tmux", binary: "tmux", endpoint: "/tmp/tmux-1000/default", callerPaneId: "%9" });
});

test("tmux version parses plain and next builds", () => {
  assert.deepEqual(parseTmuxVersion("tmux 3.7c"), { major: 3, minor: 7 });
  assert.deepEqual(parseTmuxVersion("tmux next-3.8"), { major: 3, minor: 8 });
  assert.equal(parseTmuxVersion("garbage"), undefined);
});

test("below the 3.2 floor the first operation reports unavailable after only the version probe", async () => {
  const calls = [];
  const exec = async (_b, args) => { calls.push(args); return "tmux 3.1c\n"; };
  const adapter = createTmuxAdapter(getTmuxContext({ TMUX: "/tmp/t,1,0", TMUX_PANE: "%1" }), exec);
  const result = await adapter.currentPane();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
  assert.deepEqual(calls, [["-S", "/tmp/t", "-V"]]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tmux-adapter.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement detection and the guarded adapter shell.** All tmux commands are `["-S", context.endpoint, ...args]`. On first operation, run `["-S", endpoint, "-V"]`, parse, cache `supported`; below floor return `{ ok:false, reason:"unavailable", error:"tmux <v> is below the 3.2 floor" }` for every op. Add the tmux branch to `detectMux` (after Herdr, before undefined) and a test that `detectMux` resolves tmux when only `TMUX`/`TMUX_PANE` are present.
- [ ] **Step 4: Run**

Run: `node --test tests/tmux-adapter.test.mjs tests/mux-detection.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tmux-adapter.ts mux-detection.ts tests/tmux-adapter.test.mjs tests/mux-detection.test.mjs
git commit -m "feat: detect tmux and enforce the 3.2 version floor"
```

---

## Task 7: tmux pane lifecycle and viewer launch

**Files:**
- Modify: `tmux-adapter.ts`, `mux-adapter.ts`, `herdr-adapter.ts`, `mux-viewers.ts`, `tests/tmux-adapter.test.mjs`

**Interfaces:**
- Consumes: `PaneRef`, `MuxAdapter`, `ApiResult`.
- Produces:
  - `export interface ViewerLaunch { argv: readonly string[]; shellCommand: string }`
  - `MuxAdapter.runViewer(id: string, viewer: ViewerLaunch): Promise<ApiResult<void>>` (changed from `command: string`)
  - tmux ops: `currentPane`, `pane`, `panes`, `createTab`, `splitPane`, `runViewer`, `closePane`, `closeTab`, `scoped`

- [ ] **Step 1: Write the failing tests** (exact external argv)

```js
test("current pane and panes use the socket and print the pane triple", async () => {
  const calls = [];
  const exec = async (_b, args) => { calls.push(args); return "tmux 3.7c"; };
  // Stub -V first, then return formatted output for the pane query.
  const adapter = createTmuxAdapter(ctx, async (b, args, o) => {
    if (args.includes("-V")) return "tmux 3.7c";
    calls.push(args);
    return "%3 @4 $0";
  });
  assert.deepEqual((await adapter.currentPane()).value, { paneId: "%3", tabId: "@4", workspaceId: "$0" });
  assert.deepEqual(calls.at(-1), ["-S", "/tmp/t", "display-message", "-p", "-t", "%1", "#{pane_id} #{window_id} #{session_id}"]);
});

test("createTab creates a detached window and reports its root pane", async () => {
  const calls = [];
  const adapter = withVersion(calls, "@7 %8");
  const result = await adapter.createTab("$0", "/work");
  assert.deepEqual(result.value, { tabId: "@7", rootPane: { paneId: "%8", tabId: "@7", workspaceId: "$0" } });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "new-window", "-d", "-t", "$0:", "-c", "/work", "-n", "Subagents", "-P", "-F", "#{window_id} #{pane_id}"]);
});

test("runViewer respawns with direct argv, never a shell string", async () => {
  const calls = [];
  const adapter = withVersion(calls, "");
  await adapter.runViewer("%8", { argv: ["/n/node", "/mux-viewer.mjs", "--slot", "0"], shellCommand: "/n/node '/mux-viewer.mjs'" });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "respawn-pane", "-k", "-t", "%8", "/n/node", "/mux-viewer.mjs", "--slot", "0"]);
});
```

where `withVersion` records real calls and answers `-V` with `tmux 3.7c`, and `ctx = getTmuxContext({ TMUX: "/tmp/t,1,0", TMUX_PANE: "%1" })`.

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tmux-adapter.test.mjs`
Expected: FAIL — ops not implemented.

- [ ] **Step 3: Implement the ops** with these exact argv (all prefixed by `-S <endpoint>`):
  - `currentPane(id?)`: `display-message -p -t <id|callerPaneId> '#{pane_id} #{window_id} #{session_id}'`; parse the whitespace-separated triple; missing pane → `missing`, malformed → `invalid`.
  - `pane(id)`: same, then reject when the returned `pane_id !== id` as `invalid`.
  - `panes(sessionId)`: `list-panes -s -t <sessionId> -F '#{pane_id} #{window_id} #{session_id}'`.
  - `createTab(sessionId, cwd)`: `new-window -d -t <sessionId>: -c <cwd> -n Subagents -P -F '#{window_id} #{pane_id}'`.
  - `splitPane(id, direction, cwd)`: `split-window -d -h|-v -t <id> -c <cwd> -P -F '#{pane_id}'`, returning `{ paneId, tabId, workspaceId }` resolved from the pane.
  - `runViewer(id, viewer)`: `respawn-pane -k -t <id> <...viewer.argv>`.
  - `closePane(id)`: `kill-pane -t <id>`; `closeTab(id)`: `kill-window -t <id>`; `scoped` mirrors the Herdr adapter using `createCommandQueue`.
  - Update `ViewerLaunch` in `mux-adapter.ts`; update `herdr-adapter.runViewer` to use `viewer.shellCommand`; update `mux-viewers.ts` to build `{ argv, shellCommand }` (argv is the existing `[node, script, --snapshot, …]` list; `shellCommand` remains `buildViewerCommand(...)`), and to stop requiring a supported shell on backends whose adapter launches by argv.
- [ ] **Step 4: Run**

Run: `npm test && npm run typecheck`
Expected: PASS, including all `mux-viewers` tests.

- [ ] **Step 5: Commit**

```bash
git add tmux-adapter.ts mux-adapter.ts herdr-adapter.ts mux-viewers.ts tests/tmux-adapter.test.mjs
git commit -m "feat: tmux pane lifecycle and argv viewer launch"
```

---

## Task 8: tmux presentation, process info, and the format-injection guard

**Files:**
- Modify: `tmux-adapter.ts`, `tests/tmux-adapter.test.mjs`

**Interfaces:**
- Consumes: `MetadataPatch`, `ProcessInfo`.
- Produces: tmux `metadata`, `viewerState`, `releaseViewer`, `notify`, `processInfo`; `export function escapeFormatValue(value: string): string`.

- [ ] **Step 1: Write the failing tests**

```js
test("format values strip controls and escape every hash", () => {
  assert.equal(escapeFormatValue("a#(rm -rf /)\u001b[31mb"), "a##(rm -rf /)[31mb");
});

test("metadata writes the parent summary and mirrors the aggregate window option", async () => {
  const calls = [];
  const adapter = withVersion(calls, "");
  await adapter.metadata("%1", { source: "s", seq: "1", ttlMs: 15000, tokens: { subagent_summary: "running 2" } });
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "set-option", "-p", "-t", "%1", "@pi_subagent_summary", "running 2"]);
});

test("metadata with a null token unsets it and schedules exactly one ttl unset per target", async () => {
  // assert set -pu -t %1 @pi_subagent_summary appears, and one timer is registered
});

test("processInfo reports pane_pid and the current command as the single foreground process", async () => {
  const adapter = withVersion(calls, "12345 fish");
  assert.deepEqual((await adapter.processInfo("%1")).value,
    { paneId: "%1", shellPid: 12345, foregroundProcesses: [{ pid: 12345, name: "fish" }] });
});

test("notify uses a bounded display-message and never a popup", async () => {
  const adapter = withVersion(calls, "");
  await adapter.notify("Batch completed", "2 tasks");
  assert.deepEqual(calls[0], ["-S", "/tmp/t", "display-message", "-d", "5000", "-t", "%1", "Batch completed · 2 tasks"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tmux-adapter.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `escapeFormatValue(value)`: strip C0/C1 controls and ESC sequences, then replace `#` with `##`.
  - `metadata(id, patch)`: for `tokens.subagent_summary` write `set-option -p -t <id> @pi_subagent_summary <escapeFormatValue(v)>` (or `set-option -pu -t <id> @pi_subagent_summary` when null) and mirror to the containing window as `set-option -w -t <window> @pi_subagents <value>`; `stateLabels` → `@pi_state_<state>`; `clearStateLabels` → unset them. Hold at most one scheduled unset timer per target when `ttlMs` is present; replace on each patch and clear on `stop`/null.
  - `viewerState(id, state)`: `set-option -p -t <id> @pi_viewer_state <state>`; `releaseViewer(id)`: `set-option -pu -t <id> @pi_viewer_state @pi_viewer_summary`.
  - `notify(title, body)`: `display-message -d 5000 -t <callerPaneId> "<title> · <body>"`, both escaped.
  - `processInfo(id)`: `display-message -p -t <id> '#{pane_pid} #{pane_current_command}'` → single foreground process `{ pid: pane_pid, name: pane_current_command }`, `shellPid: pane_pid`.
- [ ] **Step 4: Run**

Run: `node --test tests/tmux-adapter.test.mjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tmux-adapter.ts tests/tmux-adapter.test.mjs
git commit -m "feat: tmux presentation, process info, and format escaping"
```

---

## Task 9: Wire tmux into the monitor, entry, and settings dialog

**Files:**
- Modify: `index.ts`, `mux-monitor.ts`, `command-subagents.ts`, `tests/herdr-extension.test.mjs`→`tests/mux-extension.test.mjs`, `command-subagents` dialog test
- Test: `tests/mux-extension.test.mjs`

**Interfaces:**
- Consumes: `detectMux`, `createTmuxAdapter`, `createHerdrAdapter`, `MuxSettings`, `readMuxSettings`, `writeMuxOptions`.
- Produces: `adapterFactory: (ctx) => ctx.backend === "tmux" ? createTmuxAdapter(ctx) : createHerdrAdapter(ctx)`; `/subagents` rows `tmux-enabled` and `tmux-viewers`.

- [ ] **Step 1: Write the failing tests**
  - `detectMux({ TMUX: "/tmp/t,1,0", TMUX_PANE: "%9" })?.backend === "tmux"`.
  - In the generalized entry test, set `TMUX`/`TMUX_PANE` (and delete Herdr vars), start the session, and assert the injected monitor's `adapterFactory` receives `backend: "tmux"` and that no viewer/timer is created when `subagent.tmux.enabled` is false.
  - Dialog test: reach the four rows in order (`herdr-enabled`, `herdr-viewers`, `tmux-enabled`, `tmux-viewers`) and assert each toggle persists only its own key.
- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/mux-extension.test.mjs tests/mux-detection.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** the `adapterFactory` dispatch in `index.ts`, rename the entry test file, extend `command-subagents.ts` with the two tmux rows using `readMuxSettings`/`writeMuxOptions`, and make `applyOptions` re-read `readMuxSettings(settingsPath)` for the detected backend.
- [ ] **Step 4: Run**

Run: `npm test && npm run typecheck`
Expected: PASS. Confirm the "user closes a viewer pane" path: the tmux-shaped `processInfo` missing result relinquishes the slot without recreating that attempt (covered by the generalized `mux-viewers` tests).

- [ ] **Step 5: Commit**

```bash
git add index.ts mux-monitor.ts command-subagents.ts tests/mux-extension.test.mjs
git rm tests/herdr-extension.test.mjs
git commit -m "feat: wire tmux backend into monitor, entry, and settings"
```

---

## Task 10: Window-scoped chrome and completion chrome

**Files:**
- Modify: `tmux-adapter.ts`, `tests/tmux-adapter.test.mjs`

**Interfaces:**
- Consumes: the `createTab`/`metadata` implementations from Tasks 7–8.
- Produces: window-scoped `pane-border-status`/`pane-border-format`, `automatic-rename off`, and the `Subagents · N running` window name.

- [ ] **Step 1: Write the failing tests**

```js
test("createTab scopes border chrome and disables automatic rename", async () => {
  const calls = [];
  const adapter = withVersion(calls, "@7 %8");
  await adapter.createTab("$0", "/work");
  const argv = calls.map(c => c.join(" "));
  assert.ok(argv.some(a => a.includes("set-option -w -t @7 pane-border-status top")));
  assert.ok(argv.some(a => a.includes("set-option -w -t @7 pane-border-format  #{@pi_viewer_summary} ")));
  assert.ok(argv.some(a => a.includes("set-option -w -t @7 automatic-rename off")));
  assert.ok(!argv.some(a => a.includes("set-option -g")));
});

test("metadata mirrors a bounded aggregate into the owned window name", async () => {
  // after createTab, metadata on the parent renames the owned window to "Subagents · 2 running"
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tmux-adapter.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** the window options in `createTab` (all `-w -t <window>`, never `-g`) and the window-name aggregate in `metadata`/`viewerState` (re-assert `pane-border-status top` at each `createTab`; use `escapeFormatValue` on the name).
- [ ] **Step 4: Run**

Run: `node --test tests/tmux-adapter.test.mjs && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tmux-adapter.ts tests/tmux-adapter.test.mjs
git commit -m "feat: window-scoped tmux chrome and notices"
```

---

## Task 11: Live smoke gate and documentation

**Files:**
- Create: `scripts/tmux-monitor-smoke.mjs`, `scripts/tmux-monitor-smoke-driver.mjs`, `tests/tmux-smoke-safety.test.mjs`
- Modify: `README.md`, `AGENTS.md`

**Interfaces:**
- Consumes: the extension entry, `createMuxMonitor`, `createViewerManager`, `createSnapshotStore`.
- Produces: `export async function runSmoke(): Promise<string[]>` returning check names; a driver that runs inside a disposable `tmux -L pi-smoke-<nonce>` server.

- [ ] **Step 1: Write the failing offline safety test** modeled on `tests/herdr-smoke-safety.test.mjs`: assert the launcher refuses to run without an installed `tmux` binary, uses a `-L pi-smoke-<32hex>` server (never the ambient `$TMUX`), and makes no model call.
- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/tmux-smoke-safety.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the smoke script and driver** mirroring `herdr-monitor-smoke*`: create the disposable server, run the extension with the tmux env in a plain (non-model) child, spawn a fixture task, assert a `Subagents` window appears with viewer panes and `@pi_viewer_state`/window-scoped options set, then kill the server. Wrap the pre-panic guard so an aborted run cannot leave the server behind.
- [ ] **Step 4: Run the smoke gate**

Run: `node scripts/tmux-monitor-smoke.mjs`
Expected: PASS, check names printed, no lingering `pi-smoke-` server (`tmux ls` unaffected).

- [ ] **Step 5: Document** — add the README "Optional tmux monitoring" section (floor and version guard, `subagent.tmux` keys, `/subagents` toggles, inertness guarantee, the format-injection note, the opt-in parent-summary snippet) and update AGENTS.md module layout and dependency graph.
- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/tmux-monitor-smoke.mjs scripts/tmux-monitor-smoke-driver.mjs tests/tmux-smoke-safety.test.mjs README.md AGENTS.md
git commit -m "test+docs: tmux smoke gate and tmux monitoring documentation"
```

---

## Self-Review

- **Spec coverage:** intent/non-goals (Tasks 1–11 keep children piped), module layout (Tasks 1–2), interface changes incl. `ViewerLaunch` (Task 7) and shared queue (Task 3), tmux command mapping (Tasks 7–8), window chrome (Task 10), format injection (Task 8), settings/detection/precedence (Tasks 4–6, 9), failure/self-healing (existing `mux-viewers` tests + Task 9), compatibility floor (Task 6), testing incl. smoke (Tasks 1–11, 11), docs (Task 11), four-commit rollout (grouped into the 11 tasks' commits).
- **Review Focus:** six lines, each with a named test in its owning task.
- **Type consistency:** `MuxContext`/`MuxBackend`/`MuxAdapter`/`ViewerLaunch`/`MuxOptions`/`MuxSettings`/`createCommandQueue`/`detectMux`/`escapeFormatValue` are defined once (Tasks 2–8) and reused with the same names in Tasks 9–11.
- **Proportion:** code blocks are test assertions and exact argv; implementation steps name signatures and decisions, not bodies.
