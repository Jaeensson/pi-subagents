# Subagent Mode-Discriminated Schema Design

**Status:** Proposed for user review  
**Date:** 2026-09-30

## Problem

Agents repeatedly fail to call `subagent` correctly. The current input schema places `agent`/`task`, `tasks`, and `chain` as independent optional properties, while its description talks about single, parallel, and chain “modes.” This leaves the model to infer how the modes map onto properties. In addition, the executor rejects any present empty `tasks` or `chain` array, even when another valid mode was supplied. For example, `{ agent: "worker", task: "...", tasks: [], chain: [] }` fails before dispatch.

## Goal

Make the tool contract unambiguous and mutually exclusive at the schema level, so the selected execution mode and its required fields are explicit and invalid cross-mode combinations are not part of the advertised contract.

## Approved direction

Use a TypeBox discriminated union with a required `mode` property. Each branch has only the inputs relevant to that mode, plus shared wait/notification options. Make each top-level branch closed to additional properties so incompatible mode fields are rejected rather than ignored. Set `minItems: 1` on the parallel and chain arrays in the schema as well as checking them at runtime:

- **Single:** `mode: "single"`, required `task`, optional `agent`, `cwd`, `tier`, and `name`.
- **Parallel:** `mode: "parallel"`, required non-empty `tasks` array (up to eight entries); each item has required `task` and optional `agent`, `cwd`, `tier`, and `name`.
- **Chain:** `mode: "chain"`, required non-empty `chain` array; each step has required `task` and optional `agent`, `cwd`, `tier`, and `name`. `{previous}` remains supported in step task text. The existing top-level `cwd` remains available for chain execution.
- All branches retain `wait` and `notifyOnComplete` with their existing defaults and semantics.

The executor dispatches by `mode`; its runtime validation still rejects empty arrays and missing/blank task text defensively. Schema validation must reject missing/unknown modes and cross-mode fields. Validation must never spawn a partial parallel batch or chain when input is invalid.

## Compatibility and migration

This is a deliberate tool-call contract change. The legacy flat shapes (`{agent, task}`, `{tasks: [...]}`, and `{chain: [...]}`) will no longer be accepted. Update all README examples and user-facing descriptions to the new form in the same change. Do not add aliases or a compatibility union: retaining both forms would preserve the ambiguity this redesign is intended to remove.

## Implementation boundaries

- `tools/subagent.ts`: define the three schema branches, describe the contract clearly, dispatch and validate by mode, and render calls based on the discriminator. Preserve all current job lifecycle, result, cancellation, persistence, tier, and output behavior.
- `tests/tool-contracts.test.mjs`: cover valid mode shapes through Pi's registered-tool wrapper, reject missing/unknown mode, mode-inappropriate fields or structures, empty batches, and missing/blank task text. Assert invalid input fails before any task is spawned.
- `README.md`: migrate tool-call examples and describe the required discriminator. No unrelated runtime or storage changes.

## Acceptance criteria

1. A call must select exactly one mode using `mode` and satisfy that branch's required fields.
2. Single, parallel, and chain calls retain existing execution semantics, including asynchronous `wait: false` behavior.
3. Empty or absent task arrays for parallel/chain cannot silently run and are rejected with actionable errors.
4. Rendered tool calls correctly identify the selected mode and show relevant task previews.
5. Existing flat call forms fail clearly rather than being guessed or silently interpreted.
6. The test suite and TypeScript typecheck pass.
