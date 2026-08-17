/**
 * tools/subagent-agents.ts — The `subagent_agents` tool.
 *
 * Lists available agent definitions (user files + the built-in default).
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverUserAgents, getUserAgentsDir } from "../agents.ts";
import type { ToolDetails } from "../runtime.ts";

const subagentAgentsParams = Type.Object({});

export const subagentAgentsTool = defineTool<typeof subagentAgentsParams, ToolDetails>({
	name: "subagent_agents",
	label: "Subagent Agents",
	description: `List available subagent definitions from ${getUserAgentsDir()}. Each is a markdown file with YAML frontmatter (name, description, tools, tier, extensions) and a system prompt body.`,
	promptSnippet: "List available subagent definitions",
	parameters: subagentAgentsParams,

	async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
		const agents = discoverUserAgents();
		const lines = agents.map((a) => {
			const parts = [`- **${a.name}** — ${a.description}`];
			if (a.tools) parts.push(`  - tools: ${a.tools.join(", ")}`);
			if (a.extensions) parts.push(`  - extensions: ${a.extensions.join(", ")}`);
			if (a.tier) parts.push(`  - tier: ${a.tier}`);
			return parts.join("\n");
		});
		const text = [
			`Available agents (${agents.length}):`,
			...lines,
			"",
			`Agent files: ${getUserAgentsDir()}`,
			"Raw prompts: call subagent with just {task} to use the built-in default agent.",
		].join("\n");
		return {
			content: [{ type: "text", text }],
			details: { mode: "collect" as const, jobIds: [], tasks: [] },
		};
	},

	renderCall(_args, theme, _context) {
		return new Text(theme.fg("toolTitle", theme.bold("subagent_agents ")) + theme.fg("muted", "(list)"), 0, 0);
	},
});
