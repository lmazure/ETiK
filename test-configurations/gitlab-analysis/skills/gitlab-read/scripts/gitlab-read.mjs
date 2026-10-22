import { parseArgs } from "util";

const GITLAB_URL = (process.env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const PROJECT    = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";

const USAGE = [
  "Usage:",
  "  gitlab-read.mjs issue <iid> [--project <path>]",
  "  gitlab-read.mjs search <terms> [--state opened|closed|all] [--limit <n>] [--project <path>]",
].join("\n");

function fail(message) {
  throw new Error(message);
}

function parseCli() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "issue" && command !== "search") fail(`expected the command "issue" or "search"\n${USAGE}`);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: "string", default: PROJECT },
        state:   { type: "string", default: "all" },
        limit:   { type: "string", default: "20" },
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const token = process.env.GITLAB_READ_TOKEN;
  if (!token) fail("GITLAB_READ_TOKEN environment variable is not set");
  const common = { command, token, project: values.project };

  if (command === "issue") {
    if (positionals.length !== 1) fail(`expected exactly one issue iid\n${USAGE}`);
    const iid = positionals[0].replace(/^#/, "");
    if (!/^[1-9][0-9]*$/.test(iid)) fail(`invalid issue iid: ${positionals[0]}`);
    return { ...common, iid };
  }
  if (positionals.length === 0) fail(`expected search terms\n${USAGE}`);
  if (!["opened", "closed", "all"].includes(values.state)) fail(`invalid --state "${values.state}" (expected opened, closed or all)`);
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(`invalid --limit "${values.limit}" (expected 1 to 100)`);
  return { ...common, terms: positionals.join(" "), state: values.state, limit };
}

async function gitlab(token, path) {
  let res;
  try {
    res = await fetch(`${GITLAB_URL}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": token } });
  } catch (e) {
    fail(`GitLab unreachable at ${GITLAB_URL}: ${e.cause?.message ?? e.message}`);
  }
  const json = await res.json().catch(() => undefined);
  if (!res.ok) fail(`GET ${path} failed (HTTP ${res.status}): ${json?.message ?? json?.error ?? res.statusText}`);
  return { json, next: res.headers.get("x-next-page") };
}

/** Refuses a token that could write: Claude Code runs unsupervised here, so it must only read. */
async function checkReadOnly(token) {
  const { json } = await gitlab(token, "/personal_access_tokens/self");
  const writing = (json?.scopes ?? []).filter(s => !s.startsWith("read_"));
  if (writing.length) fail(`GITLAB_READ_TOKEN must be read-only, but it has the scope(s) ${writing.join(", ")}; use a token with read_api and read_repository only`);
}

async function allPages(token, path) {
  const items = [];
  for (let page = "1"; page; ) {
    const { json, next } = await gitlab(token, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...json);
    page = next;
  }
  return items;
}

const users = (list) => (list ?? []).map(u => `@${u.username}`).join(", ") || "none";

async function showIssue({ token, project, iid }) {
  const base = `/projects/${encodeURIComponent(project)}/issues/${iid}`;
  const { json: issue } = await gitlab(token, base);
  const notes = (await allPages(token, `${base}/notes?sort=asc&order_by=created_at`)).filter(n => !n.system);
  const links = await allPages(token, `${base}/links`);

  const out = [
    `# #${issue.iid} ${issue.title}`,
    "",
    `- URL: ${issue.web_url}`,
    `- State: ${issue.state}${issue.closed_at ? ` (closed ${issue.closed_at})` : ""}`,
    `- Labels: ${issue.labels?.join(", ") || "none"}`,
    `- Author: @${issue.author?.username}, created ${issue.created_at}, updated ${issue.updated_at}`,
    `- Assignees: ${users(issue.assignees)}`,
    `- Milestone: ${issue.milestone?.title ?? "none"}`,
    `- Linked issues: ${links.map(l => `${l.references?.full ?? `#${l.iid}`} (${l.link_type}, ${l.state}) ${l.title}`).join("; ") || "none"}`,
    "",
    "## Description",
    "",
    issue.description?.trim() || "(empty)",
    "",
    `## Notes (${notes.length})`,
  ];
  for (const note of notes) {
    out.push("", `### @${note.author?.username}, ${note.created_at}`, "", note.body.trim());
  }
  return out.join("\n");
}

async function search({ token, project, terms, state, limit }) {
  const query = new URLSearchParams({ search: terms, in: "title,description", scope: "all", state, per_page: String(limit) });
  const { json } = await gitlab(token, `/projects/${encodeURIComponent(project)}/issues?${query}`);
  if (json.length === 0) return `No issue matches "${terms}" (state ${state}).`;
  return json.map(i => `#${i.iid} · ${i.state} · ${i.updated_at.slice(0, 10)} · ${i.labels.join(", ") || "no label"} · ${i.title}\n  ${i.web_url}`).join("\n");
}

try {
  const opts = parseCli();
  await checkReadOnly(opts.token);
  console.log(opts.command === "issue" ? await showIssue(opts) : await search(opts));
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
