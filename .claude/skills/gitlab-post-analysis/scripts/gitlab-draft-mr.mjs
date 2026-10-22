import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseArgs } from "util";

const GITLAB_URL    = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const ISSUE_PROJECT = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";

const USAGE = "Usage: gitlab-draft-mr.mjs <issue iid> --project <code project path> --memory-url <url> --store <store>";

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
        project:      { type: "string" },
        "memory-url": { type: "string" },
        store:        { type: "string" },
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) fail(`expected exactly one issue iid\n${USAGE}`);
  const iid = positionals[0].replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(iid)) fail(`invalid issue iid: ${positionals[0]}`);
  if (!values.project) fail(`--project is required\n${USAGE}`);
  if (!values["memory-url"]) fail(`--memory-url is required\n${USAGE}`);
  if (!values.store) fail(`--store is required\n${USAGE}`);
  const token = process.env.GITLAB_TOKEN;
  if (!token) fail("GITLAB_TOKEN environment variable is not set");
  const memoryToken = process.env.MEMORY_TOKEN;
  if (!memoryToken) fail("MEMORY_TOKEN environment variable is not set");
  return {
    iid, project: values.project, token,
    memory: { url: values["memory-url"].replace(/\/+$/, ""), store: values.store, token: memoryToken },
  };
}

/** GET on the store's REST API; fails with the server's message. */
async function memoryDoc(memory, path) {
  let res;
  try {
    res = await fetch(`${memory.url}/api/stores/${encodeURIComponent(memory.store)}/docs${path.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${memory.token}` },
    });
  } catch (e) {
    fail(`memory server unreachable at ${memory.url}: ${e.cause?.message ?? e.message}`);
  }
  const json = await res.json().catch(() => undefined);
  if (!res.ok) fail(`cannot read ${path} from the memory server (HTTP ${res.status}): ${json?.error?.message ?? res.statusText}`);
  return json;
}

/** GitLab REST call; `raw` returns the bytes; a 404 returns undefined when `allow404`. */
async function gitlab(token, method, path, { body, raw = false, allow404 = false } = {}) {
  const res = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    method,
    headers: { "PRIVATE-TOKEN": token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return undefined;
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const detail = json?.message ?? json?.error ?? text;
    fail(`${method} ${path} failed (HTTP ${res.status}): ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return json;
}

/** The files of a `git diff`: one entry per `diff --git` block. */
function parseDiff(diff) {
  if (/^GIT binary patch$/m.test(diff) || /^Binary files .* differ$/m.test(diff)) fail("fix.diff changes a binary file; only text changes are supported");
  const files = [];
  for (const block of diff.split(/^(?=diff --git )/m).filter(b => b.startsWith("diff --git "))) {
    const header = block.split("\n")[0];
    if (header.includes('"')) fail(`quoted paths are not supported: ${header}`);
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) fail(`unexpected diff header: ${header}`);
    const file = { oldPath: match[1], newPath: match[2], kind: "update" };
    if (/^new file mode /m.test(block)) file.kind = "create";
    else if (/^deleted file mode /m.test(block)) file.kind = "delete";
    else if (/^rename from /m.test(block)) {
      file.kind = "move";
      file.oldPath = block.match(/^rename from (.+)$/m)[1];
      file.newPath = block.match(/^rename to (.+)$/m)[1];
    }
    files.push(file);
  }
  if (files.length === 0) fail("fix.diff holds no file change");
  return files;
}

/** Applies the diff to the files at `sha` (only those it touches) in a temporary folder; returns the commit actions. */
async function applyDiff(token, projectPath, sha, diff, files) {
  const dir = mkdtempSync(join(tmpdir(), "etik-mr-"));
  try {
    for (const file of files.filter(f => f.kind !== "create")) {
      const data = await gitlab(token, "GET",
        `/projects/${projectPath}/repository/files/${encodeURIComponent(file.oldPath)}/raw?ref=${sha}`, { raw: true, allow404: true });
      if (data === undefined) fail(`${file.oldPath} does not exist at ${sha}`);
      mkdirSync(dirname(join(dir, file.oldPath)), { recursive: true });
      writeFileSync(join(dir, file.oldPath), data);
    }
    writeFileSync(join(dir, ".fix.diff"), diff);
    try {
      execFileSync("git", ["apply", "--check", ".fix.diff"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["apply", ".fix.diff"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      fail(`fix.diff does not apply to ${sha}:\n${(e.stderr?.toString() || e.message).trim()}`);
    }
    return files.map(file => {
      if (file.kind === "delete") return { action: "delete", file_path: file.oldPath };
      const content = readFileSync(join(dir, file.newPath)).toString("base64");
      return file.kind === "move"
        ? { action: "move", previous_path: file.oldPath, file_path: file.newPath, content, encoding: "base64" }
        : { action: file.kind, file_path: file.newPath, content, encoding: "base64" };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function slug(title) {
  return title.toLowerCase().replace(/\[[^\]]*\]/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "fix";
}

/** The `## Summary` section of the analysis, when there is one. */
function summary(analysis) {
  const match = analysis.match(/^## Summary\s*\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/m);
  return match ? match[1].trim() : undefined;
}

// ── Main ─────────────────────────────────────────────────────────────────────
try {
  const opts = parseCli();
  const fix = await memoryDoc(opts.memory, `/analyses/${opts.iid}/fix.diff`);
  const analysis = await memoryDoc(opts.memory, `/analyses/${opts.iid}/analysis.md`);
  const { project, target_branch: targetBranch, base_sha: baseSha } = fix.metadata ?? {};
  if (project !== opts.project) fail(`fix.diff is for the project ${project ?? "(none)"}, not ${opts.project}`);
  if (!targetBranch) fail("fix.diff has no target_branch metadata");
  const files = parseDiff(fix.content);

  const projectPath = encodeURIComponent(project);
  const issue = await gitlab(opts.token, "GET", `/projects/${encodeURIComponent(ISSUE_PROJECT)}/issues/${opts.iid}`);
  const branch = await gitlab(opts.token, "GET", `/projects/${projectPath}/repository/branches/${encodeURIComponent(targetBranch)}`);
  const headSha = branch.commit.id;
  const actions = await applyDiff(opts.token, projectPath, headSha, fix.content, files);

  const sourceBranch = `etik/${opts.iid}-${slug(issue.title)}`;
  if (await gitlab(opts.token, "GET", `/projects/${projectPath}/repository/branches/${encodeURIComponent(sourceBranch)}`, { allow404: true })) {
    fail(`the branch ${sourceBranch} already exists in ${project}; a Draft merge request was probably already opened`);
  }

  const reference = `${ISSUE_PROJECT}#${opts.iid}`;
  await gitlab(opts.token, "POST", `/projects/${projectPath}/repository/commits`, { body: {
    branch: sourceBranch,
    start_sha: headSha,
    commit_message: `Fix ${reference}: ${issue.title}\n\nProposed from the analysis of ${issue.web_url}; not built nor tested.`,
    actions,
  } });

  const description = [
    `Proposed fix for ${reference}.`,
    ...(summary(analysis.content) ? ["", summary(analysis.content)] : []),
    "",
    `The full analysis is in a comment of ${issue.web_url}.`,
    "",
    `Written by an AI agent from the code at \`${baseSha ?? headSha}\`, **not built nor tested**: review it, build it and run the tests before marking it ready.`,
  ].join("\n");
  let mr;
  try {
    mr = await gitlab(opts.token, "POST", `/projects/${projectPath}/merge_requests`, { body: {
      source_branch: sourceBranch,
      target_branch: targetBranch,
      title: `Draft: ${issue.title}`,
      description,
      remove_source_branch: true,
    } });
  } catch (e) {
    fail(`the branch ${sourceBranch} was created in ${project}, but not the merge request: ${e.message}`);
  }

  if (baseSha && baseSha !== headSha) process.stderr.write(`Warning: the fix was written against ${baseSha}, and applied to ${headSha}, the head of ${targetBranch}\n`);
  if (!mr.draft) process.stderr.write("Warning: the merge request is not marked as draft\n");
  process.stdout.write(`${mr.web_url}\n`);
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
