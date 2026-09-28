import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { seedBundledAgentFiles } from "../agent-seeding.ts";

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-seeding-test-"));
}

test("seeding does not overwrite an existing invalid/custom agent file", () => {
	const root = tempDir();
	try {
		const bundledDir = path.join(root, "bundled");
		const userDir = path.join(root, "user", "agents");
		fs.mkdirSync(bundledDir);
		fs.mkdirSync(userDir, { recursive: true });
		fs.writeFileSync(path.join(bundledDir, "scout.md"), "bundled scout\n");
		fs.writeFileSync(path.join(userDir, "scout.md"), "custom invalid scout\n");

		assert.deepEqual(seedBundledAgentFiles(bundledDir, userDir, ["scout"]), []);
		assert.equal(fs.readFileSync(path.join(userDir, "scout.md"), "utf8"), "custom invalid scout\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a user agent directory creation error is best-effort", () => {
	const root = tempDir();
	try {
		const bundledDir = path.join(root, "bundled");
		const userDirParentFile = path.join(root, "not-a-directory");
		fs.mkdirSync(bundledDir);
		fs.writeFileSync(path.join(bundledDir, "worker.md"), "bundled worker\n");
		fs.writeFileSync(userDirParentFile, "block mkdir");

		assert.doesNotThrow(() => seedBundledAgentFiles(bundledDir, path.join(userDirParentFile, "agents"), ["worker"]));
		assert.deepEqual(seedBundledAgentFiles(bundledDir, path.join(userDirParentFile, "agents"), ["worker"]), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
