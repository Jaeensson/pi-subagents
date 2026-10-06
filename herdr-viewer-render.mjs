export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 128 * 1024;
export const PUBLISH_INTERVAL_MS = 250;
export const VIEWER_POLL_MS = 250;
export const HEARTBEAT_INTERVAL_MS = 2000;
export const DISCONNECTED_AFTER_MS = 10000;
export const EXIT_AFTER_MS = 30000;

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
      (t.finishedAt !== undefined && !Number.isFinite(t.finishedAt)) || (t.model !== undefined && typeof t.model !== "string") ||
      (t.contextTokens !== undefined && (typeof t.contextTokens !== "number" || !Number.isFinite(t.contextTokens) || t.contextTokens < 0)) ||
      (t.contextWindow !== undefined && (typeof t.contextWindow !== "number" || !Number.isFinite(t.contextWindow) || t.contextWindow < 0))) return undefined;
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
  if (/\p{Extended_Pictographic}/u.test(g) || /[\u{1F1E6}-\u{1F1FF}]/u.test(g) || /[#*0-9]\uFE0F?\u20E3/u.test(g) ||
      /\p{Emoji_Presentation}/u.test(g) || /[\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}]/u.test(g)) return 2;
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

// Minimal SGR chrome for the viewer pane (a color terminal: the viewer already
// clears with CSI unconditionally). Agent content is sanitized before styling,
// so escapes here are only ever our own. Styling wraps whole already-wrapped
// lines, so stripping SGR reproduces the plain render exactly (width-safe).
const SGR = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const STATUS_STYLE = {
  running: [SGR.bold, SGR.green], completed: [SGR.bold, SGR.green],
  failed: [SGR.bold, SGR.red], aborted: [SGR.bold, SGR.red],
  paused: [SGR.bold, SGR.yellow], interrupted: [SGR.bold, SGR.yellow],
  disconnected: [SGR.bold, SGR.yellow],
};
// Mirrors the inline trace tokens: tool calls stand out, errors are red,
// thinking recedes; plain output and text stay unstyled for readability.
// No kind prefixes: with color carrying the kind, `tool:`/`text:` labels are noise.
const KIND_STYLE = { toolCall: [SGR.cyan], error: [SGR.red], thinking: [SGR.dim] };
const stain = (line, codes) => codes && line ? `${codes.join("")}${line}${SGR.reset}` : line;

/** Compact token counts: 999, 12.3k, 1M. */
export function formatTokens(value) {
  const tokens = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const trim = n => n.toFixed(1).replace(/\.0$/, "");
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${trim(tokens / 1000)}k`;
  return `${trim(tokens / 1_000_000)}M`;
}

/** Coarse elapsed time: 0s, 45s, 1m32s, 1h5m. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const seconds = total % 60, minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
  if (hours) return minutes ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Second header line: model · context usage · runtime; unknown parts are omitted. */
export function metaLine(task, now) {
  const parts = [];
  if (task.model) parts.push(task.model);
  const tokens = task.contextTokens;
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
    const window = task.contextWindow;
    parts.push(typeof window === "number" && Number.isFinite(window) && window > 0
      ? `ctx ${formatTokens(tokens)}/${formatTokens(window)} (${Math.round(tokens / window * 100)}%)`
      : `ctx ${formatTokens(tokens)}`);
  }
  // Runtime ticks against the snapshot heartbeat and freezes once finishedAt is set.
  const elapsed = (task.finishedAt ?? now) - task.startedAt;
  parts.push(formatDuration(elapsed));
  return parts.join(" · ");
}

export function renderViewer(snapshot, options) {
  // Fill the pane: the viewer owns a dedicated pane, so wrap at its real width
  // rather than a fixed editorial measure.
  const columns = Math.max(1, Math.floor(options.columns) || 1);
  const rows = Math.max(0, Math.floor(options.rows) || 0);
  if (!rows) return [];
  const paint = options.color === true;
  const age = Math.max(0, options.now - snapshot.heartbeatAt);
  const state = options.disconnected || age > 10000 ? "disconnected" : snapshot.task.status;
  const headingStyle = paint ? STATUS_STYLE[state] : undefined;
  const markerStyle = paint ? [SGR.dim] : undefined;
  const headingLines = wrap(sanitizeText(`${snapshot.task.name} · ${snapshot.task.agent} · ${state}`), columns).map(line => stain(line, headingStyle));
  const metaLines = wrap(sanitizeText(metaLine(snapshot.task, options.now)), columns).map(line => stain(line, markerStyle));
  const headerLines = [...headingLines, ...metaLines];
  const body = [];
  for (const segment of snapshot.segments) {
    const key = segment.kind === "toolOutput" && segment.isError ? "error" : segment.kind;
    const lineStyle = paint ? KIND_STYLE[key] : undefined;
    const text = sanitizeText(segment.text).replace(/\t/g, "    ");
    for (const rawLine of text.split("\n")) for (const line of wrap(rawLine, columns)) body.push(stain(line, lineStyle));
  }
  if (snapshot.truncated) for (const line of wrap("… earlier content truncated …", columns)) body.push(stain(line, markerStyle));
  if (headerLines.length >= rows) return headerLines.slice(0, rows);
  const available = rows - headerLines.length;
  if (body.length <= available) return [...headerLines, ...body];
  // The snapshot marker already sits at the body tail; retain it once instead of
  // prepending a second identical pane-truncation marker.
  if (snapshot.truncated) return [...headerLines, ...body.slice(-available)];
  // Keep the heading, mark the lines the pane dropped, and retain the latest tail.
  const marker = wrap("… earlier content truncated …", columns).map(line => stain(line, markerStyle));
  if (marker.length >= available) return [...headerLines, ...marker.slice(0, available)];
  return [...headerLines, ...marker, ...body.slice(-(available - marker.length))];
}
