# Optional tmux monitoring and live viewers via a shared mux layer

Date: 2026-10-09
Status: Written specification approved by the user on 2026-10-09; implementation plan and execution method awaiting approval.

## Intent and agreed scope

Add tmux as a second display-only multiplexer backend for pi-subagent, reachable
only when pi itself runs inside tmux, without changing how subagents execute.
Subagents remain piped `pi --mode json` children; tmux is observability, not an
execution transport. To avoid two divergent copies of the existing Herdr
orchestration, the current Herdr subsystem is refactored into a backend-agnostic
`mux-*` layer with `MuxAdapter` as the seam, and tmux is added as the second
adapter.

Success means:

- Inside tmux, a dedicated, extension-owned `Subagents` window holds up to four
  read-only live viewer panes, one per executing task attempt.
- tmux-native chrome shows status without mutating global tmux options:
  per-pane `pane-border-status`/`pane-border-format` (window-scoped), a
  window-list aggregate via the window name, and completion notices via
  `display-message`.
- Outside a multiplexer, behavior is unchanged: no multiplexer commands, viewer
  processes, files, or timers. The Herdr integration and its guarantees are
  preserved, including the Herdr-only parts of its experience.
- Multiplexer failures never change task/job results, scheduling, in-Pi
  notifications, durability, pause/resume, or shutdown classification.
- The Herdr refactor is behavior-preserving: all existing `herdr-*` tests pass
  through the rename before any tmux code lands.

### Non-goals

- Running children as interactive processes inside tmux panes, steering children
  from panes, or making tmux state authoritative for success (the HazAT-style
  model is explicitly rejected; see "Prior art").
- Auto-resuming jobs or viewers after a tmux server restart.
- Mutating global tmux options (`status-right`/`status-left`/global
  `pane-border-status`), installing tmux, or rewriting user tmux configuration.
- Supporting multiplexers other than Herdr and tmux in this iteration (cmux,
  zellij, WezTerm are out of scope; the seam is left open but no interface is
  designed for them).
- Replacing the Pi status widget, live watch overlay, or existing subagent tools.

## Prior art and evidence

Research into the pi extension ecosystem (2026-10-09):

- The two largest subagent extensions, `tintinweb/pi-subagents` and
  `nicobailon/pi-subagents`, have no tmux support. nicobailon integrates with
  Herdr only (inspectors, project panes, Orca progress tabs) plus RPC/events;
  tintinweb stays entirely inside pi's TUI.
- `HazAT/pi-interactive-subagents` is the only major subagent extension with
  real tmux support, via a multiplexer abstraction spanning cmux, tmux, zellij,
  and WezTerm with a `PI_SUBAGENT_MUX` override. Its model hosts the subagent as
  an interactive process in a pane, which conflicts with this repository's
  piped-child, durable-store, and resume design and is therefore not adopted.
- `pi-herdr-subagents` is Herdr-exclusive by design.
- Adjacent tmux tooling is not subagent delegation: `pi-muxr` (a tmux dashboard
  and sidebar for pi sessions), `pi-terminal-tmux` (TTY control for
  vim/htop/ssh), `pi-tmux-bash` (a tmux-backed bash), and `pi-tmux-orchestrator`
  (its own implementer/reviewer workflow).

Herdr is itself a terminal multiplexer and agent-orchestration layer, which is
why this repository's Herdr integration is the correct seam to generalize rather
than a Herdr-specific bolt-on to duplicate.

tmux primitives were verified directly on the development machine, tmux 3.7c:

- Pane-scoped and window-scoped user options work and read back
  (`set -p @k v` / `set -w @k v`; `show-options -p/-w -v @k`;
  `display-message -p '#{@k}'`).
- `pane-border-status` and `pane-border-format` are window options (`set -w`).
- The host tmux already runs catppuccin, which owns `status-right` and sets
  `@catppuccin_pane_border_status off` globally; this is why a scoped approach is
  required.
- `pipe-pane`, `respawn-pane -k`, `wait-for -S`, and `display-popup` exist.
- `respawn-pane -k -t <pane> <absolute-argv…>` execs the command directly (no
  shell wrapper), so `#{pane_pid}` becomes the launched process itself. This
  means the viewer's reported PID equals `#{pane_pid}` and ownership
  classification works from `#{pane_pid}` plus `#{pane_current_command}` alone,
  with no `ps` dependency. Before launch, `#{pane_pid}` is the pane shell and
  `#{pane_current_command}` names it.

## Chosen approach

Rename the backend-agnostic pieces of the Herdr subsystem into a `mux-*` layer,
extract `MuxAdapter`, and implement tmux as a second adapter. Reuse the existing
snapshot store, snapshot DTO, renderer, viewer script, ownership handshake, slot
policy, command queue, and bounded-cleanup discipline unchanged in behavior.
Only detection, command translation, and the shell-run representation are
backend-specific.

### Module layout and dependency graph

```
mux-core.ts ──> mux-viewer-render.mjs         (MuxContext, PaneRef, snapshot projection,
                                               summarizeTasks, chooseSlot)
mux-adapter.ts ──> mux-core.ts                (MuxAdapter, ApiResult, ProcessInfo,
                                               MetadataPatch, createCommandQueue)
herdr-adapter.ts ──> mux-adapter.ts           (getHerdrContext, Herdr exec envelope,
                                               buildViewerCommand/herdr shell matrix)
tmux-adapter.ts  ──> mux-adapter.ts           (getTmuxContext, tmux argv,
                                               pane_pid/pane_current_command process info)
mux-detection.ts ──> herdr-adapter, tmux-adapter   (env → {backend, context} | undefined)
mux-files.ts     ──> mux-core.ts              (SnapshotStore; temp prefix "pi-mux-viewer-")
mux-viewers.ts   ──> mux-adapter, mux-files, mux-core
mux-monitor.ts   ──> mux-core, mux-adapter (type-only), mux-viewers
mux-settings.ts  ──> settings.ts              (normalizes subagent.herdr + subagent.tmux)
mux-viewer.mjs / mux-viewer-render.mjs        (standalone reader; generic)
index.ts         ──> mux-monitor, mux-detection, adapters, mux-settings   (wiring only)
```

Renames (logic-preserving): `herdr-core.ts`→`mux-core.ts`,
`herdr-monitor.ts`→`mux-monitor.ts`, `herdr-viewers.ts`→`mux-viewers.ts`,
`herdr-files.ts`→`mux-files.ts`, `herdr-viewer.mjs`→`mux-viewer.mjs`,
`herdr-viewer-render.mjs`→`mux-viewer-render.mjs`. `herdr-adapter.ts` stays
Herdr-specific. New: `mux-adapter.ts`, `mux-detection.ts`, `tmux-adapter.ts`,
`mux-settings.ts`. The graph stays acyclic; leaf and observer rules are
preserved.

### Interface changes

- `HerdrContext` → `MuxContext { backend: "herdr" | "tmux"; binary: string;
  endpoint: string; callerPaneId: string }`. `endpoint` is Herdr's socket path or
  the tmux server socket parsed from `$TMUX`.
- `runViewer(id, command: string)` → `runViewer(id, viewer: { argv: readonly
  string[]; shellCommand: string })`. Herdr's `pane run` consumes `shellCommand`;
  tmux's `respawn-pane -k` consumes `argv`, removing the fish/PowerShell quoting
  matrix on the tmux path. Constructing the launch is adapter-specific: Herdr
  keeps its shell detection (`shellOf`) and command quoting in `herdr-adapter.ts`,
  while tmux uses direct argv and needs no shell classification at all. The
  shared viewer manager delegates launch construction to the adapter rather than
  requiring a supported shell on every backend.
- `MetadataPatch` keeps its shape; the tmux adapter interprets it through pane
  and window user options. This is the only emulation surface.
- The 4-concurrency/32-cap queue inside `createHerdrAdapter` is extracted to a
  shared `createCommandQueue` so both adapters get identical bounded-concurrency
  and stale-scope guarantees.

## Adapter interface and tmux command mapping

All tmux commands target the exact server via `-S <socket-from-$TMUX>`; the
integration never affects a different tmux server.

| `MuxAdapter` op | tmux implementation |
|---|---|
| `detectMux(env)` (not an adapter op) | `$TMUX` (`socket,pid,session`) + `$TMUX_PANE` → `{backend:"tmux", binary, endpoint:socket, callerPaneId}` (the session is derived from the resolved parent pane, as in Herdr); `tmux -V` version guard, floor 3.2; `PI_SUBAGENT_MUX=herdr\|tmux` forces |
| `currentPane(id?)` | `display-message -p -t <id> '#{pane_id} #{window_id} #{session_id}'` |
| `pane(id)` | same, asserting returned `pane_id === id` |
| `panes(sessionId)` | `list-panes -s -t <session> -F '#{pane_id} #{window_id} #{session_id}'` |
| `createTab(sessionId, cwd, label)` | `new-window -d -t <session>: -c <cwd> -n <label> -P -F '#{window_id} #{pane_id}'`; then window-scoped `pane-border-status top`, `pane-border-format ' #{@pi_viewer_summary} '`, `automatic-rename off` |
| `splitPane(id, right\|down, cwd)` | `split-window -d -h\|-v -t <id> -c <cwd> -P -F '#{pane_id}'` |
| `runViewer(id, {argv, shellCommand})` | `respawn-pane -k -t <id> <argv…>` (direct argv, no shell) |
| `metadata(id, patch)` | `set -p -t <id> @pi_subagent_summary <v>` / `set -pu` to clear; mirror aggregate to `set -w -t <window> @pi_subagents`; `ttlMs` → adapter-scheduled unset timer; state labels → `@pi_state_*` |
| `viewerState(id, state, …)` | `set -p -t <id> @pi_viewer_state working\|idle`, `@pi_viewer_summary <name>`; `source`/`seq` ignored (tmux has no dedup/TTL API) |
| `releaseViewer(id, …)` | `set -pu -t <id> @pi_viewer_state @pi_viewer_summary` |
| `notify(title, body)` | `display-message -d 5000 -t <caller> "<title> · <body>"` (non-blocking, no modal popup) |
| `closePane` / `closeTab` | `kill-pane -t <id>` / `kill-window -t <id>` |
| `processInfo(id)` | `display-message -p -t <id> '#{pane_pid} #{pane_current_command}'` → `{ paneId, shellPid: pane_pid, foregroundProcesses: [{ pid: pane_pid, name: pane_current_command }] }`. Because `respawn-pane` execs the viewer directly, `pane_pid` is the viewer PID, so `classifyOccupant` returns `owned` through its no-`argv` single-process fallback, and `shellOf` recognizes the pre-launch pane shell. No `ps` required. Optional `ps` argv enrichment may be added later for the strict path but is not needed |
| `scoped(isCurrent)` | same stale-scope pattern as the Herdr adapter |

### Window chrome and the window-list aggregate

Because the owned window is created with `-n <label>` and `automatic-rename off`,
its name carries `Subagents · N running` in the status-line window list without
any global mutation. Window-scoped `pane-border-status`/`pane-border-format` then
render `#{@pi_viewer_summary}` and `#{@pi_viewer_state}` per viewer pane. The
parent pane's `@pi_subagent_summary` is published but rendered only if the user
opts in through their own formats; this is documented, never forced.

### Security: format injection

tmux recursively format-expands user-option values referenced by a format. An
unsanitized value containing `#(...)` or `#{...}` written into
`@pi_viewer_summary` would execute a command when the border renders. Every value
the tmux adapter writes is control-character-stripped and has `#` escaped to
`##`. This guard is unit-tested on the exact bytes written.

## Settings, detection, and activation

`settings.json` keeps `subagent.herdr { enabled, viewers }` verbatim and adds
`subagent.tmux { enabled, viewers }`:

```json
{
  "subagent": {
    "herdr": { "enabled": true, "viewers": true },
    "tmux":  { "enabled": true, "viewers": true }
  }
}
```

All four values default to `true` when absent; only booleans are accepted, and
invalid values fall back to the default. Unknown keys are preserved on write.
`mux-settings.ts` exposes `readMuxOptions(settingsPath)` and
`writeMuxOptions(settingsPath, backend, opts)`.

Detection precedence is `PI_SUBAGENT_MUX` override → Herdr (preserving current
behavior when both environments are present) → tmux. `index.ts` constructs one
monitor with injected ports:

```
createMuxMonitor({
  env, getTasks, subscribe, clock, warn, viewerFactory,
  detect: detectMux,
  adapterFactory: (ctx) =>
    ctx.backend === "tmux" ? createTmuxAdapter(ctx) : createHerdrAdapter(ctx),
})
```

`session_start` keeps its exact order (durable recovery → commit binding →
activate). Activation runs only when detection resolves and that backend's
`enabled` is on. `applyOptions` re-reads the detected backend's options. The
`ports.createMonitor` test-injection seam is preserved.

The `/subagents` dialog gains **tmux monitoring** and **tmux viewers** rows after
the Herdr rows, with descriptions mirroring Herdr's. Toggling persists
immediately and takes effect in the current session. Existing tier/clear-key
navigation must continue to target the correct rows.

## Failure behavior, cleanup, and self-healing

- No multiplexer, version below floor, or adapter-construction failure → one
  bounded warning; monitoring is off for the session and creates no commands,
  viewer processes, files, or timers.
- Any command failure → a single bounded warning; that activation degrades, and
  viewers roll back through the existing bounded (2 s) cleanup. Failures never
  propagate into task/job handling.
- Missing `node` → viewers unavailable, metadata still attempted (unchanged).
- No `remain-on-exit`: a viewer that times out closes its own pane; `service`
  and `createLayout` re-inspect, relinquish the missing slot, and re-split a
  fresh pane. If every viewer exits, the owned window closes itself. A crash
  leaves nothing that outlives the viewer timeout.
- On `session_shutdown`, the monitor's bounded cleanup kills owned panes/windows
  and unsets this integration's options before the child-reaping guard, matching
  the current sequence.
- tmux user options never expire, so `metadata` `ttlMs` is emulated with at most
  one scheduled unset per target, replaced on each patch and invalidated
  synchronously on `stop`.

## Compatibility

Floor is tmux 3.2 (pi's own baseline; every primitive used exists there and was
verified on 3.7c). The adapter parses `tmux -V`, tolerating `tmux next-*`, and
disables with one warning below the floor. Ownership uses only
`#{pane_pid}`/`#{pane_current_command}` and does not depend on `ps`, so there is
no Linux/macOS process-listing portability concern.

## Testing

TDD with red-first tests per repository convention.

- `mux-detection.test.mjs` — `PI_SUBAGENT_MUX` override, Herdr-before-tmux
  precedence, absent → `undefined`.
- `tmux-adapter.test.mjs` — injected fake `exec`; exact argv per operation;
  format-injection guard (`#`→`##`, control stripping); version guard;
  `ApiResult` reason mapping; `pane_pid`/`pane_current_command` process info and
  the no-`argv` ownership fallback.
- `mux-settings.test.mjs` — both keys read/write, malformed normalization, and
  unchanged `subagent.herdr` round-trip.
- `mux-monitor.test.mjs` / `tmux-viewers.test.mjs` — generalized fake-adapter
  harnesses: activation gated on detection plus `enabled`; TTL-unset scheduling;
  `notify` on job finish; slot reuse; ownership classification against
  tmux-shaped `ProcessInfo`; bounded cleanup; self-healing on a missing pane.
- `mux-extension.test.mjs` — entry wiring through the preserved injection seam:
  inert with no multiplexer environment, activates under `$TMUX`, tmux dialog
  rows toggle and persist.
- All existing `herdr-*` tests stay green through the rename.

Opt-in live smoke (`scripts/tmux-monitor-smoke.mjs`, outside `npm test`): create
a disposable `tmux -L pi-smoke-<nonce>` server, run pi headless inside it, assert
a `Subagents` window with viewer panes and window-scoped options, then tear it
down. This is the honesty gate for real tmux interaction; unit tests never touch
a live server.

`npm test` and `npm run typecheck` must pass, and the smoke script must be run
once before claiming the tmux path works.

## Documentation

README gains an "Optional tmux monitoring" section paralleling the Herdr one:
floor and version guard, the `subagent.tmux` keys, the `/subagents` toggles, the
inertness guarantee, the format-injection note, and the opt-in parent-summary
rendering snippet. AGENTS.md gains the new module layout and dependency graph.

## Rollout

Four commits, each green:

1. Behavior-preserving rename to `mux-*` plus interface generalization
   (`MuxContext`, `runViewer` argv, shared command queue); Herdr tests pass
   untouched.
2. `tmux-adapter.ts` + `mux-detection.ts` + unit tests.
3. Monitor/viewer integration, entry wiring, settings and dialog rows, tests.
4. Window chrome and notices, README/AGENTS docs, smoke script.

## Known risks

- `#{pane_current_command}` naming for exotic shells (mitigated: `shellOf`
  returning `undefined` only defers a launch, never authorizes destructive
  cleanup).
- Window-option format-expansion semantics across tmux versions (verified on
  3.7c, locked by adapter tests).
- catppuccin or another theme re-applying a global `pane-border-status`
  (mitigated by writing it window-scoped at each `createTab`).
- Refactor churn in a working, tested subsystem (mitigated by landing the rename
  as an isolated, behavior-preserving first commit).
