import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModelContext } from "../jobs.ts";

test("buildModelContext preserves provider identity, settings default precedence, and scoped catalog pairs", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-model-context-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "provider-b",
			defaultModel: "shared/model",
			subagent: { modelTiers: { auto: true } },
		}));
		const sharedModel = (provider, id) => ({ provider, id, cost: { input: 1 }, contextWindow: 1000 });
		const ctx = {
			model: sharedModel("provider-a", "parent-default"),
			scopedModels: [{ model: sharedModel("provider-b", "shared/model") }],
			modelRegistry: { getAvailable: () => [
				sharedModel("provider-a", "shared/model"),
				sharedModel("provider-b", "shared/model"),
				sharedModel("provider-b", "other-model"),
			] },
		};
		assert.deepEqual(buildModelContext(ctx), {
			tierConfig: { auto: true },
			defaultModel: "provider-b/shared/model",
			catalog: [{ id: "shared/model", provider: "provider-b", inputCost: 1, contextWindow: 1000 }],
		});
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("buildModelContext qualifies the current model when no user default exists", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-model-context-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const model = { provider: "parent-provider", id: "parent-model", cost: { input: 1 }, contextWindow: 1000 };
		const context = buildModelContext({ model, scopedModels: [], modelRegistry: { getAvailable: () => [model] } });
		assert.equal(context.defaultModel, "parent-provider/parent-model");
		assert.equal(context.catalog.length, 1);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
