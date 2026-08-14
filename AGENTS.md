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
- `index.ts` is the extension entry (tools, job registry, process spawning,
  TUI rendering); `agents.ts` discovers agent definitions from
  `~/.pi/agent/agents/*.md`.
- Agent files: YAML frontmatter (`name`, `description` required; `tools`,
  `model` optional) + markdown system prompt body.
- Subagent children run `pi --mode json -p --no-session --no-extensions
  --no-skills --no-prompt-templates`.

## Development

- Local dev: symlink the repo into `~/.pi/agent/extensions/subagent`, or
  install via `pi install git:git@github.com:Jaeensson/pi-subagents`.
- Reload pi (`/reload`) after changes; the extension is loaded at session
  start.
