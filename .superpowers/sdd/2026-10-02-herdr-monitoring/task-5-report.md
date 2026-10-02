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
