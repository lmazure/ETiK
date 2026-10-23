/**
 * Git commands run by the server: `execFile` with a fixed argument list (never a shell), no pager, no external
 * diff or textconv, no hooks. Inputs coming from the agent (revisions, paths) are validated first.
 */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AnalystError } from "../errors.js";

const BASE_ARGS = ["-c", "core.pager=cat", "-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false"];
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export function runGit(args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", [...BASE_ARGS, ...args], {
      cwd: options.cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", GIT_TERMINAL_PROMPT: "0", ...options.env },
      maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? 10 * 60_000,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim().split("\n").slice(-3).join(" ");
        reject(new AnalystError("REPO_ERROR", `git ${args.find((a) => !a.startsWith("-")) ?? ""} failed: ${detail}`));
      } else {
        resolvePromise(stdout);
      }
    });
  });
}

/** A revision as the agent may give it: a SHA, a branch or tag name, `HEAD~2`, `abc123^`. */
export function checkRevision(rev: string): string {
  if (!/^[A-Za-z0-9._/~^-]+$/.test(rev) || rev.startsWith("-") || rev.length > 200) {
    throw new AnalystError("INVALID_ARGUMENT", `'${rev}' is not a revision (a SHA, a branch or tag name, HEAD~2…).`);
  }
  return rev;
}

/** A path relative to a worktree, refused if it leaves it. Returns it relative to the worktree, with `/`. */
export function checkPath(worktree: string, path: string): string {
  const rel = relative(worktree, resolve(worktree, path));
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AnalystError("INVALID_ARGUMENT", `'${path}' is outside the checkout.`);
  }
  return rel.split(sep).join("/");
}
