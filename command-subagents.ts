/**
 * command-subagents.ts — the `/subagents` settings dialog.
 *
 * An interactive loop of ctx.ui dialogs for editing the extension's
 * `subagent.modelTiers` settings:
 *
 *   - Toggle the global "auto" model tier picker on/off.
 *   - Set/clear explicit per-tier models (fast/balanced/deep) from the
 *     live model registry, a custom id, or a clear entry.
 *
 * Every change is applied through core.ts's applyTierConfigChange and
 * persisted immediately via jobs.ts's writeModelTiers (settings.json is
 * re-read per subagent tool call, so changes take effect at once).
 * When auto is on, the tier pickers are hidden — explicit mappings still
 * win in resolution, so any existing ones are surfaced as a note.
 *
 * Depends only on core.ts (pure) + jobs.ts (settings IO), like tools/*.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	TIER_LEVELS,
	applyTierConfigChange,
	type TierConfig,
	type TierConfigChange,
	type TierLevel,
} from "./core.ts";
import { buildModelContext, writeModelTiers } from "./jobs.ts";

// ── Menu labels ──────────────────────────────────────────────────────────────

/** Current effective value of a tier: explicit id, or "auto" when unset. */
function tierValue(config: TierConfig | undefined, level: TierLevel): string {
	return config?.[level] ?? "auto";
}

function tierMenuLabel(config: TierConfig | undefined, level: TierLevel): string {
	return `  ${level}: ${tierValue(config, level)}`;
}

// ── Applying changes ─────────────────────────────────────────────────────────

/**
 * Apply one change and persist it. Returns the next config on success;
 * returns null on a persistence failure (caller exits) after notifying.
 */
function applyChange(
	config: TierConfig | undefined,
	change: TierConfigChange,
	ui: ExtensionCommandContext["ui"],
): TierConfig | undefined | null {
	const next = applyTierConfigChange(config, change);
	const result = writeModelTiers(next);
	if (!result.ok) {
		ui.notify(`Could not save settings: ${result.error}`, "error");
		return null;
	}
	return next;
}

// ── Model picker ─────────────────────────────────────────────────────────────

interface ModelOption {
	label: string;
	model: string;
}

/** Catalog entries as `provider/id` options, sorted for stable scanning. */
function catalogOptions(ctx: ExtensionCommandContext): ModelOption[] {
	const seen = new Set<string>();
	const options: ModelOption[] = [];
	const models = [...ctx.modelRegistry.getAvailable()].sort(
		(a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
	);
	for (const m of models) {
		const model = `${m.provider}/${m.id}`;
		if (seen.has(model)) continue;
		seen.add(model);
		const cost = m.cost.input > 0 ? ` — $${trimCost(m.cost.input)}/Mtok in` : "";
		const ctxK = m.contextWindow > 0 ? `, ${Math.round(m.contextWindow / 1000)}k ctx` : "";
		options.push({ label: `${model}${cost}${ctxK}`, model });
	}
	return options;
}

function trimCost(cost: number): string {
	return cost >= 1 ? cost.toFixed(cost % 1 === 0 ? 0 : 1) : cost.toPrecision(2);
}

/** Ask for a model for one tier. Returns the applied change, or undefined on cancel. */
async function pickTierModel(
	ctx: ExtensionCommandContext,
	config: TierConfig | undefined,
	level: TierLevel,
): Promise<TierConfigChange | undefined> {
	const ui = ctx.ui;
	const current = tierValue(config, level);
	const options = catalogOptions(ctx);
	const labels = [
		...options.map((o) => o.label),
		"Type custom model id…",
		"Clear (use auto)",
	];
	const choice = await ui.select(`Model for tier "${level}" (current: ${current})`, labels);
	if (choice === undefined) return undefined;
	if (choice === "Clear (use auto)") return { kind: "tier", level, model: undefined };
	if (choice === "Type custom model id…") {
		const custom = await ui.input("Model id (e.g. anthropic/claude-sonnet-4-5):", current === "auto" ? undefined : current);
		if (custom === undefined) return undefined;
		const trimmed = custom.trim();
		if (trimmed === "" || trimmed.toLowerCase() === "auto") {
			ui.notify(`"${custom}" is not a model id — use "Clear (use auto)" instead.`, "warning");
			return undefined;
		}
		if (/\s/.test(trimmed)) {
			ui.notify("Model ids cannot contain whitespace.", "warning");
			return undefined;
		}
		return { kind: "tier", level, model: trimmed };
	}
	const picked = options.find((o) => o.label === choice);
	return picked ? { kind: "tier", level, model: picked.model } : undefined;
}

// ── Main menu loop ───────────────────────────────────────────────────────────

async function runDialog(ctx: ExtensionCommandContext): Promise<void> {
	const ui = ctx.ui;
	let config = buildModelContext(ctx).tierConfig;
	const explicitNote = () => {
		const explicit = TIER_LEVELS.filter((l) => config?.[l]).map((l) => `${l}: ${config?.[l]}`);
		return explicit.length > 0 ? `  (explicit mappings still win: ${explicit.join(", ")})` : undefined;
	};

	while (true) {
		const autoOn = config?.auto === true;
		const options = ["Toggle auto tier: " + (autoOn ? "ON" : "OFF")];
		if (!autoOn) {
			for (const level of TIER_LEVELS) options.push(tierMenuLabel(config, level));
		} else {
			const note = explicitNote();
			if (note) options.push("Note:" + note);
		}
		options.push("Done");

		const choice = await ui.select("Subagent model tiers (saved to settings.json)", options);
		if (choice === undefined || choice === "Done") return;

		if (choice.startsWith("Toggle auto tier:")) {
			const next = applyChange(config, { kind: "auto", value: !autoOn }, ui);
			if (next === null) return;
			config = next;
			continue;
		}
		if (choice.startsWith("Note:")) {
			ui.notify("Explicit tier mappings still take precedence over auto. Turn auto off to edit them.", "info");
			continue;
		}
		const level = TIER_LEVELS.find((l) => choice.startsWith(`  ${l}: `));
		if (level) {
			const change = await pickTierModel(ctx, config, level);
			if (!change) continue;
			const next = applyChange(config, change, ui);
			if (next === null) return;
			config = next;
		}
	}
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Register the `/subagents` settings command. */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("subagents", {
		description: "Subagent model tier settings (auto toggle + per-tier models)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagents needs an interactive UI (unavailable in this mode).", "warning");
				return;
			}
			await runDialog(ctx);
		},
	});
}
