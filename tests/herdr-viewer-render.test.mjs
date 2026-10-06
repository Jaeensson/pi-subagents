import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeText, parseSnapshot, renderViewer, formatTokens, formatDuration, SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES,
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

test("uses the full pane width instead of capping the render at 80 columns", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 1, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "running", startedAt: 0 }, segments: [{ kind: "text", text: "x".repeat(200) }], truncated: false };
  const lines = renderViewer(snapshot, { columns: 120, rows: 10, now: 1 });
  assert.deepEqual(lines.slice(2), ["x".repeat(120), "x".repeat(80)]);
  assert.ok(lines.every(line => physicalWidth(line) <= 120));
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
    "0s",
    "… earlier content truncated …",
    "LATEST-TAIL",
  ]);
  assert.deepEqual(renderViewer(snapshot, { columns: 80, rows: 10, now: 1 }), [
    "job · worker · completed",
    "0s",
    "EARLY-HEAD",
    "mid-2",
    "mid-3",
    "mid-4",
    "LATEST-TAIL",
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
  assert.deepEqual(renderViewer({ ...snapshot, segments: [] }, { columns: 80, rows: 4, now: 1 }), ["job · worker · completed", "0s"]);
  const truncatedLines = renderViewer({ ...snapshot, truncated: true }, { columns: 80, rows: 7, now: 1 });
  assert.deepEqual(truncatedLines.at(-1), "… earlier content truncated …");
  assert.equal(truncatedLines.filter(line => line === "… earlier content truncated …").length, 1);
  assert.ok(truncatedLines.includes("LATEST-TAIL"));
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
  assert.ok(colored.find(line => stripSgr(line) === "boom").includes("\x1b[31m"));
  assert.ok(colored.find(line => stripSgr(line) === "hmm").includes("\x1b[2m"));
  assert.ok(colored.find(line => stripSgr(line).startsWith("read ")).includes("\x1b[36m"));
  assert.ok(colored.every(line => !/^(text|thinking|tool|output|error): /.test(stripSgr(line))));
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

test("formats token counts and durations compactly", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(12345), "12.3k");
  assert.equal(formatTokens(200000), "200k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(92_000), "1m32s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_900_000), "1h5m");
  assert.equal(formatDuration(-5), "0s");
});

test("renders a dim meta line with model, context usage, and runtime", () => {
  const snapshot = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 92_000, task: { id: "t", generation: 1, name: "job", agent: "worker", model: "opus-4", status: "running", startedAt: 0, contextTokens: 12345, contextWindow: 200000 }, segments: [], truncated: false };
  assert.deepEqual(renderViewer(snapshot, { columns: 80, rows: 4, now: 92_000 }), [
    "job · worker · running",
    "opus-4 · ctx 12.3k/200k (6%) · 1m32s",
  ]);
  const colored = renderViewer(snapshot, { columns: 80, rows: 4, now: 92_000, color: true });
  assert.ok(colored[0].includes("\x1b[1m"));
  assert.ok(colored[1].includes("\x1b[2m"));
  assert.deepEqual(colored.map(stripSgr), renderViewer(snapshot, { columns: 80, rows: 4, now: 92_000 }));
  for (const columns of [1, 2, 3, 7]) {
    const lines = renderViewer(snapshot, { columns, rows: 6, now: 92_000 });
    assert.ok(lines.every(line => physicalWidth(line) <= columns));
  }
});

test("meta line omits unknown fields, clamps future starts, and freezes finished runtime", () => {
  const base = { version: 1, activationId: "a", slotId: 0, nonce: "n", seq: 1, heartbeatAt: 5000, task: { id: "t", generation: 1, name: "job", agent: "worker", status: "running", startedAt: 0 }, segments: [], truncated: false };
  const meta = snapshot => renderViewer(snapshot, { columns: 80, rows: 4, now: 5000 })[1];
  assert.equal(meta({ ...base, task: { ...base.task, contextTokens: 750 } }), "ctx 750 · 5s");
  assert.equal(meta({ ...base, task: { ...base.task, model: "m" } }), "m · 5s");
  assert.equal(meta({ ...base, task: { ...base.task, contextTokens: 0, contextWindow: 200000 } }), "5s");
  assert.equal(meta({ ...base, task: { ...base.task, startedAt: 1000, finishedAt: 6000 } }), "5s");
  assert.equal(meta({ ...base, task: { ...base.task, startedAt: 10000 } }), "0s");
  assert.equal(meta({ ...base, task: { ...base.task, contextTokens: 100, contextWindow: 0 } }), "ctx 100 · 5s");
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
