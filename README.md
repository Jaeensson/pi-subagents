# Subagent Tool for pi

Delegate tasks to specialized subagents with **isolated context windows**. Each
subagent runs in its own `pi` process, so delegated work never pollutes the
parent conversation's context.

The parent session can either **wait** for subagents (synchronous) or keep
**working in parallel** (asynchronous: spawn in the background, collect later).

## Installation

Install as a pi package, then reload pi (`/reload`):

```bash
pi install https://github.com/Jaeensson/pi-subagents
```

Update with `pi update --extensions` (or `--all`), then `/reload`. For a
single project only, pass `-l` (writes to `.pi/settings.json`).

Agent definitions live in `~/.pi/agent/agents/*.md` (see
[Agent definitions](#agent-definitions)).

## Tools

| Tool | Purpose |
|------|---------|
| `subagent` | Spawn subagents: single, parallel, or chain. `wait: true` (default) blocks and returns results; `wait: false` spawns in the background and returns a `jobId` immediately. Optional `name` gives the session a human-readable label shown in the status widget. |
| `subagent_wait` | Block until background subagents finish and return their full results (`{ jobIds, timeoutSeconds? }`). |
| `subagent_status` | Non-blocking progress check for background subagents (`{ jobIds? }`). Omit `jobIds` to list all jobs for this session, including interrupted jobs from a previous run of it. |
| `subagent_agents` | List available agent definitions from `~/.pi/agent/agents`. |
| `subagent_pause` | Gracefully pause a running background job (`{ jobId }`): tasks finalize with their transcripts on disk and can be resumed later. |
| `subagent_resume` | Resume interrupted/paused jobs from a previous run of THIS session: `{}` lists them; `{ jobId }` continues where the tasks left off. |

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
# 1. Spawn:   subagent { agent: "scout", task: "...", wait: false }   → returns jobId
# 2. Later:   subagent_status { jobIds: ["..."] }                     → peek at progress
# 3. Collect: subagent_wait { jobIds: ["..."] }                       → full results
```

### Async details

- When all tasks in a spawned batch finish, the extension injects one compact
  summary message (`✓ [scout] <preview>` per task). Set `notifyOnComplete:
  false` to suppress it and poll with `subagent_status` / `subagent_wait`.
- `subagent_wait` blocks until completion (optionally `timeoutSeconds`);
  results are cached if the batch already finished. Esc cancels only the wait —
  background jobs keep running. Esc during a synchronous (`wait: true`) run
  kills the subagents.
- Running children are killed on session shutdown (new session, resume, exit),
  and `pi -p` (print mode) kills them when the prompt completes — async work is
  tied to the current interactive session.

### Status widget

While subagents run, a compact widget above the input editor updates live (1s
tick), showing agent, elapsed time, chain step, and last activity:

```
⏳ 2 subagents running
  ▸ scout     12s   → bash: npm test
  ▸ planner    4s   step 2/3  "Refactor the core loop"
```

TUI-only — print/JSON modes are unaffected.

### Watch pane

While subagents run, press `ctrl+alt+s` to open a centered, bordered live
watch pane showing a subagent's reasoning stream in real time — thinking,
visible text, tool calls, and in-progress tool output, rendered with the same
native markdown as the main conversation: headings, lists, tables, and
syntax-highlighted code blocks (thinking stays italic thinkingText):

┌● watching: researcher · 1/2  3m 12s · claude-opus-4-5 · ctx 3.0%/200k┐
│Let me check where settings are read… (thinking, italic)            │
│→ grep pattern="modelTiers" in src/                                 │
│└ pages… done, 1 hit                                                │
│● live   ↑↓ scroll · PgUp/PgDn · Tab agent · End tail · Esc close   │
└────────────────────────────────────────────────────────────────────┘

- `ctrl+alt+s` toggles the pane (TUI only). `↑↓` scroll the retained
  history, `PgUp`/`PgDn` page, `Tab` cycles running agents, `End` jumps back
  to the live tail, `Esc` (or the toggle key) closes.
- The header shows the subagent's context usage (`ctx 3.0%/200k`, updated
  live like pi's footer: warning above 70%, error above 90%). It is hidden
  when the child model's context window is unknown.
- Scrolling up **pins** the viewport: new tokens keep streaming below while
  the text you're reading stays put; the footer shows `↑ N above` while
  pinned. Scrolling down to the live edge (or `End`) resumes tailing.
- The pane does not capture focus — keep typing in the editor while open.
- A finished selected agent keeps its final view (`✓ done`); the pane closes
  automatically when the last agent finishes.
- Reasoning is buffered in memory only (last 64 KB per task) and is never fed
  back into the conversation or model context; completed results are exactly
  as before via `subagent_wait` / the completion card.

## Durability & resume

Subagent work survives session death (crash, power loss, SSH drop, plain
`/exit`):

- Every child runs with its own pi session under
  `~/.pi/agent/subagent-jobs/<parent-session-id>/<job-id>/tasks/` — the
  transcript is durably on disk as the agent works. A small `manifest.json`
  per job tracks statuses, usage, and final outputs.
- Jobs are **bound to the parent session**: `pi -c` / `/resume` of that
  session surfaces an "interrupted jobs" card listing what was mid-flight.
  A brand-new session never sees another session's jobs.
- Nothing resumes automatically. Resume on demand with
  `subagent_resume { jobId }` — interrupted tasks continue from their own
  transcript (chain jobs pick up at the lowest incomplete step); or inspect
  first with `subagent_status {}` / `subagent_resume {}`.
- Pause instead of killing: `subagent_pause { jobId }` gracefully stops the
  running tasks; resume them any time later.
- Only `completed` is terminal. Paused, interrupted, and aborted tasks are
  all resumable while their job exists in the store.
- Job store retention: `subagent.jobRetentionDays` in settings.json (default
  7; `0` keeps everything forever).

## Agent definitions

`~/.pi/agent/agents/*.md` — markdown with YAML frontmatter and a system prompt
body:

```markdown
---
name: scout
description: Fast recon agent, read-only
tools: read, grep, find, ls, bash
tier: fast
---

You are a scout agent. Find information quickly and report it compactly.
```

- `name` and `description` are required; `tools` (comma-separated), `tier`
  (`fast` | `balanced` | `deep`), and `extensions` (comma-separated extension
  specs loaded in the child, e.g. `npm:pi-web-access`) are optional. Omit
  `tools` for the full default toolset. The frontmatter `model` key is
  intentionally unsupported — `tier` is the only model control.
- Omit the agent entirely — in single, parallel, or chain mode — to use the
  built-in default general-purpose agent (raw prompt mode).
- **Bundled defaults:** `scout` (tier `fast`), `researcher` (tier `deep`),
  `worker` (tier `balanced`), and `reviewer` (tier `deep`) ship with the
  package under `agents/` and are copied into `~/.pi/agent/agents/` on
  extension load when missing — existing files are never overwritten, so any
  edits you make win. Delete a seeded agent and it returns on the next
  reload; rename or customize it to keep your own version. An agent's `tier`
  is its *default*: a `tier` passed on the call (single/parallel/chain)
  always overrides it.
- A sample `planner` agent also ships with pi in
  `examples/extensions/subagent/agents/` — copy it over if you want it.

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

- Set a tier in an agent file (`tier: deep`) and/or pass it per call —
  `subagent { agent: "scout", task: "...", tier: "fast" }` (also per item in
  `tasks` and `chain`). Explicit per-tier values always win; `auto` fills only
  unmapped tiers.
- Resolution precedence per task: call-time `tier` → agent `tier` → the
  parent's default model.
- With `auto: true`, tiers resolve relative to your `defaultModel`: `balanced`
  is always your default model; `fast` is the cheapest model in the same brand
  family; `deep` is the priciest family member (never jumping to another
  vendor's family), collapsing to your default when nothing bigger exists.
  `enabledModels` scoping is respected, and auto-picked models are passed to
  subagents provider-qualified to avoid ambiguity.
- Without any mapping or `auto`, tiers fall back to the parent's default model.
- The mapping lives in the user-level settings file
  (`~/.pi/agent/settings.json`); project-local `.pi/settings.json` is not read.

## How it works

Each subagent runs `pi --mode json -p --session-dir <tasksDir> --session-id
<taskId> --no-extensions --no-skills --no-prompt-templates` with the agent's
system prompt appended and the task as the prompt (resumes use
`--session <file>` plus a continuation prompt). Children are lean (no
extension recursion) and read the same user config (model, API keys) as the
parent. JSON events from the child's stdout are parsed for messages, usage
(tokens/cost), and errors, while pi itself durably journals the child's
transcript to the job store. Background jobs are tracked in an in-memory
registry inside the extension process, mirrored by per-job manifests on disk
at lifecycle boundaries.

## Development

```bash
cd ~/.pi/agent/extensions/subagent
npm test                    # node:test — pure logic in core.ts (no pi deps needed)
npm run typecheck           # tsc --noEmit
```

`core.ts` is dependency-free by design and tested with the built-in node test
runner (Node >= 22.6 type stripping). `node_modules/` contains symlinks into
the nix-store copy of pi, used only for typechecking — re-link them after a pi
update. For local development, symlink the repo into
`~/.pi/agent/extensions/subagent` and `/reload` after changes.
