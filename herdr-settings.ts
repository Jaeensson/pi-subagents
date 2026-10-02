import { readSettingsJson, updateSettingsJson, type WriteSettingsResult } from "./settings.ts";

export type HerdrOptions = { enabled: boolean; viewers: boolean };

export function normalizeHerdrOptions(raw: unknown): HerdrOptions {
	const options = raw && typeof raw === "object" && !Array.isArray(raw)
		? raw as Record<string, unknown>
		: {};
	return {
		enabled: typeof options.enabled === "boolean" ? options.enabled : true,
		viewers: typeof options.viewers === "boolean" ? options.viewers : true,
	};
}

export function readHerdrOptions(settingsPath: string): HerdrOptions {
	const settings = readSettingsJson(settingsPath);
	const subagent = settings?.subagent;
	const subagentObject = subagent && typeof subagent === "object" && !Array.isArray(subagent)
		? subagent as Record<string, unknown>
		: undefined;
	return normalizeHerdrOptions(subagentObject?.herdr);
}

export function writeHerdrOptions(settingsPath: string, next: HerdrOptions): WriteSettingsResult {
	return updateSettingsJson(settingsPath, (settings) => {
		const currentSubagent = settings.subagent;
		const subagent = currentSubagent && typeof currentSubagent === "object" && !Array.isArray(currentSubagent)
			? currentSubagent as Record<string, unknown>
			: {};
		const currentHerdr = subagent.herdr;
		const herdr = currentHerdr && typeof currentHerdr === "object" && !Array.isArray(currentHerdr)
			? currentHerdr as Record<string, unknown>
			: {};
		herdr.enabled = next.enabled;
		herdr.viewers = next.viewers;
		subagent.herdr = herdr;
		settings.subagent = subagent;
	});
}
