import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_BASENAME } from "./identity.ts";

export function expandTildePath(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured ? expandTildePath(configured, home) : join(home, ".pi", "agent");
}

/** `~/.pi/agent/extensions/opencode-go-usage.json` — the user-wide config. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(piAgentDir(env, home), "extensions", CONFIG_BASENAME);
}

/** `<project>/.pi/extensions/opencode-go-usage.json` — layered over the global one. */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", CONFIG_BASENAME);
}
