import type { PaneRef, ViewerIdentity } from "./mux-core.ts";
export type { MuxBackend } from "./mux-core.ts";
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "unavailable" | "invalid"; error: string };
export interface ProcessInfo { paneId: string; shellPid?: number; foregroundProcessGroupId?: number; foregroundProcesses: Array<{ pid: number; name: string; argv?: string[] }> }
export interface MetadataPatch { source: string; seq: string; ttlMs?: number; tokens?: Record<string, string | null>; stateLabels?: Partial<Record<"idle" | "working" | "blocked" | "done" | "unknown", string>>; clearStateLabels?: boolean }
export interface ViewerLaunch { argv: readonly string[]; shellCommand: string }
export interface MuxAdapter {
  currentPane(callerPaneId?: string): Promise<ApiResult<PaneRef>>; pane(id: string): Promise<ApiResult<PaneRef>>; processInfo(id: string): Promise<ApiResult<ProcessInfo>>;
  panes(workspaceId: string): Promise<ApiResult<PaneRef[]>>; createTab(workspaceId: string, cwd: string): Promise<ApiResult<{ tabId: string; rootPane: PaneRef }>>;
  splitPane(id: string, direction: "right" | "down", cwd: string): Promise<ApiResult<PaneRef>>; runViewer(id: string, viewer: ViewerLaunch): Promise<ApiResult<void>>;
  metadata(id: string, patch: MetadataPatch): Promise<ApiResult<void>>; viewerState(id: string, state: "idle" | "working", source: string, seq: string, label?: string): Promise<ApiResult<void>>;
  releaseViewer(id: string, source: string, seq: string): Promise<ApiResult<void>>; notify(title: string, body: string): Promise<ApiResult<void>>;
  closePane(id: string): Promise<ApiResult<void>>; closeTab(id: string): Promise<ApiResult<void>>; scoped(isCurrent: () => boolean): MuxAdapter;
}

export interface CommandQueue {
  schedule<T>(work: Array<() => Promise<T>>, stale: () => boolean, key?: string): Promise<T[]>;
}

// Bounded command executor shared by the Herdr and tmux adapters: at most
// `limit` commands run at once, `capacity` may wait, and same-key work is
// serialized. Stale admits and stale dispatches reject with `stale: true`;
// capacity overflow rejects with `unavailable: true`.
export function createCommandQueue(limit = 4, capacity = 32): CommandQueue {
  let active = 0;
  // All waiting commands, including same-pane serialization, live in this queue.
  const queue: Array<{ key?: string; run: () => void; stale: () => boolean; reject: (error: Error) => void }> = [];
  const activeKeys = new Set<string>();
  const staleError = () => Object.assign(new Error("scope is stale"), { stale: true });
  const dispatch = () => {
    for (let i = 0; i < queue.length;) {
      if (queue[i].stale()) queue.splice(i, 1)[0].reject(staleError());
      else i++;
    }
    while (active < limit) {
      const index = queue.findIndex(item => item.key === undefined || !activeKeys.has(item.key));
      if (index < 0) break;
      const item = queue.splice(index, 1)[0];
      active++;
      if (item.key !== undefined) activeKeys.add(item.key);
      item.run();
    }
  };
  const schedule = async <T>(work: Array<() => Promise<T>>, stale: () => boolean, key?: string): Promise<T[]> => {
    if (stale()) throw staleError();
    dispatch();
    // Reserve a whole batch (release + presentation clear) or none of it.
    // Free executor slots count only if their pane is actually dispatchable.
    const keys = new Set(activeKeys); let free = limit - active; let immediate = 0;
    for (const item of [...queue, ...work.map(() => ({ key }))]) {
      if (free && (item.key === undefined || !keys.has(item.key))) {
        free--; immediate++;
        if (item.key !== undefined) keys.add(item.key);
      }
    }
    if (queue.length + work.length - immediate > capacity) throw Object.assign(new Error("Herdr command queue is full"), { unavailable: true });
    const pending = work.map(fn => new Promise<T>((resolve, reject) => {
      queue.push({ key, stale, reject, run: () => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          active--;
          if (key !== undefined) activeKeys.delete(key);
          dispatch();
        });
      } });
    }));
    dispatch();
    // Settle every admitted command, so a failed release still clears presentation.
    const results = await Promise.allSettled(pending);
    const failed = results.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return results.map(r => (r as PromiseFulfilledResult<T>).value);
  };
  return { schedule };
}

export function classifyOccupant(processInfo: ProcessInfo, identity: ViewerIdentity, expectedScript: string, now: number): "owned" | "foreign" | "unknown" {
  if (!Number.isFinite(now) || !Number.isFinite(identity.heartbeatAt) || now - identity.heartbeatAt < 0 || now - identity.heartbeatAt >= 10000) return "unknown";
  const matching = processInfo.foregroundProcesses.find(p => p.pid === identity.pid);
  if (!matching) return processInfo.foregroundProcesses.length ? "foreign" : "unknown";
  // No evidence authorizes additional foreground participants as viewer-owned.
  if (processInfo.foregroundProcesses.length !== 1) return "foreign";
  if (matching.argv) {
    const argv = matching.argv;
    if (argv[1] !== expectedScript) return "foreign";
    for (const [flag, value] of [["--activation", identity.activationId], ["--slot", String(identity.slotId)], ["--nonce", identity.nonce]]) {
      const index = argv.indexOf(flag, 2);
      if (index < 0 || argv[index + 1] !== value || argv.lastIndexOf(flag) !== index) return "foreign";
    }
  }
  return "owned";
}
