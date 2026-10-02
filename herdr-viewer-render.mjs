const STATUS = new Set(["running", "completed", "failed", "aborted", "paused", "interrupted"]);
const KINDS = new Set(["text", "thinking", "toolCall", "toolOutput"]);

export function sanitizeText(text) {
  return String(text)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?|\x9D[^\x07\x9C]*(?:\x07|\x9C)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

export function parseSnapshot(raw) {
  let value;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 128 * 1024) return undefined;
    value = JSON.parse(raw);
  } catch { return undefined; }
  if (!value || typeof value !== "object" || value.version !== 1 || typeof value.activationId !== "string" ||
      typeof value.nonce !== "string" || !Number.isSafeInteger(value.slotId) || value.slotId < 0 ||
      !Number.isSafeInteger(value.seq) || value.seq < 0 || !Number.isFinite(value.heartbeatAt) ||
      typeof value.truncated !== "boolean" || !Array.isArray(value.segments) || !value.task || typeof value.task !== "object") return undefined;
  const t = value.task;
  if (typeof t.id !== "string" || !Number.isSafeInteger(t.generation) || t.generation < 0 || typeof t.name !== "string" ||
      typeof t.agent !== "string" || !STATUS.has(t.status) || !Number.isFinite(t.startedAt) ||
      (t.finishedAt !== undefined && !Number.isFinite(t.finishedAt)) || (t.model !== undefined && typeof t.model !== "string")) return undefined;
  for (const seg of value.segments) {
    if (!seg || typeof seg !== "object" || !KINDS.has(seg.kind) || typeof seg.text !== "string" ||
        (seg.isError !== undefined && typeof seg.isError !== "boolean") || (seg.pending !== undefined && typeof seg.pending !== "boolean")) return undefined;
  }
  return value;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text) { return [...segmenter.segment(text)].map(part => part.segment); }
function cellWidth(g) {
  if (!g || /^\p{Mark}+$/u.test(g)) return 0;
  if (/\p{Extended_Pictographic}/u.test(g) || /[\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}]/u.test(g)) return 2;
  return 1;
}
function wrap(text, columns) {
  const lines = [""];
  let width = 0;
  for (const g of graphemes(text)) {
    if (g === "\n") { lines.push(""); width = 0; continue; }
    const w = cellWidth(g);
    if (width + w > columns && lines.at(-1)) { lines.push(""); width = 0; }
    if (w > columns) continue;
    lines[lines.length - 1] += g; width += w;
  }
  return lines;
}

export function renderViewer(snapshot, options) {
  const columns = Math.max(1, Math.min(80, Math.floor(options.columns) || 1));
  const rows = Math.max(0, Math.floor(options.rows) || 0);
  if (!rows) return [];
  const age = Math.max(0, options.now - snapshot.heartbeatAt);
  const state = options.disconnected || age > 10000 ? "disconnected" : snapshot.task.status;
  const heading = `${snapshot.task.name} · ${snapshot.task.agent} · ${state}`;
  const lines = wrap(sanitizeText(heading), columns);
  for (const segment of snapshot.segments) {
    const label = segment.kind === "toolCall" ? "tool" : segment.kind === "toolOutput" ? (segment.isError ? "error" : "output") : segment.kind;
    const text = sanitizeText(segment.text).replace(/\t/g, "    ");
    for (const rawLine of text.split("\n")) lines.push(...wrap(`${label}: ${rawLine}`, columns));
  }
  if (snapshot.truncated) lines.push(...wrap("… earlier content truncated …", columns));
  return lines.slice(0, rows);
}
