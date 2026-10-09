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
 * re-read per subagent tool call, so changes take effect at once). Herdr switches
 * persist independently via mux-settings.ts before notifying the entry controller.
 *
 * Depends on core.ts (pure), jobs.ts and mux-settings.ts (settings IO), not monitoring.
 */

import path from "node:path";
import {
	DynamicBorder,
	getAgentDir,
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
	Key,
	matchesKey,
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
	resolveModel,
	type TierConfig,
	type TierConfigChange,
	type TierLevel,
} from "./core.ts";
import { buildModelContext, writeModelTiers } from "./jobs.ts";
import { readMuxSettings, writeMuxOptions, type MuxOptions } from "./mux-settings.ts";

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
/** ctrl+alt+l — clear the highlighted tier's model from the main menu. */
const CLEAR_TIER = Key.ctrlAlt("l");

/**
 * Search-driven model picker: type to fuzzy-filter the catalog, arrows to
 * navigate (SelectList scrolls), enter to select, esc to cancel. Clearing
 * lives in the main menu (ctrl+alt+l on the highlighted tier row).
 * `onDone(id)` sets, `onDone()` cancels without changes.
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
			theme.fg("dim", "type to search · ↑↓ navigate · enter select · esc back"),
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
const HERDR_ENABLED_ID = "herdr-enabled";
const HERDR_VIEWERS_ID = "herdr-viewers";
const MENU_VISIBLE_ROWS = 10;
const isTierId = (id: string): id is TierLevel => (TIER_LEVELS as readonly string[]).includes(id);

async function runDialog(ctx: ExtensionCommandContext, onHerdrOptionsChange?: (next: MuxOptions) => void): Promise<void> {
	const ui = ctx.ui;
	const modelContext = buildModelContext(ctx);
	let config = modelContext.tierConfig;
	const settingsPath = path.join(getAgentDir(), "settings.json");
	let herdr = readMuxSettings(settingsPath).herdr;
	const options = catalogOptions(ctx);

	const explicitTiers = () => TIER_LEVELS.filter((l) => config?.[l]).map((l) => `${l}: ${config?.[l]}`);

	await ui.custom<boolean>((_tui, theme, _kb, done) => {
		const tui = _tui;
		const container = new Container();
		const listHost = new Container();
		const previewHost = new Container();
		// Mirror of the SettingsList highlight (its selectedIndex is private);
		// kept in sync by intercepting main-menu up/down with the same wrap semantics.
		let selectedIndex = 0;
		let submenuOpen = false;
		const rowIds = () => [AUTO_ID, ...(config?.auto === true ? [] : TIER_LEVELS), HERDR_ENABLED_ID, HERDR_VIEWERS_ID];
		const itemCount = () => rowIds().length;
		const selectedId = () => rowIds()[selectedIndex];

		// A rebuilt SettingsList starts with its cursor on row 0. Re-apply the
		// mirrored highlight by feeding the fresh list down-arrows (public API
		// only — there is no cursor setter). This keeps the visible cursor and
		// the ctrl+alt+l clear target in sync across rebuilds.
		const rebuildMenu = () => {
			selectedIndex = Math.min(selectedIndex, itemCount() - 1);
			const list = buildSettingsList();
			for (let i = 0; i < selectedIndex; i++) list.handleInput("\x1b[B"); // down
			listHost.clear();
			listHost.addChild(list);
		};

		const rebuildPreview = () => {
			previewHost.clear();
			for (const level of TIER_LEVELS) {
				const explicit = config?.[level];
				const resolution = resolveModel({
					callTier: level,
					tierConfig: config,
					defaultModel: modelContext.defaultModel,
					catalog: modelContext.catalog,
				});
				const model = resolution.model ?? modelContext.defaultModel;
				let source = "default";
				if (explicit) source = "explicit";
				else if (config?.auto) source = resolution.model ? "auto" : "auto → default fallback";
				const assignment = model ?? "parent default (unknown)";
				const note = resolution.note ? ` — ${resolution.note}` : "";
				previewHost.addChild(new Text(
					theme.fg("dim", `  ${level.padEnd(8)} ${assignment}  (${source})${note}`),
					1,
					0,
				));
			}
		};

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
							description: `Explicit model for "${level}" tasks · enter: pick model · ctrl+alt+l: clear`,
							submenu: (_current, submenuDone) =>
								new ModelPickerComponent(tui, theme, level, config?.[level] ?? "auto", options, (value) => {
									submenuOpen = false;
									submenuDone(value);
								}),
						}))),
				{
					id: HERDR_ENABLED_ID, label: "Herdr monitoring",
					currentValue: herdr.enabled ? "on" : "off", values: ["on", "off"],
					description: "Display subagent activity in Herdr; only active inside a Herdr session",
				},
				{
					id: HERDR_VIEWERS_ID, label: "Herdr viewers",
					currentValue: herdr.viewers ? "on" : "off", values: ["on", "off"],
					description: herdr.enabled
						? "Show live traces in owned viewer panes; disabling viewers leaves monitoring active"
						: "Inactive while Herdr monitoring is disabled; the viewer preference is retained",
				},
			];
			return new SettingsList(items, MENU_VISIBLE_ROWS, getSettingsListTheme(), (id, value) => {
				if (id === HERDR_ENABLED_ID || id === HERDR_VIEWERS_ID) {
					const next = { ...herdr, [id === HERDR_ENABLED_ID ? "enabled" : "viewers"]: value === "on" };
					const result = writeMuxOptions(settingsPath, "herdr", next);
					if (!result.ok) {
						ui.notify(`Could not save settings: ${result.error}`, "error");
						// SettingsList mutates its row before calling us; restore active values.
						rebuildMenu();
						done(true);
						return;
					}
					herdr = next;
					try { onHerdrOptionsChange?.(next); }
					catch { ui.notify("Herdr monitoring could not apply saved settings.", "warning"); }
					rebuildMenu();
					tui.requestRender();
					return;
				}
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
				if (id === AUTO_ID) rebuildMenu();
				rebuildPreview();
				tui.requestRender();
			}, () => done(true));
		};

		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Subagent model tiers (saved to settings.json)")), 1, 0));
		container.addChild(new Text(theme.fg("dim", "ctrl+alt+l: clear the highlighted tier's model"), 1, 0));
		listHost.addChild(buildSettingsList());
		container.addChild(listHost);
		container.addChild(new Text(theme.fg("accent", theme.bold("Effective assignments")), 1, 0));
		rebuildPreview();
		container.addChild(previewHost);
		container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (!submenuOpen && matchesKey(data, CLEAR_TIER)) {
					const id = selectedId();
					const level = isTierId(id) ? id : undefined;
					if (!level) {
						ui.notify("Highlight a tier row (fast/balanced/deep) to clear it.", "info");
					} else {
						const next = applyChange(config, { kind: "tier", level, model: undefined }, ui);
						if (next === null) {
							done(true);
							return;
						}
						config = next;
						// Refresh the row so the tier shows "auto" again, keeping the
						// cursor on the same (now cleared) tier row.
						rebuildMenu();
						rebuildPreview();
					}
					tui.requestRender();
					return;
				}
				const kb = getKeybindings();
				if (submenuOpen) {
					// SettingsList owns submenu navigation. Its arrows must never alter
					// the main-menu highlight used by ctrl+alt+l.
					listHost.children[0]?.handleInput?.(data);
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.up")) {
					selectedIndex = selectedIndex === 0 ? itemCount() - 1 : selectedIndex - 1;
				} else if (kb.matches(data, "tui.select.down")) {
					selectedIndex = selectedIndex === itemCount() - 1 ? 0 : selectedIndex + 1;
				} else if (kb.matches(data, "tui.select.confirm") && isTierId(selectedId())) {
					submenuOpen = true;
				}
				listHost.children[0]?.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

// ── Registration ─────────────────────────────────────────────────────────────

/** Register the `/subagents` settings command. */
export function registerSubagentsCommand(pi: ExtensionAPI, onHerdrOptionsChange?: (next: MuxOptions) => void): void {
	pi.registerCommand("subagents", {
		description: "Subagent settings (model tiers + Herdr monitoring and viewers)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				process.stderr.write("/subagents requires TUI mode; its settings dialog is terminal-only.\n");
				return;
			}
			await runDialog(ctx, onHerdrOptionsChange);
		},
	});
}
