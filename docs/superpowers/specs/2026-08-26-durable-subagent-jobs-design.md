# Durable Subagent Jobs — Design

Date: 2026-08-26
Status: Approved design, pending implementation plan

## Motivation

Subagent work is lost whenever the parent session dies: power outage, network loss, SSH
disconnect, crash, or a plain `/exit`. Two causes:

1. Children run `pi --mode json -p --no-session` — transcripts exist only in the
   parent's RAM.
2. The task/job registry (`runtime.ts`) is in-memory only and is cleared on
   `session_shutdown` after children are killed.

Additionally, running subagents cannot be paused, and background jobs have no
human-friendly identity in the TUI.

## Goals

- Mid-task continuation: a task interrupted at any point can resume from its own
  transcript later, in the same parent session.
- Pause = graceful interrupt now + resume later (robust for pauses of any length).
- Jobs are bound to the parent session. A brand-new session never surfaces another
  session's jobs; resuming that session surfaces its interrupted jobs on demand.
- Named sessions: every task has a human-readable name shown in the status widget
  (e.g. `Worker feature1-implementation [glm-5.3] 12s`).
- No automatic token burn: nothing resumes without an explicit tool call.

## Non-goals

- Surviving parent death with children still *running* (detached supervisor/daemon).
  Composes later on top of this design if "keep working while disconnected" matters.
- Resuming jobs into a different parent session than the one that spawned them.
- Custom event journaling; pi's own session files are the journal.

## Approach (approved)

Pi-native child sessions + thin manifests. Children spawn with
`--session-dir <job tasks dir>` and `--session-id <task id>` so pi durably appends
each event to `<ts>_<task-id>.jsonl` as it works — crash-safe by construction.
The extension maintains a small per-job `manifest.json`, written only at lifecycle
boundaries. Resume re-spawns children on the same session file with a continuation
prompt; finished tasks are read from the manifest.

### Verified pi mechanics (spike to confirm first)

- `--session-dir <dir>` + `--session-id <id>` creates `<dir>/<timestamp>_<id>.jsonl`
  (`session-manager.js`: `join(getSessionDir(), \`${fileTimestamp}_${sessionId}.jsonl\`)`).
- `--session <file>` + `-p "<prompt>"` appends to that session and continues in JSON
  print mode.
- Children stay out of `pi -r` because their session dir is our store, not the default.
- Spike = two cheap real spawns; run before any other implementation step.

## Storage layout

New module `store.ts`. Root: `~/.pi/agent/subagent-jobs/`.

```
~/.pi/agent/subagent-jobs/<parent-session-id>/<job-id>/
  manifest.json
  tasks/                      ← passed as the child's --session-dir
    <ts>_<task-id>.jsonl      ← pi-written child transcript
```

- Bucket key: `ctx.sessionManager.getSessionId()`. Ephemeral parents (`--no-session`)
  still get a bucket under their in-memory id; its surfacing never fires (no session
  to resume) and retention GC reclaims it.
- Manifests are written atomically (tmp file + rename).

### Manifest schema (version 1)

```jsonc
{
  "version": 1,
  "jobId": "uuid",
  "parentSessionId": "uuid",
  "mode": "single | parallel | chain",
  "createdAt": 0,
  "updatedAt": 0,
  "notifyOnComplete": true,
  // job status stays "running" while tasks are paused; pause is per-task
  "status": "running | completed | failed | aborted | interrupted",
  "errorMessage": "…",           // optional
  "chainTotal": 5,                // chain mode only
  "chain": [                      // chain mode only: original step definitions
    { "agent": "scout", "task": "…", "cwd": "…", "tier": "fast", "name": "…" }
  ],
  "tasks": [
    {
      "taskId": "uuid",
      "name": "feature1-implementation",
      "agent": "worker",
      "task": "original task text",
      "cwd": "/path",
      "tier": "fast",            // optional, as requested
      "model": "provider/model", // effective model once known; updated from stream
      "step": 2,                 // chain mode only
      "sessionFile": "~/.pi/agent/subagent-jobs/…/tasks/<ts>_<taskId>.jsonl",
      "status": "running | completed | failed | aborted | paused | interrupted",
      "exitCode": 0,
      "stopReason": "…",
      "errorMessage": "…",
      "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                 "cost": 0, "contextTokens": 0, "turns": 0 },
      "finalOutput": "last assistant text, capped at 50 KiB",
      "startedAt": 0,
      "finishedAt": 0
    }
  ]
}
```

## Lifecycle & flush points

Flushes happen only at lifecycle boundaries — never per event. Every write is
best-effort (`try/catch`); an unwritable store degrades to today's exact in-memory
behavior and never breaks spawning.

| Event | Flush |
|---|---|
| `createJob` | write manifest (status `running`, task defs) — **before any spawn** |
| task spawn | append/update the task entry (with `sessionFile` once resolvable) — **before child spawn** |
| task finalize | status, exitCode, stopReason, usage, finalOutput, finishedAt |
| chain step transition | task entries (progress is implicit in task statuses) |
| job complete | job status |
| `session_shutdown` sweep | unfinished tasks → `interrupted`, job → `interrupted` |

**Write-ordering invariant:** manifest first, child second. A task's session file can
never exist without its manifest entry; a crash mid-spawn leaves at worst an empty job
(surfaces in the list as "no tasks"). `sessionFile` resolution globs
`tasks/*_<taskId>.jsonl` (retry at finalize / resume if the child hadn't created it yet).

**Shutdown sweep** extends today's kill sweep in `index.ts`: after killing running
children, mark unfinished tasks `interrupted`. Applies to crashes and clean exits
alike (`/exit`, `/resume` switch): any non-finished task is resumable when *that
session* returns.

### Task statuses

`running`, `completed`, `failed`, `aborted` (as today), plus:

- `paused` — user-requested interrupt (`subagent_pause`); resumable.
- `interrupted` — parent crash/shutdown; exists on disk (and in manifests loaded from
  disk); resumable.

One uniform rule: only `completed` is terminal. `paused`, `interrupted`, and `aborted`
are all resumable.

## Pause

New tool `subagent_pause` (`tools/subagent-pause.ts`): `{ jobId }`.

- Sets a `pauseRequested` flag on the job's running tasks, then SIGTERM via the
  existing `killTask` path (pi children finalize their session file cleanly).
- `finalizeTask` honors `pauseRequested` and marks tasks `paused` (not `aborted`).
- Chain: pauses the current step; the job is not `finished`, so watch-pane auto-close
  and job waiters stay alive. Parallel/single: all running tasks.
- Result text lists paused tasks and `resume with subagent_resume {jobId: "…"}`.
- Note in tool description: a paused job holds `subagent_wait` callers until they
  time out; resume to let them proceed.
- Esc/Ctrl+C aborts still work as today and produce `aborted` — equally resumable.

## Resume

New tool `subagent_resume` (`tools/subagent-resume.ts`), two behaviors:

- `{}` — **list**: merges live registry + disk manifests for the current parent
  session id (dedupe by job id). Per job: id, mode, name(s), progress, per-task
  status, created/updated, resumable flag. `subagent_status` learns the same merge so
  discovery also works there; disk-only jobs render like today's report with their
  persisted statuses.
- `{ jobId, wait?, notifyOnComplete? }` — **resume**. Defaults mirror `subagent`:
  `wait: true`, `notifyOnComplete: true` (independent of the manifest's original
  value, which describes the original run).

Resume mechanics (`resumeJob` in `jobs.ts`):

1. Load the manifest. Refuse when `parentSessionId` ≠ current session id ("belongs to
   another session") or when the job is already live in the registry (no double-spawn).
2. Finished tasks stay as-is; results are read from the manifest.
3. Each `paused` / `interrupted` / `aborted` task re-spawns:
   - agent re-resolved by name from current definitions; unknown agent → default agent
     with a warning in the result;
   - agent system prompt re-written to a temp file as today; same tools/extensions;
   - model = the manifest's **effective model** (recorded from the stream), so a
     resumed task lands back on the same model; when none was recorded (crashed
     before the first message), re-resolve from the task's tier at resume time;
     if the recorded model is gone, the child fails
     and the task remains resumable after settings are fixed;
   - `--session <sessionFile>` + continuation prompt:
     `CONTINUATION: Your previous run of this task was interrupted; your session transcript has been restored. Continue where you left off and complete the task.`;
   - missing session file → fresh re-run of the task (new session id) with a note.
4. Chain: continue from the lowest incomplete step — the interrupted step resumes via
   its session; never-started steps spawn fresh; `{previous}` for the next fresh step =
   `finalOutput` of the highest completed step in the manifest. `runChain` grows a
   resume entry point that reuses the existing runner loop.
5. Parallel: re-applies the concurrency limit across re-spawned tasks.
6. Job flips back to `running`; the existing notification/waiter/completion machinery
   is reused untouched. Registry tasks rebuilt from the manifest get fresh `proc`,
   `live`, etc.

## Surfacing after a crash

On `session_start` with reason `startup` or `resume` (never `new`), if the current
session's bucket has non-terminal jobs, inject a custom message (no turn trigger —
the agent sees it on its next turn):

- Message type `subagent-jobs-interrupted` with a small renderer (warning header +
  per-job lines: id, mode, progress, names; hint to call `subagent_resume`).
- Nothing ever auto-resumes.

## Garbage collection

On `session_start`, sweep `~/.pi/agent/subagent-jobs/*/*/` and delete job dirs whose
`updatedAt` (fs mtime fallback when the manifest is missing/unreadable) is older than
`subagent.jobRetentionDays` (settings.json; default 7; `0` = never delete). Also remove empty parent-session dirs. Each directory is guarded
individually; sweep failures never block startup.

## Named sessions

- `subagent` schema gains `name?: string` on single mode and per item in `tasks[]` /
  `chain[]`.
- New pure helper `slugifyName` in `core.ts`: lowercase, `[a-z0-9-]`, ≤ 32 chars.
  Fallback when omitted: slug of the task text's first words + 4-char task-id suffix
  (e.g. `fix-auth-loop-3f2a`). Every task gets a displayable name with zero effort.
- Stored on the registry task and in the manifest.
- Status widget line becomes
  `▸ Worker feature1-implementation [glm-5.3] 12s  → bash: npm test`
  (name in accent after the agent name, model tag dimmed — today's line with the name
  inserted).
- Completion card lines and status/wait reports use `[agent/name]` when a name exists;
  reports gain icons for `paused` (⏸) and `interrupted` (⚠).

## Error handling summary

| Failure | Behavior |
|---|---|
| Disk write fails | Degrade to in-memory-only (today's behavior); never break spawning |
| Resume for another session's job | Refuse with a clear error |
| Resume of an already-live job | Refuse (registry membership check) — no double-spawn |
| Agent definition missing at resume | Default agent + warning in the result |
| Session file missing at resume | Fresh re-run of the task + note |
| Recorded model unavailable at resume | Task fails; stays resumable after settings fix |
| GC failure on one directory | Skipped; never blocks startup |

## Module layout

New: `store.ts` (persistence: schema, atomic writes, glob resolution, GC sweep,
listing merge — pure helpers unit-testable, thin fs wrappers), `tools/subagent-pause.ts`,
`tools/subagent-resume.ts`.

Dependency graph stays acyclic, topological order (earlier modules never import later
ones): `core → store → runtime → process → jobs → tools`, with `watch-render`/`watch`
unchanged. `index.ts` calls `store` for the session-start GC + surfacing and the
shutdown sweep.

`buildChildArgs` (`core.ts`) replaces `--no-session` with
`--session-dir <tasksDir> --session-id <taskId>` (children otherwise unchanged, so the
recursion guard via `--no-extensions` is unaffected).

README + AGENTS.md updated: module list, two new tools, `name` param, retention setting.

## Testing

Repo conventions: pure logic, `node --test`, fail-first.

- `tests/store.test.mjs` (new): manifest round-trip against real tmpdirs; atomic-write
  behavior; write-ordering helper; `resolveSessionFile` glob; GC predicate (age
  boundary, `0` disables); status derivation matrices (pause / crash / finish);
  registry ∪ disk listing merge + dedupe.
- `tests/core.test.mjs`: `slugifyName` (valid inputs, sanitization, length cap, empty →
  undefined), continuation-prompt builder, `paused`/`interrupted` mapping in
  `isFailedState`/`getResultOutput`/`formatStatusReport` icons, `buildChildArgs`
  session flags.
- `npm test` and `npm run typecheck` green before commit.

## Implementation order

1. Spike: verify session flags (two cheap real spawns) — before anything else.
2. `store.ts` + tests.
3. `core.ts` helpers + tests (`buildChildArgs`, `slugifyName`, statuses, prompt).
4. Spawn-path integration (`process.ts`, `jobs.ts`, `runtime.ts` statuses).
5. Pause + resume tools.
6. Surfacing + GC in `index.ts`.
7. TUI naming + docs.
