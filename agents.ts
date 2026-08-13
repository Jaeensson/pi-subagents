/**
 * agents.ts — Discovery of user-defined agent markdown files.
 *
 * Agents live in `~/.pi/agent/agents/*.md` (via `getAgentDir()`), the same
 * convention as pi's own user-level resource directories:
 *
 *   ---
 *   name: scout
 *   description: Fast codebase recon
 *   tools: read, grep, find, ls, bash
 *   model: claude-haiku-4-5
 *   ---
 *   <system prompt body>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentMarkdown, type AgentSummary } from "./core.ts";

/** Directory containing user agent definitions: `~/.pi/agent/agents`. */
export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
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
			model: parsed.model,
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
