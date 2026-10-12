import { posix } from "node:path";
import { z } from "zod";

/**
 * A configuration is a folder:
 * - `config.json` (see `configSchema`);
 * - the system prompt file it names;
 * - `skills/<name>/` for each skill that is not built into the image;
 * - `files/`, copied as-is into the workspace at each session start.
 */
export const CONFIG_FILE = "config.json";
export const SKILLS_DIR = "skills";
export const FILES_DIR = "files";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 500;

const hostname = z.string().regex(
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/,
  "must be a host name",
);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be letters, digits, '.', '_' or '-'");

export const configSchema = z.strictObject({
  /** Shown in the console. */
  name: z.string().min(1).max(200),
  /** Path, in the configuration folder, of the system prompt appended to Claude Code's one. */
  systemPrompt: z.string().min(1),
  /** Internet domains Claude Code may reach, on top of the Anthropic ones. */
  domains: z.array(hostname).default([]),
  /** Ports Claude Code may reach on the Docker host (host.docker.internal). */
  hostPorts: z.array(z.number().int().min(1).max(65535)).default([]),
  tools: z.strictObject({
    /** Claude Code built-in tools (`claude --tools`): "default" for all of them, or their names. */
    builtin: z.union([z.literal("default"), z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be a tool name"))]),
    /** MCP servers, in the `mcpServers` format of `.mcp.json`; `${VAR}` is expanded by Claude Code. */
    mcpServers: z.record(name, z.record(z.string(), z.unknown())).default({}),
  }),
  /** Skills: a folder `skills/<name>/` of the configuration, or a skill built into the image. */
  skills: z.array(name).default([]),
  /** Environment variables of the container passed on to Claude Code (e.g. tokens from memory.env). */
  env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")).default([]),
  /** HTTP GETs that must answer 2xx before a session starts; `${VAR}` is expanded from the container environment. */
  checks: z.array(z.strictObject({
    name: z.string().min(1),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
  })).default([]),
});

export type ConfigFile = z.infer<typeof configSchema>;

export class ConfigurationError extends Error {
  constructor(readonly problems: string[], readonly statusCode = 400) {
    super(problems.join("\n"));
  }
}

/** A configuration id is the name of its folder. */
export function checkId(id: string): void {
  if (!name.safeParse(id).success) throw new ConfigurationError([`invalid configuration name '${id}': use letters, digits, '.', '_' or '-'`]);
}

/** Normalizes a path relative to the configuration folder; rejects anything that would escape it. */
export function relativePath(raw: string): string {
  const path = raw.replaceAll("\\", "/");
  const normalized = posix.normalize(path);
  if (path.startsWith("/") || path.includes("\0") || normalized === "."
    || normalized.split("/").some((part) => part === "" || part === "..")) {
    throw new ConfigurationError([`invalid path '${raw}'`]);
  }
  return normalized;
}

/**
 * Validates the files of a configuration folder (paths relative to the folder) and returns its config.json.
 * `builtinSkills` are the skills baked into the image.
 */
export function validateConfiguration(files: ReadonlyMap<string, Buffer>, builtinSkills: readonly string[]): ConfigFile {
  const problems: string[] = [];
  if (files.size > MAX_FILES) problems.push(`too many files (${files.size}, at most ${MAX_FILES})`);
  let total = 0;
  for (const [path, content] of files) {
    total += content.length;
    if (content.length > MAX_FILE_BYTES) problems.push(`${path} is too large (at most ${MAX_FILE_BYTES} bytes)`);
  }
  if (total > MAX_TOTAL_BYTES) problems.push(`the configuration is too large (at most ${MAX_TOTAL_BYTES} bytes)`);

  const raw = files.get(CONFIG_FILE);
  if (!raw) throw new ConfigurationError([...problems, `${CONFIG_FILE} is missing`]);
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new ConfigurationError([...problems, `${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`]);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${CONFIG_FILE}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new ConfigurationError(problems);
  }
  const config = parsed.data;

  let promptPath: string | undefined;
  try {
    promptPath = relativePath(config.systemPrompt);
  } catch {
    problems.push(`${CONFIG_FILE}: systemPrompt: invalid path '${config.systemPrompt}'`);
  }
  if (promptPath !== undefined && !files.has(promptPath)) problems.push(`the system prompt file '${config.systemPrompt}' is missing`);
  for (const skill of config.skills) {
    if (!files.has(`${SKILLS_DIR}/${skill}/SKILL.md`) && !builtinSkills.includes(skill)) {
      problems.push(`skill '${skill}': neither ${SKILLS_DIR}/${skill}/SKILL.md nor a built-in skill (${builtinSkills.join(", ") || "none"})`);
    }
  }
  if (problems.length > 0) throw new ConfigurationError(problems);
  return config;
}
