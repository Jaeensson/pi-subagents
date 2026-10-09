import type { Task } from "./runtime.ts";
import { SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES } from "./mux-viewer-render.mjs";
export {
  SNAPSHOT_VERSION, SNAPSHOT_MAX_BYTES, PUBLISH_INTERVAL_MS, VIEWER_POLL_MS,
  HEARTBEAT_INTERVAL_MS, DISCONNECTED_AFTER_MS, EXIT_AFTER_MS,
} from "./mux-viewer-render.mjs";

export type MuxBackend = "herdr" | "tmux";
export interface MuxContext { backend: MuxBackend; binary: string; endpoint: string; callerPaneId: string }
export interface PaneRef { paneId: string; tabId: string; workspaceId: string }
export interface SlotIdentity { activationId: string; slotId: number; nonce: string }
export interface SlotState {
  index: number; phase: "empty" | "reserved" | "ready" | "unavailable";
  taskKey?: string; taskStatus?: ViewerSnapshot["task"]["status"];
  availableSince: number;
}
export interface ViewerSegment { kind: "text" | "thinking" | "toolCall" | "toolOutput"; text: string; isError?: boolean; pending?: boolean }
export interface ViewerSnapshot {
  version: 1; activationId: string; slotId: number; nonce: string;
  seq: number; heartbeatAt: number;
  task: { id: string; generation: number; name: string; agent: string; model?: string;
    contextTokens?: number; contextWindow?: number;
    status: "running" | "completed" | "failed" | "aborted" | "paused" | "interrupted";
    startedAt: number; finishedAt?: number };
  segments: ViewerSegment[]; truncated: boolean;
}
export interface ViewerIdentity { version: 1; activationId: string; slotId: number; nonce: string; pid: number; heartbeatAt: number }
export interface TaskCounts { executing: number; queued: number; paused: number; completed: number; unsuccessful: number }

export function attemptKey(task: Pick<Task, "id" | "processGeneration">): string {
  return `${task.id}:${task.processGeneration ?? 0}`;
}

export function summarizeTasks(tasks: Iterable<Task>): TaskCounts {
  const counts: TaskCounts = { executing: 0, queued: 0, paused: 0, completed: 0, unsuccessful: 0 };
  for (const task of tasks) {
    if (task.status === "running") counts.executing++;
    else if (task.status === "paused") counts.paused++;
    else if (task.status === "completed") counts.completed++;
    else if (task.status === "failed" || task.status === "aborted" || task.status === "interrupted") counts.unsuccessful++;
    if (task.status === "running" && (task.setupPending || task.dispatchState === "queued")) {
      counts.executing--;
      counts.queued++;
    } else if (task.status !== "running" && (task.setupPending || task.dispatchState === "queued")) counts.queued++;
  }
  return counts;
}

export function formatSummary(counts: TaskCounts): string {
  return `running ${counts.executing} · queued ${counts.queued} · paused ${counts.paused} · completed ${counts.completed} · unsuccessful ${counts.unsuccessful}`;
}

const cleanText = (value: string): string => value
  .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)?/g, "")
  .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
const bounded = (value: unknown, max = 80): string => cleanText(typeof value === "string" ? value : "").slice(0, max);
const finiteCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function flatten(value: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(v => flatten(v, depth + 1)).join(", ");
  return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${flatten(v, depth + 1)}`).join(", ");
}

function toSegments(task: Task): ViewerSegment[] {
  const result: ViewerSegment[] = [];
  for (const seg of task.live?.segments ?? []) {
    if (seg.kind === "toolCall") result.push({ kind: "toolCall", text: cleanText(`${seg.name}${Object.keys(seg.args).length ? ` ${flatten(seg.args)}` : ""}`) });
    else if (seg.kind === "toolOutput") result.push({ kind: "toolOutput", text: cleanText(seg.text), ...(seg.isError ? { isError: true } : {}) });
    else result.push({ kind: seg.kind, text: cleanText(seg.text) });
  }
  const pending = task.live?.pending;
  if (pending?.text) result.push({ kind: pending.kind, text: cleanText(pending.text), pending: true });
  return result;
}

export function projectSnapshot(task: Task, identity: SlotIdentity, seq: number, now: number): ViewerSnapshot {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError("sequence must be a nonnegative safe integer");
  if (!Number.isFinite(now)) throw new RangeError("heartbeat time must be finite");
  let segments = toSegments(task);
  const snapshot: ViewerSnapshot = {
    version: SNAPSHOT_VERSION, activationId: bounded(identity.activationId), slotId: identity.slotId,
    nonce: bounded(identity.nonce), seq, heartbeatAt: Math.max(0, now),
    task: { id: bounded(task.id), generation: task.processGeneration ?? 0, name: bounded(task.name ?? task.agent), agent: bounded(task.agent),
      ...(task.model ? { model: bounded(task.model) } : {}),
      ...(finiteCount(task.usage?.contextTokens) ? { contextTokens: Math.floor(task.usage.contextTokens) } : {}),
      ...(finiteCount(task.contextWindow) ? { contextWindow: Math.floor(task.contextWindow) } : {}),
      status: task.status, startedAt: task.startedAt,
      ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}) },
    segments, truncated: (task.live?.dropped ?? 0) > 0,
  };
  while (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SNAPSHOT_MAX_BYTES && segments.length > 1) {
    segments = segments.slice(1);
    snapshot.segments = segments;
    snapshot.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SNAPSHOT_MAX_BYTES) {
    const last = segments.at(-1);
    if (last) {
      const codepoints = [...last.text];
      let low = 0;
      let high = codepoints.length;
      while (low < high) {
        const keep = Math.ceil((low + high) / 2);
        last.text = codepoints.slice(-keep).join("");
        if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= SNAPSHOT_MAX_BYTES) low = keep;
        else high = keep - 1;
      }
      last.text = codepoints.slice(-low).join("");
      snapshot.truncated = true;
    }
  }
  while (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SNAPSHOT_MAX_BYTES && segments.length) {
    segments = segments.slice(1); snapshot.segments = segments; snapshot.truncated = true;
  }
  return snapshot;
}

export function encodeSnapshot(snapshot: ViewerSnapshot): string {
  if (snapshot.version !== SNAPSHOT_VERSION || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) throw new RangeError("invalid snapshot version or sequence");
  let encoded = JSON.stringify(snapshot);
  if (Buffer.byteLength(encoded, "utf8") > SNAPSHOT_MAX_BYTES) throw new RangeError("snapshot exceeds byte limit");
  return encoded;
}

export function chooseSlot(slots: readonly SlotState[]): { kind: "reuse" | "create"; index: number } | { kind: "full" } {
  const reusable = slots.filter(slot => slot.phase === "ready" && slot.taskStatus !== "running")
    .sort((a, b) => a.availableSince - b.availableSince || a.index - b.index)[0];
  if (reusable) return { kind: "reuse", index: reusable.index };
  const empty = slots.filter(slot => slot.phase === "empty").sort((a, b) => a.index - b.index)[0];
  return empty ? { kind: "create", index: empty.index } : { kind: "full" };
}
