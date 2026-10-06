# Subagent Tool for pi

Delegate work to specialized subagents with separate context windows. Each
subagent runs in its own `pi` process, so its conversation does not add to the
parent's context.

## Installation

Install the package and reload pi (`/reload`):

```bash
pi install https://github.com/Jaeensson/pi-subagents
```

To install for one project only, use `pi install -l` (project packages load
after project trust is granted). Update with `pi update --extensions` or
`pi update --all`, then reload. This package registers its extension through
the `pi.extensions` entry in `package.json`.

## Tools and usage

| Tool | Purpose |
|------|---------|
| `subagent` | Run one task, a parallel batch, or a sequential chain. Wait for results or run in the background. |
| `subagent_wait` | Wait for background jobs and collect their results. |
| `subagent_status` | Check progress or list jobs belonging to this parent session. |
| `subagent_agents` | List available agent definitions. |
| `subagent_pause` | Gracefully pause a background job. |
| `subagent_resume` | List resumable jobs or continue one belonging to this parent session. |

```text
# One task; omit agent to use the built-in general-purpose agent
subagent { mode: "single", agent: "scout", task: "Find the authentication code", wait: true }

# Parallel batch (up to 8 accepted tasks; at most 4 child processes run at once)
subagent { mode: "parallel", tasks: [{ agent: "scout", task: "Find models" }, { task: "Find providers" }], wait: true }

# Chain; {previous} is replaced with the previous step's full output
subagent { mode: "chain", chain: [{ agent: "scout", task: "Find the read tool" }, { task: "Suggest improvements to {previous}" }] }

# Background work
subagent { mode: "single", agent: "researcher", task: "Explore the codebase", wait: false }
subagent_status { }
subagent_wait { jobIds: ["<jobId>"] }
```

Every `subagent` call requires a `mode` discriminator (`"single"`, `"parallel"`,
or `"chain"`). The old flat input shapes without `mode` are not accepted.

Parallel batches accept at most 8 tasks; more than 4 are queued until a
scheduler slot is available. Queued tasks appear as queued in the live UI. The
status widget above the input editor shows running tasks, elapsed time, chain
step, and recent activity. In the TUI, `ctrl+alt+s` opens the live watch pane;
`↑↓`/`PgUp`/`PgDn` scroll, `Tab` cycles running tasks, `End` returns to the live
tail, and `Esc` closes it. Both displays are TUI-only.

With `wait: false`, the call returns a job ID so work can continue in the
background. When the batch finishes, a compact summary is delivered unless
`notifyOnComplete: false`; collect full results with `subagent_wait`. Esc while
waiting for a background job cancels only the wait. Esc during a synchronous
run aborts its children. Children are terminated during parent-session
shutdown; a background job is not an independent service.

### Output size and artifacts

Tool responses are bounded to **50 KiB and 2,000 lines**. When the final task
output is larger, the complete text is saved as an output artifact and the
response includes its path. In a durable job, artifacts are next to the child
transcripts:

```text
~/.pi/agent/subagent-jobs/<parent-session-id>/<job-id>/tasks/<task-id>-output.txt
```

If durable storage is unavailable, the artifact is written to a private
`pi-subagent-output-*` directory under the operating system's temporary
directory instead. Use pi's `read` tool with the reported path to inspect the
full output; the response text and compact live task history are not the full
artifact. Artifacts in the durable job directory are subject to job retention.

## Durability and resume

When the parent has a pi session ID and the job store is writable, jobs are
recorded under
`~/.pi/agent/subagent-jobs/<parent-session-id>/<job-id>/`. Each job has a
`manifest.json` and a `tasks/` directory containing child pi session
transcripts and output artifacts. The manifest is written before child
launches, and updates use atomic replacement and locking. These writes are
best-effort: an unavailable or unwritable store falls back to in-memory job
tracking and may leave no resumable record. This improves recovery but is not a
guarantee against crashes, storage failure, or power loss.

Jobs belong to the parent pi session that created them. Resuming that session
surfaces resumable jobs; a new session cannot inspect or resume those jobs
through the tools. Child transcripts are resumed by their recorded session
file (`pi --session <file>`), not by creating a fresh child session. Jobs are
**never resumed automatically**: inspect with `subagent_status` or
`subagent_resume {}`, then explicitly call `subagent_resume { jobId: "…" }`.
Completed jobs are terminal; paused, interrupted, and aborted tasks can be
resumable if their records and transcripts remain available. Failed tasks are
not resumed. A parallel batch may have partial successes: check
the job's per-task statuses and collect completed results even if other tasks
failed or were interrupted.

During orderly parent-session shutdown, in-flight work is marked interrupted
on a best-effort basis and owned child processes are terminated. On restart,
recovery is performed only for the current parent session. A job with a live
local owner is left alone; an owner recorded on another host is conservatively
treated as live because its process cannot be checked safely. Such remote-owned
jobs cannot be reclaimed automatically while that ownership record remains.

Retention is configured in the user-level `~/.pi/agent/settings.json` under
`subagent.jobRetentionDays` (default `7`; `0` disables cleanup). On pi session
start, jobs older than the retention period are eligible for cleanup across
session buckets, except a running job with a live or conservatively presumed
live owner. Retention is cleanup policy, not archival storage.

## Agent definitions

Agent definitions live in `~/.pi/agent/agents/*.md` and contain YAML
frontmatter followed by a system prompt:

```markdown
---
name: scout
description: Fast recon agent
tools: read, grep, find, ls, bash
tier: fast
---

Find relevant information quickly and report it compactly.
```

`name` and `description` are required. Optional fields are `tools`
(comma-separated pi tools), `tier` (`fast`, `balanced`, or `deep`), and
`extensions` (comma-separated extension package specs, such as
`npm:pi-web-access`). The `model` frontmatter field is unsupported; use a tier
instead. Omit `tools` to use the default tool set. If the agent is omitted in a
tool call, the built-in general-purpose agent is used.

Bundled defaults (`scout`, `researcher`, `worker`, and `reviewer`) are copied
into the user agent directory when missing. Existing files are never
overwritten, so local edits take precedence. An agent's tier is its default;
a tier specified at call time overrides it.

A `tools` allowlist controls which pi tools a child can use, but it cannot
confine shell commands, filesystem access, or other processes and is **not a
sandbox**. Agent prompts are instructions, not a security boundary. Children
run with the parent's operating system permissions and can access the same
host files and credentials those permissions expose. Only configure agents
and extensions you trust.

## Model tiers

Tiers express capability needs rather than a fixed model choice. Configure
`subagent.modelTiers` in the user-level settings file:

```json
{
  "subagent": {
    "modelTiers": {
      "auto": true,
      "fast": "anthropic/claude-haiku-4-5",
      "balanced": "anthropic/claude-sonnet-4-5",
      "deep": "anthropic/claude-opus-4-5"
    }
  }
}
```

Explicit per-tier model values take precedence; with `auto: true`, unmapped
tiers are selected relative to the default model. `balanced` uses the default;
`fast` picks a cheaper model in the same provider/model family where possible,
then may fall back to that provider's cheapest model. `deep` picks the priciest
model in the same family where available, otherwise it collapses to the
default. Automatically selected models are provider-qualified to disambiguate
providers that offer the same model ID. The available-model catalog respects
pi's model scoping (`enabledModels`).

Resolution order is call-time tier, agent-file tier, then the parent's default
model. An unmapped or unresolved tier falls through to the next level. If no
tier mapping applies, the child inherits the parent's default model. The
extension's `/subagents` settings dialog can toggle automatic tiers and choose
per-tier models.

## Optional Herdr monitoring

When pi runs inside a Herdr pane, subagents can report display-only activity
metadata and open a **Subagents** tab with up to four read-only viewer panes.
Herdr 0.8.2 is the compatibility baseline. Outside Herdr, this integration is
inactive: no Herdr commands, viewer processes, monitoring files, or timers.

Both settings default to `true` in `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "herdr": {
      "enabled": true,
      "viewers": true
    }
  }
}
```

Use `/subagents` to change **Herdr monitoring** or **Herdr viewers**
immediately. Manual settings-file edits require `/reload`. Setting `viewers`
to `false` closes owned viewers but keeps central activity metadata enabled;
setting `enabled` to `false` also clears the integration's metadata. Neither
switch stops running children.

Viewer panes show sanitized text, thinking, and tool activity under a heading
(named task · agent · status) and a second line with the model, context usage
(context tokens/window and percentage when known), and elapsed runtime; unknown
fields are omitted and runtime freezes when the task finishes. Completed output
stays visible until that pane is reused; executing tasks are never evicted.
Panes open without stealing focus and are **not** execution backends or
interactive child pi sessions. Display labels and activity counts do not change
the parent's semantic agent state, native session identity, or resume behavior.
A viewer shows disconnected after ten seconds without a producer heartbeat and
exits after thirty seconds. Live snapshots are bounded previews, not full
transcripts or output artifacts.

Missing Herdr/Node, unsupported shells, or monitoring failures fall back to the
normal pi status/watch UI and tool results. Spawning, model selection,
completion delivery, durable jobs, and pause/resume remain authoritative and
unchanged; the optional monitor must not block child work.

## How it works

Children run `pi --mode json -p` with `--no-extensions --no-skills
--no-prompt-templates`, so extensions are not auto-discovered and recursive
subagent loading is prevented. Extensions explicitly declared by an agent are
still passed to that child. Children use the parent's pi configuration and
credentials; the separate process gives a separate conversation context, not
an operating-system security boundary.

## Development

Requires **Node.js >= 22.19.0**. From the repository root:

```bash
npm ci --ignore-scripts
npm test
npm run typecheck
```

`npm test` uses Node's built-in test runner. `npm run typecheck` runs `tsc
--noEmit`. For local development, symlink the repository into
`~/.pi/agent/extensions/subagent`, then reload pi (`/reload`).

### Opt-in Herdr smoke verification (source checkout only)

```bash
node scripts/herdr-monitor-smoke.mjs
```

This developer script is not packed with the extension. It explicitly creates
one uniquely named disposable **headless** Herdr session with private temporary
configuration, agent files, and snapshot resources, then stops and deletes that
session. It never attaches to your default/inherited session or loads your shell
dotfiles/Herdr plugins. Fake JSON children exercise the real extension hooks and
parsing without provider calls or recursive agents. Checks include four real
viewers, retained output and reuse, no focus stealing, parent native identity,
settings switches, plain-terminal inactivity, and producer-heartbeat loss.
Successful output includes the generated session name and checks; failures exit
nonzero. Requires an installed Herdr CLI and `/bin/sh`; allow about a minute.
`npm test` uses injected external ports and never creates a live Herdr session.

Treat live verification as platform-specific: the compatibility baseline is not
a claim that every OS or shell has been tested. Windows/PowerShell/cmd and other
shells need their own isolated live verification before claiming support there.
