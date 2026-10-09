import type { SlotIdentity } from "./mux-core.ts";
import type { ViewerIdentity, ViewerSnapshot } from "./mux-core.ts";
export interface ViewerDeps {
  readFile(path: string): Promise<string>;
  writeIdentity(path: string, identity: ViewerIdentity): Promise<void>;
  wallNow(): number;
  monotonicNow(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  output: { size(): { columns: number; rows: number }; write(frame: string): void };
  pid: number;
}
export function runViewer(paths: { snapshotPath: string; identityPath: string; identity: SlotIdentity }, deps?: Partial<ViewerDeps>): { stop(): Promise<void> };
export type { ViewerIdentity, ViewerSnapshot };
