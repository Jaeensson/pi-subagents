import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { MuxContext, PaneRef } from "./mux-core.ts";
import { createCommandQueue } from "./mux-adapter.ts";
import type { ApiResult, MuxAdapter, ViewerLaunch } from "./mux-adapter.ts";

export type TmuxExec = (binary: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<string>;

const execFile = promisify(nodeExecFile);
const FLOOR = { major: 3, minor: 2 };
const COMMAND_TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024;
const PANE_FORMAT = "#{pane_id} #{window_id} #{session_id}";
const PANE_ID = /^%\d+$/;
const TAB_ID = /^@\d+$/;
const WORKSPACE_ID = /^\$\d+$/;

type FailureReason = "missing" | "unavailable" | "invalid";

export function getTmuxContext(env: NodeJS.ProcessEnv): MuxContext | undefined {
  const tmux = env.TMUX?.trim();
  const pane = env.TMUX_PANE?.trim();
  if (!tmux || !pane) return undefined;
  // $TMUX is "<socket>,<server-pid>,<session-id>"; the socket is the first field.
  const endpoint = tmux.split(",")[0]?.trim();
  if (!endpoint) return undefined;
  return { backend: "tmux", binary: env.PI_TMUX_BIN?.trim() || "tmux", endpoint, callerPaneId: pane };
}

export function parseTmuxVersion(output: string): { major: number; minor: number } | undefined {
  const match = /^tmux\s+(?:next-)?(\d+)\.(\d+)/.exec(output.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

const atFloor = (version: { major: number; minor: number }): boolean =>
  version.major > FLOOR.major || (version.major === FLOOR.major && version.minor >= FLOOR.minor);

const success = <T>(value: T): ApiResult<T> => ({ ok: true, value });
const failure = (reason: FailureReason, error: string): ApiResult<never> => ({ ok: false, reason, error });

function paneRefFromText(output: string): PaneRef {
  const parts = output.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || !PANE_ID.test(parts[0]) || !TAB_ID.test(parts[1]) || !WORKSPACE_ID.test(parts[2])) {
    throw new TypeError("invalid tmux pane response");
  }
  return { paneId: parts[0], tabId: parts[1], workspaceId: parts[2] };
}

function errorResult(error: any): ApiResult<never> {
  if (error?.stale) return failure("unavailable", "scope is stale");
  if (error?.unavailable || error?.code === "ETIMEDOUT" || error?.name === "AbortError") return failure("unavailable", error.message ?? "tmux command unavailable");
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const detail = `${error?.message ?? ""}\n${stderr}`;
  if (/(?:can't find|no such) (?:pane|window|session)/i.test(detail)) return failure("missing", (stderr.trim() || error?.message || "missing tmux target").trim());
  if (error instanceof SyntaxError || error instanceof TypeError) return failure("invalid", error.message);
  return failure("unavailable", [error?.message ?? "tmux command failed", stderr, stdout].filter(Boolean).join("\n"));
}

type ProbeResult = { ok: true } | { ok: false; error: string };

export function createTmuxAdapter(
  context: MuxContext,
  exec: TmuxExec = (binary, args, options) => execFile(binary, args, options).then(result => String(result.stdout)),
): MuxAdapter {
  const queue = createCommandQueue();
  const staleError = () => Object.assign(new Error("scope is stale"), { stale: true });
  let probe: Promise<ProbeResult> | undefined;
  // The version probe is the only command allowed below the floor. It runs
  // lazily on the first operation and its result (success or failure) is cached.
  const versionProbe = (): Promise<ProbeResult> => {
    probe ??= (async () => {
      try {
        const output = await exec(context.binary, ["-S", context.endpoint, "-V"], { timeout: 2000, maxBuffer: MAX_BUFFER });
        const version = parseTmuxVersion(output);
        if (!version) return { ok: false, error: "unable to determine the tmux version" };
        return atFloor(version) ? { ok: true } : { ok: false, error: `tmux ${version.major}.${version.minor} is below the 3.2 floor` };
      } catch (error: any) {
        return { ok: false, error: error?.message ?? "tmux version probe failed" };
      }
    })();
    return probe;
  };

  // Below the floor every operation returns before issuing any other command.
  // Task 8 replaces the remaining presentation stubs.
  const make = (isCurrent: () => boolean): MuxAdapter => {
    const invoke = (args: string[], key?: string): Promise<string> => queue.schedule([async () => {
      if (!isCurrent()) throw staleError();
      return exec(context.binary, ["-S", context.endpoint, ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    }], () => !isCurrent(), key).then(results => results[0]);
    const ready = async (): Promise<ApiResult<void>> => {
      const state = await versionProbe();
      return state.ok ? success(undefined) : failure("unavailable", state.error);
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<ApiResult<T>> => {
      try { return success(await fn()); } catch (error: any) { return errorResult(error); }
    };
    const queryPane = async (id: string): Promise<PaneRef> => paneRefFromText(await invoke(["display-message", "-p", "-t", id, PANE_FORMAT]));
    const stub = (operation: string) => async (): Promise<ApiResult<never>> => {
      const state = await ready();
      return failure("unavailable", state.ok ? `tmux ${operation} is not implemented` : state.error);
    };
    return {
      currentPane: async (id) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(() => queryPane(id ?? context.callerPaneId));
      },
      pane: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          const ref = await queryPane(id);
          if (ref.paneId !== id) throw new TypeError("tmux pane ID mismatch");
          return ref;
        });
      },
      panes: async workspaceId => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => (await invoke(["list-panes", "-s", "-t", workspaceId, "-F", PANE_FORMAT]))
          .split("\n").map(line => line.trim()).filter(Boolean).map(paneRefFromText));
      },
      createTab: async (workspaceId, cwd) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          const output = await invoke(["new-window", "-d", "-t", `${workspaceId}:`, "-c", cwd, "-n", "Subagents", "-P", "-F", "#{window_id} #{pane_id}"]);
          const parts = output.trim().split(/\s+/).filter(Boolean);
          if (parts.length !== 2 || !TAB_ID.test(parts[0]) || !PANE_ID.test(parts[1])) throw new TypeError("invalid tmux window creation response");
          return { tabId: parts[0], rootPane: { paneId: parts[1], tabId: parts[0], workspaceId } };
        });
      },
      splitPane: async (id, direction, cwd) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          const output = await invoke(["split-window", "-d", direction === "right" ? "-h" : "-v", "-t", id, "-c", cwd, "-P", "-F", "#{pane_id}"]);
          const paneId = output.trim();
          if (!PANE_ID.test(paneId)) throw new TypeError("invalid tmux split response");
          return queryPane(paneId);
        });
      },
      runViewer: async (id, viewer: ViewerLaunch) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => { await invoke(["respawn-pane", "-k", "-t", id, ...viewer.argv]); return undefined; });
      },
      processInfo: stub("processInfo"),
      metadata: stub("metadata"),
      viewerState: stub("viewerState"),
      releaseViewer: stub("releaseViewer"),
      notify: stub("notify"),
      closePane: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => { await invoke(["kill-pane", "-t", id], id); return undefined; });
      },
      closeTab: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => { await invoke(["kill-window", "-t", id], id); return undefined; });
      },
      scoped: scope => make(() => isCurrent() && scope()),
    };
  };
  return make(() => true);
}
