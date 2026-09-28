import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_OUTPUT_CAP_BYTES = 50 * 1024;
export const DEFAULT_OUTPUT_CAP_LINES = 2000;
export const MAX_OUTPUT_LINES = DEFAULT_OUTPUT_CAP_LINES;

export function truncateUtf8(text: string, maxBytes: number, suffix = "…"): string {
	const cap = Math.max(0, Math.floor(maxBytes));
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const contentCap = Math.max(0, cap - suffixBytes);
	const kept: string[] = [];
	let used = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (used + size > contentCap) break;
		kept.push(char);
		used += size;
	}
	return `${kept.join("")}${suffixBytes <= cap ? suffix : ""}`;
}

/** Read a persisted full-output sidecar; unavailable or unreadable artifacts fall back to the compact result. */
export function readOutputArtifact(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	try { return fs.readFileSync(filePath, "utf8"); } catch { return undefined; }
}

export interface BoundOutputOptions {
	maxBytes?: number;
	maxLines?: number;
	artifactPath?: string;
}

/**
 * Bound a complete rendered result, including its truncation note. It scans
 * source code points once and retains only the prefix that can fit, avoiding
 * repeated encoding/concatenation and memory proportional to discarded text.
 */
export function boundOutput(text: string, options: BoundOutputOptions = {}): string {
	const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? DEFAULT_OUTPUT_CAP_BYTES));
	const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_OUTPUT_CAP_LINES));
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= maxBytes && lineCount(text) <= maxLines) return text;

	const markerFor = (omitted: number) => options.artifactPath
		? `[Output truncated: ${Math.max(0, omitted)} bytes omitted. Full output: ${options.artifactPath}]`
		: `[Output truncated: ${Math.max(0, omitted)}B; artifact unavailable]`;
	// Reserve the longest likely note (all source bytes omitted) and its line
	// separator before scanning. The actual note can only be shorter.
	const markerReserve = Buffer.byteLength(markerFor(totalBytes), "utf8");
	const separator = maxLines > 1 ? "\n" : "";
	const prefixBudget = Math.max(0, maxBytes - markerReserve - Buffer.byteLength(separator, "utf8"));
	const prefixLineLimit = maxLines > 1 ? maxLines - 1 : maxLines;
	const prefix: string[] = [];
	let keptBytes = 0;
	let prefixLines = 1;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (keptBytes + size > prefixBudget) break;
		const nextLines = prefixLines + (char === "\n" ? 1 : 0);
		if (nextLines > prefixLineLimit) break;
		prefix.push(char);
		keptBytes += size;
		prefixLines = nextLines;
	}
	const kept = prefix.join("");
	const actualSeparator = kept.length > 0 ? separator : "";
	let result = `${kept}${actualSeparator}${markerFor(totalBytes - keptBytes)}`;
	// Very small custom budgets cannot fit a descriptive notice.
	if (Buffer.byteLength(result, "utf8") > maxBytes || lineCount(result) > maxLines) {
		const fallback = "[truncated]";
		result = Buffer.byteLength(fallback, "utf8") <= maxBytes && maxLines >= 1 ? fallback : "";
	}
	return result;
}

function lineCount(text: string): number {
	let lines = 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
	return lines;
}

/** Persist full output beside durable task transcripts or in a private temp dir. */
export function writeOutputArtifact(
	text: string,
	options: { taskId: string; tasksDir?: string },
): { path: string; bytes: number } {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.taskId) || options.taskId === "." || options.taskId === "..") {
		throw new Error("Invalid task id for output artifact");
	}
	let directory: string;
	if (options.tasksDir) {
		directory = options.tasksDir;
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		try { fs.chmodSync(directory, 0o700); } catch { /* platform may not support chmod */ }
	} else {
		// Deliberately separate from the prompt temp directory: that directory is
		// removed at child finalization, while output artifacts must survive it.
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-output-"));
		try { fs.chmodSync(directory, 0o700); } catch { /* platform may not support chmod */ }
	}
	const filePath = path.join(directory, `${options.taskId}-output.txt`);
	fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
	try { fs.chmodSync(filePath, 0o600); } catch { /* platform may not support chmod */ }
	return { path: filePath, bytes: Buffer.byteLength(text, "utf8") };
}
