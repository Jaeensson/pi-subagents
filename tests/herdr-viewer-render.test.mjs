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

test("fits independent physical-cell oracle across narrow widths and grapheme fixtures", () => {
  const fixtures = ["界", "🙂", "e\u0301", "🇸🇪", "🇳🇴", "1️⃣", "2️⃣", "👍🏽", "👨‍👩‍👧‍👦"];
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "", agent: "", status: "running", startedAt: 0 }, segments: [{ kind: "text", text: fixtures.join("") }], truncated: false };
  for (const columns of [1, 2, 3, 7]) {
    const rows = 50;
    const lines = renderViewer(snapshot, { columns, rows, now: 1 });
    assert.ok(lines.length <= rows, `output exceeds ${rows} rows at width ${columns}`);
    assert.ok(lines.every(line => physicalWidth(line) <= columns), `line exceeds ${columns} cells: ${JSON.stringify(lines)}`);
    assert.ok(lines.every(line => !/\x1b/.test(line)));
  }
  const wideLines = renderViewer(snapshot, { columns: 7, rows: 50, now: 1 });
  assert.ok(fixtures.every(grapheme => wideLines.join("\n").includes(grapheme)));
});

// Independent fixture oracle: widths are explicit for every non-ASCII grapheme
// emitted by these tests (not inferred from the renderer's Unicode categories).
function physicalWidth(text) {
  const widths = new Map([
    ["界", 2], ["🙂", 2], ["e\u0301", 1], ["🇸🇪", 2], ["🇳🇴", 2],
    ["1️⃣", 2], ["2️⃣", 2], ["👍🏽", 2], ["👨‍👩‍👧‍👦", 2], ["…", 1], ["·", 1],
  ]);
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)]
    .reduce((cells, part) => {
      const known = widths.get(part.segment);
      assert.ok(known !== undefined || /^[\x20-\x7e]*$/.test(part.segment), `oracle has no width for ${JSON.stringify(part.segment)}`);
      return cells + (known ?? part.segment.length);
    }, 0);
}
