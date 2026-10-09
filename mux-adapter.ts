import type { PaneRef, ViewerIdentity } from "./mux-core.ts";

export type MuxBackend = "herdr" | "tmux";
export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "unavailable" | "invalid"; error: string };
export interface ProcessInfo { paneId: string; shellPid?: number; foregroundProcessGroupId?: number; foregroundProcesses: Array<{ pid: number; name: string; argv?: string[] }> }
export interface MetadataPatch { source: string; seq: string; ttlMs?: number; tokens?: Record<string, string | null>; stateLabels?: Partial<Record<"idle" | "working" | "blocked" | "done" | "unknown", string>>; clearStateLabels?: boolean }
export interface MuxAdapter {
  currentPane(callerPaneId?: string): Promise<ApiResult<PaneRef>>; pane(id: string): Promise<ApiResult<PaneRef>>; processInfo(id: string): Promise<ApiResult<ProcessInfo>>;
  panes(workspaceId: string): Promise<ApiResult<PaneRef[]>>; createTab(workspaceId: string, cwd: string): Promise<ApiResult<{ tabId: string; rootPane: PaneRef }>>;
  splitPane(id: string, direction: "right" | "down", cwd: string): Promise<ApiResult<PaneRef>>; runViewer(id: string, command: string): Promise<ApiResult<void>>;
  metadata(id: string, patch: MetadataPatch): Promise<ApiResult<void>>; viewerState(id: string, state: "idle" | "working", source: string, seq: string): Promise<ApiResult<void>>;
  releaseViewer(id: string, source: string, seq: string): Promise<ApiResult<void>>; notify(title: string, body: string): Promise<ApiResult<void>>;
  closePane(id: string): Promise<ApiResult<void>>; closeTab(id: string): Promise<ApiResult<void>>; scoped(isCurrent: () => boolean): MuxAdapter;
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
