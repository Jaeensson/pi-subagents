import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMuxSettings, writeMuxOptions } from "../mux-settings.ts";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mux-settings-"));
  const file = path.join(dir, "settings.json");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("mux settings default each backend's invalid values on", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ subagent: { herdr: { enabled: "yes" }, tmux: { viewers: 0 } } }));
    assert.deepEqual(readMuxSettings(f.file), { herdr: { enabled: true, viewers: true }, tmux: { enabled: true, viewers: true } });
  } finally { f.cleanup(); }
});

test("mux settings read valid booleans per backend and default the rest", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ subagent: { herdr: { enabled: false, viewers: true }, tmux: { enabled: true, viewers: false } } }));
    assert.deepEqual(readMuxSettings(f.file), { herdr: { enabled: false, viewers: true }, tmux: { enabled: true, viewers: false } });
    writeFileSync(f.file, JSON.stringify({ subagent: { herdr: { enabled: null }, tmux: { enabled: false, viewers: null } } }));
    assert.deepEqual(readMuxSettings(f.file), { herdr: { enabled: true, viewers: true }, tmux: { enabled: false, viewers: true } });
  } finally { f.cleanup(); }
});

test("writeMuxOptions writes one backend and preserves the other, tiers, and unknown keys", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ subagent: { modelTiers: { fast: "m" }, herdr: { enabled: false, viewers: false, custom: 1 }, tmux: { enabled: true, viewers: true } } }));
    assert.equal(writeMuxOptions(f.file, "tmux", { enabled: true, viewers: false }).ok, true);
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    assert.deepEqual(saved.subagent.tmux, { enabled: true, viewers: false });
    assert.equal(saved.subagent.herdr.enabled, false);
    assert.equal(saved.subagent.herdr.custom, 1);
    assert.deepEqual(saved.subagent.modelTiers, { fast: "m" });
  } finally { f.cleanup(); }
});

test("writeMuxOptions can write the herdr backend without disturbing tmux", () => {
  const f = fixture();
  try {
    writeFileSync(f.file, JSON.stringify({ subagent: { herdr: { enabled: true, viewers: true, futureKey: "preserved" }, tmux: { enabled: true, viewers: false } } }));
    assert.equal(writeMuxOptions(f.file, "herdr", { enabled: false, viewers: true }).ok, true);
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    assert.deepEqual(saved.subagent.herdr, { enabled: false, viewers: true, futureKey: "preserved" });
    assert.deepEqual(saved.subagent.tmux, { enabled: true, viewers: false });
  } finally { f.cleanup(); }
});

test("mux settings refuse to overwrite malformed settings", () => {
  const f = fixture();
  const originalMalformedBytes = "{ malformed\n";
  try {
    writeFileSync(f.file, originalMalformedBytes);
    assert.equal(writeMuxOptions(f.file, "herdr", { enabled: false, viewers: false }).ok, false);
    assert.equal(writeMuxOptions(f.file, "tmux", { enabled: false, viewers: false }).ok, false);
    assert.equal(readFileSync(f.file, "utf8"), originalMalformedBytes);
  } finally { f.cleanup(); }
});
