// Source-checkout-only, explicit opt-in validation. Importing this file is inert.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** @typedef {import('../herdr-adapter.ts').HerdrExec} HerdrExec */
/**
 * @typedef {Object} SmokeDeps
 * @property {string} binary
 * @property {NodeJS.ProcessEnv} env
 * @property {HerdrExec} exec
 * @property {(binary:string,args:string[],env:NodeJS.ProcessEnv)=>import('node:child_process').ChildProcess} spawnServer
 * @property {string} tempRoot
 */
const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const parse = raw => {
  const value = JSON.parse(raw);
  if (typeof value.id !== "string" || !value.result || value.error) throw new Error(`invalid Herdr response: ${raw}`);
  return value.result;
};
async function until(read, timeout, label) {
  const deadline = performance.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  throw new Error(`timed out: ${label}`);
}

/** @param {Partial<SmokeDeps>} supplied @returns {Promise<{sessionName:string;checks:string[]}>} */
export async function runSmoke(supplied = {}) {
  const inherited = supplied.env ?? process.env;
  const binary = supplied.binary ?? inherited.HERDR_BIN_PATH ?? "herdr";
  const exec = supplied.exec ?? ((bin, args, options) => promisify(execFile)(bin, args, options).then(r => String(r.stdout)));
  const spawnServer = supplied.spawnServer ?? ((bin, args, env) => spawn(bin, args, { env, stdio: ["ignore", "ignore", "pipe"] }));
  const sessionName = `ps-${randomUUID().replaceAll("-", "")}`;
  // macOS Unix sockets have a small sun_path limit. Keep the disposable HOME
  // short, and canonicalize it so the returned socket uses the same prefix.
  const root = await fs.realpath(await fs.mkdtemp(path.join(supplied.tempRoot ?? (process.platform === "darwin" ? "/tmp" : os.tmpdir()), "hs-")));
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith("HERDR_") && !["ENV", "BASH_ENV", "ZDOTDIR", "CDPATH"].includes(key)));
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_CACHE_HOME: path.join(root, ".cache"), XDG_DATA_HOME: path.join(root, ".local/share"),
    HERDR_CONFIG_PATH: path.join(root, "config.toml"), PI_CODING_AGENT_DIR: path.join(root, "agent"), SHELL: "/bin/sh", TMPDIR: root, TEMP: root, TMP: root });
  const invoke = async args => {
    try { return await exec(binary, args, { env, timeout: 2000, maxBuffer: 128 * 1024 }); }
    catch (error) { throw new Error(`${binary} ${JSON.stringify(args)}: ${error.message}\n${error.stderr ?? ""}`); }
  };
  const named = args => invoke(["--session", sessionName, ...args]);
  const record = async () => {
    const lines = (await named(["session", "list"])).trim().split(/\r?\n/);
    const row = lines.map(line => line.trim().split(/\s+/)).find(fields => fields[0] === sessionName);
    if (!row) return;
    const [name, status, directory, socket] = row;
    // Neither labels nor merely finding a socket prove ownership. Fresh name,
    // private paths and the still-live process we launched are all required.
    if (name !== sessionName || !directory?.startsWith(root + path.sep) || !socket?.startsWith(directory + path.sep)) throw new Error(`unowned session route: ${row.join(" ")}`);
    return { status, directory, socket };
  };
  let server, owned, serverError = "", spawnError, failure, result, cleanupEvidence = "no server ownership established";
  try {
    await fs.chmod(root, 0o700);
    await fs.mkdir(env.PI_CODING_AGENT_DIR, { mode: 0o700 });
    const defaults = await invoke(["--default-config"]);
    const config = defaults.replace('# default_shell = ""', 'default_shell = "/bin/sh"')
      .replace('# shell_mode = "auto"', 'shell_mode = "non_login"')
      .replace('# version_check = true', 'version_check = false')
      .replace('# manifest_check = true', 'manifest_check = false')
      .replace('# resume_agents_on_restore = true', 'resume_agents_on_restore = false')
      .replace('# headless_cols = 120', 'headless_cols = 240').replace('# headless_rows = 40', 'headless_rows = 80');
    await fs.writeFile(env.HERDR_CONFIG_PATH, config, { mode: 0o600 });
    if (await record()) throw new Error("generated session already exists; refusing adoption");
    server = spawnServer(binary, ["--session", sessionName, "server"], env);
    server.on("error", error => { spawnError = error; });
    server.stderr?.on("data", chunk => { serverError = (serverError + String(chunk)).slice(-4096); });
    owned = await until(async () => {
      if (server.exitCode !== null || spawnError) throw new Error(`server exited or failed: ${spawnError?.message ?? (serverError || server.exitCode)}`);
      const route = await record();
      return route?.status === "running" ? route : undefined;
    }, 10000, "owned named server startup");
    const created = parse(await named(["workspace", "create", "--cwd", root, "--label", "Smoke parent", "--no-focus"]));
    const parent = created.root_pane;
    if (!parent?.pane_id || parent.tab_id !== created.tab?.tab_id || parent.workspace_id !== created.workspace?.workspace_id) throw new Error("invalid authoritative workspace creation IDs");
    const driver = fileURLToPath(new URL("./herdr-monitor-smoke-driver.mjs", import.meta.url));
    const command = ["/usr/bin/env", `PI_CODING_AGENT_DIR=${env.PI_CODING_AGENT_DIR}`, `HERDR_SMOKE_SESSION=${sessionName}`, `HERDR_SMOKE_ROOT=${root}`, `HERDR_SMOKE_SOCKET=${owned.socket}`, `HERDR_SMOKE_PANE=${parent.pane_id}`, `HERDR_SMOKE_BINARY=${binary}`, process.execPath, driver].map(quote).join(" ");
    // Installed 0.8.2 action commands can succeed without stdout. Require the
    // driver's bounded marker from an explicit pane read, never infer success.
    await named(["pane", "run", parent.pane_id, command]);
    const checks = await until(async () => {
      const output = await named(["pane", "read", parent.pane_id, "--source", "recent-unwrapped", "--lines", "200"]);
      let text = output; // installed CLI reads are plain terminal text
      try { text = parse(output).read?.text ?? output; } catch { /* plain CLI output */ }
      const failed = text.match(/^HERDR_SMOKE_FAILED:(.*)$/m);
      if (failed) throw new Error(`driver failure: ${failed[1]}`);
      const passed = text.match(/^HERDR_SMOKE_OK:(\[[^\r\n]*\])$/m);
      if (passed) return JSON.parse(passed[1]);
    }, 120000, "driver completion marker");
    if (!Array.isArray(checks) || !["four-viewers", "reuse", "switches", "heartbeat-loss", "outside-gate"].every(check => checks.includes(check))) throw new Error("incomplete driver checks");
    result = { sessionName, checks };
  } catch (error) {
    failure = error;
    // Preserve evidence before disposable resources are removed. Never inspect
    // logs/config belonging to the inherited/default session.
    const logs = [];
    for (const directory of [root, owned?.directory, path.join(root, ".config/herdr")].filter(Boolean)) {
      for (const name of ["herdr.log", "herdr-server.log"]) {
        try { logs.push(`${name}: ${(await fs.readFile(path.join(directory, name), "utf8")).slice(-4096)}`); } catch { /* absent */ }
      }
    }
    failure.message += `\nowned server exit=${server?.exitCode}; stderr=${serverError}; ${logs.join("\n")}`;
  }
  finally {
    try {
      if (owned) {
        const route = await record();
        if (!route || route.directory !== owned.directory || route.socket !== owned.socket) throw new Error("cleanup ownership changed; refusing stop/delete");
        const stopped = async () => {
          const current = await record();
          if (!current || current.directory !== owned.directory || current.socket !== owned.socket) throw new Error("cleanup ownership changed");
          return current.status === "stopped";
        };
        try { await named(["session", "stop", sessionName]); }
        catch (error) {
          // A crashing owned server may remove its socket before stop reaches
          // it. Delete only after both our process and the named route agree.
          try { await until(async () => server.exitCode !== null && await stopped(), 2000, "owned server already exited"); }
          catch { throw error; }
        }
        await until(stopped, 10000, "named server stopped");
        await named(["session", "delete", sessionName]);
        if (await record()) throw new Error("named session still exists after delete");
        cleanupEvidence = `named stop/delete verified absent: ${sessionName}`;
      }
    } catch (error) { failure = new AggregateError([failure, error].filter(Boolean), `smoke/cleanup failed: ${failure?.message ?? ""}; ${error.message}`); }
    await fs.rm(root, { recursive: true, force: true });
    if (failure) failure.message += `\ncleanup=${cleanupEvidence}; private root removed: ${root}`;
  }
  if (failure) throw Object.assign(failure, { sessionName });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runSmoke().then(result => console.log(JSON.stringify(result)), error => {
    console.error(`HERDR_SMOKE_FAILED session=${error.sessionName ?? "not-started"}: ${error.stack}`);
    process.exitCode = 1;
  });
}
