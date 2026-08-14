# Model Tiers for Subagents — Design

Date: 2026-08-14
Status: Approved (brainstorming)

## Problem

Agent definitions today hardcode concrete model names in frontmatter
(`model: claude-haiku-4-5`), and tool calls cannot steer model choice. This
couples agent files to one provider and breaks on model-name churn; changing
provider means editing every agent file.

## Concept

Introduce **model tiers**: agent files and tool calls declare *how much
capability they need* rather than *which model*. A central mapping in pi
settings resolves tiers to concrete models at spawn time.

Tier values: `fast | balanced | deep`.

## Config schema

`~/.pi/agent/settings.json` (read via `getSettingsPath()`):

```json
{
  "subagent": {
    "modelTiers": {
      "auto": true,
      "fast": "claude-haiku-4-5",
      "balanced": "claude-sonnet-4-5",
      "deep": "claude-opus-4-5"
    }
  }
}
```

- `auto` (optional, default `false`): enable the catalog-aware auto-picker for
  unmapped tiers.
- Explicit per-tier values always win over `auto`; `auto` fills only unmapped
  tiers.
- If a requested tier is neither mapped nor resolvable by `auto`, the task
  falls back to inheriting the parent's `defaultModel` (today's behavior when
  no `--model` is passed).

## Declaration points

1. **Agent frontmatter** — optional `tier` key alongside existing `model`:

   ```markdown
   ---
   name: planner
   description: Designs implementation plans
   tools: read, bash
   tier: deep
   ---
   ```

2. **Tool schema** — optional `tier` param on the `subagent` tool (single
   mode) and on `TaskItem` / `ChainItem` (parallel and chain modes), matching
   the per-item granularity of existing `agent` / `cwd` params.

## Resolution precedence (per task)

1. Call-time `tier` → resolved through tier resolution
2. Agent frontmatter `model` (concrete pin beats abstract tier at file level)
3. Agent frontmatter `tier` → resolved through tier resolution
4. Parent `defaultModel` (inherit; no `--model` flag passed)

**Tier resolution** of tier `t`:

1. `modelTiers[t]` explicit mapping → use it
2. `modelTiers.auto === true` → auto-picker
3. Parent `defaultModel` (inherit)

## Auto-picker (family-aware)

Applied per tier only when `auto: true` and no explicit mapping for that tier:

1. Look up `defaultModel` in the pi-ai built-in catalog to find its provider
   family. Not found (custom/local model) → inherit parent default for all
   tiers.
2. Cluster that provider's catalog models into **name families** around
   `defaultModel`. A family is the set of model ids sharing the same
   non-suffixed stem as the default: strip trailing `-YYYYMMDD` date suffixes
   (e.g. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`) and known variant
   keywords (`-latest`), then group ids whose stems share the same dot-free
   prefix up to the last `-`-separated segment (so `deepseek-v4-flash` and
   `deepseek-v4-pro` form one family via `deepseek-v4`). Dated duplicates of
   the same stem are considered equivalent to the canonical id for ranking.
   Filter by `enabledModels` patterns from settings when set.
3. **balanced** = `defaultModel`, always.
4. **fast** = cheapest same-family model (by input cost) that is cheaper than
   the default; if none, cheapest model in the provider overall.
5. **deep** = most expensive same-family model pricier than the default; if
   none, collapse to `defaultModel`. **Never** pick from another family.
6. Collapsed or fallen-back tiers are reported (see Reporting).

Rationale: cost ranking within the default model's family yields coherent
tiers (Anthropic users naturally get haiku/sonnet/opus) without hardcoded
per-provider trio tables that churn with catalog updates. Cross-family jumps
are avoided because they select unrelated vendors' models (e.g. defaulting to
`deepseek-v4-pro` should not make "fast" resolve to `gpt-5.6-luna`).

## Reporting

- Completion summaries show the resolved model as `model: <id> (tier: <tier>)`.
- When a requested tier fell back to the parent default or collapsed, include a
  one-line note in the result, e.g. `tier "deep" collapsed to default model`.
- `subagent_agents` output lists `tier` alongside `model` for each agent.

## Files

- `core.ts` — pure logic, no pi imports:
  - `resolveModel({ requestedTier, agentModel, agentTier, tierConfig, defaultModel, catalogSnapshot, enabledModels })` → `{ model?: string, tierUsed?: string, fallback?: string }`
  - `pickAutoTier(...)` — family clustering + cost ranking (operates on plain
    data snapshots, not pi-ai imports).
  - `parseAgentMarkdown` — accept and expose `tier` in frontmatter.
- `index.ts` — imports `getSettingsPath()` and the pi-ai catalog; reads
  settings; wires resolution into spawn (`buildChildArgs`); adds `tier` to tool
  schemas; extends result/summary formatting and `subagent_agents` output.
- `agents.ts` — expose `tier` on discovered agent summaries.
- `tests/core.test.mjs` — unit tests for resolution precedence, auto-picker
  family clustering, collapse/fallback behavior, frontmatter parsing.
- `README.md` — new "Model tiers" section: schema, precedence, auto behavior,
  suggested Anthropic trio mapping.

## Non-goals

- No per-provider hardcoded tier tables.
- No tier-specific thinking-level or reasoning-effort steering (pi's
  `defaultThinkingLevel` already applies to children; revisit only if needed).
- No validation that a resolved model is actually usable/authorized for the
  user (pi's child process reports its own errors; `auto` is opt-in and
  explicit overrides are the escape hatch).
