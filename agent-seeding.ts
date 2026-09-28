import * as fs from "node:fs";
import * as path from "node:path";

/** Best-effort seeding; existing destinations always win, including invalid files. */
export function seedBundledAgentFiles(bundledDir: string, userDir: string, names: string[]): string[] {
	try {
		fs.mkdirSync(userDir, { recursive: true });
	} catch {
		return [];
	}

	const seeded: string[] = [];
	for (const name of names) {
		try {
			fs.copyFileSync(
				path.join(bundledDir, `${name}.md`),
				path.join(userDir, `${name}.md`),
				fs.constants.COPYFILE_EXCL,
			);
			seeded.push(name);
		} catch {
			/* ignore existing files, read-only dirs, or missing bundled files */
		}
	}
	return seeded;
}
