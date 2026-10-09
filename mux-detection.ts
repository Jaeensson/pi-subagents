import type { MuxBackend, MuxContext } from "./mux-core.ts";
import { getHerdrContext } from "./herdr-adapter.ts";

// Detection precedence (per the mux design): PI_SUBAGENT_MUX override → Herdr →
// tmux. Only the Herdr branch exists so far; the tmux branch lands with
// tmux-adapter.ts. Until then a forced tmux (or any other) backend stays inert.
export function detectMux(env: NodeJS.ProcessEnv): { backend: MuxBackend; context: MuxContext } | undefined {
  const override = env.PI_SUBAGENT_MUX?.trim();
  if (override && override !== "herdr") return undefined;
  const context = getHerdrContext(env);
  return context ? { backend: "herdr", context } : undefined;
}
