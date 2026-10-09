import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { MuxContext } from "./mux-core.ts";
import type { ApiResult, MuxAdapter } from "./mux-adapter.ts";

export type TmuxExec = (binary: string, args: string[], options: { timeout: number; maxBuffer: number; signal?: AbortSignal }) => Promise<string>;

const execFile = promisify(nodeExecFile);
const FLOOR = { major: 3, minor: 2 };

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

const failure = (error: string): ApiResult<never> => ({ ok: false, reason: "unavailable", error });

type ProbeResult = { ok: true } | { ok: false; error: string };

export function createTmuxAdapter(
  context: MuxContext,
  exec: TmuxExec = (binary, args, options) => execFile(binary, args, options).then(result => String(result.stdout)),
): MuxAdapter {
  let probe: Promise<ProbeResult> | undefined;
  // The version probe is the only command allowed below the floor. It runs
  // lazily on the first operation and its result (success or failure) is cached.
  const versionProbe = (): Promise<ProbeResult> => {
    probe ??= (async () => {
      try {
        const output = await exec(context.binary, ["-S", context.endpoint, "-V"], { timeout: 2000, maxBuffer: 64 * 1024 });
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
  // Tasks 7 and 8 replace these stubs with real implementations.
  const stub = (operation: string) => async (): Promise<ApiResult<never>> => {
    const state = await versionProbe();
    return state.ok ? failure(`tmux ${operation} is not implemented`) : failure(state.error);
  };

  const make = (isCurrent: () => boolean): MuxAdapter => ({
    currentPane: stub("currentPane"),
    pane: stub("pane"),
    processInfo: stub("processInfo"),
    panes: stub("panes"),
    createTab: stub("createTab"),
    splitPane: stub("splitPane"),
    runViewer: stub("runViewer"),
    metadata: stub("metadata"),
    viewerState: stub("viewerState"),
    releaseViewer: stub("releaseViewer"),
    notify: stub("notify"),
    closePane: stub("closePane"),
    closeTab: stub("closeTab"),
    scoped: scope => make(() => isCurrent() && scope()),
  });
  return make(() => true);
}
