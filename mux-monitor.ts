import { createHash, randomUUID } from "node:crypto";
import { formatSummary, getHerdrContext, summarizeTasks, type HerdrContext, type PaneRef } from "./mux-core.ts";
import type { ApiResult, HerdrAdapter } from "./herdr-adapter.ts";
import type { HerdrOptions } from "./herdr-settings.ts";
import type { RuntimeObservation, Task, subscribeRuntimeObservations } from "./runtime.ts";

export interface MonitorClock {
  wallNow(): number;
  monotonicNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

// Opaque handles are cancellation closures: callers never cast Node timer handles.
export const nodeMonitorClock: MonitorClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
  clearTimeout: handle => { if (typeof handle === "function") handle(); },
  setInterval: (fn, ms) => { const timer = setInterval(fn, ms); return () => clearInterval(timer); },
  clearInterval: handle => { if (typeof handle === "function") handle(); },
};

export type ViewerManager = { reconcile(tasks: readonly Task[], parent: PaneRef): void; stop(): Promise<void> };
export type ViewerHost = {
  adapter: HerdrAdapter; parent: PaneRef; cwd: string; activationId: string;
  isCurrent: () => boolean; warn: (message: string) => void;
};
export interface MonitorDeps {
  env: NodeJS.ProcessEnv;
  getTasks: () => readonly Task[];
  subscribe: typeof subscribeRuntimeObservations;
  adapterFactory: (context: HerdrContext) => HerdrAdapter;
  clock: MonitorClock;
  warn: (message: string) => void;
  viewerFactory?: (host: ViewerHost) => ViewerManager;
}
export interface HerdrMonitor {
  start(sessionId: string, cwd: string, options: HerdrOptions): void;
  applyOptions(options: HerdrOptions): void;
  stop(): Promise<void> | undefined;
}

interface Activation {
  id: string; source: string; cwd: string; context: HerdrContext; viewers: boolean;
  raw: HerdrAdapter; api: HerdrAdapter; isCurrent: () => boolean;
  warned: boolean; busy: boolean; dirty: boolean; startupFailed: boolean;
  reportTimer?: unknown; refreshTimer?: unknown; unsubscribe?: () => void;
  targets: Set<string>; notified: Set<string>; viewerAttempted: boolean; viewer?: ViewerManager;
}

function metadataSource(sessionId: string): string {
  const source = `pi-subagent:${sessionId}`;
  return source.length <= 80 && /^[a-zA-Z0-9:_-]+$/.test(source)
    ? source : `pi-subagent:${createHash("sha256").update(sessionId).digest("hex")}`;
}
const sameContext = (a: HerdrContext, b: HerdrContext): boolean =>
  a.binary === b.binary && a.socketPath === b.socketPath && a.callerPaneId === b.callerPaneId;
const stripTerminalControls = (value: string): string => value
  .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x1F\x7F-\x9F]/g, "");
const displayWarning = (message: string): string => stripTerminalControls(`Herdr monitoring unavailable: ${message}`).slice(0, 80);
const displayJobId = (id: string): string => stripTerminalControls(id).trim().slice(0, 48) || "unknown";

export function createHerdrMonitor(deps: MonitorDeps): HerdrMonitor {
  const { clock } = deps;
  let binding: { sessionId: string; cwd: string; options: HerdrOptions } | undefined;
  let cached: { context: HerdrContext; adapter: HerdrAdapter } | undefined;
  let active: Activation | undefined;
  // One counter for the controller, including cleanup. Never reset on toggles.
  let sequence = 0n;
  const nextSeq = (): string => String(++sequence);
  const warn = (a: Activation, message: string): void => {
    if (!a.isCurrent() || a.warned) return;
    a.warned = true;
    try { deps.warn(displayWarning(message)); } catch { /* display only */ }
  };
  const check = (a: Activation, result: ApiResult<unknown>): void => {
    if (!result.ok) warn(a, result.error);
  };
  const clearRefresh = (a: Activation): void => {
    if (a.refreshTimer !== undefined) clock.clearInterval(a.refreshTimer);
    a.refreshTimer = undefined;
  };
  const refreshPolicy = (a: Activation, tasks: readonly Task[]): void => {
    if (!tasks.length) clearRefresh(a);
    else if (a.refreshTimer === undefined) a.refreshTimer = clock.setInterval(() => request(a), 5000);
  };
  const scheduleReport = (a: Activation): void => {
    if (!a.isCurrent() || a.startupFailed) return;
    if (!deps.getTasks().length) clearRefresh(a);
    if (a.busy) { a.dirty = true; return; }
    if (a.reportTimer !== undefined) return;
    a.reportTimer = clock.setTimeout(() => { a.reportTimer = undefined; request(a); }, 0);
  };
  const observe = (a: Activation, event: RuntimeObservation): void => {
    if (!a.isCurrent()) return;
    if (event.type === "status") scheduleReport(a);
    if (event.type !== "job-finished" || !event.completion.notifyOnComplete) return;
    const completion = event.completion;
    if (a.notified.has(completion.id)) return;
    // Retain one scalar ID for this activation to suppress duplicate live events.
    a.notified.add(completion.id);
    const outcome = completion.status === "completed" ? "completed" : "unsuccessful";
    const title = `Subagent batch ${outcome} · ${displayJobId(completion.id)}`.slice(0, 80);
    // Batch counts only; never task text or transcripts.
    const body = `${completion.total} tasks · ${completion.unsuccessful} unsuccessful`.slice(0, 80);
    void a.api.notify(title, body).then(result => check(a, result), () => warn(a, "notification failed"));
  };

  async function report(a: Activation, initial: boolean): Promise<void> {
    const resolved = await a.api.currentPane(a.context.callerPaneId);
    if (!a.isCurrent()) return;
    if (!resolved.ok) {
      check(a, resolved);
      if (initial) { a.startupFailed = true; clearRefresh(a); }
      return;
    }
    const parent = resolved.value;
    // Re-read after lookup: a held command must not publish a stale task snapshot.
    let tasks = deps.getTasks();
    refreshPolicy(a, tasks);
    for (const id of a.targets) {
      if (tasks.length && id === parent.paneId) continue;
      const result = await a.api.metadata(id, { source: a.source, seq: nextSeq(), tokens: { subagent_summary: null } });
      if (!a.isCurrent()) return;
      check(a, result);
      // Failed clears expire by TTL; don't retain a history of moved parent panes.
      a.targets.delete(id);
    }
    tasks = deps.getTasks();
    refreshPolicy(a, tasks);
    if (tasks.length) {
      // Track BEFORE await, so stop also clears an already-issued report.
      a.targets.add(parent.paneId);
      const result = await a.api.metadata(parent.paneId, {
        source: a.source, seq: nextSeq(), ttlMs: 15000,
        tokens: { subagent_summary: formatSummary(summarizeTasks(tasks)).slice(0, 80) },
      });
      if (!a.isCurrent()) return;
      check(a, result);
      if (deps.getTasks().length && a.viewers && deps.viewerFactory && !a.viewerAttempted) {
        a.viewerAttempted = true;
        try {
          a.viewer = deps.viewerFactory({ adapter: a.raw, parent, cwd: a.cwd, activationId: a.id,
            isCurrent: a.isCurrent, warn: message => warn(a, message) });
          // A host port can synchronously disable monitoring while creating a viewer.
          if (!a.isCurrent()) { void a.viewer.stop().catch(() => {}); return; }
        } catch { warn(a, "viewer creation failed"); }
      }
    }
    if (!a.isCurrent()) return;
    // Latest mutable tasks belong to the viewer; central reports don't follow tokens.
    try { a.viewer?.reconcile(deps.getTasks(), parent); } catch { warn(a, "viewer reconciliation failed"); }
  }
  function request(a: Activation, initial = false): void {
    if (!a.isCurrent() || a.startupFailed) return;
    if (!deps.getTasks().length) clearRefresh(a);
    if (a.busy) { a.dirty = true; return; }
    if (a.reportTimer !== undefined) clock.clearTimeout(a.reportTimer);
    a.reportTimer = undefined;
    a.busy = true;
    void report(a, initial).catch(() => {
      if (!a.isCurrent()) return;
      warn(a, "activity report failed");
      if (initial) { a.startupFailed = true; clearRefresh(a); }
    }).finally(() => {
      if (!a.isCurrent()) return;
      a.busy = false;
      if (a.dirty) { a.dirty = false; scheduleReport(a); }
    });
  }

  function stop(): Promise<void> | undefined {
    const a = active;
    if (!a) return;
    // Invalidate all ordinary work synchronously, before ANY cleanup await.
    active = undefined;
    try { a.unsubscribe?.(); } catch { /* still invalidate timers and work */ }
    if (a.reportTimer !== undefined) clock.clearTimeout(a.reportTimer);
    clearRefresh(a);
    const deadline = clock.monotonicNow() + 2000;
    let expired = false;
    const cleanupApi = a.raw.scoped(() => !expired && clock.monotonicNow() < deadline);
    const work: Promise<unknown>[] = [];
    // Admit all clears now, assigning sequences before a new activation can report.
    // The same raw scheduler orders these with old scoped and new scoped work.
    for (const id of a.targets) work.push(cleanupApi.metadata(id, { source: a.source, seq: nextSeq(), tokens: { subagent_summary: null } }));
    try { if (a.viewer) work.push(a.viewer.stop()); } catch { /* cleanup is best effort */ }
    return new Promise<void>(resolve => {
      const finish = (): void => { expired = true; clock.clearTimeout(timer); resolve(); };
      const timer = clock.setTimeout(finish, 2000);
      void Promise.allSettled(work).then(finish);
    });
  }
  function activate(): void {
    if (!binding?.options.enabled) return;
    const context = getHerdrContext(deps.env);
    if (!context) return;
    const seed = clock.wallNow();
    if (Number.isFinite(seed)) sequence = sequence > BigInt(Math.max(0, Math.floor(seed))) * 1000n
      ? sequence : BigInt(Math.max(0, Math.floor(seed))) * 1000n;
    try {
      if (!cached || !sameContext(cached.context, context)) cached = { context, adapter: deps.adapterFactory(context) };
    } catch {
      try { deps.warn(displayWarning("adapter creation failed")); } catch { /* display only */ }
      return;
    }
    const a: Activation = {
      id: randomUUID(), source: metadataSource(binding.sessionId), cwd: binding.cwd, context,
      viewers: binding.options.viewers, raw: cached.adapter, api: cached.adapter,
      isCurrent: () => active === a, warned: false, busy: false, dirty: false, startupFailed: false,
      targets: new Set(), notified: new Set(), viewerAttempted: false,
    };
    a.api = a.raw.scoped(a.isCurrent);
    active = a;
    // No history reads. Subscribe synchronously before issuing the asynchronous lookup.
    a.unsubscribe = deps.subscribe(event => observe(a, event));
    request(a, true);
  }
  return {
    start(sessionId, cwd, options) {
      void stop();
      binding = { sessionId, cwd, options: { ...options } };
      activate();
    },
    applyOptions(options) {
      if (!binding || (binding.options.enabled === options.enabled && binding.options.viewers === options.viewers)) return;
      void stop();
      binding.options = { ...options };
      activate();
    },
    stop,
  };
}
