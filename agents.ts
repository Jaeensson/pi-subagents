/**
 * agents.ts — Discovery and default seeding of agent markdown files.
 *
 * Agents live in `~/.pi/agent/agents/*.md` (via `getAgentDir()`), the same
 * convention as pi's own user-level resource directories. The package bundles
 * default agents in `agents/*.md` (scout, researcher, worker) that are seeded
 * into the user directory on load when missing — user files always win.
 *
 *   ---
 *   name: scout
 *   description: Fast codebase recon
 *   tools: read, grep, find, ls, bash
 *   tier: fast
 *   ---
 *   <system prompt body>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentMarkdown, planAgentSeeds, type AgentSummary } from "./core.ts";

/** Directory containing user agent definitions: `~/.pi/agent/agents`. */
export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

/** Directory bundled with the package containing default agent files. */
export function getBundledAgentsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
}

/** Names of valid bundled agent files (*.md), sorted. */
export function listBundledAgents(): string[] {
	const dir = getBundledAgentsDir();
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name.slice(0, -3))
		.sort();
}

/**
 * Copy bundled default agents into the user agent dir when missing.
 * Idempotent: existing user agents are never overwritten. Returns the
 * names of freshly seeded agents.
 */
export function seedBundledAgents(): string[] {
	const bundledDir = getBundledAgentsDir();
	const bundled = listBundledAgents();
	if (bundled.length === 0) return [];

	const userDir = getUserAgentsDir();
	const missing = planAgentSeeds(
		bundled,
		discoverUserAgents().map((a) => a.name),
	);
	if (missing.length === 0) return [];

	fs.mkdirSync(userDir, { recursive: true });
	const seeded: string[] = [];
	for (const name of missing) {
		try {
			fs.copyFileSync(path.join(bundledDir, `${name}.md`), path.join(userDir, `${name}.md`));
			seeded.push(name);
		} catch {
			/* ignore: read-only user dir or missing file */
		}
	}
	return seeded;
}

/** Discover all valid user agents, sorted by name. */
export function discoverUserAgents(): AgentSummary[] {
	const dir = getUserAgentsDir();
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentSummary[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const parsed = parseAgentMarkdown(content);
		if (!parsed) continue;

		agents.push({
			name: parsed.name,
			description: parsed.description,
			tools: parsed.tools,
			tier: parsed.tier,
			extensions: parsed.extensions,
			systemPrompt: parsed.systemPrompt,
			source: "user",
			filePath,
		});
	}

	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/** Format the agent list for LLM-visible output (names + descriptions). */
export function formatAgentList(agents: AgentSummary[], maxItems = 12): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
