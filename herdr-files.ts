import * as nodeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlotIdentity, ViewerIdentity, ViewerSnapshot } from "./herdr-core.ts";
import { SNAPSHOT_MAX_BYTES } from "./herdr-viewer-render.mjs";

export type SnapshotFsDeps = { fs?: Pick<typeof import("node:fs/promises"), "mkdtemp" | "chmod" | "writeFile" | "rename" | "rm" | "readFile">; tempRoot?: string };
export interface SnapshotStore {
  openSlot(identity: SlotIdentity): Promise<{ snapshotPath: string; identityPath: string }>;
  publish(slotId: number, snapshot: ViewerSnapshot, isCurrent: () => boolean): Promise<void>;
  readIdentity(slotId: number): Promise<ViewerIdentity | undefined>;
  dispose(): Promise<void>;
}

type Slot = { identity: SlotIdentity; snapshotPath: string; identityPath: string; busy: boolean; pending?: { snapshot: ViewerSnapshot; isCurrent: () => boolean }; waiters: Array<() => void> };
export function createSnapshotStore(deps: SnapshotFsDeps = {}): SnapshotStore {
  const fs = deps.fs ?? nodeFs;
  const root = deps.tempRoot ?? os.tmpdir();
  let directoryPromise: Promise<string> | undefined;
  let disposed = false;
  const slots = new Map<number, Slot>();
  const writes = new Set<Promise<void>>();
  const directory = () => directoryPromise ??= (async () => {
    const dir = await fs.mkdtemp(path.join(root, "pi-herdr-viewer-"));
    await fs.chmod(dir, 0o700);
    return dir;
  })();
  async function atomicWrite(file: string, content: string, isCurrent: () => boolean): Promise<void> {
    const dir = path.dirname(file);
    const temp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
    try {
      if (!isCurrent() || disposed) return;
      await fs.writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await fs.chmod(temp, 0o600);
      if (!isCurrent() || disposed) return;
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  async function drain(slot: Slot): Promise<void> {
    if (slot.busy) return;
    slot.busy = true;
    try {
      while (slot.pending && !disposed) {
        const item = slot.pending; slot.pending = undefined;
        const promise = directory().then(dir => atomicWrite(path.join(dir, path.basename(slot.snapshotPath)), JSON.stringify(item.snapshot), item.isCurrent));
        writes.add(promise);
        try { await promise; } catch {} finally { writes.delete(promise); }
      }
    } finally {
      slot.busy = false;
      for (const resolve of slot.waiters.splice(0)) resolve();
      if (slot.pending && !disposed) void drain(slot);
    }
  }
  return {
    async openSlot(identity) {
      if (disposed) throw new Error("snapshot store is disposed");
      if (!Number.isSafeInteger(identity.slotId) || identity.slotId < 0 || identity.slotId >= 4 || !identity.activationId || !identity.nonce) throw new RangeError("invalid slot identity");
      const existing = slots.get(identity.slotId);
      if (existing) {
        if (existing.identity.activationId !== identity.activationId || existing.identity.nonce !== identity.nonce) throw new Error("slot identity mismatch");
        return { snapshotPath: existing.snapshotPath, identityPath: existing.identityPath };
      }
      if (slots.size >= 4) throw new RangeError("snapshot store supports at most four slots");
      const dir = await directory();
      if (disposed) throw new Error("snapshot store is disposed");
      const slot = { identity: { ...identity }, snapshotPath: path.join(dir, `slot-${identity.slotId}.json`), identityPath: path.join(dir, `slot-${identity.slotId}.identity.json`), busy: false, waiters: [] };
      slots.set(identity.slotId, slot);
      return { snapshotPath: slot.snapshotPath, identityPath: slot.identityPath };
    },
    async publish(slotId, snapshot, isCurrent) {
      if (disposed) return;
      const slot = slots.get(slotId);
      if (!slot) throw new Error("slot is not open");
      if (snapshot.slotId !== slotId || snapshot.activationId !== slot.identity.activationId || snapshot.nonce !== slot.identity.nonce || Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_MAX_BYTES) throw new TypeError("invalid snapshot for slot");
      slot.pending = { snapshot, isCurrent };
      const complete = new Promise<void>(resolve => slot.waiters.push(resolve));
      void drain(slot);
      await complete;
    },
    async readIdentity(slotId) {
      const slot = slots.get(slotId);
      if (!slot || disposed) return;
      try {
        const value = JSON.parse(await fs.readFile(slot.identityPath, "utf8")) as ViewerIdentity;
        if (value.version !== 1 || value.activationId !== slot.identity.activationId || value.slotId !== slotId || value.nonce !== slot.identity.nonce || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isFinite(value.heartbeatAt)) return;
        return value;
      } catch { return; }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of slots.values()) { slot.pending = undefined; for (const resolve of slot.waiters.splice(0)) resolve(); }
      if (directoryPromise) {
        const dir = await directoryPromise.catch(() => undefined);
        while (writes.size) await Promise.allSettled([...writes]);
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      slots.clear();
    },
  };
}
