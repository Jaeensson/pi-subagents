import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeHerdrOptions, readHerdrOptions, writeHerdrOptions } from "../herdr-settings.ts";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subagent-herdr-settings-"));
  const file = path.join(dir, "settings.json");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Herdr option normalization defaults invalid values on", () => {
  assert.deepEqual(normalizeHerdrOptions(undefined), { enabled: true, viewers: true });
  assert.deepEqual(normalizeHerdrOptions({ enabled: false, viewers: true }), { enabled: false, viewers: true });
  assert.deepEqual(normalizeHerdrOptions({ enabled: "false", viewers: null }), { enabled: true, viewers: true });
});

test("Herdr options write independently and preserve model tiers and unknown Herdr keys", () => {
  const f = fixture();
  const originalTiers = { fast: "provider/model", auto: true };
  try {
    writeFileSync(f.file, JSON.stringify({ subagent: { modelTiers: originalTiers, herdr: { futureKey: "preserved" } } }));
    assert.equal(writeHerdrOptions(f.file, { enabled: true, viewers: false }).ok, true);
    assert.equal(readHerdrOptions(f.file).viewers, false);
    const readSaved = (file) => JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(readSaved(f.file).subagent.modelTiers, originalTiers);
    assert.equal(readSaved(f.file).subagent.herdr.futureKey, "preserved");
  } finally { f.cleanup(); }
});

test("Herdr options refuse to overwrite malformed settings", () => {
  const f = fixture();
  const originalMalformedBytes = "{ malformed\n";
  try {
    writeFileSync(f.file, originalMalformedBytes);
    const writeToMalformedFile = () => writeHerdrOptions(f.file, { enabled: false, viewers: false });
    const readMalformedBytes = () => readFileSync(f.file, "utf8");
    assert.equal(writeToMalformedFile().ok, false);
    assert.equal(readMalformedBytes(), originalMalformedBytes);
  } finally { f.cleanup(); }
});
