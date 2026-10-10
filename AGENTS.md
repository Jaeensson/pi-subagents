# AGENTS.md

pi-subagent-extension: `subagent` tool for pi — delegates tasks to isolated
child pi processes (single/parallel/chain; sync or background).

## Commands

```bash
npm test          # node:test — unit tests for core.ts
npm run typecheck # tsc --noEmit (uses nix-store symlinks in node_modules/)
```

## Key conventions

- `core.ts` must stay free of runtime imports from pi packages and use only
  erasable TypeScript syntax (no enums, no parameter properties) so it runs
  under Node's type stripping in `node --test`.
- Add unit tests in `tests/core.test.mjs` / `tests/store.test.mjs` for new pure
  logic; watch them fail first.
- Module layout (each file is a single responsibility):
  - `index.ts` — extension entry only: session hooks (store binding, GC,
    interrupted-job surfacing, shutdown sweep) + tool registration
  - `store.ts` — durable job store: manifest schema, atomic writes,
    session-file globbing, GC planning, resume plans (pure; no pi imports;
    tested)
  - `runtime.ts` — in-memory task/job registry, waiters, completion checks
    (type-only import from `live.ts`; safe to import from anywhere)
  - `live.ts` — pure live-trace state: segment reducer over child stdout
    (`message_update`/`tool_execution_*`) + trace→lines renderer (zero pi
    imports; tested with `node --test`)
  - `process.ts` — child pi process lifecycle (spawn/kill/finalize)
  - `jobs.ts` — job orchestration: chain runner, concurrency limiter,
    result builders, model-tier context
  - `tui.ts` — TUI rendering helpers + persistent status widget
  - `command-subagents.ts` — `/subagents` settings dialog: auto-tier toggle,
    per-tier model pickers, and Herdr/tmux monitoring/viewer switches; model
    tiers persist via `writeModelTiers` and mux options via `mux-settings.ts`
  - `mux-core.ts` — shared multiplexer types (`MuxContext`/`PaneRef`/slot
    state) and task-summary/snapshot projection helpers
  - `mux-adapter.ts` — shared `MuxAdapter` interface, bounded command queue, and
    viewer-occupant classification
  - `mux-detection.ts` — backend detection precedence: `PI_SUBAGENT_MUX`
    override → Herdr → tmux
  - `mux-settings.ts` — pure normalization and persistence of the per-backend
    `subagent.herdr` / `subagent.tmux` options
  - `mux-monitor.ts` — session-bound metadata reporting and viewer lifecycle,
    plus `MonitorClock`/`nodeMonitorClock`
  - `mux-viewers.ts` — owned viewer-pane pool and snapshot lifecycle (uses
    `mux-files.ts` for private transports)
  - `mux-files.ts` — private snapshot/identity files with atomic writes
  - `herdr-adapter.ts` — Herdr protocol and CLI adaptation, plus the shared
    `buildViewerCommand`
  - `tmux-adapter.ts` — tmux protocol/CLI adaptation, window-scoped chrome,
    `escapeFormatValue`, and the lazy 3.2 version guard
  - `mux-viewer-render.d.mts`, `mux-viewer-render.mjs`, `mux-viewer.d.mts`, and
    `mux-viewer.mjs` — standalone snapshot renderer and viewer process
  - `index.ts` constructs one idle, extension-scoped mux controller through
    `createMuxMonitor`; each `session_start` updates its mutable session
    binding and starts it after durable recovery, before the non-TUI return.
    Suppliers filter by owning job session. Adapter selection goes through
    `detectMux` plus `createHerdrAdapter`/`createTmuxAdapter`. Failed starts
    promptly stop the retained controller. Shutdown closes the spawn gate,
    immediately handles monitor-stop rejection, then durably interrupts and
    reaps children before a promise-only two-second final cleanup guard.
  - `watch-render.ts` — markdown-aware trace→lines rendering for the watch
    pane: sealed + pending text/thinking through pi's native Markdown +
    getMarkdownTheme, memoized via live.ts's LineCache. Leaf module;
    depends only on live + pi-tui + pi-coding-agent (never process/jobs)
  - `watch.ts` — keybind-toggled watch pane: overlay component, keys, ticker,
    renderer latching (depends on runtime + watch-render + live + core + tui;
    never on process/jobs)
  - `tools/*.ts` — one file per registered tool (`defineTool`)
- Keep the dependency graph acyclic: core → store → runtime → process → jobs
  → tools; live is a leaf (runtime imports it type-only, jobs imports
  emptyLiveTrace); tui depends on runtime + core; watch-render depends on
  live; watch depends on runtime + watch-render + live + core + tui.
  Multiplexer modules: mux-core is a leaf (plus mux-viewer-render.mjs);
  mux-adapter depends on mux-core; herdr-adapter and tmux-adapter depend on
  mux-core + mux-adapter; mux-files depends on mux-core; mux-settings depends
  on mux-adapter (type); mux-monitor depends on mux-core + mux-adapter +
  mux-detection (type) + mux-settings (type) + runtime (type); mux-viewers
  depends on mux-core + mux-adapter + mux-files + mux-monitor + herdr-adapter
  (shared viewer command); mux-detection depends on both adapters + mux-core;
  index wires the adapters, detection, monitor, settings, and viewers.
- `agents.ts` discovers agent definitions from `~/.pi/agent/agents/*.md` and seeds the bundled defaults (`agents/*.md`: scout, researcher, worker, reviewer) into that directory on load when missing.
- Agent files: YAML frontmatter (`name`, `description` required; `tools`,
  `tier`, `extensions` optional) + markdown system prompt body. `tier` is
  `fast | balanced | deep`, resolved via `subagent.modelTiers` in pi's
  settings.json. The `model` frontmatter key is intentionally unsupported.
- Agents may declare `extensions` (comma-separated specs, e.g.
  `npm:pi-web-access`) that are loaded in the child via explicit `-e` flags;
  `--no-extensions` still prevents auto-discovery, so recursion is impossible.
- Subagent children run durable pi sessions:
  `pi --mode json -p --session-dir <tasksDir> --session-id <taskId>` (resumes
  use `--session <file>` + a continuation prompt), still with
  `--no-extensions --no-skills --no-prompt-templates` (no recursion).
- Durability: jobs persist under
  `~/.pi/agent/subagent-jobs/<parentSessionId>/<jobId>/` (`manifest.json` +
  child transcripts in `tasks/`) and are bound to the parent session — a
  brand-new session never sees another session's jobs. Paused (`subagent_pause`),
  interrupted (crash/shutdown), and aborted tasks are resumable via
  `subagent_resume`; only `completed` is terminal. Retention:
  `subagent.jobRetentionDays` in settings.json (default 7; 0 = keep forever).
  Manifest first, child second: a task entry is flushed before its child
  spawns, and every disk write is best-effort (store problems degrade to
  in-memory behavior, never breaking spawning).

## Development

- Local dev: symlink the repo into `~/.pi/agent/extensions/subagent`, or
  install via `pi install git:git@github.com:Jaeensson/pi-subagents`.
- Reload pi (`/reload`) after changes; the extension is loaded at session
  start.
