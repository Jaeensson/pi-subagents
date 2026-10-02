import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeText, parseSnapshot, renderViewer } from "../herdr-viewer-render.mjs";

test("sanitizes OSC, CSI and terminal controls and validates protocol snapshots", () => {
  assert.equal(sanitizeText("safe\x1b]52;c;bad\x07\x1b[31mred"), "safered");
  assert.equal(parseSnapshot('{"version":99}'), undefined);
});

test("renders within narrow terminal dimensions with grapheme-safe clipping", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "界🙂e\u0301", agent: "worker", status: "running", startedAt: 0 }, segments: [{ kind: "text", text: "界🙂e\u0301\nhello" }], truncated: false };
  for (const columns of [1, 2, 3, 7, 80]) {
    const lines = renderViewer(snapshot, { columns, rows: 4, now: 1 });
    assert.ok(lines.length <= 4);
    const width = line => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].reduce((n, x) => n + (x.segment.codePointAt(0) > 0x2e00 ? 2 : 1), 0);
    assert.ok(lines.every(line => width(line) <= columns));
    assert.ok(lines.every(line => !/\x1b/.test(line)));
  }
});
