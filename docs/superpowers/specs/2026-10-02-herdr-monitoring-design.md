# Optional Herdr monitoring and live viewers

Date: 2026-10-02
Status: Design approved in conversation; written specification awaiting user review.

## Intent and agreed scope

Add central Herdr monitoring and read-only live viewer panes to pi-subagent without changing how subagents execute. The user explicitly deferred Herdr-native execution.

Success means:

- Inside Herdr, the parent pane displays aggregate subagent activity and receives eligible completion notifications.
- Live viewers open automatically inside Herdr, but can be disabled independently of central monitoring.
- At most four reusable viewer panes exist for one parent session. Completed output stays readable until its slot is reused.
- Outside Herdr, subagent behavior is unchanged. No Herdr commands, viewer processes, monitoring files, or integration timers are created.
- Herdr failures never change task/job results, scheduling, notifications within Pi, durability, pause/resume, or shutdown classification.

### Non-goals

- Running children through Herdr, interactive child sessions, steering children from viewers, or making Herdr state authoritative for success.
- Automatically resuming jobs or viewers after a Herdr/server restart.
- Git worktree management, installing/upgrading Herdr, installing its Pi integration, or rewriting Herdr configuration.
- Replacing the Pi status widget, live watch overlay, or existing subagent tools.

## Current boundaries and evidence

`core.ts:buildChildArgs` selects `--mode json -p`, disables automatic extension discovery, and chooses durable child sessions when available. `process.ts:spawnTask` owns the child, parses its stdout, updates `Task.live`, and finalizes against the durable store. `runtime.ts` owns task/job registries and completion dispatch. Its existing status and job-finished hooks drive the Pi widget and watch overlay.

These children have piped stdout, not dedicated terminal panes. They inherit the parent's Herdr environment. Loading a pane-state reporter into such a child could report against the parent's pane; this design does not do that.

The installed Herdr 0.8.2 CLI and bundled schema were inspected. They support `pane.report_agent`, `pane.report_metadata`, `pane.release_agent`, pane creation/closing, and no-focus tab creation. Herdr state is pane-scoped. Metadata is display-only and separate from semantic state and native session identity.

Graph tools were unavailable during discovery; evidence came from direct source reads and installed CLI/schema inspection. No live pane experiment has been performed yet.

References:

- https://herdr.dev/docs/socket-api/
- https://herdr.dev/docs/add-herdr-support/
- https://herdr.dev/docs/agent-automation/
- https://pi.dev/packages/pi-herdr-agents (reference only, not a dependency)

## Chosen approach

Use asynchronous, bounded Herdr CLI calls for layout, metadata, state reporting, and notifications. Use private, atomically replaced snapshot files to carry readable live traces to independent viewer processes.

This is simpler and more portable than maintaining a direct socket client. Throttling/coalescing avoids a CLI process per token. If process overhead later proves material, the Herdr adapter can change transport without changing task execution or the snapshot protocol.

The integration is an observer. Tasks never await a viewer launch, metadata report, snapshot write, notification, or cleanup command.

## Settings and activation

User-level `settings.json` gains:

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

Both values default to `true` when absent. Only boolean values are accepted; invalid values fall back to these defaults. Unknown keys are preserved during writes.

- `enabled: false` disables all Herdr integration, including viewers and Herdr notifications.
- `enabled: true, viewers: false` retains central monitoring and notifications but creates no viewer panes or viewer snapshots.
- `enabled: true, viewers: true` enables both, subject to the environment gate.

The `/subagents` dialog gains **Herdr monitoring** and **Herdr live viewers** rows. They remain visible regardless of the automatic model-tier setting. The viewer preference is retained when monitoring is off, with an explanation that monitoring must be enabled for viewers to run. Existing tier selection and clear-key behavior must continue to target tier rows correctly.

Dialog changes persist immediately and take effect in the current session. Turning viewers off closes only extension-owned viewers and removes their files; running children continue. Turning monitoring off additionally clears this integration's parent metadata. Turning settings back on attaches to currently executing tasks as well as future ones, subject to the four-slot limit.

Manual edits to `settings.json` are applied on `/reload`; live external settings-file watching is not required. README instructions distinguish this from immediate dialog changes.

Settings writes follow the current read-modify-write, temporary-file-and-rename convention. Broken/unreadable existing settings are not overwritten. A failed save leaves the active preference unchanged and reports the error through Pi.

### Environment gate

Before any Herdr interaction, require `HERDR_ENV=1` and nonempty `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`. Prefer `HERDR_BIN_PATH` when present, otherwise invoke `herdr` through PATH. Do not perform executable discovery or create integration resources outside this gate.

Inside the gate, resolve the calling pane using Herdr's current-pane API rather than guessing IDs or using another client's focused pane. A failed context query or unavailable binary/socket disables integration for the current activation. An explicit off/on toggle or `/reload` can retry it. Do not install missing software or start a server.

## Central monitoring

Publish compact aggregate metadata on the actual parent pane. Use a unique source scoped to the parent activation, monotonically increasing report sequences, a fifteen-second metadata TTL, and a five-second refresh while there is session-local task information to display. With no tasks, leave parent presentation unchanged. Counts come from the runtime registry, not from Herdr detection.

The summary includes executing, queued, paused, completed, and unsuccessful task counts. "Executing" requires actual dispatch, not merely `Task.status === "running"`, which also covers queued/setup work. Completed and unsuccessful counts are session-local totals; unsuccessful covers failed, aborted, and interrupted tasks. Paused tasks are separate.

Store the summary under the namespaced `subagent_summary` metadata token and display it through metadata state labels, retaining the ordinary state name, for example `idle · 2 subagents running`. Normalize display values to at most eighty characters. Do not clear unrelated metadata tokens. Supply labels for idle, working, blocked, done, and unknown. This is display customization only: it does not make an idle parent semantically working. Do not override the parent's agent name, title, native session reference, or resume command. Clear this source's presentation when integration is disabled or the session ends; TTL provides crash/disconnection recovery.

The monitor never calls `report-agent`, `report-agent-session`, or `release-agent` on the parent. It must coexist with Herdr's official Pi integration if that integration is installed later.

When a job completes and `notifyOnComplete` is true, send one bounded Herdr notification identifying the batch and outcome. Never include full task prompts, thinking, tool output, or final responses in notifications. Delivery is best-effort; timeout/error does not trigger an immediate retry that could duplicate it. Respect Herdr's notification settings. Existing Pi completion delivery remains untouched and independent.

## Live viewer pool

On the first executing task, create an owned `Subagents` tab in the caller's workspace without stealing focus. Use its returned root-pane ID. Add panes only as needed, up to four, using a readable two-column/two-row arrangement at full capacity. Do not rename, split, reuse, or close unrelated tabs or panes, even if they have the same label.

Each slot holds at most one executing task. Reserve a slot synchronously before asynchronous layout operations so concurrent launches cannot overbook it. Reuse the oldest available completed/paused/unsuccessful slot before creating additional panes. Never evict an executing task's viewer. If all slots are occupied, skip additional viewers rather than blocking tasks.

Viewer assignment is per task attempt (`task.id` plus `processGeneration`). A resumed attempt may reuse its previous available slot or obtain another. Assigning an attempt replaces the entire slot snapshot with that task's projected trace, not just its status. A resumed task may retain its own earlier trace according to existing `Task.live` behavior; unrelated previous slot occupants must never remain visible. Completed output remains until reuse, disablement, manual closure, or parent-session end. An inactive slot is available while a paused task awaits an explicit resume.

Closing a viewer pane manually never cancels its task. Mark the slot absent when Herdr reports it missing; do not recreate a manually closed viewer for the same attempt. A later attempt/task may allocate a replacement within the four-pane bound. An unavailable API response is not evidence that a pane is absent.

Successful creation gives the adapter ownership of the returned pane ID, even if later setup fails. If setup cannot complete, roll back that pane best-effort. A tab is considered extension-owned only from its creation response. Ownership must not be inferred from labels. Before reusing or closing a pane after viewer startup, inspect its occupant. If the user has replaced the viewer with unrelated foreground work, relinquish that slot rather than overwriting or closing the new work. Unavailable inspection does not authorize destructive cleanup.

## Snapshot and viewer behavior

The parent creates a private temporary directory only when viewers are enabled and needed. Snapshot files contain a versioned JSON DTO, not the mutable runtime `Task` or a raw child event stream.

Each slot snapshot includes:

- protocol version, activation identifier, monotonically increasing slot sequence, and heartbeat;
- task ID, attempt generation, short display name, role/model, status, and timestamps;
- bounded text/thinking/tool-call/tool-output segments and any pending stream;
- truncation/disconnection indicators where applicable.

Use the already bounded `Task.live` trace as the source. Serialize only data needed by the viewer; do not serialize the full task prompt, messages array, process objects, or Sets. Clamp display metadata and cap each serialized snapshot at 128 KiB, dropping the oldest segments and clipping oversized content while retaining valid JSON and an explicit truncation indicator. Publish at most four snapshots per second per slot, coalescing intermediate changes, with a final status snapshot after task finalization. Do not synchronously serialize the whole trace on every token.

Create the directory with private permissions and files with mode `0600` where supported. Replace snapshots atomically so viewers never see partially written JSON. Keep at most the four current slot snapshots and bounded in-flight writes. Disk failure disables the affected viewer; there is no unbounded queue or durable monitoring archive.

The viewer is a standalone lightweight JavaScript (`.mjs`) Node entrypoint with no runtime Pi-package imports and no dependency on jobs/process/store modules. Prefer the parent executable when it is Node; otherwise resolve a runnable Node executable from PATH inside the environment gate. If unavailable, skip viewers without affecting monitoring or tasks. Use a packaged script path rather than a temporary product-code script. Launch commands contain executable/script/snapshot paths, not task text. Quoting must handle spaces and shell metacharacters on supported platforms.

It polls the slot snapshot every 250 milliseconds, renders readable text/thinking/tool activity, shows exact task status, and keeps completed output visible. It adapts to terminal dimensions. It must remove ANSI/OSC/control sequences from untrusted content; only the viewer's own terminal rendering controls may be emitted. Existing watch-pane thinking visibility is preserved, but these files and panes remain local and private to the user's account.

A viewer is read-only. Terminal input cannot steer a child or answer child extension dialogs. Herdr's agent prompt surface must not be advertised as an input channel for these viewers.

The parent reports each viewer as a custom agent label under its own lifecycle source, never as an official Pi session:

| Task state | Viewer semantic state | Display label |
| --- | --- | --- |
| Executing | working | running |
| Completed | idle | completed |
| Paused | idle | paused |
| Failed/aborted/interrupted | idle | exact task status |

Queued tasks do not reserve panes. Do not use `blocked` merely for failure or pause. Herdr idle/done transitions are visual signals, not proof of task success. Viewer state reports contain no child native session identity or resume command.

The adapter heartbeats live viewer snapshots every two seconds, including retained terminal output. A viewer without a heartbeat for ten seconds displays disconnection; after thirty seconds it exits rather than displaying a permanently live task. Heartbeats are advisory and never affect task classification. A healthy parent can reconnect/report without recreating the underlying child.

## Lifecycle and failure isolation

Add observer subscriptions alongside the existing runtime hooks rather than replacing the widget/watch callbacks. Required notifications cover task dispatch/status changes, live-trace updates, and finalized job completion. Each observer is isolated: an exception or rejected promise cannot prevent another observer or lifecycle consumer from running.

Observer callbacks schedule/coalesce work and return immediately. CLI commands use `execFile` with a short timeout, bounded output, and no shell for the Herdr invocation itself. Maintain finite queues and bounded concurrency. Commands for one pane/source are ordered; reports include sequences to reject stale updates. At most one pending latest snapshot/report per slot/source is retained.

Capture an activation generation in asynchronous operations. Disablement or session shutdown invalidates it before awaiting cleanup. A late creation result must be recorded for cleanup, not resurrect the old activation. A late report/write must not overwrite a newer slot/task or recreate files after cleanup.

Herdr commands time out after two seconds. Cleanup has an overall two-second budget, may issue independent pane cleanup commands concurrently, and is independent of the existing durable interruption and child-reaping paths. Timeout means best-effort cleanup can leave panes behind; it never delays or cancels durable task cleanup. Failures are caught at the integration boundary; warn at most once per activation rather than flooding the conversation. Do not reclassify a task because a viewer exits, a pane disappears, a report fails, or cleanup times out.

On disablement/session end:

1. Stop new integration work and invalidate in-flight work.
2. Clear this integration's parent metadata best-effort.
3. Release viewer lifecycle authority and close only owned panes.
4. Close the owned tab only if inspection confirms it contains no unrelated panes; otherwise leave it intact.
5. Stop snapshot publishing and remove owned temporary files after any in-flight writes settle.

After a parent crash, snapshot expiry stops viewer processes and metadata TTL removes stale parent presentation. Empty viewer panes may remain as shells until manually closed; crash-proof layout cleanup and automatic restore are out of scope.

## Module responsibilities

Keep the existing dependency graph acyclic:

- Pure option normalization, aggregation, slot selection, sequence/generation checks, and snapshot projection: testable without Pi runtime imports.
- Herdr CLI adapter: command construction, execution limits, response validation, and explicit pane ownership.
- Monitoring controller: subscribes to runtime observations, coordinates snapshots and slots, and owns activation/cleanup.
- Standalone viewer: snapshot reading and safe terminal rendering only.
- `index.ts`: session lifecycle binding and observer installation/disposal.
- `command-subagents.ts` plus settings IO: independent settings rows and atomic persistence.
- `process.ts`/`runtime.ts`: small additive observation points, not a backend abstraction or execution rewrite.

The controller receives settings/context explicitly; low-level modules must not import `jobs.ts` merely to obtain configuration. No monitor dependency is added to core/store, and the standalone viewer cannot mutate registries or manifests.

## Verification and acceptance

Write new pure-logic tests first and observe failures before implementation. Add adapter/controller tests with injected command execution, clock, filesystem, and snapshot sinks. Avoid fixed sleeps for async lifecycle verification; synchronize on observed calls/completion.

Required coverage:

1. Missing/non-Herdr environment creates no commands, viewers, files, or integration timers, even with default settings.
2. Invalid options/defaults and independent toggles; settings writes preserve unrelated fields and fail safely on malformed files.
3. Executing versus queued aggregate counts and display-only parent metadata; no parent lifecycle/session reports.
4. One eligible completion notification per job; `notifyOnComplete: false` suppresses Herdr delivery without altering Pi behavior.
5. Four-slot limit under simultaneous tasks; no active eviction; reuse resets attempt content and sequence.
6. Disabling viewers closes only owned panes, leaves central monitoring and children active, and prevents late async recreation.
7. Missing binary, socket failures, CLI timeout, disk failure, malformed responses, and vanished panes leave task/job outcomes intact.
8. Manual pane closure does not kill/reopen the same child attempt; pane unavailability is not treated as confirmed closure.
9. Pause/resume, chain progression, stream-error classification, and final-output delivery remain unchanged with integration enabled and disabled.
10. Bounded snapshots/writes, atomic replacement, private permissions, control-sequence sanitization, and heartbeat expiry.
11. Shutdown/reload races: late pane creation is cleaned up, stale writes/reports cannot cross generations, unrelated panes survive, and child reaping still completes.
12. Existing `/subagents` tier rows, auto toggle, picker, and clear-key navigation remain correct after adding Herdr rows.

Run the existing full `npm test` and `npm run typecheck` suites. Smoke-test actual central metadata and four-viewer reuse in a disposable named Herdr session, not the user's active pane layout. Also test a plain terminal with Herdr variables removed and viewer-off mode with Herdr present. Record installed Herdr/Pi/Node versions and any unavailable platform validation. Documentation must explain defaults, both switches, read-only behavior, viewer retention, and fallback behavior.

No implementation begins until the user approves this written specification and the subsequent implementation plan/execution method.
