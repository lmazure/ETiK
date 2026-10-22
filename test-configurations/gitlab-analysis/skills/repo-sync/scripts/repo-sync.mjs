import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { parseArgs } from "util";

const GITLAB_URL = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const REPOS_DIR  = process.env.REPOS_DIR || "/repos";

const USAGE = "Usage: repo-sync.mjs <project path> [<branch | tag | commit>] [--discard]";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)+$/;
const VERSION_TAG_RE = /\d+\.\d+/;

function fail(message) {
  throw new Error(message);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: { discard: { type: "boolean", default: false } },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length < 1 || positionals.length > 2) fail(`expected a project path and an optional ref\n${USAGE}`);
  const [project, ref] = positionals;
  if (!PROJECT_RE.test(project) || project.split("/").some(p => p === "." || p === "..") || project.endsWith(".git")) {
    fail(`invalid project path (e.g. henixdevelopment/squash/squash-tm/core/squash-tm): ${project}`);
  }
  if (ref !== undefined && (ref.startsWith("-") || /[\s~^:?*[\\]/.test(ref))) fail(`invalid ref: ${ref}`);
  const token = process.env.GITLAB_READ_TOKEN;
  if (!token) fail("GITLAB_READ_TOKEN environment variable is not set");
  return { project, ref, token, discard: values.discard };
}

/** Refuses a token that could write: Claude Code runs unsupervised here, so it must only read. */
async function checkReadOnly(token) {
  let res;
  try {
    res = await fetch(`${GITLAB_URL}/api/v4/personal_access_tokens/self`, { headers: { "PRIVATE-TOKEN": token } });
  } catch (e) {
    fail(`GitLab unreachable at ${GITLAB_URL}: ${e.cause?.message ?? e.message}`);
  }
  const json = await res.json().catch(() => undefined);
  if (!res.ok) fail(`cannot check GITLAB_READ_TOKEN (HTTP ${res.status}): ${json?.message ?? json?.error ?? res.statusText}`);
  const writing = (json?.scopes ?? []).filter(s => !s.startsWith("read_"));
  if (writing.length) fail(`GITLAB_READ_TOKEN must be read-only, but it has the scope(s) ${writing.join(", ")}; use a token with read_api and read_repository only`);
}

/**
 * The token reaches git through a credential helper reading the environment, given in GIT_CONFIG_* variables:
 * it is never written in the remote URL, in .git/config or on a command line.
 */
const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=oauth2 && echo "password=$GITLAB_READ_TOKEN"; }; f',
};

function git(args, { cwd, quiet = false } = {}) {
  try {
    return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
      env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    if (quiet) return undefined;
    fail(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

function sync({ project, ref, discard }) {
  const dir = join(REPOS_DIR, ...project.split("/"));
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dirname(dir), { recursive: true });
    git(["clone", "--quiet", "--no-checkout", `${GITLAB_URL}/${project}.git`, dir]);
  } else {
    const changes = git(["status", "--porcelain"], { cwd: dir });
    if (changes && !discard) {
      fail(`${dir} has local changes (save them first, e.g. with the fix-upload skill), or pass --discard to drop them:\n${changes}`);
    }
    git(["fetch", "--quiet", "--prune", "--prune-tags", "--tags", "--force", "origin"], { cwd: dir });
    git(["remote", "set-head", "origin", "--auto"], { cwd: dir });
  }

  const defaultBranch = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir });
  const wanted = ref ?? defaultBranch.replace(/^origin\//, "");
  // A remote branch first (local branches are stale), then a tag, then a commit.
  const candidates = ref === undefined ? [defaultBranch] : [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref];
  let sha, kind;
  for (const candidate of candidates) {
    sha = git(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { cwd: dir, quiet: true });
    if (sha) {
      kind = candidate.startsWith("refs/tags/") ? "tag" : candidate === ref ? "commit" : "branch";
      break;
    }
  }
  if (!sha) fail(`no branch, tag or commit "${wanted}" in ${project}`);

  git(["checkout", "--quiet", "--detach", "--force", sha], { cwd: dir });
  git(["clean", "-fdxq"], { cwd: dir });

  const commit = git(["log", "-1", "--format=%cI %s", sha], { cwd: dir });
  const tags = git(["tag", "--list", "--sort=-creatordate"], { cwd: dir }).split("\n").filter(t => VERSION_TAG_RE.test(t)).slice(0, 30);
  return [
    `Project: ${project}`,
    `Path: ${dir}`,
    `Ref: ${wanted} (${kind})`,
    `Commit: ${sha} ${commit}`,
    `Permalinks: ${GITLAB_URL}/${project}/-/blob/${sha}/<path>#L<line>`,
    `Default branch: ${defaultBranch.replace(/^origin\//, "")}`,
    `Version tags, newest first: ${tags.join(", ") || "none"}`,
  ].join("\n");
}

try {
  const opts = parseCli();
  await checkReadOnly(opts.token);
  console.log(sync(opts));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
