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
const record = (value: any): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
function structuredError(value: any): Error | undefined {
  if (record(value) && typeof value.id === "string" && !("result" in value) && record(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return Object.assign(new Error(value.error.message), { herdrCode: value.error.code });
  }
}
function parseOutput(output: string): any {
  const value = JSON.parse(output);
  const error = structuredError(value);
  if (error) throw error;
  if (!record(value) || typeof value.id !== "string" || "error" in value || !record(value.result) || !text(value.result.type)) throw new TypeError("invalid Herdr response");
  return value.result;
}
const processId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export function createHerdrAdapter(context: HerdrContext, exec: HerdrExec = (binary, args, options) => execFile(binary, args, options).then(r => String(r.stdout))): HerdrAdapter {
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
    while (active < 4) {
      const index = queue.findIndex(item => item.key === undefined || !activeKeys.has(item.key));
      if (index < 0) break;
      const item = queue.splice(index, 1)[0];
      active++;
      if (item.key !== undefined) activeKeys.add(item.key);
      item.run();
    }
  };
  const schedule = async (work: Array<() => Promise<any>>, stale: () => boolean, key?: string): Promise<any[]> => {
    if (stale()) throw staleError();
    dispatch();
    // Reserve a whole batch (release + presentation clear) or none of it.
    // Free executor slots count only if their pane is actually dispatchable.
    const keys = new Set(activeKeys); let free = 4 - active; let immediate = 0;
    for (const item of [...queue, ...work.map(() => ({ key }))]) {
      if (free && (item.key === undefined || !keys.has(item.key))) {
        free--; immediate++;
        if (item.key !== undefined) keys.add(item.key);
      }
    }
    if (queue.length + work.length - immediate > 32) throw Object.assign(new Error("Herdr command queue is full"), { unavailable: true });
    const pending = work.map(fn => new Promise<any>((resolve, reject) => {
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
    return results.map(r => (r as PromiseFulfilledResult<any>).value);
  };

  const make = (isCurrent: () => boolean): HerdrAdapter => {
    const invokeBatch = (commands: string[][], caller = context.callerPaneId, key?: string, voidActions = false): Promise<any[]> => schedule(commands.map(args => async () => {
      if (!isCurrent()) throw staleError();
      const output = await exec(context.binary, args, { env: { ...process.env, HERDR_SOCKET_PATH: context.socketPath, HERDR_PANE_ID: caller }, timeout: 2000, maxBuffer: 64 * 1024 });
      if (voidActions && output.trim() === "") return undefined;
      return parseOutput(output);
    }), () => !isCurrent(), key);
    const invoke = async (args: string[], caller = context.callerPaneId, key?: string): Promise<any> => (await invokeBatch([args], caller, key))[0];
    const action = async (args: string[], key?: string): Promise<ApiResult<void>> => {
      try { await invokeBatch([args], context.callerPaneId, key, true); return success(undefined); } catch (e: any) { return errorResult(e); }
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
        for (const field of ["shell_pid", "foreground_process_group_id"]) if (p[field] != null && !processId(p[field])) throw new TypeError(`invalid ${field}`);
        if (p.foreground_processes.some((x: any) => !record(x) || !processId(x.pid) || !text(x.name) || (x.argv != null && (!Array.isArray(x.argv) || x.argv.some((a: unknown) => typeof a !== "string"))))) throw new TypeError("invalid foreground process");
        return { paneId: p.pane_id, ...(p.shell_pid != null ? { shellPid: p.shell_pid } : {}), ...(p.foreground_process_group_id != null ? { foregroundProcessGroupId: p.foreground_process_group_id } : {}), foregroundProcesses: p.foreground_processes.map((x: any) => ({ pid: x.pid, name: x.name, ...(x.argv != null ? { argv: x.argv } : {}) })) };
      }),
      panes: workspaceId => wrap(async () => {
        const r = await invoke(["pane", "list"]); if (!Array.isArray(r.panes)) throw new TypeError("invalid pane list");
        const refs = r.panes.map((p: any) => { const ref = paneRef(p); if (!ref) throw new TypeError("invalid pane list entry"); return ref; });
        return refs.filter((p: PaneRef) => p.workspaceId === workspaceId);
      }),
      createTab: (workspaceId, cwd) => wrap(async () => { const r = await invoke(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--no-focus", "--label", "Subagents"]); const tab = r.tab, root = paneRef(r.root_pane); if (!text(tab?.tab_id) || !root || root.tabId !== tab.tab_id || root.workspaceId !== workspaceId) throw new TypeError("invalid tab creation response"); return { tabId: tab.tab_id, rootPane: root }; }),
      splitPane: (id, direction, cwd) => wrap(async () => { const r = await invoke(["pane", "split", id, "--direction", direction, "--cwd", cwd, "--no-focus"]); const ref = paneRef(r.pane); if (!ref) throw new TypeError("invalid split response"); return ref; }),
      runViewer: (id, command) => action(["pane", "run", id, command]),
      metadata: async (id, patch) => {
        const args = ["pane", "report-metadata", id, "--source", patch.source, "--seq", patch.seq];
        if (patch.ttlMs !== undefined) args.push("--ttl-ms", String(patch.ttlMs));
        for (const [key, value] of Object.entries(patch.tokens ?? {})) {
          if (value === null) { if (key !== "subagent_summary") return failure("invalid", "only subagent_summary may be cleared"); args.push("--clear-token", "subagent_summary"); }
          else args.push("--token", `${key}=${value}`);
        }
        for (const [key, value] of Object.entries(patch.stateLabels ?? {})) if (value !== undefined) args.push("--state-label", `${key}=${value}`);
        if (patch.clearStateLabels) args.push("--clear-state-labels");
        return action(args, id);
      },
      // These lifecycle methods target viewer panes only, never the parent pane.
      viewerState: (id, state, source, seq) => action(["pane", "report-agent", id, "--source", source, "--seq", seq, "--agent", "pi-subagent-viewer", "--state", state], id),
      releaseViewer: async (id, source, seq) => {
        try {
          await invokeBatch([
            ["pane", "release-agent", id, "--source", source, "--seq", seq, "--agent", "pi-subagent-viewer"],
            ["pane", "report-metadata", id, "--source", source, "--seq", seq, "--clear-token", "subagent_summary", "--clear-state-labels"],
          ], context.callerPaneId, id, true);
          return success(undefined);
        } catch (e: any) { return errorResult(e); }
      },
      notify: (title, body) => action(["notification", "show", title, "--body", body]),
      closePane: id => action(["pane", "close", id], id), closeTab: id => action(["tab", "close", id], id),
      scoped: scope => make(() => isCurrent() && scope()),
    };
  };
  return make(() => true);
}
function errorResult(error: any): ApiResult<never> {
  if (error?.stale) return failure("unavailable", "scope is stale");
  if (error?.unavailable || error?.code === "ETIMEDOUT" || error?.name === "AbortError") return failure("unavailable", error.message ?? "Herdr command unavailable");
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  // Installed CLI server errors exit 1 with an id/error envelope on stderr.
  let apiError = error?.herdrCode ? error : undefined;
  if (!apiError && stderr) { try { apiError = structuredError(JSON.parse(stderr)); } catch {} }
  if (apiError?.herdrCode === "pane_not_found" || apiError?.herdrCode === "tab_not_found") return failure("missing", apiError.message);
  if (error instanceof SyntaxError || error instanceof TypeError) return failure("invalid", error.message);
  return failure("unavailable", [error?.message ?? "Herdr command failed", apiError?.message, stdout, stderr].filter(Boolean).join("\n"));
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export function buildViewerCommand(nodePath: string, scriptPath: string, snapshotPath: string, identityPath: string, identity: SlotIdentity, shell: "posix" | "powershell" | "cmd" | "unsupported"): string | undefined {
  const values = [nodePath, scriptPath, snapshotPath, identityPath, identity.activationId, identity.nonce];
  if (values.some(v => /[\x00-\x1f\x7f-\x9f]/.test(v)) || !Number.isSafeInteger(identity.slotId) || identity.slotId < 0) return;
  const args = [nodePath, scriptPath, "--snapshot", snapshotPath, "--identity", identityPath, "--activation", identity.activationId, "--slot", String(identity.slotId), "--nonce", identity.nonce];
  if (shell === "posix") return args.map(shellQuote).join(" ");
  if (shell !== "powershell" && shell !== "cmd") return;
  const ps = `& ${args.map(psQuote).join(" ")}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  return shell === "powershell" ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}` : `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
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
