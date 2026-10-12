import { chownSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FILES_DIR, SKILLS_DIR } from "./configuration.js";
import type { Configuration } from "./store.js";

export interface Owner {
  uid: number;
  gid: number;
}

/** Name of the next session directory: session_01, session_02… after the highest existing number. */
export function nextSessionName(workspaceDir: string): string {
  let last = 0;
  for (const entry of existsSync(workspaceDir) ? readdirSync(workspaceDir, { withFileTypes: true }) : []) {
    const match = /^session_(\d+)$/.exec(entry.name);
    if (entry.isDirectory() && match) last = Math.max(last, Number(match[1]));
  }
  return `session_${String(last + 1).padStart(2, "0")}`;
}

/**
 * Prepares the workspace for a session of `configuration`:
 * - creates the session directory;
 * - replaces `.claude/skills/` with exactly the selected skills;
 *   a built-in skill also brings the other files its installer produced (e.g. `.playwright/cli.config.json`);
 * - copies the configuration's `files/` over the workspace, last, so that they can override built-in files.
 * Everything written is given to `owner` (the agent user) when set.
 */
export function prepareWorkspace(
  workspaceDir: string,
  configuration: Configuration,
  builtinDir: string,
  sessionName: string,
  owner: Owner | undefined,
): void {
  mkdirSync(join(workspaceDir, sessionName), { recursive: true });
  chown(join(workspaceDir, sessionName), owner);

  const claudeDir = join(workspaceDir, ".claude");
  const skillsDir = join(claudeDir, "skills");
  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of configuration.config.skills) {
    const uploaded = join(configuration.dir, SKILLS_DIR, skill);
    if (existsSync(uploaded)) {
      cpSync(uploaded, join(skillsDir, skill), { recursive: true });
      continue;
    }
    const installed = join(builtinDir, skill);
    cpSync(join(installed, ".claude", "skills", skill), join(skillsDir, skill), { recursive: true });
    for (const entry of readdirSync(installed)) {
      if (entry !== ".claude") copyInto(workspaceDir, installed, entry, owner);
    }
  }
  chown(claudeDir, owner);

  const files = join(configuration.dir, FILES_DIR);
  if (existsSync(files)) {
    for (const entry of readdirSync(files)) copyInto(workspaceDir, files, entry, owner);
  }
}

/** Copies `<from>/<entry>` into the workspace, over what is there. */
function copyInto(workspaceDir: string, from: string, entry: string, owner: Owner | undefined): void {
  const target = join(workspaceDir, entry);
  cpSync(join(from, entry), target, { recursive: true, force: true });
  chown(target, owner);
}

/** The installed built-in skills: the directories `<builtinDir>/<name>/` holding `.claude/skills/<name>/SKILL.md`. */
export function builtinSkills(builtinDir: string): string[] {
  if (!existsSync(builtinDir)) return [];
  return readdirSync(builtinDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(builtinDir, entry.name, ".claude", "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/** Recursive chown; symbolic links are not followed. */
export function chown(path: string, owner: Owner | undefined): void {
  if (!owner) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chownSync(path, owner.uid, owner.gid);
  if (stat.isDirectory()) for (const entry of readdirSync(path)) chown(join(path, entry), owner);
}

/** Expands `${VAR}` and `${VAR:-default}` from `env`, like Claude Code does in `.mcp.json`; unset variables become "". */
export function expandVariables(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : (fallback ?? "");
  });
}

/** Arguments of `claude` for a session. */
export function claudeArguments(configuration: Configuration, systemPrompt: string, mcpConfigFile: string): string[] {
  const builtin = configuration.config.tools.builtin;
  return [
    "--dangerously-skip-permissions",
    "--append-system-prompt", systemPrompt,
    "--tools", builtin === "default" ? "default" : builtin.join(","),
    "--mcp-config", mcpConfigFile,
    "--strict-mcp-config",
  ];
}
