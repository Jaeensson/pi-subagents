# Subagent Tool for pi

Delegate tasks to specialized subagents with **isolated context windows**. Each
subagent runs in its own `pi` process, so delegated work never pollutes the
parent conversation's context.

The parent session can either **wait** for subagents (synchronous) or keep
**working in parallel** (asynchronous: spawn in the background, collect later).

## Installation

Install directly from the git repo as a pi package, then reload pi (`/reload`):

```bash
pi install https://github.com/Jaeensson/pi-subagents
```

While the repo is private, or if you use SSH keys, install via SSH instead:

```bash
pi install git:git@github.com:Jaeensson/pi-subagents
```

Update to the latest version:

```bash
pi update --extensions   # or: pi update --all
# then /reload
```

Install for a single project only (`-l` writes to `.pi/settings.json`):

```bash
pi install -l https://github.com/Jaeensson/pi-subagents
```

Alternatively, for local development, copy or symlink the repo into
`~/.pi/agent/extensions/`:

```bash
# Option A: copy
cp -R pi-subagents ~/.pi/agent/extensions/subagent

# Option B: symlink (single source of truth — edits in the repo take effect after /reload)
ln -sfn "$(pwd)/pi-subagents" ~/.pi/agent/extensions/subagent
```

Agent definitions go in `~/.pi/agent/agents/*.md` (see [Agent definitions](#agent-definitions)).

## Tools

| Tool | Purpose |
|------|---------|
| `subagent` | Spawn subagents: single, parallel, or chain. `wait: true` (default) blocks and returns results; `wait: false` spawns in the background and returns a `jobId` immediately. |
| `subagent_wait` | Block until background subagents finish and return their full results (`{ jobIds, timeoutSeconds? }`). |
| `subagent_status` | Non-blocking progress check for background subagents (`{ jobIds }`). |
| `subagent_agents` | List available agent definitions from `~/.pi/agent/agents`. |

## Usage

```
# Synchronous — block until done
Use subagent { agent: "scout", task: "Find all auth code", wait: true }

# Raw prompt — no agent file needed (built-in default agent)
Use subagent { task: "Summarize the README", wait: true }

# Parallel — multiple agents concurrently (omit agent for the default agent)
Use subagent { tasks: [{ agent: "scout", task: "Find models" }, { task: "Find providers" }], wait: true }

# Chain — sequential, {previous} placeholder gets the prior step's output (agent optional per step)
Use subagent { chain: [{ agent: "scout", task: "Find the read tool" }, { task: "Improve it: {previous}" }], wait: true }

# Asynchronous — parent keeps working while subagents run in the background
# 1. Spawn:  subagent { agent: "scout", task: "...", wait: false }   → returns jobId
# 2. Later:  subagent_status { jobIds: ["..."] }                     → peek at progress
# 3. Collect: subagent_wait { jobIds: ["..."] }                      → full results
```

### Async mode details

- Spawning with `wait: false` returns immediately with a `jobId`. The parent can
  continue its own turn — pi runs sibling tool calls concurrently, so e.g. a
  `bash` call in the same message runs while the subagent works.
- When **all** tasks in a spawned batch finish, the extension injects **one
  compact summary message** into the conversation (`✓ [scout] <preview>` per
  task). The parent picks it up on its next turn automatically. Set
  `notifyOnComplete: false` to suppress this and poll with
  `subagent_status` / `subagent_wait` instead.
- `subagent_wait` blocks until completion (optionally `timeoutSeconds`); results
  are already cached if the batch finished earlier. Esc during the wait cancels
  only the wait — background jobs keep running.
- Esc during a synchronous (`wait: true`) run kills the subagents.
- All running children are killed on session shutdown (new session, resume,
  exit). Async work is therefore tied to the current session.
- Async spawning is designed for interactive sessions — `pi -p` (print mode)
  exits when the prompt completes and kills background children.

### Status widget

While subagents are running, a compact widget appears above the input editor and
updates live (1s tick):

```
⏳ 2 subagents running
  ▸ scout     12s   → bash: npm test
  ▸ planner    4s   step 2/3  "Refactor the core loop"
```

Each line shows the agent, elapsed time, chain step (chain mode), and the last
activity (most recent tool call, latest output, or the task description). The
widget covers sync and async runs alike; it disappears automatically when
nothing is running. TUI-only — print/JSON modes are unaffected.

## Agent definitions

`~/.pi/agent/agents/*.md` — markdown with YAML frontmatter and a system prompt
body:

```markdown
---
name: scout
description: Fast recon agent, read-only
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
tier: fast
---

You are a scout agent. Find information quickly and report it compactly.
```

- `name` and `description` are required; `tools` (comma-separated), `model`,
  and `tier` (`fast` | `balanced` | `deep`) are optional. Omit `tools` for the
  full default toolset.
- If both `model` and `tier` are set, `model` wins (a concrete pin beats an
  abstract tier). A call-time `tier` parameter beats both.
- Omit the agent entirely when calling `subagent` — in single, parallel, or
  chain mode — to use the built-in default general-purpose agent (raw prompt
  mode).
- More sample agents (planner, reviewer, worker) ship with pi:
  `examples/extensions/subagent/agents/` inside the pi package — copy them to
  `~/.pi/agent/agents/`.

## Model tiers

`tier: fast | balanced | deep` declares how much capability a task needs
instead of which model to use. Tiers resolve to concrete models at spawn time
through a central mapping in pi's `settings.json`:

```json
{
  "subagent": {
    "modelTiers": {
      "auto": true,
      "fast": "claude-haiku-4-5",
      "balanced": "claude-sonnet-4-5",
      "deep": "claude-opus-4-5"
    }
  }
}
```

- Declare a tier in an agent file (`tier: deep` in frontmatter) and/or pass it
  per call: `subagent { agent: "scout", task: "...", tier: "fast" }` (also
  available per item in `tasks` and `chain`).
- Resolution precedence per task: call-time `tier` → agent `model` → agent
  `tier` → the parent's default model.
- Explicit per-tier values always win; `auto: true` fills only unmapped tiers.
- **Auto-picker:** with `auto: true`, tiers resolve from the model registry
  relative to your `defaultModel`: `balanced` is always your default model;
  `fast` is the cheapest model in the same brand family (e.g. `claude-*` /
  `deepseek-*`); `deep` is the priciest family member, or collapses to your
  default model when nothing bigger exists (it never jumps to another vendor's
  family). `enabledModels` scoping is respected.
- Without any mapping or `auto`, tiers fall back to the parent's default model
  (the same behavior as today when no `--model` is passed).
- Resolved models are reported in results, e.g.
  `model: claude-opus-4-5 (tier: deep)`, with a `Note:` line when a tier fell
  back or collapsed.
- The mapping lives in the user-level settings file
  (`~/.pi/agent/settings.json`). Project-local `.pi/settings.json` is not read
  by the extension.

## How it works

Each subagent runs `pi --mode json -p --no-session --no-extensions
--no-skills --no-prompt-templates` with the agent's system prompt appended and
the task as the prompt. Children are lean (no extension recursion) and read the
same user config (model, API keys) as the parent. JSON events from the child's
stdout are parsed for messages, usage (tokens/cost), and errors.

Background jobs are tracked in an in-memory registry inside the extension
process; running children are terminated on session shutdown.

## Development

```bash
cd ~/.pi/agent/extensions/subagent
npm test                    # node:test — pure logic in core.ts (no pi deps needed)
npm run typecheck           # tsc --noEmit (needs dev node_modules, see below)
```

`core.ts` is dependency-free by design and unit-tested with the built-in node
test runner (Node >= 22.6 type stripping).

The `node_modules/` directory contains symlinks into the nix store copy of the
installed pi package, used only for typechecking — pi itself resolves the
`@earendil-works/*` packages at runtime. Re-link after updating pi:

```bash
STORE=$(readlink -f /run/current-system/sw/bin/pi | sed 's|/bin/pi$||')/lib/node_modules/pi-monorepo
cd ~/.pi/agent/extensions/subagent
mkdir -p node_modules/@earendil-works
ln -sfn $STORE node_modules/@earendil-works/pi-coding-agent
ln -sfn $STORE/node_modules/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -sfn $STORE/node_modules/@earendil-works/pi-tui node_modules/@earendil-works/pi-tui
ln -sfn $STORE/node_modules/@earendil-works/pi-agent-core node_modules/@earendil-works/pi-agent-core
ln -sfn $STORE/node_modules/typebox node_modules/typebox
```

## Files

```
~/.pi/agent/extensions/subagent/
├── index.ts      # entry: tools, job registry, process spawning, TUI rendering
├── agents.ts     # agent discovery from ~/.pi/agent/agents
├── core.ts       # pure logic: parsing, event handling, formatting, truncation
└── tests/
    └── core.test.mjs   # node:test suite
```
