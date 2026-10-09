import type { MuxBackend } from "./mux-adapter.ts";
import { readSettingsJson, updateSettingsJson, type WriteSettingsResult } from "./settings.ts";

export type MuxOptions = { enabled: boolean; viewers: boolean };
export type MuxSettings = Record<MuxBackend, MuxOptions>;

function normalizeMuxOptions(raw: unknown): MuxOptions {
	const options = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	return {
		enabled: typeof options.enabled === "boolean" ? options.enabled : true,
		viewers: typeof options.viewers === "boolean" ? options.viewers : true,
	};
}

function normalizeSubagent(settings: Record<string, unknown> | undefined): Record<string, unknown> {
	const subagent = settings?.subagent;
	return subagent && typeof subagent === "object" && !Array.isArray(subagent)
		? subagent as Record<string, unknown>
		: {};
}

export function readMuxSettings(settingsPath: string): MuxSettings {
	const subagent = normalizeSubagent(readSettingsJson(settingsPath));
	return {
		herdr: normalizeMuxOptions(subagent.herdr),
		tmux: normalizeMuxOptions(subagent.tmux),
	};
}

export function writeMuxOptions(settingsPath: string, backend: MuxBackend, options: MuxOptions): WriteSettingsResult {
	return updateSettingsJson(settingsPath, (settings) => {
		const subagent = normalizeSubagent(settings);
		const current = subagent[backend];
		const target = current && typeof current === "object" && !Array.isArray(current)
			? current as Record<string, unknown>
			: {};
		target.enabled = options.enabled;
		target.viewers = options.viewers;
		subagent[backend] = target;
		settings.subagent = subagent;
	});
}
