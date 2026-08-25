/**
 * live.ts — Pure live-trace state for watching running subagents.
 *
 * No runtime imports from pi packages: this module is unit-testable with
 * `node --test` (Node >= 22.6 type stripping). Keep it to erasable
 * TypeScript syntax only (no enums, no parameter properties).
 */

export const LIVE_TRACE_CAP_BYTES = 64 * 1024;

export type TraceSegment =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string }
	| { kind: "toolCall"; name: string; args: Record<string, unknown> }
	| { kind: "toolOutput"; text: string; isError?: boolean; toolCallId?: string };

export interface LiveTrace {
	/** Chronological sealed segments. */
	segments: TraceSegment[];
	/** Approximate retained bytes (sealed segments + pending stream). */
	bytes: number;
	/** Segments evicted from the head by the ring-buffer cap. */
	dropped: number;
	/** Unsealed stream currently being built (thinking or text). */
	pending: { kind: "thinking" | "text"; text: string } | null;
	/** Bookkeeping: toolCall content indices already emitted (streamed or reconciled). */
	emittedToolIndices: Set<number>;
	/** True between a message_end and the next message's first *_start (blocks stragglers). */
	messageSealed: boolean;
}

export type StyleFn = (color: string, text: string) => string;
export type FormatToolCallFn = (
	name: string,
	args: Record<string, unknown>,
	style: StyleFn,
) => string;

interface JsonEvent {
	type?: string;
	message?: { content?: Array<Record<string, unknown>> };
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
		content?: string;
		contentIndex?: number;
		toolCall?: { name?: unknown; arguments?: unknown };
	};
}

export function emptyLiveTrace(): LiveTrace {
	return { segments: [], bytes: 0, dropped: 0, pending: null, emittedToolIndices: new Set(), messageSealed: false };
}

function segmentBytes(seg: TraceSegment): number {
	const payload =
		seg.kind === "toolCall" ? `${seg.name}${JSON.stringify(seg.args)}` : seg.text;
	return Buffer.byteLength(payload, "utf8");
}

/** Evict whole segments from the head while over cap. Never evicts `pending`. */
function enforceCap(trace: LiveTrace): void {
	while (trace.bytes > LIVE_TRACE_CAP_BYTES && trace.segments.length > 0) {
		const head = trace.segments.shift()!;
		trace.bytes = Math.max(0, trace.bytes - segmentBytes(head));
		trace.dropped++;
	}
}

function sealPending(trace: LiveTrace): void {
	const pending = trace.pending;
	if (!pending) return;
	trace.pending = null;
	if (!pending.text.trim()) {
		trace.bytes = Math.max(0, trace.bytes - Buffer.byteLength(pending.text, "utf8"));
		return;
	}
	trace.segments.push(
		pending.kind === "thinking"
			? { kind: "thinking", text: pending.text }
			: { kind: "text", text: pending.text },
	);
	// Bytes for pending text were already counted when appended.
	enforceCap(trace);
}

/** Append a delta to the open thinking/text stream, sealing a prior stream of a different kind. */
function appendStreamDelta(trace: LiveTrace, kind: "thinking" | "text", delta: string): void {
	if (!delta) return;
	if (!trace.pending || trace.pending.kind !== kind) {
		sealPending(trace);
		trace.pending = { kind, text: "" };
	}
	trace.pending.text += delta;
	trace.bytes += Buffer.byteLength(delta, "utf8");
	enforceCap(trace);
}

/** Handle one text/thinking stream event (`*_start`, `*_delta`, `*_end`). */
function applyStreamDelta(trace: LiveTrace, kind: "thinking" | "text", dt: string, deltaText: string | undefined, content: string | undefined): void {
	if (dt.endsWith("_start")) {
		sealPending(trace);
		trace.pending = { kind, text: "" };
		return;
	}
	if (dt.endsWith("_delta")) {
		appendStreamDelta(trace, kind, deltaText ?? "");
		return;
	}
	// `*_end`: adopt `content` ONLY when the same-kind stream is still pending
	// AND empty (delta-less provider fallback). Never synthesize or disturb a
	// different-kind pending: real providers emit `*_end` after the next stream
	// already started (observed in spike), and the deltas already captured that
	// content — adopting would duplicate/reorder segments. The end seals its own
	// stream only when that stream is still pending.
	if (content) {
		if (trace.pending && trace.pending.kind === kind && !trace.pending.text) {
			trace.pending.text = content;
			trace.bytes += Buffer.byteLength(content, "utf8");
		}
	}
	if (trace.pending?.kind === kind) sealPending(trace);
}

function applyMessageUpdate(event: JsonEvent, trace: LiveTrace): LiveTrace {
	const ame = event.assistantMessageEvent;
	if (ame) {
		const dt = ame.type;
		const deltaText = typeof ame.delta === "string" ? ame.delta : undefined;
		const content = typeof ame.content === "string" ? ame.content : undefined;
		if (dt === "thinking_start" || dt === "text_start" || dt === "toolcall_start") {
			// A new message begins with a *_start: unseal after the previous message_end.
			trace.messageSealed = false;
		}
		if (dt === "thinking_start" || dt === "thinking_delta" || dt === "thinking_end") {
			applyStreamDelta(trace, "thinking", dt, deltaText, content);
		} else if (dt === "text_start" || dt === "text_delta" || dt === "text_end") {
			applyStreamDelta(trace, "text", dt, deltaText, content);
		} else if ((dt === "toolcall_start" || dt === "toolcall_delta" || dt === "toolcall_end") && !trace.messageSealed) {
			// A tool call begins after any open thinking/text stream.
			sealPending(trace);
			if (dt === "toolcall_end") emitToolCall(ame, trace);
		}
	}
	return trace;
}

function parseArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* fall through to raw wrapper */
		}
	}
	return { raw: raw === null ? "null" : String(raw ?? "") };
}

/**
 * Emit a toolCall segment from a streamed toolcall_end, deduped by content
 * index against both streamed and reconcile-emitted segments.
 */
function emitToolCall(ame: NonNullable<JsonEvent["assistantMessageEvent"]>, trace: LiveTrace): void {
	const idx = typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
	if (trace.emittedToolIndices.has(idx)) return;
	const tc = ame.toolCall;
	if (!tc) return;
	const name = typeof tc.name === "string" && tc.name ? tc.name : "?";
	const args = parseArgs(tc.arguments);
	trace.emittedToolIndices.add(idx);
	trace.segments.push({ kind: "toolCall", name, args });
	trace.bytes += segmentBytes({ kind: "toolCall", name, args });
	enforceCap(trace);
}

/** Reconcile at message_end: emit toolCall content parts whose index was never streamed. */
function scanToolCalls(message: { content?: Array<Record<string, unknown>> } | undefined, trace: LiveTrace): void {
	if (!message?.content) return;
	const content = message.content;
	for (let i = 0; i < content.length; i++) {
		if (trace.emittedToolIndices.has(i)) continue;
		const part = content[i];
		if (!part || part.type !== "toolCall") continue;
		trace.emittedToolIndices.add(i);
		const name = typeof part.name === "string" && part.name ? part.name : "?";
		const args = parseArgs(part.arguments);
		trace.segments.push({ kind: "toolCall", name, args });
		trace.bytes += segmentBytes({ kind: "toolCall", name, args });
		enforceCap(trace);
	}
}

/** Reconcile at message end: seal open streams, emit remaining toolCalls, seal the message. */
function applyMessageEnd(event: JsonEvent, trace: LiveTrace): LiveTrace {
	sealPending(trace);
	scanToolCalls(event.message, trace);
	trace.emittedToolIndices.clear();
	trace.messageSealed = true;
	return trace;
}

/** Newest toolOutput; exact toolCallId match preferred, newest unmatched as fallback. */
function lastToolOutputSegment(trace: LiveTrace, toolCallId?: string): TraceSegment | null {
	if (toolCallId !== undefined) {
		for (let i = trace.segments.length - 1; i >= 0; i--) {
			const s = trace.segments[i];
			if (s.kind === "toolOutput" && s.toolCallId === toolCallId) return s;
		}
	}
	for (let i = trace.segments.length - 1; i >= 0; i--) {
		if (trace.segments[i].kind === "toolOutput") return trace.segments[i];
	}
	return null;
}

/**
 * Extract renderable text from a tool result. Real wires send snapshot objects
 * `{ content: [{ type: "text", text }] }`; a plain string is passed through;
 * anything else JSON-stringifies (empty content arrays → "").
 */
function toolResultText(raw: unknown): string {
	if (raw == null) return "";
	if (typeof raw === "string") return raw;
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const content = (raw as Record<string, unknown>).content;
		if (Array.isArray(content)) {
			let out = "";
			for (const part of content) {
				if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
					const text = (part as Record<string, unknown>).text;
					if (typeof text === "string") out += text;
				}
			}
			return out;
		}
	}
	try {
		return JSON.stringify(raw ?? "");
	} catch {
		return String(raw ?? "");
	}
}

/** Replace the targeted toolOutput segment's text (snapshots, not deltas), keeping bytes accurate. */
function setOpenToolOutput(trace: LiveTrace, text: string, toolCallId?: string): void {
	const seg = lastToolOutputSegment(trace, toolCallId);
	if (!seg) return;
	const old = seg.text;
	if (old === text) return;
	seg.text = text;
	const deltaBytes = Buffer.byteLength(text, "utf8") - Buffer.byteLength(old, "utf8");
	trace.bytes += deltaBytes;
	enforceCap(trace);
}

function applyToolExecution(evType: string, event: Record<string, unknown>, trace: LiveTrace): LiveTrace {
	const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
	if (evType === "tool_execution_start") {
		trace.segments.push({ kind: "toolOutput", text: "", toolCallId: id });
		return trace;
	}
	if (evType === "tool_execution_update") {
		if (event.partialResult == null) return trace;
		setOpenToolOutput(trace, toolResultText(event.partialResult), id);
		return trace;
	}
	// tool_execution_end
	if (event.result != null) setOpenToolOutput(trace, toolResultText(event.result), id);
	const seg = lastToolOutputSegment(trace, id);
	if (seg) seg.isError = event.isError === true;
	return trace;
}

/**
 * Parse one child stdout line and reduce live-relevant events into trace.
 * Never throws; non-live or malformed lines leave `trace` untouched.
 */
export function applyLiveEvent(line: string, trace: LiveTrace): LiveTrace {
	if (!line.trim()) return trace;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		return trace;
	}
	return reduceLiveEvent(event as JsonEvent, trace);
}

/** Pure reducer over a parsed event object (exported for direct unit tests). */
export function reduceLiveEvent(event: JsonEvent, trace: LiveTrace): LiveTrace {
	// Literal JSON null (and any non-object payload) is an unrelated line.
	if (!event || typeof event !== "object") return trace;
	switch (event.type) {
		case "message_update":
			return applyMessageUpdate(event, trace);
		case "message_end":
			return applyMessageEnd(event, trace);
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return applyToolExecution(event.type, event, trace);
		default:
			return trace;
	}
}
