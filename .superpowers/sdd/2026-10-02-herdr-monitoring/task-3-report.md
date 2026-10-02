# Task 3 report: bounded snapshots and pane-pool decisions

## Changed files
- `herdr-core.ts` — shared Herdr context/protocol/pane/slot contracts, constants, task attempt/count helpers, bounded snapshot projection/encoding, and pure slot selection.
- `herdr-viewer-render.mjs` — standalone snapshot validation, terminal-control sanitization, grapheme-aware rendering.
- `herdr-viewer-render.d.mts` — runtime-matched renderer declarations.
- `tests/herdr-core.test.mjs` — core interfaces, count behavior, task-attempt identity, caps, prompt exclusion, immutability, pending segments, and pool policy.
- `tests/herdr-viewer-render.test.mjs` — sanitizer, malformed protocol, and narrow/wide Unicode rendering.

## API decisions
- `attemptKey` formats identity as `taskId:processGeneration`; missing generation defaults to `0` for compatibility with the optional runtime field.
- `summarizeTasks` treats `setupPending` and queued dispatch as queued, including setup work whose task status is already `running`.
- Slot selection creates at the lowest-index empty slot, otherwise reuses the oldest paused ready slot before other non-running ready slots. Reserved, unavailable, and executing slots cannot be selected.
- Invalid/unsafe snapshot sequence values throw `RangeError`; snapshot projection clips oldest segments first and flags truncation. Snapshot payloads contain display metadata and live segments only, never the original task prompt.
- Viewer rendering owns no terminal control sequences; CJK/emoji graphemes are accounted as double-width and combining marks are kept with their grapheme.

## Validation evidence
- TDD RED: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` initially failed on missing modules.
- Focused GREEN: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` passed.
- Full suite: `npm test` — 286 tests passed.
- Typecheck: `npm run typecheck` — passed.
- `git diff --check` — passed before commit.

## Concerns
- Display cell-width handling is a deliberate lightweight Unicode approximation (grapheme segmentation plus common wide/CJK and emoji ranges), not a complete terminal-specific `wcwidth` implementation.
- No runtime producer/viewer integration was introduced, per task scope.

## Task 3 fix round 1
- Corrected the snapshot mechanism: an oversized lone segment was dropped by the initial oldest-segment loop, so the later fallback that sliced from the front was unreachable. The loop now preserves the final segment and trims its start on Unicode code-point boundaries, retaining the newest tail and checking serialized UTF-8 size before returning.
- Added focused regressions for a 140,000-character lone segment ending in `LATEST-TAIL🙂`, valid JSON, and the 128 KiB byte cap; and for flag/keycap/skin-tone/ZWJ emoji at narrow terminal width. Added width cases 1, 2, 3, and 7 with broader grapheme coverage.
- Moved the shared protocol/timing constants into standalone `herdr-viewer-render.mjs`; declarations expose them and `herdr-core.ts` imports/re-exports the same values.
- TDD RED: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` failed as expected: the oversized lone segment had zero segments, and the renderer lacked the standalone constants export (the emoji regression was added and also exposed the width issue).
- Focused GREEN: `node --test tests/herdr-core.test.mjs tests/herdr-viewer-render.test.mjs` — 9 tests passed, 0 failed.
- Typecheck: `npm run typecheck` — passed. `git diff --check` — passed.

## Task 3 fix round 2
- Replaced the renderer test's broad Unicode-category width guess with an independent grapheme fixture oracle: explicit cell widths for flags, keycaps, skin-tone and ZWJ emoji, CJK, combining text, and renderer punctuation; ASCII fixture characters count individually.
- Exercised the combined grapheme fixture at widths 1, 2, 3, and 7, asserting every emitted line fits the explicit cell count and all output stays within the row limit. At width 7, all fixture graphemes are also asserted present. No production changes were needed.
- Focused validation: `node --test tests/herdr-viewer-render.test.mjs tests/herdr-core.test.mjs` — 9 passed, 0 failed.
- No MCP/code-graph coverage claim; exact-source fallback used as requested.
