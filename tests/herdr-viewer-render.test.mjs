import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeText, parseSnapshot, renderViewer, SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES,
  PUBLISH_INTERVAL_MS, VIEWER_POLL_MS, HEARTBEAT_INTERVAL_MS, DISCONNECTED_AFTER_MS, EXIT_AFTER_MS,
} from "../herdr-viewer-render.mjs";

test("sanitizes OSC, CSI and terminal controls and validates protocol snapshots", () => {
  assert.equal(sanitizeText("safe\x1b]52;c;bad\x07\x1b[31mred"), "safered");
  assert.equal(parseSnapshot('{"version":99}'), undefined);
});

test("exports the shared protocol and timing constants", () => {
  assert.deepEqual([
    SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES, PUBLISH_INTERVAL_MS, VIEWER_POLL_MS,
    HEARTBEAT_INTERVAL_MS, DISCONNECTED_AFTER_MS, EXIT_AFTER_MS,
  ], [1, 128 * 1024, 250, 250, 2000, 10000, 30000]);
});

test("renders within narrow terminal dimensions with grapheme-safe clipping", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "界🙂e\u0301", agent: "worker", status: "running", startedAt: 0 }, segments: [{ kind: "text", text: "界🙂e\u0301\nhello" }], truncated: false };
  for (const columns of [1, 2, 3, 7, 80]) {
    const lines = renderViewer(snapshot, { columns, rows: 4, now: 1 });
    assert.ok(lines.length <= 4);
    assert.ok(lines.every(line => physicalWidth(line) <= columns));
    assert.ok(lines.every(line => !/\x1b/.test(line)));
  }
});

test("wraps flag and keycap emoji at their full cell width and clips only at grapheme boundaries", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "", agent: "", status: "running", startedAt: 0 }, segments: [{ kind: "text", text: "🇸🇪🇳🇴1️⃣2️⃣👍🏽👨‍👩‍👧‍👦" }], truncated: false };
  const lines = renderViewer(snapshot, { columns: 2, rows: 30, now: 1 });
  const emoji = ["🇸🇪", "🇳🇴", "1️⃣", "2️⃣", "👍🏽", "👨‍👩‍👧‍👦"];
  const emojiLines = lines.filter(line => emoji.some(grapheme => line.includes(grapheme)));
  assert.ok(emoji.every(grapheme => lines.join("\n").includes(grapheme)));
  assert.ok(emojiLines.every(line => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)]
    .filter(part => emoji.some(grapheme => part.segment === grapheme)).length === 1));
  assert.ok(lines.every(line => physicalWidth(line) <= 2));
});

function physicalWidth(text) {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .reduce((n, part) => n + (/\p{Extended_Pictographic}/u.test(part.segment) || /[\u{1F1E6}-\u{1F1FF}\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}]/u.test(part.segment) ? 2 : 1), 0);
}
