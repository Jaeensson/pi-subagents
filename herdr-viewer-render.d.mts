import type { ViewerSnapshot } from "./herdr-core.ts";
export function sanitizeText(text: string): string;
export function parseSnapshot(raw: string): ViewerSnapshot | undefined;
export function renderViewer(snapshot: ViewerSnapshot, options: { columns: number; rows: number; now: number; disconnected?: boolean }): string[];
