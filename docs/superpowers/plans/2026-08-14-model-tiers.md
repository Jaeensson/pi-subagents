# Model Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `tier: fast | balanced | deep` model steering to the subagent extension, resolvable via a `subagent.modelTiers` config in pi's settings.json with an opt-in family-aware auto-picker.

**Architecture:** All pure logic (tier types, config normalization, family clustering, cost ranking, precedence resolution, formatting) lives in `core.ts` with unit tests in `tests/core.test.mjs` (TDD, node --test). `index.ts` wires it up: reads settings.json via `getSettingsPath()`, builds a catalog snapshot from `ctx.modelRegistry.getAvailable()` + `ctx.scopedModels`, resolves the model per spawned task in `spawnTask`, and reports the used tier in status output.

**Tech Stack:** TypeScript (erasable syntax in core.ts), Node built-in test runner, TypeBox schemas, pi SDK (`@earendil-works/pi-coding-agent`).

**Spec:** `docs/superpowers/specs/2026-08-14-model-tiers-design.md`

---

## File Structure

- `core.ts` (modify) — tier types, `normalizeTierConfig`, `isTierLevel`, `familyStem`, `pickAutoTier`, `resolveModel`, `parseAgentMarkdown` tier key, `formatUsageStats` tier param, `formatStatusReport` tier/note fields
- `tests/core.test.mjs` (modify) — unit tests for all of the above
- `agents.ts` (modify) — pass `tier` from parsed frontmatter into agent summaries
- `index.ts` (modify) — settings loading, catalog snapshot, model context plumbing through `spawnTask`/`runChain`/`execute`, tool schema `tier` params, `subagent_agents` listing, single-mode usage line with tier
- `README.md`, `AGENTS.md` (modify) — document the feature

---

### Task 1: Tier types, config normalization, and tier validation in core.ts

**Files:**
- Modify: `core.ts` (add new section after the "Default agent" section, before "Agent markdown parsing")
- Test: `tests/core.test.mjs`

- [ ] **Step 1.1: Write the failing tests**

Append to `tests/core.test.mjs` (after the `parseAgentMarkdown` block) and add the new imports to the import list at the top (`normalizeTierConfig`, `isTierLevel`):

```js
// ── Model tiers: normalizeTierConfig / isTierLevel ───────────────────────────

test("normalizeTierConfig extracts auto and level mappings, ignores junk", () => {
	assert.deepEqual(
		normalizeTierConfig({ auto: true, fast: "a", balanced: "b", deep: "c", junk: 1 }),
		{ auto: true, fast: "a", balanced: "b", deep: "c" },
	);
	assert.deepEqual(normalizeTierConfig({ fast: "x" }), { fast: "x" });
	assert.deepEqual(normalizeTierConfig({ auto: false }), { auto: false });
});

test("normalizeTierConfig trims strings and drops non-string levels", () => {
	assert.deepEqual(normalizeTierConfig({ fast: "  claude-haiku-4-5 ", balanced: 42 }), {
		fast: "claude-haiku-4-5",
	});
});

test("normalizeTierConfig returns undefined for missing, empty, or malformed config", () => {
	assert.equal(normalizeTierConfig(undefined), undefined);
	assert.equal(normalizeTierConfig(null), undefined);
	assert.equal(normalizeTierConfig("auto"), undefined);
	assert.equal(normalizeTierConfig([]), undefined);
	assert.equal(normalizeTierConfig({}), undefined);
	assert.equal(normalizeTierConfig({ auto: "yes" }), undefined);
	assert.equal(normalizeTierConfig({ deep: "" }), undefined);
});

test("isTierLevel accepts only fast, balanced, deep", () => {
	assert.equal(isTierLevel("fast"), true);
	assert.equal(isTierLevel("balanced"), true);
	assert.equal(isTierLevel("deep"), true);
	assert.equal(isTierLevel("mega"), false);
	assert.equal(isTierLevel(undefined), false);
	assert.equal(isTierLevel(""), false);
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `SyntaxError: The requested module '../core.ts' does not provide an export named 'normalizeTierConfig'` (the import fails; if the runner reports the import error only, that is the expected failure).

- [ ] **Step 1.3: Implement in core.ts**

Insert after the `DEFAULT_AGENT_SYSTEM_PROMPT` block, before "Agent markdown parsing":

```ts
// ── Model tiers ──────────────────────────────────────────────────────────────

export type TierLevel = "fast" | "balanced" | "deep";

export const TIER_LEVELS: readonly TierLevel[] = ["fast", "balanced", "deep"];

/** The `subagent.modelTiers` object from settings.json, normalized. */
export interface TierConfig {
	auto?: boolean;
	fast?: string;
	balanced?: string;
	deep?: string;
}

/** A plain snapshot of a catalog model, built from pi's model registry. */
export interface CatalogModel {
	id: string;
	provider: string;
	inputCost: number;
}

export interface ModelResolution {
	/** Concrete model id to pass to the child; undefined → inherit parent default. */
	model?: string;
	/** The tier that produced the model, if any. */
	tierUsed?: TierLevel;
	/** Human-readable fallback/collapse note, if any. */
	note?: string;
}

export function isTierLevel(value: string | undefined): value is TierLevel {
	return value !== undefined && (TIER_LEVELS as readonly string[]).includes(value);
}

/**
 * Normalize an arbitrary settings.json value into a TierConfig.
 * Returns undefined when nothing usable is present (feature off).
 */
export function normalizeTierConfig(value: unknown): TierConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const src = value as Record<string, unknown>;
	const cfg: TierConfig = {};
	if (typeof src.auto === "boolean") cfg.auto = src.auto;
	for (const level of TIER_LEVELS) {
		const v = src[level];
		if (typeof v === "string" && v.trim() !== "") cfg[level] = v.trim();
	}
	if (cfg.auto === undefined && cfg.fast === undefined && cfg.balanced === undefined && cfg.deep === undefined) {
		return undefined;
	}
	return cfg;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 1.5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(tier): tier types and config normalization in core"
```

---

### Task 2: Family clustering and the auto-picker in core.ts

**Files:**
- Modify: `core.ts` (extend the "Model tiers" section)
- Test: `tests/core.test.mjs`

- [ ] **Step 2.1: Write the failing tests**

Add to the imports: `familyStem`, `pickAutoTier`. Append after the Task 1 tests:

```js
// ── Model tiers: familyStem / pickAutoTier ───────────────────────────────────

test("familyStem strips date and -latest suffixes and returns the first segment", () => {
	assert.equal(familyStem("claude-haiku-4-5-20251001"), "claude");
	assert.equal(familyStem("claude-haiku-4-5-latest"), "claude");
	assert.equal(familyStem("deepseek-v4-pro"), "deepseek");
	assert.equal(familyStem("gpt-5.6-luna"), "gpt");
	assert.equal(familyStem("hy3"), "hy3");
});

test("pickAutoTier picks same-family cheaper/pricier models around the default", () => {
	const catalog = [
		{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 1 },
		{ id: "claude-haiku-4-5-20251001", provider: "anthropic", inputCost: 1 },
		{ id: "claude-sonnet-4-5", provider: "anthropic", inputCost: 3 },
		{ id: "claude-opus-4-5", provider: "anthropic", inputCost: 15 },
		{ id: "qwen-whatever", provider: "anthropic", inputCost: 0.5 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "claude-sonnet-4-5", catalog }), {
		model: "claude-haiku-4-5",
	});
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "claude-sonnet-4-5", catalog }), {
		model: "claude-opus-4-5",
	});
});

test("pickAutoTier collapses deep when no pricier family member exists", () => {
	const catalog = [
		{ id: "deepseek-v4-flash", provider: "opencode-go", inputCost: 0.14 },
		{ id: "deepseek-v4-pro", provider: "opencode-go", inputCost: 0.435 },
	];
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "deepseek-v4-pro", catalog }), {
		model: "deepseek-v4-pro",
		collapsed: true,
	});
});

test("pickAutoTier fast falls back to the provider's cheapest model outside the family", () => {
	const catalog = [
		{ id: "gpt-5.4", provider: "opencode-go", inputCost: 2 },
		{ id: "mini-m3", provider: "opencode-go", inputCost: 1 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "gpt-5.4", catalog }), {
		model: "mini-m3",
		outsideFamily: true,
	});
});

test("pickAutoTier fast collapses when the default is already cheapest", () => {
	const catalog = [
		{ id: "gpt-5.4", provider: "opencode-go", inputCost: 2 },
		{ id: "kimi-k3", provider: "opencode-go", inputCost: 3 },
	];
	assert.deepEqual(pickAutoTier("fast", { defaultModel: "gpt-5.4", catalog }), {
		model: "gpt-5.4",
		collapsed: true,
	});
});

test("pickAutoTier returns nothing for missing defaults or unknown models", () => {
	assert.deepEqual(pickAutoTier("fast", { defaultModel: undefined, catalog: [] }), {});
	assert.deepEqual(pickAutoTier("deep", { defaultModel: "llama3.1:8b", catalog: [] }), {});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `familyStem` / `pickAutoTier` are not exported from `core.ts`.

- [ ] **Step 2.3: Implement in core.ts**

Extend the "Model tiers" section (after `normalizeTierConfig`):

```ts
/** Result of the auto-picker for one tier. */
export interface AutoPick {
	model?: string;
	/** The pick equals the default model (tier collapsed). */
	collapsed?: boolean;
	/** The pick is outside the default model's family (fast fallback only). */
	outsideFamily?: boolean;
}

/**
 * Family stem of a model id: the first `-`-separated segment after stripping
 * trailing `-YYYYMMDD` date suffixes and `-latest`. Brand families keep
 * provider trios together (`claude-haiku-4-5`, `claude-sonnet-4-5` and
 * `claude-opus-4-5` all belong to `claude`).
 */
export function familyStem(id: string): string {
	let stem = id.replace(/-\d{8}$/, "");
	stem = stem.replace(/-latest$/i, "");
	return stem.split("-")[0];
}

/**
 * Pick a model for a fast/deep tier from the catalog, relative to the
 * default model. Cost-ranked within the default model's family; cost ties
 * prefer the canonical (shorter) id so dated duplicates lose.
 */
export function pickAutoTier(
	level: "fast" | "deep",
	options: { defaultModel?: string; catalog: CatalogModel[] },
): AutoPick {
	const { defaultModel, catalog } = options;
	if (!defaultModel) return {};
	const def = catalog.find((m) => m.id === defaultModel);
	if (!def) return {};
	const family = catalog.filter(
		(m) => m.provider === def.provider && familyStem(m.id) === familyStem(def.id),
	);
	const byCost = (models: CatalogModel[]) =>
		[...models].sort((a, b) => a.inputCost - b.inputCost || a.id.length - b.id.length);
	if (level === "fast") {
		const cheaper = byCost(family).filter((m) => m.inputCost < def.inputCost);
		if (cheaper.length > 0) return { model: cheaper[0].id };
		const providerModels = byCost(catalog.filter((m) => m.provider === def.provider));
		const pick = providerModels[0];
		if (!pick) return {};
		if (pick.id === def.id) return { model: pick.id, collapsed: true };
		return { model: pick.id, outsideFamily: true };
	}
	const pricier = byCost(family)
		.filter((m) => m.inputCost > def.inputCost)
		.reverse();
	if (pricier.length > 0) return { model: pricier[0].id };
	return { model: def.id, collapsed: true };
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the six new ones.

- [ ] **Step 2.5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(tier): family clustering and cost-ranked auto-picker"
```

---

### Task 3: Model resolution precedence in core.ts

**Files:**
- Modify: `core.ts` (extend the "Model tiers" section)
- Test: `tests/core.test.mjs`

- [ ] **Step 3.1: Write the failing tests**

Add `resolveModel` to the imports. Append after the Task 2 tests:

```js
// ── Model tiers: resolveModel ────────────────────────────────────────────────

const tierCatalog = [
	{ id: "claude-haiku-4-5", provider: "anthropic", inputCost: 1 },
	{ id: "claude-sonnet-4-5", provider: "anthropic", inputCost: 3 },
	{ id: "claude-opus-4-5", provider: "anthropic", inputCost: 15 },
];

test("resolveModel prefers an explicit call-time tier mapping over the agent model", () => {
	assert.deepEqual(
		resolveModel({
			callTier: "deep",
			agentModel: "claude-haiku-4-5",
			tierConfig: { deep: "claude-opus-4-5" },
			catalog: tierCatalog,
		}),
		{ model: "claude-opus-4-5", tierUsed: "deep", note: undefined },
	);
});

test("resolveModel uses auto for balanced and fast tiers", () => {
	assert.deepEqual(
		resolveModel({
			callTier: "balanced",
			tierConfig: { auto: true },
			defaultModel: "claude-sonnet-4-5",
			catalog: tierCatalog,
		}),
		{ model: "claude-sonnet-4-5", tierUsed: "balanced", note: undefined },
	);
	assert.deepEqual(
		resolveModel({
			callTier: "fast",
			tierConfig: { auto: true },
			defaultModel: "claude-sonnet-4-5",
			catalog: tierCatalog,
		}),
		{ model: "claude-haiku-4-5", tierUsed: "fast", note: undefined },
	);
});

test("resolveModel reports deep collapse through auto", () => {
	const r = resolveModel({
		agentTier: "deep",
		tierConfig: { auto: true },
		defaultModel: "deepseek-v4-pro",
		catalog: [
			{ id: "deepseek-v4-flash", provider: "opencode-go", inputCost: 0.14 },
			{ id: "deepseek-v4-pro", provider: "opencode-go", inputCost: 0.435 },
		],
	});
	assert.equal(r.model, "deepseek-v4-pro");
	assert.equal(r.tierUsed, "deep");
	assert.ok(r.note?.includes("collapsed"));
});

test("resolveModel agent model beats agent tier when no call tier is given", () => {
	assert.deepEqual(
		resolveModel({
			agentModel: "claude-opus-4-5",
			agentTier: "fast",
			tierConfig: { fast: "claude-haiku-4-5" },
			catalog: tierCatalog,
		}),
		{ model: "claude-opus-4-5", note: undefined },
	);
});

test("resolveModel resolves the agent tier when no call tier or agent model applies", () => {
	assert.deepEqual(
		resolveModel({ agentTier: "deep", tierConfig: { deep: "claude-opus-4-5" }, catalog: tierCatalog }),
		{ model: "claude-opus-4-5", tierUsed: "deep", note: undefined },
	);
});

test("resolveModel falls back to the parent default with a note when tiers are unresolvable", () => {
	assert.deepEqual(
		resolveModel({ callTier: "fast", tierConfig: {}, catalog: tierCatalog }),
		{ model: undefined, note: 'tier "fast" is not configured; falling back' },
	);
});

test("resolveModel ignores invalid tier strings and uses the agent model", () => {
	assert.deepEqual(
		resolveModel({ callTier: "mega", agentModel: "claude-haiku-4-5", catalog: tierCatalog }),
		{ model: "claude-haiku-4-5", note: undefined },
	);
});

test("resolveModel returns no model when nothing applies", () => {
	assert.deepEqual(resolveModel({ catalog: tierCatalog }), { model: undefined, note: undefined });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveModel` is not exported from `core.ts`.

- [ ] **Step 3.3: Implement in core.ts**

Extend the "Model tiers" section (after `pickAutoTier`):

```ts
/**
 * Resolve which concrete model a task should run with.
 *
 * Precedence: call-time tier → agent frontmatter model → agent frontmatter
 * tier → parent default (inherit, model undefined). A requested tier resolves
 * via the explicit mapping first, then the auto-picker when enabled; an
 * unresolvable tier falls through to the next precedence level with a note.
 */
export function resolveModel(options: {
	callTier?: string;
	agentModel?: string;
	agentTier?: string;
	tierConfig?: TierConfig;
	defaultModel?: string;
	catalog: CatalogModel[];
}): ModelResolution {
	const { callTier, agentModel, agentTier, tierConfig, defaultModel, catalog } = options;
	const notes: string[] = [];

	if (isTierLevel(callTier)) {
		const resolved = resolveTier(callTier, tierConfig, defaultModel, catalog, notes);
		if (resolved) return { model: resolved, tierUsed: callTier, note: notes.join("; ") || undefined };
		notes.push(`tier "${callTier}" is not configured; falling back`);
	}
	if (agentModel) return { model: agentModel, note: notes.join("; ") || undefined };
	if (isTierLevel(agentTier)) {
		const resolved = resolveTier(agentTier, tierConfig, defaultModel, catalog, notes);
		if (resolved) return { model: resolved, tierUsed: agentTier, note: notes.join("; ") || undefined };
		notes.push(`tier "${agentTier}" is not configured; falling back`);
	}
	return { model: undefined, note: notes.join("; ") || undefined };
}

function resolveTier(
	level: TierLevel,
	tierConfig: TierConfig | undefined,
	defaultModel: string | undefined,
	catalog: CatalogModel[],
	notes: string[],
): string | undefined {
	if (tierConfig?.[level]) return tierConfig[level];
	if (!tierConfig?.auto) return undefined;
	if (level === "balanced") return defaultModel;
	if (!defaultModel) return undefined;
	const picked = pickAutoTier(level, { defaultModel, catalog });
	if (picked.model) {
		if (picked.collapsed) {
			notes.push(
				`tier "${level}" collapsed to the default model (no ${level === "fast" ? "cheaper" : "pricier"} model in its family)`,
			);
		} else if (picked.outsideFamily) {
			notes.push(`tier "${level}" fell back to the provider's cheapest model outside the default family`);
		}
		return picked.model;
	}
	return undefined;
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the nine new ones.

- [ ] **Step 3.5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(tier): model resolution precedence with fallback notes"
```

---

### Task 4: `tier` key in agent markdown parsing and AgentSummary

**Files:**
- Modify: `core.ts` (`parseAgentMarkdown` + `AgentSummary`)
- Test: `tests/core.test.mjs`

- [ ] **Step 4.1: Write the failing tests**

Append after the existing `parseAgentMarkdown` tests:

```js
test("parseAgentMarkdown parses the tier key when present", () => {
	const agent = parseAgentMarkdown("---\nname: planner\ndescription: plans\ntier: deep\n---\nBody");
	assert.ok(agent);
	assert.equal(agent.tier, "deep");
});

test("parseAgentMarkdown leaves tier undefined when absent and keeps raw invalid values", () => {
	const absent = parseAgentMarkdown("---\nname: a\ndescription: b\n---\n");
	assert.equal(absent.tier, undefined);
	const invalid = parseAgentMarkdown("---\nname: a\ndescription: b\ntier: mega\n---\n");
	assert.equal(invalid.tier, "mega");
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `agent.tier` is `undefined` where `"deep"` is expected (TypeScript compiles fine; `parseAgentMarkdown` simply returns no `tier` key today).

- [ ] **Step 4.3: Implement in core.ts**

Three small edits to `core.ts`:

1. In the `AgentSummary` interface (after `model?: string;`):

```ts
	tier?: string;
```

2. In the `parseAgentMarkdown` doc comment, extend the supported-keys line:

```
 * line): name, description, tools (comma-separated), model, tier. Values may be
```

3. In `parseAgentMarkdown`'s body, after `const model = frontmatter.get("model");`:

```ts
	const tier = frontmatter.get("tier");
```

and in the return object after `model: model || undefined,`:

```ts
		tier: tier || undefined,
```

Also extend the function's return type annotation:

```ts
): { name: string; description: string; tools?: string[]; model?: string; tier?: string; systemPrompt: string } | null {
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 4.5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(tier): parse tier key from agent frontmatter"
```

---

### Task 5: Tier display in usage stats and status reports

**Files:**
- Modify: `core.ts` (`formatUsageStats`, `formatStatusReport`)
- Test: `tests/core.test.mjs`

- [ ] **Step 5.1: Write the failing tests**

Append after the `formatUsageStats` tests:

```js
test("formatUsageStats appends the tier to the model when given", () => {
	assert.ok(formatUsageStats({ turns: 1 }, "claude-opus-4-5", "deep").includes("claude-opus-4-5 (tier: deep)"));
	assert.ok(formatUsageStats({ turns: 1 }, "claude-opus-4-5").includes("claude-opus-4-5"));
	assert.equal(formatUsageStats({ turns: 1 }, undefined, "deep"), "1 turn");
});
```

Append after the `formatStatusReport` tests:

```js
test("formatStatusReport shows the used tier and fallback notes", () => {
	const report = formatStatusReport([
		{
			id: "b",
			agent: "planner",
			status: "completed",
			task: "plan",
			exitCode: 0,
			messages: [],
			usage: { ...emptyUsage(), turns: 2 },
			model: "claude-opus-4-5",
			tierUsed: "deep",
			tierNote: 'tier "deep" collapsed to the default model',
		},
	]);
	assert.ok(report.includes("claude-opus-4-5 (tier: deep)"));
	assert.ok(report.includes('Note: tier "deep" collapsed'));
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — first test: the string `(tier: deep)` is not present; second test: the report has no `Note:` line.

- [ ] **Step 5.3: Implement in core.ts**

1. `formatUsageStats` — add a third parameter and use it when a model is present:

```ts
export function formatUsageStats(
	usage: Partial<UsageStats>,
	model?: string,
	tier?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(tier ? `${model} (tier: ${tier})` : model);
	return parts.join(" ");
}
```

2. `formatStatusReport` — add two fields to its input type and a `Note:` line:

```ts
export function formatStatusReport(
	tasks: Array<{
		id: string;
		agent: string;
		status: "running" | "completed" | "failed" | "aborted";
		task: string;
		exitCode?: number;
		messages: MessageLike[];
		usage: UsageStats;
		model?: string;
		tierUsed?: string;
		tierNote?: string;
		errorMessage?: string;
	}>,
	opts: { maxOutputBytes?: number } = {},
): string {
```

and inside the `else` branch (after the `formatUsageStats` line):

```ts
			const usageStr = formatUsageStats(t.usage, t.model, t.tierUsed);
			if (usageStr) lines.push(usageStr);
			if (t.tierNote) lines.push(`Note: ${t.tierNote}`);
```

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5.5: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(tier): show resolved tier in usage stats and status reports"
```

---

### Task 6: Pass `tier` through agent discovery in agents.ts

**Files:**
- Modify: `agents.ts`

- [ ] **Step 6.1: Implement**

In `discoverUserAgents`, the summary object after `model: parsed.model,` gains one line:

```ts
			tier: parsed.tier,
```

- [ ] **Step 6.2: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output.

- [ ] **Step 6.3: Commit**

```bash
git add agents.ts
git commit -m "feat(tier): expose tier on discovered agent summaries"
```

---

### Task 7: Wire resolution into index.ts (settings, catalog snapshot, spawnTask, runChain, execute)

**Files:**
- Modify: `index.ts`

- [ ] **Step 7.1: Extend imports**

Change the pi-coding-agent import line to:

```ts
import { getSettingsPath, type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
```

Add a type-only pi-ai import after it:

```ts
import type { Model } from "@earendil-works/pi-ai";
```

Extend the `./core.ts` import list with `normalizeTierConfig`, `resolveModel`, `type CatalogModel`, `type TierConfig`:

```ts
import {
	applyEventLine,
	buildChildArgs,
	displayAgentName,
	formatCompletionNotification,
	formatElapsed,
	formatStatusReport,
	formatUsageStats,
	getFinalOutput,
	getResultOutput,
	isFailedState,
	normalizeTierConfig,
	resolveAgent,
	resolveModel,
	shouldNotify,
	truncateOutput,
	type AgentSummary,
	type CatalogModel,
	type MessageLike,
	type TierConfig,
	type UsageStats,
} from "./core.ts";
```

- [ ] **Step 7.2: Add tier fields to Task and TaskInfo**

In `interface Task` (after `model?: string;`):

```ts
	tierUsed?: string;
	tierNote?: string;
```

In `interface TaskInfo` (after `model?: string;`):

```ts
	tierUsed?: string;
	tierNote?: string;
```

In `toTaskInfo` (after `model: t.model,`):

```ts
		tierUsed: t.tierUsed,
		tierNote: t.tierNote,
```

- [ ] **Step 7.3: Add the ModelContext interface and builders**

Insert after the `TaskInfo`/`ToolDetails` interfaces (before the "Registry" section):

```ts
// ── Model tier context ───────────────────────────────────────────────────────

/** Per-tool-call snapshot of tier config, default model, and catalog models. */
interface ModelContext {
	tierConfig?: TierConfig;
	defaultModel?: string;
	catalog: CatalogModel[];
}

/** Read `subagent.modelTiers` and `defaultModel` from the user's settings.json. */
function readSettingsFile(): { tierConfig?: TierConfig; defaultModel?: string } {
	let raw: string;
	try {
		raw = fs.readFileSync(getSettingsPath(), "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const settings = parsed as Record<string, unknown>;
	const subagent = settings.subagent;
	const modelTiers =
		subagent && typeof subagent === "object" && !Array.isArray(subagent)
			? (subagent as Record<string, unknown>).modelTiers
			: undefined;
	return {
		tierConfig: normalizeTierConfig(modelTiers),
		defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
	};
}

/** Build the model context for one tool call from the extension context. */
function buildModelContext(ctx: ExtensionContext): ModelContext {
	const settings = readSettingsFile();
	const scopedIds = new Set(ctx.scopedModels.map((s) => s.model.id));
	const catalog: CatalogModel[] = ctx.modelRegistry
		.getAvailable()
		.filter((m) => scopedIds.size === 0 || scopedIds.has(m.id))
		.map((m) => ({ id: m.id, provider: m.provider, inputCost: m.cost.input }));
	return {
		tierConfig: settings.tierConfig,
		defaultModel: settings.defaultModel ?? ctx.model?.id,
		catalog,
	};
}
```

- [ ] **Step 7.4: Resolve the model in spawnTask**

Replace the `spawnTask` signature and its task-construction + `buildChildArgs` call. Old signature:

```ts
async function spawnTask(agent: AgentSummary, taskText: string, cwd: string, jobId: string, step?: number): Promise<Task> {
	const task: Task = {
		id: randomUUID(),
		jobId,
		agent: agent.name,
		agentSource: agent.source,
		task: taskText,
		cwd,
		status: "running",
		startedAt: Date.now(),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};
```

New:

```ts
async function spawnTask(
	agent: AgentSummary,
	taskText: string,
	cwd: string,
	jobId: string,
	options: { step?: number; tier?: string; modelCtx: ModelContext },
): Promise<Task> {
	const resolution = resolveModel({
		callTier: options.tier,
		agentModel: agent.model,
		agentTier: agent.tier,
		tierConfig: options.modelCtx.tierConfig,
		defaultModel: options.modelCtx.defaultModel,
		catalog: options.modelCtx.catalog,
	});
	const task: Task = {
		id: randomUUID(),
		jobId,
		agent: agent.name,
		agentSource: agent.source,
		task: taskText,
		cwd,
		status: "running",
		startedAt: Date.now(),
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: resolution.model,
		tierUsed: resolution.tierUsed,
		tierNote: resolution.note,
		step: options.step,
	};
```

And inside the same function, change:

```ts
		const args = buildChildArgs({ model: agent.model, tools: agent.tools, systemPromptFile, task: taskText });
```

to:

```ts
		const args = buildChildArgs({ model: resolution.model, tools: agent.tools, systemPromptFile, task: taskText });
```

- [ ] **Step 7.5: Thread modelCtx and tier through runChain**

Change the chain item type and signature:

```ts
function runChain(
	job: Job,
	chain: Array<{ agent?: string; task: string; cwd?: string; tier?: string }>,
	agents: AgentSummary[],
	defaultCwd: string,
	modelCtx: ModelContext,
	signal?: AbortSignal,
) {
```

and the spawnTask call inside it:

```ts
			const task = await spawnTask(agent, step.task.replace(/\{previous\}/g, previousOutput), step.cwd ?? defaultCwd, job.id, {
				step: i + 1,
				tier: step.tier,
				modelCtx,
			});
```

- [ ] **Step 7.6: Update execute() call sites**

In `execute`, right after `const agents = discoverUserAgents();` add:

```ts
			const modelCtx = buildModelContext(ctx);
```

Chain mode — change:

```ts
				runChain(job, params.chain!, agents, params.cwd ?? ctx.cwd, wait ? signal : undefined);
```

to:

```ts
				runChain(job, params.chain!, agents, params.cwd ?? ctx.cwd, modelCtx, wait ? signal : undefined);
```

Parallel mode (both call sites) — change:

```ts
						const task = await spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id);
```

to:

```ts
						const task = await spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, modelCtx });
```

and:

```ts
					void spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id);
```

to:

```ts
					void spawnTask(agent, t.task, t.cwd ?? ctx.cwd, job.id, { tier: t.tier, modelCtx });
```

Single mode — change:

```ts
			const task = await spawnTask(agent, params.task ?? "", params.cwd ?? ctx.cwd, job.id);
```

to:

```ts
			const task = await spawnTask(agent, params.task ?? "", params.cwd ?? ctx.cwd, job.id, { tier: params.tier, modelCtx });
```

Note: `params.tier` does not exist yet on the schemas — Task 8 adds it. To keep this task typecheckable, add the schema fields in this task too (or run typecheck only after Task 8; prefer adding schemas here). Add to `TaskItem`, `ChainItem`, and the top-level `parameters` object:

```ts
		tier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("balanced"), Type.Literal("deep")], { description: "Model tier for this task: fast (small/cheap model), balanced (default model), deep (large/capable model). Resolved via subagent.modelTiers in settings.json; unmapped tiers fall back to the agent's model/tier, then the parent's default model." })),
```

(with `this task` replaced by `the subagent (single mode)` in the top-level parameters entry).

- [ ] **Step 7.7: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output. If typebox `Type.Union`/`Type.Literal` are not available on the imported `Type`, import them explicitly: `import { Type, type Static } from "typebox";` is not needed — `Type.Union` and `Type.Literal` are standard typebox exports; verify with `grep "Union" node_modules/typebox/dist/*.d.ts`.

- [ ] **Step 7.8: Run the unit tests (no regression)**

Run: `npm test`
Expected: PASS — core.ts behavior unchanged.

- [ ] **Step 7.9: Commit**

```bash
git add index.ts
git commit -m "feat(tier): resolve tiers per task from settings and the model registry"
```

---

### Task 8: Report tiers in subagent_agents and the single-mode usage line

**Files:**
- Modify: `index.ts`

- [ ] **Step 8.1: List tier in subagent_agents**

In the `subagent_agents` tool's `execute`, after `if (a.model) parts.push(\`  - model: ${a.model}\`);` add:

```ts
				if (a.tier) parts.push(`  - tier: ${a.tier}`);
```

Update its `description` string to include `tier` in the frontmatter key list:

```ts
		description: `List available subagent definitions from ${getUserAgentsDir()}. Each is a markdown file with YAML frontmatter (name, description, tools, model, tier) and a system prompt body.`,
```

Also update the `subagent` tool's description line:

```ts
			`Agent definitions live in ${getUserAgentsDir()} (*.md with YAML frontmatter: name, description, tools, model, tier).`,
```

- [ ] **Step 8.2: Show model/tier in the single-mode usage line**

In `renderResult`, the final aggregated usage line (the occurrence whose next line is `if (usageStr && details.tasks.every((t) => t.status !== "running")) {`) changes from:

```ts
			const usageStr = formatUsageStats(usageAgg);
```

to:

```ts
			const usageStr = formatUsageStats(
				usageAgg,
				details.mode === "single" ? details.tasks[0]?.model : undefined,
				details.mode === "single" ? details.tasks[0]?.tierUsed : undefined,
			);
```

- [ ] **Step 8.3: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output.

- [ ] **Step 8.4: Commit**

```bash
git add index.ts
git commit -m "feat(tier): list agent tiers and show resolved model in single results"
```

---

### Task 9: Documentation (README.md, AGENTS.md)

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 9.1: Update the agent definitions section of README.md**

Update the frontmatter example block to include `tier`, and the bullet list below it:

````markdown
```markdown
---
name: scout
description: Fast recon agent, read-only
tools: read, grep, find, ls, bash
model: claude-haiku-4-5
tier: fast
---

You are a scout agent. Find information quickly and report it compactly.
```
````

- `name` and `description` are required; `tools` (comma-separated), `model`,
  and `tier` (`fast` | `balanced` | `deep`) are optional. Omit `tools` for the
  full default toolset.
- If both `model` and `tier` are set, `model` wins (a concrete pin beats an
  abstract tier). A call-time `tier` parameter beats both.

- [ ] **Step 9.2: Add the "Model tiers" section to README.md**

Insert after the "Agent definitions" section:

````markdown
## Model tiers

`tier: fast | balanced | deep` declares how much capability a task needs
instead of which model to use. Tiers resolve to concrete models at spawn time
through a central mapping in pi's `settings.json`:

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

- Declare a tier in an agent file (`tier: deep` in frontmatter) and/or pass it
  per call: `subagent { agent: "scout", task: "...", tier: "fast" }` (also
  available per item in `tasks` and `chain`).
- Resolution precedence per task: call-time `tier` → agent `model` → agent
  `tier` → the parent's default model.
- Explicit per-tier values always win; `auto: true` fills only unmapped tiers.
- **Auto-picker:** with `auto: true`, tiers resolve from the model registry
  relative to your `defaultModel`: `balanced` is always your default model;
  `fast` is the cheapest model in the same brand family (e.g. `claude-*` /
  `deepseek-*`); `deep` is the priciest family member, or collapses to your
  default model when nothing bigger exists (it never jumps to another vendor's
  family). `enabledModels` scoping is respected.
- Without any mapping or `auto`, tiers fall back to the parent's default model
  (the same behavior as today when no `--model` is passed).
- Resolved models are reported in results, e.g.
  `model: claude-opus-4-5 (tier: deep)`, with a `Note:` line when a tier fell
  back or collapsed.
````

- [ ] **Step 9.3: Update AGENTS.md conventions**

In the "Key conventions" section of `AGENTS.md`, change the agent-files bullet:

```
- Agent files: YAML frontmatter (`name`, `description` required; `tools`,
  `model`, `tier` optional) + markdown system prompt body. `tier` is
  `fast | balanced | deep`, resolved via `subagent.modelTiers` in pi's
  settings.json.
```

- [ ] **Step 9.4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document model tiers (config, precedence, auto-picker)"
```

---

### Task 10: Full verification

**Files:** none

- [ ] **Step 10.1: Run the unit test suite**

Run: `npm test`
Expected: PASS, `tests` count includes all tier tests added in Tasks 1–5.

- [ ] **Step 10.2: Run the typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output.

- [ ] **Step 10.3: Manual smoke test (interactive pi)**

1. In a pi session with this extension installed (symlinked dev copy), create
   a test agent:

   ```bash
   mkdir -p ~/.pi/agent/agents
   cat > ~/.pi/agent/agents/tiercheck.md <<'EOF'
   ---
   name: tiercheck
   description: Reports which model ran
   tier: deep
   ---
   You are a tier check agent. Just answer with one short sentence.
   EOF
   ```

2. Run `/reload`, then call `subagent { agent: "tiercheck", task: "Say hi", wait: true }`.
   Expected: without any `subagent.modelTiers` config the task runs on the
   parent's default model; status output shows no tier note.
3. Add `"subagent": { "modelTiers": { "auto": true } }` to
   `~/.pi/agent/settings.json`, `/reload`, call again with
   `tier: "fast"` — verify via the TUI result line (Ctrl+O) or
   `subagent_status` that the resolved model matches the auto-picker choice
   for your `defaultModel` (for `defaultModel: deepseek-v4-pro`:
   fast → `deepseek-v4-flash`, balanced → `deepseek-v4-pro`,
   deep → `deepseek-v4-pro` with a collapse note).
4. Call with an explicit mapping (e.g. `"deep": "some-other-model"`) and
   verify the explicit value wins over `auto`.
5. Remove the `subagent` key from settings.json when done (or keep it if
   desired).

- [ ] **Step 10.4: Final review of the diff**

Run: `git diff HEAD~9 --stat` and skim the full diff for leftovers, debug
code, or unrelated changes.

- [ ] **Step 10.5: Commit any smoke-test fixes**

If the smoke test surfaced fixes, commit them; otherwise nothing to commit.

---

## Self-review notes (run by plan author)

- **Spec coverage:** config schema (Tasks 1, 7), frontmatter + tool-schema declaration points (Tasks 4, 7), precedence (Task 3), auto-picker family rules (Task 2), reporting (Tasks 5, 8), docs (Task 9), tests (Tasks 1–5), non-goals respected (no thinking-level steering, no hardcoded provider tables).
- **Placeholders:** none — every step contains exact code or exact commands.
- **Type consistency:** `TierConfig`, `CatalogModel`, `ModelResolution`, `AutoPick`, `TierLevel` defined once in core.ts (Tasks 1–3) and referenced identically in index.ts (Task 7). `tierUsed`/`tierNote` field names match between Task, TaskInfo, formatStatusReport input type, and renderResult usage. `spawnTask` options signature `{ step?, tier?, modelCtx }` matches all four call sites (runChain + 3 in execute). `runChain`'s `modelCtx` parameter is passed before the optional `signal`.
