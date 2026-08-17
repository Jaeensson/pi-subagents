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
- Add unit tests in `tests/core.test.mjs` for new pure logic; watch them fail
  first.
- Module layout (each file is a single responsibility):
  - `index.ts` — extension entry only: session hooks + tool registration
  - `runtime.ts` — in-memory task/job registry, waiters, completion checks
    (no imports from sibling modules; safe to import from anywhere)
  - `process.ts` — child pi process lifecycle (spawn/kill/finalize)
  - `jobs.ts` — job orchestration: chain runner, concurrency limiter,
    result builders, model-tier context
  - `tui.ts` — TUI rendering helpers + persistent status widget
  - `tools/*.ts` — one file per registered tool (`defineTool`)
- Keep the dependency graph acyclic: runtime → process → jobs → tools;
  tui depends only on runtime + core.
- `agents.ts` discovers agent definitions from `~/.pi/agent/agents/*.md` and seeds the bundled defaults (`agents/*.md`: scout, researcher, worker, reviewer) into that directory on load when missing.
- Agent files: YAML frontmatter (`name`, `description` required; `tools`,
  `tier`, `extensions` optional) + markdown system prompt body. `tier` is
  `fast | balanced | deep`, resolved via `subagent.modelTiers` in pi's
  settings.json. The `model` frontmatter key is intentionally unsupported.
- Agents may declare `extensions` (comma-separated specs, e.g.
  `npm:pi-web-access`) that are loaded in the child via explicit `-e` flags;
  `--no-extensions` still prevents auto-discovery, so recursion is impossible.
- Subagent children run `pi --mode json -p --no-session --no-extensions
  --no-skills --no-prompt-templates`.

## Development

- Local dev: symlink the repo into `~/.pi/agent/extensions/subagent`, or
  install via `pi install git:git@github.com:Jaeensson/pi-subagents`.
- Reload pi (`/reload`) after changes; the extension is loaded at session
  start.
