import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

export type WriteSettingsResult = { ok: true } | { ok: false; error: string };

export function readSettingsJson(settingsPath: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	return parsed as Record<string, unknown>;
}

export function updateSettingsJson(
	settingsPath: string,
	mutate: (root: Record<string, unknown>) => void,
): WriteSettingsResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch (err) {
		return {
			ok: false,
			error: `settings.json is unreadable (${err instanceof Error ? err.message : String(err)}); not overwriting`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, error: "settings.json is not a JSON object; not overwriting" };
	}

	const root = parsed as Record<string, unknown>;
	try {
		mutate(root);
	} catch (err) {
		return { ok: false, error: `failed to update settings.json: ${err instanceof Error ? err.message : String(err)}` };
	}

	const tmp = `${settingsPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, settingsPath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// No temporary file was created, or cleanup is not possible.
		}
		return { ok: false, error: `failed to write settings.json: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { ok: true };
}
