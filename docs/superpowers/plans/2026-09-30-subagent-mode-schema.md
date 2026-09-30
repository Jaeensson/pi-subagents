# Subagent Mode-Discriminated Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous flat `subagent` parameters with a required, mode-discriminated schema that agents can call reliably.

**Architecture:** Define a TypeBox union of closed objects for single, parallel, and chain calls. Dispatch and render using the discriminator, retain defensive runtime validation, and migrate the README examples without changing child-job lifecycle behavior.

**Tech Stack:** TypeScript, TypeBox, pi-coding-agent registered-tool wrapper, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-30-subagent-mode-schema-design.md`

## Global Constraints

- Preserve existing job lifecycle, result, cancellation, persistence, tier, and output behavior.
- The legacy flat tool-call shapes will no longer be accepted.
- Keep changes limited to the schema, executor/rendering, contract tests, and README examples.

## Review Focus

- Unknown/missing discriminator: reject rather than silently selecting a mode; schema test covers both.
- Cross-mode fields: reject rather than ignore; schema test covers an extra mode-specific property.
- Empty parallel/chain arrays: reject before execution; schema test checks `minItems` and runtime test checks defensive validation.
- Whitespace-only task text: reject before spawning; registered-tool contract test covers single, parallel, and chain.
- Omitted `agent` and `wait: false`: remain valid on each mode; schema tests cover these compatibility behaviors.

---

### Task 1: Replace the flat subagent tool contract

**Files:**
- Modify: `tools/subagent.ts`
- Test: `tests/tool-contracts.test.mjs`
- Modify: `README.md`
- Include: `docs/superpowers/specs/2026-09-30-subagent-mode-schema-design.md`
- Include: `docs/superpowers/plans/2026-09-30-subagent-mode-schema.md`

**Interfaces:**
- Produces `subagentParams`, a TypeBox union with three closed branches:
  - Single: `{ mode: "single", task: string, agent?, cwd?, tier?, name?, wait?, notifyOnComplete? }`.
  - Parallel: `{ mode: "parallel", tasks: TaskItem[], wait?, notifyOnComplete? }`; `tasks` has `minItems: 1` and a maximum of eight enforced by the executor.
  - Chain: `{ mode: "chain", chain: ChainItem[], cwd?, wait?, notifyOnComplete? }`; `chain` has `minItems: 1`.
- Each top-level branch sets `additionalProperties: false`. Keep task and chain item properties and defaults consistent with the current schema.
- The executor selects behavior from `params.mode`; chain steps still substitute `{previous}` and all three modes retain current wait/background behavior.

- [ ] **Step 1: Add failing schema-contract tests**

In `tests/tool-contracts.test.mjs`, import `Check` from `typebox/value`. Add tests that assert the new schema accepts one valid example for each mode (including omitted `agent` and `wait: false`) and rejects: legacy flat inputs, absent/unknown `mode`, cross-mode properties, and empty parallel/chain arrays. Update the over-eight-tasks case to use `mode: "parallel"` and assert it still fails at executor validation. Add registered-tool tests that reject whitespace-only single, parallel-item, and chain-step tasks before any spawn, and that exercise each dispatch branch with an unknown agent (which must fail before spawn). Add direct `execute` tests for empty/missing mode-specific arrays and missing/unknown mode to pin defensive validation.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `node --test tests/tool-contracts.test.mjs`
Expected: FAIL because the current schema has no required `mode` discriminator and does not constrain cross-mode fields or array minimum lengths.

- [ ] **Step 3: Define the mode-discriminated schemas in `tools/subagent.ts`**

Create `SingleParams`, `ParallelParams`, and `ChainParams` TypeBox object schemas with literal `mode` fields, the mode-specific properties above, shared `wait`/`notifyOnComplete` properties, and `additionalProperties: false`; define `subagentParams` as their union. Set `minItems: 1` on `tasks` and `chain` arrays. Keep parallel's eight-task limit in the executor.

- [ ] **Step 4: Dispatch and render by `params.mode`**

Replace `hasSingle`/`hasTasks`/`hasChain` inference with mode-based dispatch. Add an initial runtime mode guard so legacy calls and unknown modes fail with a clear message even if invoked outside schema-constrained tool calling; guard missing/empty mode-specific arrays before dispatch. Retain runtime validation for blank task text. Preserve current job creation, persistence, cancellation, result construction, and usage reporting. Update the tool description and `renderCall` so each variant uses its discriminator and previews its relevant tasks.

- [ ] **Step 5: Migrate README examples**

Update single, parallel, chain, and background call examples in `README.md` to include `mode`. Describe the required mode discriminator and that old flat shapes are no longer accepted.

- [ ] **Step 6: Run focused and full verification**

Run: `node --test tests/tool-contracts.test.mjs`  
Expected: PASS, including schema-level rejection and defensive runtime validation cases.

Run: `npm test`  
Expected: all tests PASS.

Run: `npm run typecheck`  
Expected: no TypeScript errors.

- [ ] **Step 7: Commit the completed change**

```bash
git add tools/subagent.ts tests/tool-contracts.test.mjs README.md docs/superpowers/specs/2026-09-30-subagent-mode-schema-design.md docs/superpowers/plans/2026-09-30-subagent-mode-schema.md
git commit -m "fix: clarify subagent mode schema"
```
