import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node-pty";
import { buildApp } from "./app.js";
import { SessionManager } from "./session.js";
import { loadSettings } from "./settings.js";
import { ConfigurationStore } from "./store.js";
import { builtinSkills, type Owner } from "./workspace.js";

const run = promisify(execFile);
const settings = loadSettings();
settings.webRoot ??= fileURLToPath(new URL("./web", import.meta.url));

// In the container, the console runs as root (it programs the firewall) and Claude Code as the agent user.
const isRoot = process.getuid?.() === 0;
let owner: Owner | undefined;
if (isRoot) {
  const id = (flag: string) => Number(execFileSync("id", [flag, settings.agentUser], { encoding: "utf8" }).trim());
  owner = { uid: id("-u"), gid: id("-g") };
}

const skills = () => builtinSkills(settings.builtinSkillsDir);
const store = new ConfigurationStore(settings.stateDir, skills);
const sessions = new SessionManager(settings, store, {
  spawnClaude: (args, options) => {
    const [file, fileArgs] = isRoot
      ? ["setpriv", ["--reuid", settings.agentUser, "--regid", settings.agentUser, "--init-groups", "--", settings.claudeCommand, ...args]]
      : [settings.claudeCommand, args];
    return spawn(file, fileArgs, { name: "xterm-256color", ...options });
  },
  applyFirewall: async (domains, hostPorts) => {
    if (!isRoot) return "(not root: firewall not applied)";
    const args = [...domains.flatMap((d) => ["--domain", d]), ...hostPorts.flatMap((p) => ["--host-port", String(p)])];
    try {
      const { stdout, stderr } = await run(settings.firewallScript, args, { timeout: 120_000 });
      return stdout + stderr;
    } catch (error) {
      const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
      throw new Error(`the firewall could not be applied:\n${stdout}${stderr}`);
    }
  },
  killAgentProcesses: async () => {
    if (!isRoot) return;
    // pkill exits with 1 when nothing matched.
    await run("pkill", ["-KILL", "-u", settings.agentUser]).catch(() => undefined);
  },
  httpGet: async (url, headers) => (await fetch(url, { headers, signal: AbortSignal.timeout(5000) })).status,
  owner,
  env: process.env,
});

const app = buildApp(store, sessions, skills, settings.webRoot, { logger: { level: process.env.LOG_LEVEL ?? "info" } });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await sessions.close();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: settings.host, port: settings.port });
