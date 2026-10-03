# Task 7 implementation report

## Status

Implemented the four-slot read-only viewer manager and the controller-authorized chooser correction on baseline `ea23d6e`. The integration naming seam was subsequently resolved by the shared-contracts ruling recorded below. Task8 composition is unchanged.

## Files

- `herdr-viewers.ts` — new manager and executable Node resolver.
- `tests/herdr-viewers.test.mjs` — 28 behavioral tests.
- `herdr-core.ts` — oldest ready non-executing slot before empty; no paused age override.
- `tests/herdr-core.test.mjs` — chooser RED case; existing paused fixture made genuinely oldest.
- This report (local SDD artifact).

## Ports / API decisions

- Exports `createViewerManager(host: ViewerHost, deps?: Partial<ViewerManagerDeps>): ViewerManager` and `resolveViewerNode(execPath, env, platform)` exactly as assigned.
- Dependencies: `storeFactory`, `resolveNode`, `viewerScriptPath`, `nonce`, `clock`, `execPath`. Production entrypoint comes from `import.meta.url`; timers use `nodeMonitorClock` opaque handles. Node discovery is lazy, only on active reconcile with admitted tasks. Prefer an executable, probed parent Node; otherwise probe executable Node candidates on PATH. Bun/standalone paths are not executed as Node.
- Consume actual Task4 adapter/parser/shared scheduler and Task5 store; no duplicate CLI parser, identity classifier, command quoting, transport writer, or DTO projection.
- Named launch flags remain `--snapshot --identity --activation --slot --nonce` through `buildViewerCommand`.
- Reports/releases use only the custom `pi-subagent-viewer` semantic lifecycle; no native Pi session/ref/resume APIs. No child-process kill or task mutation.
- A private source and wall-time-seeded monotonic decimal report counter remain alive through this physical pool. Snapshot sequence increases across task-attempt reuse with the same physical nonce; task/content/model/finishedAt/generation are replaced by a fresh projection, not merged.

## Ownership / guards / resource bounds

- Four slots reserve synchronously before asynchronous Node resolution/layout. Only executing, non-setup/non-queued tasks obtain new reservations. No executing eviction and no queued-pane backlog.
- One authoritative owned no-focus tab; root/right, root/down, right/down splits. Initial shell layout finishes before starting helpers: delayed first identity writes must not prevent a split.
- New panes are inspected before opening/launching, and again after awaited file publication. Only a sole, known Bourne/PowerShell/cmd shell with matching shell PID authorizes launch or unlaunched rollback. Unknown/unsupported shell is left alone.
- Reuse/report/release/close resolve the original inherited caller pane identity, retain the returned live ID, validate private slot identity, then classify foreground ownership. A fresh sole identity PID with absent argv is accepted by the real classifier; mismatched argv, additional participants, stale/mismatched identities and unknown inspections fail closed. Destination tabs are never adopted or split; labels convey no ownership.
- Task-attempt/slot-epoch/activation checks surround awaits. Ordinary adapter scopes also check the task epoch at queued dispatch; stale issued creation responses retain authoritative IDs only for inspected rollback. A stopped manager never starts a late reader or replacement.
- Missing attempts are retained in their unavailable physical slot and are not recreated; unavailable slots do not swallow a future generation. No unbounded successful-attempt history is retained. Four task/physical identities are the pool's lifetime ownership records.
- One active service/write per slot; task references retain latest content while I/O is held, without a promise/write queue flood. The real store supplies atomic current-generation publication and active+latest coalescing. Minimum 250 ms publication interval, retained snapshots every two seconds. Disk failure disables only the affected physical viewer, including an old-epoch failure, and never disposes a healthy peer's transport.
- Handshake has a total two-second clock deadline, including held identity/process inspection, and cancels polling/timeout handles on stop. Normal service has no overlapping slot workers.
- Stop invalidates publication/launch guards synchronously, cancels manager/handshake timers, then gives all pane inspection/release/reinspection/close/tab inspection one shared total two-second cleanup budget. Raw cleanup scopes skip queued commands after expiry. Store disposal follows bounded pane work and waits for outstanding atomic writes before removing files. Explicit manager stop may therefore await held filesystem I/O; the existing controller already caps its own wait at two seconds.
- Late creation responses receive a separate best-effort bounded inspected rollback. Close only the authoritative created tab after inspection shows no remaining panes; user-added panes and destination tabs are preserved. Foreign work introduced during release prevents the subsequent close.

## RED / GREEN and evidence

- First `node --test tests/herdr-viewers.test.mjs tests/herdr-core.test.mjs`: RED (missing manager module, chooser preferred empty).
- Additional RED iterations demonstrated destination-tab splitting, initial layout racing delayed helper identity, pending handshake timers surviving stop, stale cached ownership after held reuse publication, and suppression incorrectly swallowing a future manually-closed task generation. Corrected each and observed GREEN.
- Final focused combined command: `node --test tests/herdr-viewers.test.mjs tests/herdr-adapter.test.mjs tests/herdr-files.test.mjs tests/herdr-core.test.mjs` — **63/63 pass**.
- Final full check (once): `npm test` — **384/384 pass** (baseline 355 plus 29 tests); `npm run typecheck` — **pass**.
- Tests use deferred external CLI/write operations and injected clocks. The manager exercises the real adapter/scheduler. A composed test also runs the real SnapshotStore and standalone helper with deterministic filesystem/CLI ports; existing combined store tests exercise real private filesystem writes. Node resolver probes only controlled local Node executable/symlink fixtures. No live Herdr mutations or subagents were used.
- Read assigned brief first, constraints/contracts including controller rulings, writing-good-tests reference, and exact target/port source. MCP tools unavailable; Verify exact-source fallback only. Project/generation/index coverage unknown; no graph or exhaustive coverage claims.

## Self-review / concerns

- Checked changed source and tests for stale scopes, shell/foreign safety, sequence reuse, late creation, deadline ordering and absence of child/native-session operations. `git diff --check` clean. No existing orchestration/controller code changed.
- **RESOLVED (Task7 naming seam):** shared-contracts ruling authorizes the unchanged `HerdrAdapter.createTab(workspaceId, cwd)` signature to append literal `--label Subagents` to `tab create`. The label is display-only, never ownership evidence.
- Unsupported/unknown/foreign panes are intentionally left intact. Files are removed on stop even if pane cleanup cannot finish; an unclosable helper follows its existing no-heartbeat exit policy.
- Manager factory wiring and session-local task filtering remain Task8 responsibilities. Global cross-activation teardown/creation ordering is controlled by the existing monitor, not changed in Task7.

## Naming seam resolution evidence (baseline `b9df410`)

- Applied the shared-contracts ruling: installed Herdr 0.8.2 `herdr tab create --help` (parent-verified) explicitly supports `--label <TEXT>`; keep the integration-only `createTab(workspaceId, cwd)` API and pass the literal label `Subagents`. Presentation only; no ownership logic consumes it.
- Added an exact external-argv regression first. `node --test tests/herdr-adapter.test.mjs` failed RED because argv omitted `--label Subagents`; after the adapter-only argv change it passed.
- Focused validation: `node --test tests/herdr-adapter.test.mjs tests/herdr-viewers.test.mjs tests/herdr-core.test.mjs` — **52/52 pass**; `npm run typecheck` — **pass**.
- Scope: `herdr-adapter.ts`, `tests/herdr-adapter.test.mjs`, and this report only. No manager changes, agents, live Herdr mutations, or full-plan run. MCP unavailable; exact-source fallback was used.
