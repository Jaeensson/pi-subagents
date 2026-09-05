/**
 * command-subagents.ts — the `/subagents` settings dialog.
 *
 * Two pi-native TUI pieces (tui.md patterns 1 & 3):
 *
 *   - Main menu: a SettingsList in a ctx.ui.custom overlay. Space (or
 *     enter) toggles the global auto tier; per-tier rows open a search
 *     submenu. Tier rows are hidden while auto is on — explicit mappings
 *     still win in resolution, so any existing ones are surfaced in the
 *     auto tier's description.
 *   - Model picker submenu: an Input search box + fuzzy-filtered
 *     SelectList (scrolls, ~8 rows visible). Enter selects, alt+c clears
 *     the tier back to auto, esc cancels.
 *
 * Every change is applied through core.ts's applyTierConfigChange and
 * persisted immediately via jobs.ts's writeModelTiers (settings.json is
 * re-read per subagent tool call, so changes take effect at once).
 *
 * Depends only on core.ts (pure) + jobs.ts (settings IO), like tools/*.
 */

import {
	DynamicBorder,
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	TIER_LEVELS,
	applyTierConfigChange,
	type TierConfig,
	type TierConfigChange,
	type TierLevel,
} from "./core.ts";
import { buildModelContext, writeModelTiers } from "./jobs.ts";

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

// ── Model catalog ────────────────────────────────────────────────────────────

interface ModelOption {
	item: SelectItem;
	model: string;
}

function trimCost(cost: number): string {
	return cost >= 1 ? cost.toFixed(cost % 1 === 0 ? 0 : 1) : cost.toPrecision(2);
}

/** Full model registry as sorted, deduped `provider/id` select items. */
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
		options.push({ item: { value: model, label: `${m.id}  [${m.provider}]${cost}${ctxK}` }, model });
	}
	return options;
}

// ── Model picker submenu ─────────────────────────────────────────────────────

const PICKER_VISIBLE_ROWS = 8;
/** alt+c — clear the tier mapping and close the picker. */
const ALT_C = "\x1bc";

/**
 * Search-driven model picker: type to fuzzy-filter the catalog, arrows to
 * navigate (SelectList scrolls), enter to select, alt+c to clear the tier
 * back to auto, esc to cancel. `onDone("auto")` clears, `onDone(id)` sets,
 * `onDone()` cancels without changes.
 */
class ModelPickerComponent extends Container {
	private readonly tui: TUI;
	private readonly items: SelectItem[];
	private readonly onDone: (value?: string) => void;
	private readonly input = new Input();
	private readonly listHost = new Container();

	constructor(
		tui: TUI,
		theme: Theme,
		level: TierLevel,
		current: string,
		options: ModelOption[],
		onDone: (value?: string) => void,
	) {
		super();
		this.tui = tui;
		this.onDone = onDone;
		this.items = options.map((o) =>
			o.model === current ? { ...o.item, label: `${o.item.label} ✓` } : o.item,
		);

		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Model for tier "${level}" — current: ${current}`)), 1, 0));
		this.addChild(this.input);
		this.addChild(this.listHost);
		this.addChild(new Text(
			theme.fg("dim", "type to search · ↑↓ navigate · enter select · alt+c clear · esc cancel"),
			1,
			0,
		));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		this.rebuildList();
	}

	private rebuildList(): void {
		this.listHost.clear();
		const query = this.input.getValue();
		const filtered = query.trim() === ""
			? this.items
			: fuzzyFilter(this.items, query, (i) => `${i.value} ${i.label}`);
		const list = new SelectList(
			filtered,
			Math.max(Math.min(PICKER_VISIBLE_ROWS, filtered.length), 1),
			getSelectListTheme(),
		);
		list.onSelect = (item) => this.onDone(item.value);
		list.onCancel = () => this.onDone();
		this.listHost.addChild(list);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (data === ALT_C || data === "\x1bC") {
			this.onDone("auto");
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onDone();
			return;
		}
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.confirm")
		) {
			this.listHost.children[0]?.handleInput?.(data);
		} else {
			this.input.handleInput(data);
			this.rebuildList();
		}
		this.tui.requestRender();
	}
}

// ── Main menu ────────────────────────────────────────────────────────────────

const AUTO_ID = "auto";
const MENU_VISIBLE_ROWS = 10;

async function runDialog(ctx: ExtensionCommandContext): Promise<void> {
	const ui = ctx.ui;
	let config = buildModelContext(ctx).tierConfig;
	const options = catalogOptions(ctx);

	const explicitTiers = () => TIER_LEVELS.filter((l) => config?.[l]).map((l) => `${l}: ${config?.[l]}`);

	await ui.custom<boolean>((_tui, theme, _kb, done) => {
		const tui = _tui;
		const container = new Container();
		const listHost = new Container();

		const buildSettingsList = () => {
			const autoOn = config?.auto === true;
			const explicit = explicitTiers();
			const items: SettingItem[] = [
				{
					id: AUTO_ID,
					label: "Auto tier",
					currentValue: autoOn ? "on" : "off",
					values: ["on", "off"],
					description: explicit.length > 0
						? `Pick models automatically — explicit mappings still win: ${explicit.join(", ")}`
						: "Pick fast/balanced/deep models automatically from the default model's family",
				},
				...(autoOn
					? []
					: TIER_LEVELS.map<SettingItem>((level) => ({
							id: level,
							label: level,
							currentValue: config?.[level] ?? "auto",
							description: `Explicit model for "${level}" tasks; auto picks one when unset`,
							submenu: (_current, submenuDone) =>
								new ModelPickerComponent(tui, theme, level, config?.[level] ?? "auto", options, submenuDone),
						}))),
			];
			return new SettingsList(items, MENU_VISIBLE_ROWS, getSettingsListTheme(), (id, value) => {
				const change: TierConfigChange = id === AUTO_ID
					? { kind: "auto", value: value === "on" }
					: { kind: "tier", level: id as TierLevel, model: value === AUTO_ID ? undefined : value };
				const next = applyChange(config, change, ui);
				if (next === null) {
					done(true);
					return;
				}
				config = next;
				// Toggling auto adds/removes the tier rows — rebuild the menu.
				if (id === AUTO_ID) {
					listHost.clear();
					listHost.addChild(buildSettingsList());
				}
				tui.requestRender();
			}, () => done(true));
		};

		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent model tiers (saved to settings.json)")), 1, 0));
		listHost.addChild(buildSettingsList());
		container.addChild(listHost);
		container.addChild(new Text(theme.fg("dim", "enter/space change · esc close"), 1, 0));
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				listHost.children[0]?.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
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
