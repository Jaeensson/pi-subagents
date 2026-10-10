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

// tmux recursively format-expands user-option values referenced by a format, so
// a value containing `#(...)` or `#{...}` would execute a command when rendered.
// Strip every C0/C1 control character, then double each `#` so tmux renders it
// literally instead of expanding a format. Every user-option value the tmux
// adapter writes passes through this guard.
export function escapeFormatValue(value: string): string {
  return value.replace(/[\x00-\x1F\x7F-\x9F]/g, "").replace(/#/g, "##");
}

// The owned window's title echoes the escaped aggregate summary after a marker
// prefix, bounded so the tmux window list stays readable. Bounding the escaped
// string can land between the two hashes of an escaped `#`, so drop a dangling
// half before it renders as a broken format token.
const OWNED_WINDOW_PREFIX = "Subagents · ";
const OWNED_WINDOW_MAX = 40;
const PARENT_WINDOW_NAME = "Subagents";
const BORDER_FORMAT = " #{@pi_viewer_summary} ";

export function boundedWindowName(summary: string): string {
  const escaped = escapeFormatValue(summary);
  const budget = OWNED_WINDOW_MAX - OWNED_WINDOW_PREFIX.length;
  let body = escaped.slice(0, budget);
  if (body.endsWith("#") && !body.endsWith("##")) body = body.slice(0, -1);
  return `${OWNED_WINDOW_PREFIX}${body}`;
}

export interface TmuxClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: TmuxClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
};

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
  clock: TmuxClock = realClock,
): MuxAdapter {
  const queue = createCommandQueue();
  const staleError = () => Object.assign(new Error("scope is stale"), { stale: true });
  let probe: Promise<ProbeResult> | undefined;
  // The single owned window this adapter created. It is adapter-scoped (shared
  // by every scoped view) so the parent's metadata report can rename it, and it
  // is cleared by closeTab so no later summary renames a window that is gone.
  let ownedWindowId: string | undefined;
  // One scheduled TTL unset per target pane, shared across scopes: every later
  // patch or explicit clear for that pane cancels the previous timer, so no
  // timer outlives the report it belongs to. tmux options never expire on their
  // own, so this scheduled unset IS the ttlMs semantics.
  const ttlTimers = new Map<string, unknown>();
  const cancelTtl = (id: string): void => {
    const handle = ttlTimers.get(id);
    if (handle !== undefined) { clock.clearTimeout(handle); ttlTimers.delete(id); }
  };
  // TTL cleanup is best effort and outlives any one scope: it runs through the
  // shared queue directly, with no scope gate, and never throws.
  const runRaw = (args: string[], key: string): void => {
    try {
      void queue.schedule([async () => exec(context.binary, ["-S", context.endpoint, ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER })], () => false, key).catch(() => {});
    } catch { /* queue full; the stale option is harmless until the next report */ }
  };
  const scheduleTtl = (id: string, windowId: string | undefined, ttlMs: number): void => {
    cancelTtl(id);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const handle = clock.setTimeout(() => {
      ttlTimers.delete(id);
      runRaw(["set-option", "-pu", "-t", id, "@pi_subagent_summary"], id);
      if (windowId !== undefined) runRaw(["set-option", "-wu", "-t", windowId, "@pi_subagents"], windowId);
    }, ttlMs);
    ttlTimers.set(id, handle);
  };
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
  const make = (isCurrent: () => boolean): MuxAdapter => {
    const runCommands = (commands: string[][], key?: string): Promise<string[]> => queue.schedule(
      commands.map(args => async () => {
        if (!isCurrent()) throw staleError();
        return exec(context.binary, ["-S", context.endpoint, ...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
      }), () => !isCurrent(), key);
    const invoke = (args: string[], key?: string): Promise<string> => runCommands([args], key).then(results => results[0]);
    const ready = async (): Promise<ApiResult<void>> => {
      const state = await versionProbe();
      return state.ok ? success(undefined) : failure("unavailable", state.error);
    };
    const wrap = async <T>(fn: () => Promise<T>): Promise<ApiResult<T>> => {
      try { return success(await fn()); } catch (error: any) { return errorResult(error); }
    };
    const queryPane = async (id: string): Promise<PaneRef> => paneRefFromText(await invoke(["display-message", "-p", "-t", id, PANE_FORMAT]));
    // Window title chrome is decoration: a closed owned window must not fail the
    // aggregate report. Keying on the window serializes the rename with
    // closeTab, so a window closed first is never renamed afterwards.
    const renameOwned = async (name: string): Promise<void> => {
      const target = ownedWindowId;
      if (target === undefined) return;
      try { await invoke(["rename-window", "-t", target, name], target); } catch { /* best effort */ }
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
          const output = await invoke(["new-window", "-d", "-t", `${workspaceId}:`, "-c", cwd, "-n", PARENT_WINDOW_NAME, "-P", "-F", "#{window_id} #{pane_id}"]);
          const parts = output.trim().split(/\s+/).filter(Boolean);
          if (parts.length !== 2 || !TAB_ID.test(parts[0]) || !PANE_ID.test(parts[1])) throw new TypeError("invalid tmux window creation response");
          // Ownership is recorded as soon as the window exists, even if the
          // chrome below fails or the scope goes stale; the window is real.
          ownedWindowId = parts[0];
          // All chrome is window-scoped: never mutate a global tmux option.
          await runCommands([
            ["set-option", "-w", "-t", ownedWindowId, "pane-border-status", "top"],
            ["set-option", "-w", "-t", ownedWindowId, "pane-border-format", BORDER_FORMAT],
            ["set-option", "-w", "-t", ownedWindowId, "automatic-rename", "off"],
          ], ownedWindowId);
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
      processInfo: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          const output = await invoke(["display-message", "-p", "-t", id, "#{pane_pid} #{pane_current_command}"]);
          const parts = output.trim().split(/\s+/).filter(Boolean);
          const pid = Number(parts[0]);
          if (!Number.isSafeInteger(pid) || pid <= 0 || parts.length < 2) throw new TypeError("invalid tmux process info response");
          return { paneId: id, shellPid: pid, foregroundProcesses: [{ pid, name: parts.slice(1).join(" ") }] };
        });
      },
      metadata: async (id, patch) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          const tokens = patch.tokens ?? {};
          // Every patch supersedes the previous report on this pane, including
          // the ttl timer for it; only a fresh summary re-arms the timer.
          if (isCurrent()) cancelTtl(id);
          if ("subagent_summary" in tokens) {
            const value = tokens.subagent_summary;
            if (value === null) {
              await invoke(["set-option", "-pu", "-t", id, "@pi_subagent_summary"], id);
              const windowId = (await queryPane(id)).tabId;
              await invoke(["set-option", "-wu", "-t", windowId, "@pi_subagents"], id);
              await renameOwned(PARENT_WINDOW_NAME);
            } else {
              const escaped = escapeFormatValue(value);
              await invoke(["set-option", "-p", "-t", id, "@pi_subagent_summary", escaped], id);
              const windowId = (await queryPane(id)).tabId;
              await invoke(["set-option", "-w", "-t", windowId, "@pi_subagents", escaped], id);
              await renameOwned(boundedWindowName(value));
              if (isCurrent() && patch.ttlMs !== undefined) scheduleTtl(id, windowId, patch.ttlMs);
            }
          }
          for (const [name, label] of Object.entries(patch.stateLabels ?? {})) {
            if (label !== undefined) await invoke(["set-option", "-p", "-t", id, `@pi_state_${name}`, escapeFormatValue(label)], id);
          }
          if (patch.clearStateLabels) {
            for (const name of ["idle", "working", "blocked", "done", "unknown"]) {
              await invoke(["set-option", "-pu", "-t", id, `@pi_state_${name}`], id);
            }
          }
          return undefined;
        });
      },
      viewerState: async (id, nextState, _source, _seq, label) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          // tmux unsets only the first option name per command, so always batch the
          // state write and, when labelled, the summary write as separate commands.
          const commands = [["set-option", "-p", "-t", id, "@pi_viewer_state", nextState]];
          if (label !== undefined) commands.push(["set-option", "-p", "-t", id, "@pi_viewer_summary", escapeFormatValue(label)]);
          await runCommands(commands, id);
          return undefined;
        });
      },
      releaseViewer: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          await runCommands([
            ["set-option", "-pu", "-t", id, "@pi_viewer_state"],
            ["set-option", "-pu", "-t", id, "@pi_viewer_summary"],
          ], id);
          return undefined;
        });
      },
      notify: async (title, body) => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          await invoke(["display-message", "-d", "5000", "-t", context.callerPaneId, `${escapeFormatValue(title)} · ${escapeFormatValue(body)}`]);
          return undefined;
        });
      },
      closePane: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => { await invoke(["kill-pane", "-t", id], id); return undefined; });
      },
      closeTab: async id => {
        const state = await ready(); if (!state.ok) return state;
        return wrap(async () => {
          // Relinquish ownership on any explicit close of the tracked window,
          // even if the kill fails, so no later summary renames a window this
          // adapter no longer controls.
          if (ownedWindowId === id) ownedWindowId = undefined;
          await invoke(["kill-window", "-t", id], id);
          return undefined;
        });
      },
      scoped: scope => make(() => isCurrent() && scope()),
    };
  };
  return make(() => true);
}
