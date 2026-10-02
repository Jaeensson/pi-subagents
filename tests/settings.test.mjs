import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSettingsJson, updateSettingsJson } from "../settings.ts";
import { writeModelTiers } from "../jobs.ts";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-settings-"));
  const file = path.join(dir, "settings.json");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("settings JSON reads only object roots and updates while preserving unknown keys", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ untouched: true, subagent: { modelTiers: { fast: "x" }, other: 1 } }));
    assert.deepEqual(readSettingsJson(f.file), { untouched: true, subagent: { modelTiers: { fast: "x" }, other: 1 } });
    assert.deepEqual(updateSettingsJson(f.file, (root) => { root.changed = true; }), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { untouched: true, subagent: { modelTiers: { fast: "x" }, other: 1 }, changed: true });
  } finally { f.cleanup(); }
});

test("settings writes reject unreadable, malformed, non-object and missing files without temp debris", () => {
  const f = fixture();
  try {
    const malformed = "{ broken";
    writeFileSync(f.file, malformed);
    assert.equal(updateSettingsJson(f.file, () => {}).ok, false);
    assert.equal(readFileSync(f.file, "utf8"), malformed);
    writeFileSync(f.file, "[]");
    assert.equal(updateSettingsJson(f.file, () => {}).ok, false);
    rmSync(f.file);
    assert.equal(updateSettingsJson(f.file, () => {}).ok, false);
    assert.deepEqual(readdirSync(f.dir), []);
    assert.equal(readSettingsJson(path.join(f.dir, "missing.json")), undefined);
  } finally { f.cleanup(); }
});

test("settings write cleans up its temp file when rename fails", () => {
  const f = fixture();
  const require = createRequire(import.meta.url);
  const fs = require("node:fs");
  const originalRenameSync = fs.renameSync;
  let renameCalls = 0;
  try {
    writeFileSync(f.file, JSON.stringify({ unchanged: true }));
    fs.renameSync = () => {
      renameCalls++;
      throw new Error("controlled rename failure");
    };
    syncBuiltinESMExports();

    const result = updateSettingsJson(f.file, (root) => { root.changed = true; });

    assert.equal(renameCalls, 1, "update reached the controlled rename failure");
    assert.equal(result.ok, false);
    assert.match(result.error, /controlled rename failure/);
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { unchanged: true });
    assert.deepEqual(readdirSync(f.dir), ["settings.json"]);
  } finally {
    fs.renameSync = originalRenameSync;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("model tier writes preserve existing semantics and reject malformed or missing settings", () => {
  const f = fixture();
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.dir;
  try {
    const tiers = { fast: "provider/model" };
    writeFileSync(f.file, JSON.stringify({ other: 1, subagent: { modelTiers: { old: true }, herdr: { futureKey: "preserved" } } }));
    assert.equal(writeModelTiers(tiers).ok, true);
    assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).subagent.modelTiers, tiers);
    assert.equal(writeModelTiers(undefined).ok, true);
    const removed = JSON.parse(readFileSync(f.file, "utf8"));
    assert.equal("modelTiers" in removed.subagent, false);
    assert.deepEqual(removed.subagent.herdr, { futureKey: "preserved" });
    writeFileSync(f.file, "{broken");
    assert.equal(writeModelTiers(tiers).ok, false);
    assert.equal(readFileSync(f.file, "utf8"), "{broken");
    rmSync(f.file);
    assert.equal(writeModelTiers(tiers).ok, false);
    assert.deepEqual(readdirSync(f.dir), []);
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    f.cleanup();
  }
});
