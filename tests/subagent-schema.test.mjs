import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { Check } from "typebox/value";
import { subagentTool } from "../tools/subagent.ts";
import { subagentAgentsTool } from "../tools/subagent-agents.ts";
import { subagentPauseTool } from "../tools/subagent-pause.ts";
import { subagentResumeTool } from "../tools/subagent-resume.ts";
import { subagentStatusTool } from "../tools/subagent-status.ts";
import { subagentWaitTool } from "../tools/subagent-wait.ts";

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

// ── The host's own argument validation (pi 1.5.0 and later) ───────────────────
//
// pi 1.5.0 validates tool arguments with @earendil-works/pi-schema and coerces
// loosely typed input, so TypeBox's Check no longer describes what a user
// experiences. The assertions above still describe the schema shape providers
// see; the ones below state the same contract through the validator the host
// actually runs, compiled with the host's own options (its getValidator:
// `{ formats, coerce: true, unresolvedRefs: "reject" }`).

const hostValidators = {
	subagent: compile(subagentTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
	subagent_wait: compile(subagentWaitTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
	subagent_status: compile(subagentStatusTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
	subagent_pause: compile(subagentPauseTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
	subagent_resume: compile(subagentResumeTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
	subagent_agents: compile(subagentAgentsTool.parameters, { formats, coerce: true, unresolvedRefs: "reject" }),
};

// Acceptance alone is not evidence of coercion: for a value that needs none, a
// validator that echoed its input would satisfy `deepEqual(result.value, value)`
// just as well (the coercer returns the same value by identity). The weight is
// carried by the sibling coercion test below, which cannot pass without real
// coercion — a non-coercing validator rejects `wait: "true"`, and `assert.equal`
// is strict, so `"true"` fails against `true`.
test("host validator accepts the documented shape of every tool", () => {
	const accepted = {
		subagent: [
			{ mode: "single", task: "do work" },
			{ mode: "parallel", tasks: [{ task: "do work" }] },
			{ mode: "chain", chain: [{ task: "do work" }, { task: "then {previous}" }] },
		],
		subagent_wait: [{ jobIds: ["a", "b"] }, { jobIds: ["a"], timeoutSeconds: 30 }],
		subagent_status: [{}, { jobIds: ["a"] }],
		subagent_pause: [{ jobId: "a" }],
		subagent_resume: [{}, { jobId: "a" }, { jobId: "a", wait: false, notifyOnComplete: false }],
		subagent_agents: [{}],
	};
	for (const [name, values] of Object.entries(accepted)) {
		for (const value of values) {
			const result = hostValidators[name].parse(value);
			assert.equal(result.ok, true, `${name} must accept ${JSON.stringify(value)}`);
			assert.deepEqual(result.value, value, `${name} must return ${JSON.stringify(value)} unchanged`);
		}
	}
});

test("host validator coerces loosely typed arguments to the schema's types", () => {
	// A boolean string for the wait flag: accepted by the host, rejected by TypeBox.
	const wait = hostValidators.subagent.parse({ mode: "single", task: "x", wait: "true" });
	assert.equal(wait.ok, true);
	assert.equal(wait.value.wait, true);
	assert.equal(Check(subagentTool.parameters, { mode: "single", task: "x", wait: "true" }), false, "TypeBox rejects what the host coerces");

	// A single object where the schema wants an array: coerced to a one-item array.
	const tasks = hostValidators.subagent.parse({ mode: "parallel", tasks: { task: "x" } });
	assert.equal(tasks.ok, true);
	assert.deepEqual(tasks.value.tasks, [{ task: "x" }]);
	assert.equal(Check(subagentTool.parameters, { mode: "parallel", tasks: { task: "x" } }), false, "TypeBox rejects what the host coerces");

	// A single string where the schema wants an array of strings.
	const jobIds = hostValidators.subagent_wait.parse({ jobIds: "abc" });
	assert.equal(jobIds.ok, true);
	assert.deepEqual(jobIds.value.jobIds, ["abc"]);

	// A numeric string for the numeric field, and for the boolean flags of resume.
	const timeout = hostValidators.subagent_wait.parse({ jobIds: ["a"], timeoutSeconds: "30" });
	assert.equal(timeout.ok, true);
	assert.equal(timeout.value.timeoutSeconds, 30);
	const resume = hostValidators.subagent_resume.parse({ jobId: "a", wait: "false" });
	assert.equal(resume.ok, true);
	assert.equal(resume.value.wait, false);
});

test("host validator rejects the shapes the tools document as invalid", () => {
	const missingMode = hostValidators.subagent.parse({ task: "x" });
	assert.equal(missingMode.ok, false);
	assert.deepEqual(missingMode.errors, [{ path: "/mode", keyword: "required", message: "missing" }]);

	for (const value of [
		{ mode: "other", task: "x" },
		{ mode: "parallel", tasks: [] },
		{ mode: "chain", chain: [] },
		{ mode: "single", task: "x", bogus: 1 },
	]) {
		assert.equal(hostValidators.subagent.parse(value).ok, false, `subagent must reject ${JSON.stringify(value)}`);
	}
	assert.equal(hostValidators.subagent_wait.parse({}).ok, false, "subagent_wait requires jobIds");
	assert.equal(hostValidators.subagent_pause.parse({}).ok, false, "subagent_pause requires jobId");
});

test("the parallel ceiling is enforced by the tool, not by the schema", () => {
	// Measured on this tree: `tasks` carries minItems but no maxItems, so nine
	// parallel tasks pass the host's validation. The nine-task ceiling is the
	// MAX_PARALLEL_TASKS guard in the subagent tool, and the contract suite's
	// "parallel arrays above the supported limit reject before any spawn" is the
	// test that pins the rejection a user actually gets.
	const nine = { mode: "parallel", tasks: Array.from({ length: 9 }, (_, i) => ({ task: `task ${i}` })) };
	const result = hostValidators.subagent.parse(nine);
	assert.equal(result.ok, true);
	assert.equal(result.value.tasks.length, 9);
});
