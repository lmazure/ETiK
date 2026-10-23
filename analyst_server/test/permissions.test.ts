import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { denyOthers, isInside, pathGuard } from "../src/engine/permissions.js";

let dir: string;
let job: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "analyst-perm-"));
  job = join(dir, "work", "job-1");
  await mkdir(join(job, "acme/app/src"), { recursive: true });
  await writeFile(join(job, "acme/app/src/A.java"), "class A {}");
  await writeFile(join(dir, "secret.txt"), "secret");
  await symlink(join(dir, "secret.txt"), join(job, "acme/app/link.txt"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function decide(tool: string, input: Record<string, unknown>): Promise<string | undefined> {
  const output = await pathGuard(job)({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: job } as unknown as HookInput, "t", { signal: new AbortController().signal });
  const specific = (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
  return specific?.permissionDecision;
}

describe("isInside", () => {
  it("follows symbolic links and '..'", async () => {
    expect(await isInside(job, "acme/app/src/A.java")).toBe(true);
    expect(await isInside(job, join(job, "acme/app/missing/file.java"))).toBe(true);
    expect(await isInside(job, "acme/app/link.txt")).toBe(false);
    expect(await isInside(job, "../../secret.txt")).toBe(false);
    expect(await isInside(job, "/etc/passwd")).toBe(false);
  });
});

describe("pathGuard", () => {
  it("lets Read, Grep and Glob work inside the job's directory", async () => {
    expect(await decide("Read", { file_path: join(job, "acme/app/src/A.java") })).toBeUndefined();
    expect(await decide("Grep", { pattern: "class", path: join(job, "acme/app") })).toBeUndefined();
    expect(await decide("Grep", { pattern: "class" })).toBeUndefined();
    expect(await decide("Glob", { pattern: "**/*.java" })).toBeUndefined();
  });

  it("denies them outside, through a link, and with an absolute or climbing Glob pattern", async () => {
    expect(await decide("Read", { file_path: "/proc/self/environ" })).toBe("deny");
    expect(await decide("Read", { file_path: join(job, "acme/app/link.txt") })).toBe("deny");
    expect(await decide("Grep", { pattern: "TOKEN", path: "/" })).toBe("deny");
    expect(await decide("Glob", { pattern: "/etc/**/*.conf" })).toBe("deny");
    expect(await decide("Glob", { pattern: "../../**/*" })).toBe("deny");
  });

  it("denies every other built-in tool, and leaves the analyst's tools alone", async () => {
    expect(await decide("Bash", { command: "env" })).toBe("deny");
    expect(await decide("WebFetch", { url: "https://example.com" })).toBe("deny");
    expect(await decide("mcp__analyst__git_log", { project: "x" })).toBeUndefined();
  });
});

describe("denyOthers", () => {
  it("allows only the analyst's MCP tools", async () => {
    const options = { signal: new AbortController().signal };
    expect(await denyOthers("mcp__analyst__repo_checkout", {}, options as never)).toEqual({ behavior: "allow" });
    expect(await denyOthers("Bash", {}, options as never)).toMatchObject({ behavior: "deny" });
    expect(await denyOthers("mcp__other__x", {}, options as never)).toMatchObject({ behavior: "deny" });
  });
});
