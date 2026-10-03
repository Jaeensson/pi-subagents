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

test("renders the latest tail rows with a pane-truncation marker when the trace exceeds the pane", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "completed", startedAt: 0 }, segments: [
    { kind: "text", text: "EARLY-HEAD" },
    { kind: "text", text: "mid-2" },
    { kind: "text", text: "mid-3" },
    { kind: "text", text: "mid-4" },
    { kind: "text", text: "LATEST-TAIL" },
  ], truncated: false };
  const lines = renderViewer(snapshot, { columns: 80, rows: 4, now: 1 });
  assert.deepEqual(lines, [
    "job · worker · completed",
    "… earlier content truncated …",
    "text: mid-4",
    "text: LATEST-TAIL",
  ]);
  assert.deepEqual(renderViewer(snapshot, { columns: 80, rows: 10, now: 1 }), [
    "job · worker · completed",
    "text: EARLY-HEAD",
    "text: mid-2",
    "text: mid-3",
    "text: mid-4",
    "text: LATEST-TAIL",
  ]);
});

test("handles empty rows, heading-only traces, and snapshot-level truncation markers", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "completed", startedAt: 0 }, segments: [
    { kind: "text", text: "EARLY-HEAD" },
    { kind: "text", text: "mid-2" },
    { kind: "text", text: "mid-3" },
    { kind: "text", text: "mid-4" },
    { kind: "text", text: "LATEST-TAIL" },
  ], truncated: false };
  assert.deepEqual(renderViewer(snapshot, { columns: 80, rows: 0, now: 1 }), []);
  assert.deepEqual(renderViewer({ ...snapshot, segments: [] }, { columns: 80, rows: 4, now: 1 }), ["job · worker · completed"]);
  const truncatedLines = renderViewer({ ...snapshot, truncated: true }, { columns: 80, rows: 7, now: 1 });
  assert.deepEqual(truncatedLines.at(-1), "… earlier content truncated …");
  assert.equal(truncatedLines.filter(line => line === "… earlier content truncated …").length, 1);
  assert.ok(truncatedLines.includes("text: LATEST-TAIL"));
});

test("colors viewer chrome only when color:true and strips back to plain lines", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "running", startedAt: 0 }, segments: [
    { kind: "thinking", text: "hmm" },
    { kind: "toolCall", text: "read {\"path\":\"f\"}" },
    { kind: "toolOutput", text: "ok" },
    { kind: "toolOutput", text: "boom", isError: true },
    { kind: "text", text: "done" },
  ], truncated: true };
  const plain = renderViewer(snapshot, { columns: 80, rows: 20, now: 1 });
  assert.ok(plain.every(line => !/\x1b/.test(line)));
  const colored = renderViewer(snapshot, { columns: 80, rows: 20, now: 1, color: true });
  assert.ok(colored.some(line => /\x1b/.test(line)));
  // Stripping our SGR chrome must reproduce the plain render exactly (width-safe).
  assert.deepEqual(colored.map(stripSgr), plain);
  // Heading carries bold plus a status color; error and truncation markers are styled.
  assert.ok(colored[0].includes("\x1b[1m"));
  assert.ok(colored.find(line => stripSgr(line).startsWith("error: ")).includes("\x1b[31m"));
  assert.ok(colored.find(line => stripSgr(line).startsWith("thinking: ")).includes("\x1b[2m"));
  assert.ok(colored.find(line => stripSgr(line).startsWith("tool: ")).includes("\x1b[36m"));
  assert.ok(colored.filter(line => stripSgr(line).includes("truncated")).every(line => line.includes("\x1b[2m")));
});

test("heading status color follows task state", () => {
  const base = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "running", startedAt: 0 }, segments: [], truncated: false };
  const heading = status => renderViewer({ ...base, task: { ...base.task, status } }, { columns: 80, rows: 4, now: 1, color: true })[0];
  assert.ok(heading("running").includes("\x1b[32m"));
  assert.ok(heading("completed").includes("\x1b[32m"));
  assert.ok(heading("failed").includes("\x1b[31m"));
  assert.ok(heading("aborted").includes("\x1b[31m"));
  assert.ok(heading("paused").includes("\x1b[33m"));
  assert.ok(heading("interrupted").includes("\x1b[33m"));
  assert.ok(renderViewer(base, { columns: 80, rows: 4, now: 20000, disconnected: true, color: true })[0].includes("\x1b[33m"));
});

function stripSgr(text) { return text.replace(/\x1b\[[0-9;]*m/g, ""); }

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
