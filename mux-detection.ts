import type { MuxBackend, MuxContext } from "./mux-core.ts";
import { getHerdrContext } from "./herdr-adapter.ts";
import { getTmuxContext } from "./tmux-adapter.ts";

// Detection precedence (per the mux design): PI_SUBAGENT_MUX override → Herdr →
// tmux. An override forces one backend; it never falls through to the other, and
// still requires that backend's context to resolve. Unknown overrides are inert.
export function detectMux(env: NodeJS.ProcessEnv): { backend: MuxBackend; context: MuxContext } | undefined {
  const override = env.PI_SUBAGENT_MUX?.trim();
  if (override === "herdr" || override === "tmux") {
    const context = override === "herdr" ? getHerdrContext(env) : getTmuxContext(env);
    return context ? { backend: override, context } : undefined;
  }
  if (override) return undefined;
  const herdr = getHerdrContext(env);
  if (herdr) return { backend: "herdr", context: herdr };
  const tmux = getTmuxContext(env);
  return tmux ? { backend: "tmux", context: tmux } : undefined;
}
