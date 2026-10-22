import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { parseArgs } from "util";

const MEMORY_URL = process.env.MEMORY_URL || "http://host.docker.internal:9501";
const STORE      = "squashtm";
const REPOS_DIR  = process.env.REPOS_DIR || "/repos";

const USAGE = "Usage: fix-upload.mjs <project path> <issue iid> --target-branch <branch> [--overwrite]";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.-]+)+$/;

function fail(message) {
  throw new Error(message);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      strict: true,
      options: {
        "target-branch": { type: "string" },
        overwrite:       { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2) fail(`expected a project path and an issue iid\n${USAGE}`);
  const [project, rawIid] = positionals;
  if (!PROJECT_RE.test(project) || project.split("/").some(p => p === "." || p === "..")) fail(`invalid project path: ${project}`);
  const iid = rawIid.replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(iid)) fail(`invalid issue iid: ${rawIid}`);
  const targetBranch = values["target-branch"];
  if (!targetBranch) fail(`--target-branch is required (the branch the merge request would target)\n${USAGE}`);
  if (targetBranch.startsWith("-") || /[\s~^:?*[\\]/.test(targetBranch)) fail(`invalid branch: ${targetBranch}`);
  const token = process.env.MEMORY_AGENT_TOKEN;
  if (!token) fail("MEMORY_AGENT_TOKEN environment variable is not set");
  return { project, iid, targetBranch, token, overwrite: values.overwrite };
}

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    fail(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`);
  }
}

/** The changes of the checkout against its commit, new files included. */
function readDiff(project) {
  const dir = join(REPOS_DIR, ...project.split("/"));
  if (!existsSync(join(dir, ".git"))) fail(`${dir} is not a clone; run the repo-sync skill first`);
  // New files are part of the diff only once git knows them.
  git(dir, ["add", "--intent-to-add", "--all"]);
  const diff = git(dir, ["diff", "HEAD"]);
  if (!diff.trim()) fail(`no change in ${dir}: edit the files of the checkout first`);
  if (/^Binary files .* differ$/m.test(diff)) fail("the diff changes a binary file; only text changes can be proposed");
  return { diff, baseSha: git(dir, ["rev-parse", "HEAD"]).trim(), stat: git(dir, ["diff", "--stat", "HEAD"]).trimEnd() };
}

async function upload({ project, iid, targetBranch, token, overwrite }, { diff, baseSha }) {
  const path = `/analyses/${iid}/fix.diff`;
  let response;
  try {
    response = await fetch(`${MEMORY_URL}/api/stores/${STORE}/docs${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(!overwrite && { "If-None-Match": "*" }),
      },
      body: JSON.stringify({
        file_text: diff,
        description: `Fix proposed for #${iid} in ${project}, against ${targetBranch}`,
        tags: ["fix"],
        metadata: { project, target_branch: targetBranch, base_sha: baseSha },
        change_note: `analysis_${iid}: fix proposal`,
      }),
    });
  } catch (e) {
    fail(`memory server unreachable at ${MEMORY_URL}: ${e.cause?.message ?? e.message}`);
  }
  const json = await response.json().catch(() => undefined);
  if (json?.error?.code === "ALREADY_EXISTS") fail(`${path} already exists; pass --overwrite to replace it`);
  if (!response.ok) fail(json?.error?.message ?? `HTTP ${response.status}`);
  return json;
}

try {
  const opts = parseCli();
  const fix = readDiff(opts.project);
  const result = await upload(opts, fix);
  console.log(`OK ${result.path} version=${result.version}${result.created ? " (created)" : ""}${result.unchanged ? " (unchanged)" : ""}`);
  console.log(`Base commit: ${fix.baseSha}`);
  console.log(fix.stat);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
