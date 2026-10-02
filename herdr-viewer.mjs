import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DISCONNECTED_AFTER_MS, EXIT_AFTER_MS, HEARTBEAT_INTERVAL_MS, VIEWER_POLL_MS, parseSnapshot, renderViewer } from "./herdr-viewer-render.mjs";

async function writePrivateIdentity(file, identity) {
  const temp = path.join(path.dirname(file), `.identity-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    await fs.writeFile(temp, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    await fs.chmod(temp, 0o600);
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export function runViewer(paths, supplied = {}) {
  const deps = { readFile: file => fs.readFile(file, "utf8"), writeIdentity: writePrivateIdentity,
    wallNow: () => Date.now(), monotonicNow: () => performance.now(), setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle), output: { size: () => ({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }), write: frame => process.stdout.write(frame) }, pid: process.pid, ...supplied };
  const identity = paths.identity;
  let lastSeq = -1; let lastAccepted = deps.monotonicNow(); let lastFrame = ""; let disconnected = true; let stopped = false; let running = false;
  let lastIdentityAt = -Infinity;
  let lastSize = "";
  let timer;
  const stop = async () => { if (stopped) return; stopped = true; if (timer !== undefined) deps.clearInterval(timer); };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const mono = deps.monotonicNow();
      try {
        const raw = await deps.readFile(paths.snapshotPath);
        const value = parseSnapshot(raw);
        if (value && value.activationId === identity.activationId && value.slotId === identity.slotId && value.nonce === identity.nonce && value.seq > lastSeq) {
          lastSeq = value.seq; lastAccepted = mono;
          const age = mono - lastAccepted;
          const isDisconnected = age >= DISCONNECTED_AFTER_MS;
          const { columns, rows } = deps.output.size();
          const lines = renderViewer(value, { columns, rows, now: isDisconnected ? value.heartbeatAt + DISCONNECTED_AFTER_MS + 1 : value.heartbeatAt, disconnected: isDisconnected });
          const frame = `\u001b[H\u001b[2J${lines.join("\n")}`;
          deps.output.write(frame); lastFrame = frame; disconnected = isDisconnected;
        }
      } catch {}
      const since = mono - lastAccepted;
      if (since >= EXIT_AFTER_MS) { await stop(); return; }
      const isDisconnected = since >= DISCONNECTED_AFTER_MS;
      if (lastSeq >= 0) {
        try {
          const { columns, rows } = deps.output.size();
          const size = `${columns}x${rows}`;
          if (isDisconnected !== disconnected || size !== lastSize) {
            const raw = await deps.readFile(paths.snapshotPath); const value = parseSnapshot(raw);
            if (value && value.seq === lastSeq && value.activationId === identity.activationId && value.slotId === identity.slotId && value.nonce === identity.nonce) {
              const frame = `\u001b[H\u001b[2J${renderViewer(value, { columns, rows, now: isDisconnected ? value.heartbeatAt + DISCONNECTED_AFTER_MS + 1 : value.heartbeatAt, disconnected: isDisconnected }).join("\n")}`;
              if (frame !== lastFrame) deps.output.write(frame);
              lastFrame = frame; disconnected = isDisconnected; lastSize = size;
            }
          }
        } catch {}
      }
      if (mono - lastIdentityAt >= HEARTBEAT_INTERVAL_MS) {
        lastIdentityAt = mono;
        try { await deps.writeIdentity(paths.identityPath, { version: 1, ...identity, pid: deps.pid, heartbeatAt: deps.wallNow() }); } catch {}
      }
    } finally { running = false; }
  };
  timer = deps.setInterval(() => tick().catch(() => {}), VIEWER_POLL_MS);
  return { stop };
}

function parseArgs(args) {
  const names = ["--snapshot", "--identity", "--activation", "--slot", "--nonce"];
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!names.includes(flag) || flag in result || typeof args[i + 1] !== "string" || args[i + 1].startsWith("--")) throw new Error("expected --snapshot <path> --identity <path> --activation <id> --slot <id> --nonce <nonce>");
    result[flag] = args[i + 1];
  }
  if (names.some(name => !(name in result)) || !result["--snapshot"] || !result["--identity"] || !result["--activation"] || !result["--nonce"] || !/^(0|[1-3])$/.test(result["--slot"])) throw new Error("invalid viewer arguments");
  return { snapshotPath: result["--snapshot"], identityPath: result["--identity"], identity: { activationId: result["--activation"], slotId: Number(result["--slot"]), nonce: result["--nonce"] } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const paths = parseArgs(process.argv.slice(2));
    const viewer = runViewer(paths);
    process.once("SIGINT", () => { void viewer.stop(); });
    process.once("SIGTERM", () => { void viewer.stop(); });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
