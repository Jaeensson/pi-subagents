import assert from "node:assert/strict";
import test from "node:test";
import { detectMux } from "../mux-detection.ts";
import { getHerdrContext } from "../herdr-adapter.ts";

test("herdr wins when both environments are present", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "%1", HERDR_SOCKET_PATH: "/s", TMUX: "/tmp/t,1,0", TMUX_PANE: "%9" };
  assert.equal(detectMux(env)?.backend, "herdr");
  assert.deepEqual(detectMux(env)?.context, { backend: "herdr", binary: "herdr", endpoint: "/s", callerPaneId: "%1" });
});

test("no multiplexer environment resolves to undefined", () => {
  assert.equal(detectMux({}), undefined);
  assert.equal(detectMux({ TMUX: "/tmp/t,1,0" }), undefined); // TMUX without TMUX_PANE
});

test("herdr context gate requires HERDR_ENV, pane and socket", () => {
  assert.equal(getHerdrContext({ HERDR_ENV: "0" }), undefined);
  assert.equal(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p" }), undefined);
  assert.deepEqual(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }), { backend: "herdr", binary: "herdr", endpoint: "/s", callerPaneId: "p" });
  assert.equal(getHerdrContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s", HERDR_BIN_PATH: "/bin/herdr" }).binary, "/bin/herdr");
});

test("PI_SUBAGENT_MUX forces herdr and rejects backends without an implementation", () => {
  const env = { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" };
  assert.equal(detectMux({ ...env, PI_SUBAGENT_MUX: "herdr" })?.backend, "herdr");
  assert.equal(detectMux({ ...env, PI_SUBAGENT_MUX: "tmux" }), undefined);
  assert.equal(detectMux({ PI_SUBAGENT_MUX: "herdr" }), undefined); // override still needs a resolvable context
});
