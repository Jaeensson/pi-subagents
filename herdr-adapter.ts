import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrContext, PaneRef, SlotIdentity, ViewerIdentity } from "./herdr-core.ts";

export type ApiResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "unavailable" | "invalid"; error: string };
export type HerdrExec = (binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<string>;
export interface ProcessInfo { paneId: string; shellPid?: number; foregroundProcessGroupId?: number; foregroundProcesses: Array<{ pid: number; name: string; argv?: string[] }> }
export interface MetadataPatch { source: string; seq: string; ttlMs?: number; tokens?: Record<string, string | null>; stateLabels?: Partial<Record<"idle" | "working" | "blocked" | "done" | "unknown", string>>; clearStateLabels?: boolean }
export interface HerdrAdapter {
  currentPane(callerPaneId?: string): Promise<ApiResult<PaneRef>>; pane(id: string): Promise<ApiResult<PaneRef>>; processInfo(id: string): Promise<ApiResult<ProcessInfo>>;
  panes(workspaceId: string): Promise<ApiResult<PaneRef[]>>; createTab(workspaceId: string, cwd: string): Promise<ApiResult<{ tabId: string; rootPane: PaneRef }>>;
  splitPane(id: string, direction: "right" | "down", cwd: string): Promise<ApiResult<PaneRef>>; runViewer(id: string, command: string): Promise<ApiResult<void>>;
  metadata(id: string, patch: MetadataPatch): Promise<ApiResult<void>>; viewerState(id: string, state: "idle" | "working", source: string, seq: string): Promise<ApiResult<void>>;
  releaseViewer(id: string, source: string, seq: string): Promise<ApiResult<void>>; notify(title: string, body: string): Promise<ApiResult<void>>;
  closePane(id: string): Promise<ApiResult<void>>; closeTab(id: string): Promise<ApiResult<void>>; scoped(isCurrent: () => boolean): HerdrAdapter;
}

const execFile = promisify(nodeExecFile);
const success = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failure = (reason: "missing" | "unavailable" | "invalid", error: string): ApiResult<never> => ({ ok: false, reason, error });
const text = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
function paneRef(value: any): PaneRef | undefined {
  if (!value || !text(value.pane_id) || !text(value.tab_id) || !text(value.workspace_id)) return;
  return { paneId: value.pane_id, tabId: value.tab_id, workspaceId: value.workspace_id };
}
function parseOutput(output: string): any {
  const value = JSON.parse(output);
  if (value?.ok === false) throw Object.assign(new Error(value.error?.message ?? value.error ?? "Herdr request failed"), { herdrCode: value.error?.code });
  if (value?.ok !== true || !value.result || typeof value.result !== "object") throw new TypeError("invalid Herdr response");
  return value.result;
}

export function createHerdrAdapter(context: HerdrContext, exec: HerdrExec = (binary, args, options) => execFile(binary, args, options).then(r => String(r.stdout))): HerdrAdapter {
  let active = 0;
  const queue: Array<{ run: () => void; stale: () => boolean; reject: (error: Error) => void }> = [];
  const paneTails = new Map<string, Promise<unknown>>();
  const dispatch = () => {
    while (active < 4 && queue.length) {
      const item = queue.shift()!;
      if (item.stale()) { item.reject(Object.assign(new Error("scope is stale"), { stale: true })); continue; }
      active++; item.run();
    }
  };
  const schedule = <T>(work: () => Promise<T>, stale: () => boolean): Promise<T> => new Promise((resolve, reject) => {
    if (stale()) { reject(Object.assign(new Error("scope is stale"), { stale: true })); return; }
    if (active >= 4 && queue.length >= 32) { reject(Object.assign(new Error("Herdr command queue is full"), { unavailable: true })); return; }
    queue.push({ stale, reject, run: () => { work().then(resolve, reject).finally(() => { active--; dispatch(); }); } }); dispatch();
  });
  const serialPane = <T>(id: string, fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    const previous = paneTails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    paneTails.set(id, next);
    void next.finally(() => { if (paneTails.get(id) === next) paneTails.delete(id); }).catch(() => {});
    return next;
  };

  const make = (isCurrent: () => boolean): HerdrAdapter => {
    const invoke = async (args: string[], caller = context.callerPaneId): Promise<any> => {
      if (!isCurrent()) throw Object.assign(new Error("scope is stale"), { stale: true });
      return schedule(async () => {
        const output = await exec(context.binary, args, { env: { ...process.env, HERDR_SOCKET_PATH: context.socketPath, HERDR_PANE_ID: caller }, timeout: 2000, maxBuffer: 64 * 1024 });
        return parseOutput(output);
      }, () => !isCurrent());
    };
    const action = async (args: string[]): Promise<ApiResult<void>> => {
      try { await invoke(args); return success(undefined); } catch (e: any) { return errorResult(e); }
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<ApiResult<T>> => { try { return success(await fn()); } catch (e: any) { return errorResult(e); } };
    return {
      currentPane: (callerPaneId = context.callerPaneId) => wrap(async () => {
        const result = await invoke(["pane", "current", "--current"], callerPaneId); const ref = paneRef(result.pane); if (!ref) throw new TypeError("invalid pane response"); return ref;
      }),
      pane: id => wrap(async () => { const result = await invoke(["pane", "get", id]); const ref = paneRef(result.pane); if (!ref) throw new TypeError("invalid pane response"); if (ref.paneId !== id) throw new TypeError("pane ID mismatch"); return ref; }),
      processInfo: id => wrap(async () => {
        const r = await invoke(["pane", "process-info", "--pane", id]); const p = r.process_info;
        if (!p || p.pane_id !== id || !Array.isArray(p.foreground_processes)) throw new TypeError("invalid process info");
        return { paneId: p.pane_id, ...(Number.isInteger(p.shell_pid) ? { shellPid: p.shell_pid } : {}), ...(Number.isInteger(p.foreground_process_group_id) ? { foregroundProcessGroupId: p.foreground_process_group_id } : {}), foregroundProcesses: p.foreground_processes.filter((x: any) => Number.isInteger(x.pid) && text(x.name)).map((x: any) => ({ pid: x.pid, name: x.name, ...(Array.isArray(x.argv) ? { argv: x.argv.filter((a: unknown) => typeof a === "string") } : {}) })) };
      }),
      panes: workspaceId => wrap(async () => { const r = await invoke(["pane", "list"]); if (!Array.isArray(r.panes)) throw new TypeError("invalid pane list"); return r.panes.map(paneRef).filter((p: PaneRef | undefined): p is PaneRef => !!p && p.workspaceId === workspaceId); }),
      createTab: (workspaceId, cwd) => wrap(async () => { const r = await invoke(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--no-focus"]); const tab = r.tab, root = paneRef(r.root_pane); if (!text(tab?.tab_id) || !root || root.tabId !== tab.tab_id || root.workspaceId !== workspaceId) throw new TypeError("invalid tab creation response"); return { tabId: tab.tab_id, rootPane: root }; }),
      splitPane: (id, direction, cwd) => wrap(async () => { const r = await invoke(["pane", "split", id, "--direction", direction, "--cwd", cwd, "--no-focus"]); const ref = paneRef(r.pane); if (!ref) throw new TypeError("invalid split response"); return ref; }),
      runViewer: (id, command) => action(["pane", "run", id, command]),
      metadata: (id, patch) => serialPane(id, async () => {
        const args = ["pane", "report-metadata", id, "--source", patch.source, "--seq", patch.seq];
        if (patch.ttlMs !== undefined) args.push("--ttl-ms", String(patch.ttlMs));
        for (const [key, value] of Object.entries(patch.tokens ?? {})) {
          if (value === null) { if (key !== "subagent_summary") return failure("invalid", "only subagent_summary may be cleared"); args.push("--clear-token", "subagent_summary"); }
          else args.push("--token", `${key}=${value}`);
        }
        for (const [key, value] of Object.entries(patch.stateLabels ?? {})) if (value !== undefined) args.push("--state-label", `${key}=${value}`);
        if (patch.clearStateLabels) args.push("--clear-state-labels");
        try { await invoke(args); return success(undefined); } catch (e: any) { return errorResult(e); }
      }),
      viewerState: (id, state, source, seq) => serialPane(id, async () => {
        const args = ["pane", "report-metadata", id, "--source", source, "--seq", seq, "--display-agent", "pi-subagent-viewer", "--state-label", `${state}=${state}`];
        try { await invoke(args); return success(undefined); } catch (e: any) { return errorResult(e); }
      }),
      releaseViewer: (id, source, seq) => serialPane(id, async () => {
        try { await invoke(["pane", "report-metadata", id, "--source", source, "--seq", seq, "--clear-token", "subagent_summary", "--clear-state-labels"]); return success(undefined); } catch (e: any) { return errorResult(e); }
      }),
      notify: (title, body) => action(["notification", "show", title, "--body", body]),
      closePane: id => serialPane(id, () => action(["pane", "close", id])), closeTab: id => serialPane(id, () => action(["tab", "close", id])),
      scoped: scope => make(() => isCurrent() && scope()),
    };
  };
  return make(() => true);
}
function errorResult(error: any): ApiResult<never> {
  if (error?.stale) return failure("unavailable", "scope is stale");
  if (error?.unavailable || error?.code === "ETIMEDOUT" || error?.name === "AbortError") return failure("unavailable", error.message ?? "Herdr command unavailable");
  if (error?.herdrCode === "pane_not_found" || error?.herdrCode === "tab_not_found") return failure("missing", error.message);
  if (error instanceof SyntaxError || error instanceof TypeError) return failure("invalid", error.message);
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  return failure("unavailable", [error?.message ?? "Herdr command failed", stdout, stderr].filter(Boolean).join("\n"));
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export function buildViewerCommand(nodePath: string, scriptPath: string, snapshotPath: string, identityPath: string, identity: SlotIdentity, shell: "posix" | "powershell" | "cmd" | "unsupported"): string | undefined {
  const values = [nodePath, scriptPath, snapshotPath, identityPath, identity.activationId, identity.nonce];
  if (values.some(v => /[\x00-\x1f\x7f]/.test(v)) || !Number.isSafeInteger(identity.slotId) || identity.slotId < 0) return;
  const args = [nodePath, scriptPath, "--snapshot", snapshotPath, "--identity", identityPath, "--activation", identity.activationId, "--slot", String(identity.slotId), "--nonce", identity.nonce];
  if (shell === "posix") return args.map(shellQuote).join(" ");
  if (shell !== "powershell" && shell !== "cmd") return;
  const ps = `& ${args.map(psQuote).join(" ")}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return shell === "powershell" ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}` : `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}
export function classifyOccupant(processInfo: ProcessInfo, identity: ViewerIdentity, expectedScript: string, now: number): "owned" | "foreign" | "unknown" {
  if (!Number.isFinite(now) || now - identity.heartbeatAt < 0 || now - identity.heartbeatAt >= 10000) return "unknown";
  const matching = processInfo.foregroundProcesses.find(p => p.pid === identity.pid);
  if (!matching) return processInfo.foregroundProcesses.length ? "foreign" : "unknown";
  if (matching.argv && (!matching.argv.includes(expectedScript) || !matching.argv.includes("--activation") || !matching.argv.includes(identity.activationId) || !matching.argv.includes("--slot") || !matching.argv.includes(String(identity.slotId)) || !matching.argv.includes("--nonce") || !matching.argv.includes(identity.nonce))) return "foreign";
  return "owned";
}
