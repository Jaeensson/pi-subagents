import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attemptKey, chooseSlot, projectSnapshot, type PaneRef, type SlotIdentity, type SlotState, type ViewerIdentity } from "./mux-core.ts";
import { buildViewerCommand } from "./herdr-adapter.ts";
import { classifyOccupant, type MuxAdapter, type ProcessInfo } from "./mux-adapter.ts";
import { createSnapshotStore, type SnapshotStore } from "./mux-files.ts";
import { nodeMonitorClock, type MonitorClock, type ViewerHost, type ViewerManager } from "./mux-monitor.ts";
import type { Task } from "./runtime.ts";

export interface ViewerManagerDeps {
  storeFactory: () => SnapshotStore;
  resolveNode: () => Promise<string | undefined>;
  viewerScriptPath: string;
  nonce: () => string;
  clock: MonitorClock;
  execPath: string;
}

const exec = promisify(execFile);
/** Called only by an activated manager; never searches for Bun or a standalone runner. */
export async function resolveViewerNode(execPath: string, env: NodeJS.ProcessEnv, platform: string): Promise<string | undefined> {
  const win = platform === "win32";
  const paths = [execPath, ...(env.PATH ?? "").split(win ? ";" : ":").filter(Boolean).map(dir => path.join(dir, win ? "node.exe" : "node"))];
  for (const candidate of new Set(paths)) {
    if (!/^node(?:\.exe)?$/i.test(path.basename(candidate))) continue;
    try {
      await access(candidate, win ? constants.F_OK : constants.X_OK);
      const result = await exec(candidate, ["-p", "process.release.name"], { timeout: 2000, maxBuffer: 1024, env });
      if (result.stdout.trim() === "node") return candidate;
    } catch { /* no suitable Node at this path */ }
  }
}

type Shell = "posix" | "fish" | "powershell" | "cmd";
function shellOf(info: ProcessInfo): Shell | undefined {
  // Only the sole, explicitly identified shell PID authorizes an unlaunched rollback.
  if (!info.shellPid || info.foregroundProcesses.length !== 1 || info.foregroundProcesses[0].pid !== info.shellPid) return;
  const name = info.foregroundProcesses[0].name.split(/[\\/]/).at(-1)?.toLowerCase();
  if (name && /^(?:sh|bash|dash|zsh|ksh|ash)$/.test(name)) return "posix";
  // Fish parses the same single-quote grammar the posix viewer command uses.
  if (name === "fish") return "fish";
  if (name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe") return "powershell";
  if (name === "cmd" || name === "cmd.exe") return "cmd";
}
interface Slot extends SlotState {
  task?: Task; epoch: number; identity: SlotIdentity; seq: number;
  original?: PaneRef; live?: PaneRef; launched: boolean; busy: boolean;
  paths?: { snapshotPath: string; identityPath: string };
  store?: SnapshotStore; retiring?: Promise<void>; viewedKey?: string;
  lastPublish: number; lastContent?: string; lastReport: number; reportedState?: string;
}
type Inspection = { kind: "owned" | "shell"; pane: PaneRef; shell?: Shell } | { kind: "missing" | "foreign" | "unknown" };
const stale = () => new Error("stale viewer operation");

export function createViewerManager(host: ViewerHost, supplied: Partial<ViewerManagerDeps> = {}): ViewerManager {
  const execPath = supplied.execPath ?? process.execPath;
  const deps: ViewerManagerDeps = {
    storeFactory: createSnapshotStore,
    resolveNode: () => resolveViewerNode(execPath, process.env, process.platform),
    viewerScriptPath: fileURLToPath(new URL("./mux-viewer.mjs", import.meta.url)),
    nonce: randomUUID, clock: nodeMonitorClock, execPath, ...supplied,
  };
  const clock = deps.clock;
  let stopped = false, warned = false, node: string | undefined, initialized = false;
  let startup: Promise<void> | undefined, layoutBusy = false;
  let latestTasks: readonly Task[] = [];
  const missingAttempts = new Set<string>();
  let timer: unknown, stopPromise: Promise<void> | undefined, parent = host.parent;
  let ownedTab: { tabId: string; workspaceId: string } | undefined;
  const cancelHandshakes = new Set<() => void>();
  // A source is private to this physical pool, including setting toggles in one activation.
  const source = `pi-subagent-viewer:${deps.nonce()}`;
  let reportSeq = BigInt(Math.max(0, Math.floor(clock.wallNow()))) * 1000n;
  const nextReportSeq = () => String(++reportSeq);
  const slots: Slot[] = Array.from({ length: 4 }, (_, index) => ({
    index, phase: "empty", availableSince: 0, epoch: 0, identity: { activationId: host.activationId, slotId: index, nonce: deps.nonce() },
    seq: 0, launched: false, busy: false, lastPublish: -Infinity, lastReport: -Infinity,
  }));
  const active = () => !stopped && host.isCurrent();
  const api = host.adapter.scoped(active);
  const current = (slot: Slot, epoch: number) => active() && slot.epoch === epoch && !!slot.task && slot.taskKey === attemptKey(slot.task);
  const warn = (message: string) => { if (!active() || warned) return; warned = true; try { host.warn(message); } catch {} };
  const guard = (check: () => boolean) => { if (!check()) throw stale(); };

  async function inspect(slot: Slot, port: MuxAdapter, check: () => boolean): Promise<Inspection> {
    if (!slot.original) return { kind: "unknown" };
    guard(check);
    const resolved = await port.currentPane(slot.original.paneId); guard(check);
    if (!resolved.ok) return { kind: resolved.reason === "missing" ? "missing" : "unknown" };
    slot.live = resolved.value;
    let identity: ViewerIdentity | undefined;
    if (slot.launched) {
      identity = await slot.store?.readIdentity(slot.index); guard(check);
      // Validate even injected stores: mismatched identity never authorizes any pane operation.
      if (!identity || identity.version !== 1 || identity.activationId !== slot.identity.activationId || identity.slotId !== slot.index || identity.nonce !== slot.identity.nonce || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return { kind: "unknown" };
    }
    const process = await port.processInfo(resolved.value.paneId); guard(check);
    if (!process.ok) return { kind: process.reason === "missing" ? "missing" : "unknown" };
    if (identity) {
      const kind = classifyOccupant(process.value, identity, deps.viewerScriptPath, clock.wallNow());
      return kind === "owned" ? { kind, pane: resolved.value } : { kind };
    }
    const shell = shellOf(process.value);
    return shell ? { kind: "shell", pane: resolved.value, shell } : { kind: "unknown" };
  }

  // Timed work uses a scoped raw adapter, so queued commands skip after the TOTAL deadline.
  async function budget(work: (port: MuxAdapter, check: () => boolean) => Promise<void>): Promise<void> {
    const deadline = clock.monotonicNow() + 2000;
    let expired = false, handle: unknown;
    const check = () => !expired && clock.monotonicNow() < deadline;
    const port = host.adapter.scoped(check);
    await new Promise<void>(resolve => {
      const finish = () => { expired = true; clock.clearTimeout(handle); resolve(); };
      handle = clock.setTimeout(finish, 2000);
      void Promise.resolve().then(() => work(port, check)).catch(() => {}).then(finish);
    });
  }
  async function closeEmptyTab(port: MuxAdapter, check: () => boolean): Promise<void> {
    if (!ownedTab || !check()) return;
    const listed = await port.panes(ownedTab.workspaceId); guard(check);
    // Neither labels nor a viewer's destination tab convey ownership.
    if (listed.ok && !listed.value.some(p => p.tabId === ownedTab!.tabId)) {
      await port.closeTab(ownedTab.tabId); guard(check);
    }
  }
  async function cleanupSlot(slot: Slot, port: MuxAdapter, check: () => boolean): Promise<void> {
    const inspection = await inspect(slot, port, check); guard(check);
    if (inspection.kind !== "owned" && inspection.kind !== "shell") return;
    if (inspection.kind === "owned") {
      await port.releaseViewer(inspection.pane.paneId, source, nextReportSeq()); guard(check);
      // Release changes presentation only; foreground ownership must still hold before close.
      const again = await inspect(slot, port, check); guard(check);
      if (again.kind !== "owned" || again.pane.paneId !== inspection.pane.paneId) return;
    }
    await port.closePane(inspection.pane.paneId); guard(check);
  }
  const rollback = (slot: Slot) => budget(async (port, check) => { await cleanupSlot(slot, port, check); guard(check); await closeEmptyTab(port, check); });
  function unavailable(slot: Slot, message?: string, inspection?: Inspection) {
    slot.phase = "unavailable"; slot.epoch++;
    if (message) warn(message);
    // Only authoritative absence suppresses the attempt actually shown by this
    // physical reader, never a candidate assigned before ownership inspection.
    if (inspection?.kind !== "missing" && inspection?.kind !== "foreign") return;
    if (inspection.kind === "missing" && slot.viewedKey) missingAttempts.add(slot.viewedKey);
    slot.task = undefined; slot.taskKey = undefined; slot.taskStatus = undefined;
    // Missing and foreign panes are relinquished, not closed or used as anchors.
    slot.original = undefined; slot.live = undefined;
    if (slot.retiring) return;
    const oldStore = slot.store;
    slot.retiring = Promise.resolve().then(() => oldStore?.dispose()).then(() => {
      if (!active()) return;
      // Dispose must finish before allocating a replacement transport. Each of
      // four positions has at most one live OR retiring store, even with held I/O.
      slot.store = undefined; slot.paths = undefined; slot.launched = false;
      slot.viewedKey = undefined; slot.seq = 0;
      slot.identity = { activationId: host.activationId, slotId: slot.index, nonce: deps.nonce() };
      slot.lastPublish = -Infinity; slot.lastReport = -Infinity;
      slot.lastContent = undefined; slot.reportedState = undefined;
      slot.phase = "empty"; slot.availableSince = clock.monotonicNow();
      reconcile(latestTasks, parent);
    }).catch(() => { warn("viewer transport retirement failed"); }).finally(() => { slot.retiring = undefined; });
  }

  async function publish(slot: Slot, epoch: number, force = false): Promise<boolean> {
    const check = () => current(slot, epoch);
    guard(check);
    const now = clock.monotonicNow();
    if (now - slot.lastPublish < 250) return false;
    const snapshot = projectSnapshot(slot.task!, slot.identity, slot.seq, clock.wallNow());
    const content = JSON.stringify({ task: snapshot.task, segments: snapshot.segments, truncated: snapshot.truncated });
    if (!force && content === slot.lastContent && now - slot.lastPublish < 2000) return false;
    snapshot.seq = ++slot.seq; // Never reset for task reuse; the physical viewer rejects decreases.
    slot.lastPublish = now;
    try { await slot.store!.publish(slot.index, snapshot, check); }
    catch (error) {
      // A disk failure belongs to the physical transport, even if its task epoch
      // changed while I/O was held. Never let reassignment mask a broken reader.
      if (active() && slot.phase !== "unavailable") {
        unavailable(slot, "viewer snapshot publication failed"); void rollback(slot);
      }
      throw error;
    }
    guard(check);
    slot.lastContent = content;
    if (slot.launched) slot.viewedKey = slot.taskKey;
    return true;
  }
  async function report(slot: Slot, epoch: number, inspected?: Inspection): Promise<void> {
    const check = () => current(slot, epoch);
    const state = slot.taskStatus === "running" ? "working" : "idle";
    if (slot.reportedState === state && clock.monotonicNow() - slot.lastReport < 2000) return;
    const port = api.scoped(check);
    const result = inspected ?? await inspect(slot, port, check); guard(check);
    if (result.kind !== "owned") { unavailable(slot, "viewer ownership unavailable", result); return; }
    const sent = await port.viewerState(result.pane.paneId, state, source, nextReportSeq()); guard(check);
    if (!sent.ok) { unavailable(slot, "viewer report unavailable"); return; }
    slot.reportedState = state; slot.lastReport = clock.monotonicNow();
  }
  async function handshake(slot: Slot, epoch: number): Promise<Inspection> {
    const deadline = clock.monotonicNow() + 2000;
    let expired = false, timeout: unknown, sleep: unknown, wake: (() => void) | undefined;
    const check = () => current(slot, epoch) && !expired && clock.monotonicNow() < deadline;
    return new Promise<Inspection>((resolve, reject) => {
      const cancel = () => finish(undefined, stale());
      cancelHandshakes.add(cancel);
      const finish = (value?: Inspection, error?: unknown) => {
        if (expired) return;
        expired = true; clock.clearTimeout(timeout); clock.clearTimeout(sleep); wake?.();
        cancelHandshakes.delete(cancel);
        if (error) reject(error); else resolve(value!);
      };
      timeout = clock.setTimeout(() => finish(undefined, new Error("viewer handshake timed out")), 2000);
      void (async () => {
        while (check()) {
          const result = await inspect(slot, api.scoped(check), check); guard(check);
          if (result.kind === "owned") { finish(result); return; }
          if (result.kind === "foreign" || result.kind === "missing") { finish(result); return; }
          await new Promise<void>(yes => { wake = yes; sleep = clock.setTimeout(yes, 100); }); guard(check);
        }
        throw stale();
      })().catch(error => finish(undefined, error));
    });
  }
  async function initializeSlot(slot: Slot, epoch: number): Promise<void> {
    const check = () => current(slot, epoch);
    const port = api.scoped(check);
    const inspection = await inspect(slot, port, check); guard(check);
    if (slot.launched) {
      if (inspection.kind !== "owned") { unavailable(slot, "viewer ownership unavailable", inspection); return; }
      slot.phase = "ready";
      await publish(slot, epoch); guard(check);
      await report(slot, epoch); guard(check);
      return;
    }
    if (inspection.kind !== "shell") { unavailable(slot, "unsupported or unknown viewer shell", inspection); return; }
    slot.store ??= deps.storeFactory();
    slot.paths ??= await slot.store.openSlot(slot.identity); guard(check);
    // Write the first current task before launching; publication failures never launch a reader.
    if (!await publish(slot, epoch, true)) return;
    guard(check);
    // Reinspect after file I/O: users may have replaced the new shell in the meantime.
    const beforeLaunch = await inspect(slot, port, check); guard(check);
    if (beforeLaunch.kind !== "shell") { unavailable(slot, "viewer shell changed", beforeLaunch); return; }
    const command = buildViewerCommand(node!, deps.viewerScriptPath, slot.paths.snapshotPath, slot.paths.identityPath, slot.identity, beforeLaunch.shell!);
    if (!command) { unavailable(slot, "viewer command unsupported"); return; }
    // Herdr runs the quoted shell command; tmux respawns with this argv directly.
    const viewer = {
      argv: [node!, deps.viewerScriptPath, "--snapshot", slot.paths.snapshotPath, "--identity", slot.paths.identityPath,
        "--activation", slot.identity.activationId, "--slot", String(slot.identity.slotId), "--nonce", slot.identity.nonce],
      shellCommand: command,
    };
    slot.launched = true; // An issued command may start even if its response later fails.
    slot.viewedKey = slot.taskKey;
    const launched = await port.runViewer(beforeLaunch.pane.paneId, viewer); guard(check);
    if (!launched.ok) { unavailable(slot, "viewer launch unavailable"); return; }
    const owned = await handshake(slot, epoch); guard(check);
    if (owned.kind !== "owned") { unavailable(slot, "viewer handshake unavailable", owned); return; }
    slot.phase = "ready";
    await report(slot, epoch, owned); guard(check);
  }
  function service(slot: Slot): void {
    if (!active() || slot.busy || !slot.original || (!slot.launched && layoutBusy) || (slot.phase !== "ready" && slot.phase !== "reserved")) return;
    const epoch = slot.epoch;
    slot.busy = true;
    void (async () => {
      if (slot.phase === "reserved") await initializeSlot(slot, epoch);
      else { await publish(slot, epoch); guard(() => current(slot, epoch)); await report(slot, epoch); }
    })().catch(() => {
      if (!current(slot, epoch)) return;
      unavailable(slot, "viewer publication or initialization failed");
      void rollback(slot);
    }).finally(() => { slot.busy = false; });
  }

  async function createLayout(): Promise<void> {
    if (!initialized || !node || layoutBusy || !active()) return;
    layoutBusy = true;
    try {
      for (const slot of slots) {
        if (!active()) return;
        if (slot.phase !== "reserved" || slot.original) continue;
        const epoch = slot.epoch;
        const check = () => current(slot, epoch);
        const port = api.scoped(check);
        let pane: PaneRef;
        const preferred = slots[slot.index === 3 ? 1 : 0];
        let anchor: PaneRef | undefined, unknownAnchor = false;
        // Keep the initial quad layout; replacements may use another proven
        // owned peer, never a foreign pane, a label, or a destination tab.
        for (const candidate of [preferred, ...slots.filter(s => s !== preferred)]) {
          if (candidate === slot || !candidate.original) continue;
          const inspected = await inspect(candidate, port, check); guard(check);
          if (inspected.kind === "unknown") unknownAnchor = true;
          if ((inspected.kind === "owned" || inspected.kind === "shell") && ownedTab && inspected.pane.tabId === ownedTab.tabId && inspected.pane.workspaceId === ownedTab.workspaceId) { anchor = inspected.pane; break; }
        }
        if (anchor) {
          const created = await port.splitPane(anchor.paneId, slot.index === 1 ? "right" : "down", host.cwd);
          if (!created.ok) { if (active()) unavailable(slot, "viewer split unavailable"); continue; }
          pane = created.value;
        } else {
          if (unknownAnchor) { unavailable(slot, "viewer layout ownership unavailable"); continue; }
          // No safe anchor remains (e.g. the sole pane was relinquished).
          // Only a fresh authoritative creation may establish a new owned tab.
          const created = await port.createTab(parent.workspaceId, host.cwd);
          if (!created.ok) { if (active()) unavailable(slot, "viewer tab creation unavailable"); return; }
          ownedTab = { tabId: created.value.tabId, workspaceId: created.value.rootPane.workspaceId };
          pane = created.value.rootPane;
        }
        slot.original = pane; slot.live = pane;
        // Authoritative creation IDs survive invalidation; only safe rollback may use them.
        if (!current(slot, epoch) || !ownedTab || pane.tabId !== ownedTab.tabId || pane.workspaceId !== ownedTab.workspaceId) { unavailable(slot); void rollback(slot); continue; }
      }
    } catch { if (active()) warn("viewer layout unavailable"); }
    finally {
      layoutBusy = false;
      // Finish the initial shell layout before launching helpers. A helper does not
      // write its first PID identity until its first poll; it cannot anchor a split yet.
      if (active()) for (const slot of slots) service(slot);
    }
  }
  function start(): void {
    if (startup || !active()) return;
    startup = (async () => {
      node = await deps.resolveNode(); if (!active()) return;
      if (!node) { for (const slot of slots) if (slot.phase === "reserved") unavailable(slot); warn("Node unavailable for viewers"); return; }
      initialized = true;
      timer = clock.setInterval(() => { if (!active()) return; for (const slot of slots) service(slot); void createLayout(); }, 250);
      await createLayout();
    })().catch(() => { if (active()) { for (const slot of slots) if (slot.phase === "reserved") unavailable(slot); warn("viewer startup unavailable"); } });
  }
  function reconcile(tasks: readonly Task[], nextParent: PaneRef) {
    if (!active()) return;
    latestTasks = tasks;
    parent = nextParent;
    // Update all executing flags BEFORE choosing a slot; never evict a running attempt.
    for (const slot of slots) {
      if (!slot.task || slot.phase === "unavailable") continue;
      const latest = tasks.find(t => t.id === slot.task!.id);
      if (!latest) continue; // Retain final output for an inactive slot.
      const key = attemptKey(latest);
      if (key !== slot.taskKey) {
        slot.epoch++; slot.taskKey = key; slot.lastContent = undefined; slot.reportedState = undefined;
        if (slot.phase === "ready") slot.phase = "reserved";
      }
      slot.task = latest;
      if (slot.taskStatus === "running" && latest.status !== "running") slot.availableSince = clock.monotonicNow();
      slot.taskStatus = latest.status;
    }
    for (const task of tasks) {
      if (task.status !== "running" || task.setupPending || task.dispatchState === "queued") continue;
      const key = attemptKey(task);
      if (missingAttempts.has(key) || slots.some(s => s.taskKey === key)) continue;
      const choice = chooseSlot(slots);
      if (choice.kind === "full") continue;
      const slot = slots[choice.index];
      // Reserve synchronously; pending layout cannot overbook this slot on another reconcile.
      slot.phase = "reserved"; slot.task = task; slot.taskKey = key; slot.taskStatus = task.status; slot.epoch++;
      slot.lastContent = undefined; slot.reportedState = undefined;
    }
    if (!slots.some(s => s.phase === "reserved" || s.phase === "ready")) return;
    start();
    if (initialized) { for (const slot of slots) service(slot); void createLayout(); }
  }
  return {
    reconcile,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer !== undefined) clock.clearInterval(timer);
      for (const cancel of cancelHandshakes) cancel();
      // Preserve identity reads for cleanup, then dispose immediately after bounded pane work.
      // The write guards already disallow every old publication from this synchronous point.
      stopPromise = budget(async (port, check) => {
        await Promise.allSettled(slots.filter(s => s.original).map(s => cleanupSlot(s, port, check)));
        guard(check); await closeEmptyTab(port, check);
      }).then(async () => {
        await Promise.all(slots.map(async slot => { await slot.retiring; await slot.store?.dispose(); }));
      });
      return stopPromise;
    },
  };
}
