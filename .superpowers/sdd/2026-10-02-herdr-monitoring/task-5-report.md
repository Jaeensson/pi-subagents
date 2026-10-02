# Task 5 implementation report

## Scope and evidence

Implemented the standalone readonly viewer and private snapshot/identity transport within Task 5's file scope. Used exact-source review because the parent MCP graph/project/coverage evidence was unavailable; inspected the Task 5 brief, global constraints, shared contracts, renderer/core/adapter source, package/typecheck configuration, and the independent test-writing expectations. No Herdr commands, child-process control, pane-manager integration, or live layout mutation were added.

## TDD

- **RED:** `node --test tests/herdr-files.test.mjs tests/herdr-viewer.test.mjs` failed before implementation because `herdr-files.ts` and `herdr-viewer.mjs` did not exist.
- **GREEN:** Focused suites pass (8 tests). They cover lazy private storage, atomic publication, slot cap, latest-write coalescing, stale publication cleanup, held-directory disposal, no eager viewer reads, monotonic disconnect/recovery/exit behavior, malformed storage, Unicode/ANSI handling, and isolated heartbeat storage errors.

## Implementation

- `herdr-files.ts`: lazy private directory (`0700`), private atomic snapshot files (`0600`), at most four slots, per-slot serialized latest-publication coalescing, bounded identity reads, and idempotent disposal/temp cleanup.
- `herdr-viewer.mjs`: standalone named-flag CLI and import-safe `runViewer`; readonly 250ms polling, accepted-sequence monotonic expiry, 2s private identity heartbeat, 10s disconnect/30s exit, resize-aware text rendering, and no stdin forwarding.
- `herdr-viewer.d.mts`: matching typed `ViewerDeps` and `runViewer` contract.
- `herdr-core.ts`: uses the shared renderer protocol constants without redundant imports.
- `package.json`, `tsconfig.json`: package `.mjs`/`.d.mts` assets and include settings/Herdr/command modules in explicit typecheck scope.

## Validation

- `npm test`: 314 passed, 0 failed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- `npm pack --dry-run --json`: confirmed packaged `herdr-viewer.mjs`, `herdr-viewer.d.mts`, `herdr-viewer-render.mjs`, and `herdr-viewer-render.d.mts`.

## Exports, packaging, concerns

`createSnapshotStore` is exported from `herdr-files.ts`; `runViewer` and `ViewerDeps` are exported/declared from the standalone viewer entry. Renderer protocol/timing constants remain sourced from `herdr-viewer-render.mjs`. No package export map was added; assets ship through `package.json.files`.

The Herdr pane manager/controller integration is intentionally not present yet. The requested wall-clock/monotonic, stale-sequence, and viewer lifecycle behavior is tested at the injected-dependency boundary; real Herdr launch/classification remains for the integrating task.

## Task 5 fix round 1 — base `626f81b`

### Evidence and scope

Read the Task 5 brief, report, full reviewer findings, global constraints and shared contracts; verified exact viewer, file-store, renderer, declaration, config and test sources. Verify-tier direct-source fallback only: MCP unavailable; project, generation and coverage unknown. No graph completeness claims, subagents, real Herdr calls, parent execution edits, or renderer viewport-policy changes.

### Mechanism-by-mechanism RED → GREEN

Each failing regression preceded its minimal fix. Counts below are the command output at that step, not inferred results.

| Finding / regression | RED command and output | GREEN command and output |
| --- | --- | --- |
| Important 1: missing/malformed rereads; resize retained content | `node --test tests/herdr-viewer.test.mjs`: 3 passed, 1 failed; `/disconnected/i` received `running` | Same command: 4 passed, 0 failed |
| Important 2: late held read after stop; repeated stops await held identity write | Viewer command: 4 passed, 2 failed; frame count `1 !== 0`, completed stop count `2 !== 0` | Viewer command: 6 passed, 0 failed |
| Important 3: independent deadlines during held read/write; acceptance-time sampling; late 31s read | Viewer command: 6 passed, 3 failed; held I/O retained `running`, delayed acceptance disconnected too early | Viewer command: 9 passed, 0 failed |
| Important 4: concurrent conflicting slot opens | `node --test tests/herdr-files.test.mjs`: 5 passed, 1 failed; second open `fulfilled` instead of `rejected` | Same command: 6 passed, 0 failed |
| Minor: directory chmod failure, including concurrent dispose | Files command: 6 passed, 1 failed; removal list `[]` | Files command: 7 passed, 0 failed |
| Additional Important 5: propagate disk failures, injected write/chmod/rename and default atomic failure cleanup | Files command: 7 passed, 2 failed; `Missing expected rejection` | Files command: 9 passed, 0 failed |
| Additional Important 6: held-I/O flood, active/latest failure, repeated dispose race | Files command: 10 passed, 2 failed; superseded completions `0 !== 998`, premature disposal `1 !== 0` | Files command: 12 passed, 0 failed |
| Minor: heartbeat-only identical frames | Viewer command: 9 passed, 1 failed; frame count `2 !== 1` | Viewer command: 10 passed, 0 failed |
| Minor: replacing a copied write port did not exercise rejection | Viewer command: 9 passed, 1 failed; observed rejection count `0 !== 1` | Viewer command: 10 passed, 0 failed after installing a stable closure before construction |
| Minor: explicit standalone declaration coverage | `tsc --listFilesOnly` piped to a Node assertion checking `/herdr-viewer.d.mts`: `standalone viewer declaration missing from typecheck` | Same assertion: `standalone viewer declaration included` |

The initial declaration probe used a nonexistent local `.bin/tsc`; reran with the available `tsc` before making the config change. The actual compiler-output probe above reproduced and verified the coverage defect.

### Fixes and memory bounds

- Retain the last accepted snapshot; render disconnected/resize state without rereading it. Compare every candidate frame with the last written frame, including newly accepted heartbeat-only sequences.
- Fence read continuations and deferred identity-write starts after invalidation. All explicit stop calls share completion of outstanding identity writes; held reads need not settle to stop, but cannot subsequently render or write.
- Deadline ticks never await I/O. At most one read and one identity write are outstanding, without queued ticks. Sample acceptance time after parsing/validation and check expiry again before acceptance, including a 31s read released without another interval tick.
- Revalidate established slot identity after directory creation, so a rejected competing open cannot overwrite it. Clean a successfully created directory if chmod fails.
- Reject active/latest publication promises on storage failure (internal drain rejections are handled). Keep only active and latest pending publication completions per slot: superseded pending work resolves without I/O. A 1,000-publication held-write flood resolves 998 superseded calls before release and writes only sequences `[1, 1000]`.
- Repeated dispose calls share cleanup completion; pending work settles immediately while active writes finish cleanup before disposal resolves.
- Explicitly include `herdr-*.d.mts` in typecheck. Preserve the exact `ViewerDeps` ports, public store APIs, standalone import guard and named CLI flags.

### Final validation

- `node --test tests/herdr-files.test.mjs tests/herdr-viewer.test.mjs`: **25 passed, 0 failed**. Additional checks cover wrong ownership/version/old sequences, wall-clock jumps, real default identity permissions and atomic rename-failure temp cleanup. Fixtures assert independent frame/status/count/filesystem expectations; clocks and held operations use injected/deferred ports, not sleeps.
- `npm test` (one full run after focused GREEN): **331 passed, 0 failed**, including no unhandled-rejection failures.
- `npm run typecheck`: initial full check reported `herdr-files.ts(59,25): TS2339` because TypeScript retained the pre-await `pending = undefined` narrowing. Added an explicit documented widening for the asynchronously replaceable pending publication; the necessary rerun **passed**. This last correction changes only type interpretation, not runtime behavior.
- `npm pack --dry-run --json`: succeeded, 37 entries; confirmed `herdr-viewer.mjs`, `herdr-viewer.d.mts`, `herdr-viewer-render.mjs`, `herdr-viewer-render.d.mts` included.
- `git diff --check`: passed.

### Concerns / next integration boundary

No round-1 findings remain open. The future manager must catch publication rejection and disable only the affected viewer; this store does not connect errors to task execution. Outstanding identity writes are intentionally awaited by explicit stop/dispose and can delay those promises if an injected port never settles; deadlines still clear the timer independently and I/O remains bounded. Real Herdr startup/ownership/cleanup and broader renderer viewport policy remain outside this fix scope.
