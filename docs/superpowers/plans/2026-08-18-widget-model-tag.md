# Show Subagent Model in Status Widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display each running subagent's model as a dim `[model]` tag next to its name in the persistent TUI status widget.

**Architecture:** A pure helper `formatModelTag(model)` is added to `core.ts` (the only unit-tested module — it stays free of pi imports). The widget renderer in `tui.ts` calls it per running task, reading the already-populated `Task.model` field; no plumbing changes to `runtime.ts`/`process.ts`/`jobs.ts`.

**Tech Stack:** TypeScript (erasable syntax only in `core.ts`), Node's built-in test runner (`node --test`), pi extension TUI (`@earendil-works/pi-tui`).

**Spec:** `docs/superpowers/specs/2026-08-18-widget-model-tag-design.md`

---

### Task 1: Add `formatModelTag` to core.ts (TDD)

**Files:**
- Modify: `core.ts` — add helper in the "Formatting" section (near `formatTokens`/`formatElapsed`, ~line 420)
- Test: `tests/core.test.mjs` — add import + 3 tests

Behavior (from spec):
- `undefined` → `""`
- id ≤ 32 chars → `[<id>]` (unchanged)
- id > 32 chars → `[<first 31 chars>…]` (tag is still 32 display chars total)

- [ ] **Step 1: Add `formatModelTag` to the import block in `tests/core.test.mjs`**

The import block currently ends with `pickAutoTier,`. Add `formatModelTag,` after `formatElapsed,`:

```js
	formatElapsed,
	formatModelTag,
	formatTokens,
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/core.test.mjs` (after the last `test(...)` block):

```js
test("formatModelTag returns empty string when model is unknown", () => {
	assert.equal(formatModelTag(undefined), "");
});

test("formatModelTag wraps short model ids in brackets", () => {
	assert.equal(formatModelTag("claude-sonnet-4-5"), "[claude-sonnet-4-5]");
});

test("formatModelTag keeps a 32-char model id intact", () => {
	const model = "opencode-go/deepseek-v4-pro:high"; // exactly 32 chars
	assert.equal(model.length, 32);
	assert.equal(formatModelTag(model), "[opencode-go/deepseek-v4-pro:high]");
});

test("formatModelTag truncates model ids longer than 32 chars", () => {
	const model = "opencode-go/deepseek-v4-flash-ultra:long"; // 40 chars
	assert.equal(formatModelTag(model), "[opencode-go/deepseek-v4-flash-ul…]");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `ReferenceError: formatModelTag is not defined` (or similar), 4 failing tests.

- [ ] **Step 4: Add the helper to `core.ts`**

Insert into the `// ── Formatting ────` section of `core.ts`, right after the `formatElapsed` function (or next to it):

```ts
const MODEL_TAG_MAX = 32;

/** Format a model id for the status widget; "" when the model is not yet known. Long ids are truncated with an ellipsis. */
export function formatModelTag(model: string | undefined): string {
	if (!model) return "";
	if (model.length <= MODEL_TAG_MAX) return `[${model}]`;
	return `[${model.slice(0, MODEL_TAG_MAX - 1)}…]`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests green, including the 4 new ones.

- [ ] **Step 6: Commit**

```bash
git add core.ts tests/core.test.mjs
git commit -m "feat(widget): add formatModelTag helper for status widget"
```

---

### Task 2: Render the model tag in the status widget

**Files:**
- Modify: `tui.ts` — import + `runningTaskLines`

The widget line currently renders as:
`  ▸ scout  12s → bash: npm test` (agent accent-colored, elapsed dim).

New format, model tag dim-styled between agent name and elapsed time:
`  ▸ scout [claude-sonnet-4-5] 12s → bash: npm test`

- [ ] **Step 1: Import `formatModelTag` in `tui.ts`**

Change the existing import:

```ts
import { formatElapsed, type MessageLike } from "./core.ts";
```

to:

```ts
import { formatElapsed, formatModelTag, type MessageLike } from "./core.ts";
```

- [ ] **Step 2: Emit the tag in `runningTaskLines`**

Find in `runningTaskLines` (inside the `for (const t of running)` loop):

```ts
		lines.push(`  ${theme.fg("warning", "▸")} ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${elapsed}`)}${step}  ${lastActivity(t, theme)}`);
```

Replace with:

```ts
		const modelTag = formatModelTag(t.model);
		const modelText = modelTag ? ` ${theme.fg("dim", modelTag)}` : "";
		lines.push(`  ${theme.fg("warning", "▸")} ${theme.fg("accent", t.agent)}${modelText}${theme.fg("dim", ` ${elapsed}`)}${step}  ${lastActivity(t, theme)}`);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add tui.ts
git commit -m "feat(widget): show subagent model in status widget"
```

---

### Task 3: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests green.

- [ ] **Step 2: Typecheck again**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Confirm spec compliance**

Check the final `runningTaskLines` line against the spec:
- model tag right after agent name ✓
- tag absent while `t.model` is undefined ✓ (empty string → no tag)
- long ids truncated with `…` ✓ (via `formatModelTag`)
- dim styling ✓ (`theme.fg("dim", ...)`)
- only the widget touched; `formatStatusReport`/notifications unchanged ✓

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short
git add -A
git commit -m "chore(widget): final verification"   # only if there are uncommitted changes
```
