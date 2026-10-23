/**
 * What the analyses' agent may do. Its only built-in tools are Read, Grep and Glob, and they may only reach the
 * job's directory (the checkouts): a PreToolUse hook checks every call, since Claude Code does not ask before
 * reading. Every other tool is denied, except the analyst's own MCP tools.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CanUseTool, HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export const BUILTIN_TOOLS = ["Read", "Grep", "Glob"];
export const MCP_SERVER_NAME = "analyst";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The real path of `path`, or of its closest existing parent joined with the rest (a file may not exist). */
async function realPathOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(await realPathOf(parent), relative(parent, path));
  }
}

/** Whether `path` (absolute, or relative to `root`) stays inside `root` once symbolic links are followed. */
export async function isInside(root: string, path: string): Promise<boolean> {
  const realRoot = await realPathOf(root);
  const target = await realPathOf(isAbsolute(path) ? path : resolve(root, path));
  const rel = relative(realRoot, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The part of a glob pattern before its first wildcard, e.g. `/etc` for `/etc/**\/*.conf`. */
function staticPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const index = segments.findIndex((s) => /[*?[{]/.test(s));
  const prefix = (index < 0 ? segments : segments.slice(0, index)).join("/");
  return prefix === "" && pattern.startsWith("/") ? "/" : prefix || ".";
}

/** The paths a built-in tool call reads; the working directory (the job's directory) when none is given. */
function pathsOf(tool: string, input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const value = tool === "Read" ? input.file_path : input.path;
  if (typeof value === "string" && value !== "") paths.push(value);
  // A Glob pattern may itself be absolute or climb out of the directory.
  if (tool === "Glob" && typeof input.pattern === "string" && (isAbsolute(input.pattern) || input.pattern.includes(".."))) {
    paths.push(isAbsolute(input.pattern) ? staticPrefix(input.pattern) : join(typeof value === "string" ? value : "", staticPrefix(input.pattern)));
  }
  return paths;
}

function decision(permissionDecision: "allow" | "deny", reason?: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } };
}

/** PreToolUse hook: Read, Grep and Glob only inside `root`; anything else that is not ours is denied. */
export function pathGuard(root: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    if (tool.startsWith(MCP_PREFIX)) return {};
    if (!BUILTIN_TOOLS.includes(tool)) return decision("deny", `${tool} is not available to the analyst.`);
    for (const path of pathsOf(tool, (input.tool_input ?? {}) as Record<string, unknown>)) {
      if (!(await isInside(root, path))) {
        return decision("deny", `${path} is outside the checkouts (${root}); check out a project with repo_checkout and read inside it.`);
      }
    }
    return {};
  };
}

/** Anything that would need a permission is denied: nobody approves calls in the analyst. */
export const denyOthers: CanUseTool = async (toolName) =>
  toolName.startsWith(MCP_PREFIX)
    ? { behavior: "allow" }
    : { behavior: "deny", message: `${toolName} is not available to the analyst.` };
