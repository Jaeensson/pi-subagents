import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { subagentTool } from "../tools/subagent.ts";

/**
 * Regression test: the subagent tool's serialized parameters schema must be
 * strict-validator compatible — type: "object" at the top level with no
 * top-level anyOf/oneOf. A top-level union (anyOf) makes DeepSeek V4.1 via
 * opencode-go reject every request carrying the tool with a 400.
 */
test("subagent parameters serialize to a strict-compatible top-level object", () => {
	const schema = JSON.parse(JSON.stringify(subagentTool.parameters));
	assert.equal(schema.type, "object", "top-level type must be object");
	assert.ok(!("anyOf" in schema), "no top-level anyOf allowed");
	assert.ok(!("oneOf" in schema), "no top-level oneOf allowed");
	assert.ok(schema.properties && typeof schema.properties === "object", "must declare properties");
	for (const field of ["mode", "task", "tasks", "chain", "wait", "notifyOnComplete"]) {
		assert.ok(field in schema.properties, `properties must include ${field}`);
	}
});

test("flattened subagent schema still validates all three modes", () => {
	assert.equal(Check(subagentTool.parameters, { mode: "single", task: "do work" }), true);
	assert.equal(Check(subagentTool.parameters, { mode: "parallel", tasks: [{ task: "do work" }] }), true);
	assert.equal(Check(subagentTool.parameters, { mode: "chain", chain: [{ task: "do work" }] }), true);
});

test("flattened subagent schema still rejects invalid combos", () => {
	// Missing mode, unknown mode, and empty arrays reject at the schema level.
	assert.equal(Check(subagentTool.parameters, { task: "missing mode" }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "other", task: "unknown mode" }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "parallel", tasks: [] }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "chain", chain: [] }), false);
	assert.equal(Check(subagentTool.parameters, { mode: "single" }), true, "missing task passes schema, execute() guard rejects it");
});
