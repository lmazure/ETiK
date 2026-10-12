/** Settings of the console, from its environment (see the Dockerfile for the values used in the container). */
export interface Settings {
  host: string;
  port: number;
  /** Where uploaded configurations are kept (root only). */
  stateDir: string;
  /** Working directory of Claude Code; the session_## directories accumulate there. */
  workspaceDir: string;
  /** Where the MCP configuration of the running session is written. */
  runDir: string;
  /**
   * Skills baked into the image: `<builtinDir>/<skill>/` is what the skill's installer produced,
   * i.e. `.claude/skills/<skill>/` and the files it goes with (e.g. `.playwright/cli.config.json`).
   */
  builtinDir: string;
  firewallScript: string;
  /** User Claude Code runs as. */
  agentUser: string;
  agentHome: string;
  /** Command line used to run Claude Code (it runs it as the agent user). */
  claudeCommand: string;
  /** Directory of the built web app; not served when missing. */
  webRoot: string | undefined;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env, "ETIK_PORT", 7681),
    stateDir: env.ETIK_STATE_DIR ?? "/var/lib/etik",
    workspaceDir: env.ETIK_WORKSPACE_DIR ?? "/workspace",
    runDir: env.ETIK_RUN_DIR ?? "/run/etik",
    builtinDir: env.ETIK_BUILTIN_DIR ?? "/opt/etik/builtin",
    firewallScript: env.ETIK_FIREWALL_SCRIPT ?? "/usr/local/bin/init-firewall.sh",
    agentUser: env.ETIK_AGENT_USER ?? "node",
    agentHome: env.ETIK_AGENT_HOME ?? "/home/node",
    claudeCommand: env.ETIK_CLAUDE_COMMAND ?? "claude",
    webRoot: env.ETIK_WEB_ROOT || undefined,
  };
}
