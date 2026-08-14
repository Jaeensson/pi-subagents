# Optional `agent` in Parallel Tasks and Chain Steps

Date: 2026-08-14

## Goal

Allow omitting `agent` in parallel tasks and chain steps of the `subagent`
tool, falling back to the built-in default agent — the same behavior single
mode already has for raw prompts.

## Problem

`TaskItem.agent` and `ChainItem.agent` are required strings in the typebox
schemas, so `subagent { tasks: [{ task: "..." }] }` fails validation with
"must have required properties agent" even though all runtime logic
(`resolveAgent(undefined, agents)` → built-in default agent) already handles
omission correctly.

## Design

1. **Schema** (`index.ts`): make `TaskItem.agent` and `ChainItem.agent`
   optional (`Type.Optional`), with descriptions noting the default-agent
   fallback.
2. **Tool description** (`index.ts`): update the mode summary to
   `parallel {tasks: [{agent?, task}]}` and `chain {chain: [{agent?, task}]}`.
3. **TUI call preview** (`index.ts` `renderCall`): fall back to `"default"`
   when a task/step omits the agent, via a new pure helper
   `displayAgentName(name?: string)` in `core.ts` (unit-tested).
4. **README**: usage examples and agent-definitions section mention the
   optional agent in parallel/chain.

## Non-goals

- No runtime execution changes: agent resolution, pre-validation, spawn
  paths, and error messages already handle `undefined` agent names.
- No changes to single mode (already optional).

## Verification

- `npm test` (new unit test for `displayAgentName`, existing suite green)
- `npm run typecheck`
- Manual: `/reload` in pi, then `subagent { tasks: [{task}] }` without agents.
