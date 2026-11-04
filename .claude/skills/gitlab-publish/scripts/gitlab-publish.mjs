import { spawn } from "child_process";
import { readFileSync } from "fs";
import { release } from "os";
import { posix } from "path";
import { parseArgs } from "util";

const GITLAB_URL = "https://gitlab.com";
const PROJECT    = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const TEAMS      = ["AI", "Performance", "TestManagement", "PCI"];

const USAGE = [
  "Usage:",
  "  gitlab-publish.mjs issue <memory path of issue.md> --memory-url <url> --store <store> --priority <Highest|High|Medium|Low|Lowest>",
  "                     [--team <AI|Performance|TestManagement|PCI>] [--security] [--draft] [--related <iid|group/project#iid|issue URL>]... [--display]",
  "  gitlab-publish.mjs note --iid <iid> --body-file <local file> --memory-url <url> --store <store> [--media-base <memory folder>] [--display]",
].join("\n");

const MEDIA_TYPES = { ".png": "image/png", ".webm": "video/webm" };

const MD_MEDIA_RE   = /(!?\[[^\]]*\]\(\s*)(<[^>]+>|[^\s)]+)((?:\s+"[^"]*")?\s*\))/g;
const HTML_MEDIA_RE = /(<(?:img|video|source)\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;
// A line GitLab would run as a quick action (e.g. "/close", "/assign @someone"); paths such as "/sessions/042/…" do not match.
const QUICK_ACTION_RE = /^\/[a-z_]+(?:\s|$)/;

function fail(message) {
  throw new Error(message);
}

function parseCli() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "issue" && command !== "note") fail(`expected the command "issue" or "note"\n${USAGE}`);

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        "memory-url": { type: "string" },
        store:        { type: "string" },
        display:      { type: "boolean", default: false },
        ...(command === "issue" ? {
          priority: { type: "string" },
          team:     { type: "string" },
          security: { type: "boolean", default: false },
          draft:    { type: "boolean", default: false },
          related:  { type: "string", multiple: true, default: [] },
        } : {
          iid:          { type: "string" },
          "body-file":  { type: "string" },
          "media-base": { type: "string" },
        }),
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  if (!values["memory-url"]) fail(`--memory-url is required\n${USAGE}`);
  if (!values.store) fail(`--store is required\n${USAGE}`);
  const token = process.env.GITLAB_TOKEN;
  if (!token) fail("GITLAB_TOKEN environment variable is not set");
  const memoryToken = process.env.MEMORY_TOKEN;
  if (!memoryToken) fail("MEMORY_TOKEN environment variable is not set");
  const common = {
    command, token, display: values.display,
    memory: { url: values["memory-url"].replace(/\/+$/, ""), store: values.store, token: memoryToken },
  };

  if (command === "issue") {
    if (positionals.length !== 1) fail(`expected exactly one memory path\n${USAGE}`);
    const file = positionals[0];
    if (!file.startsWith("/")) fail(`not an absolute memory path (e.g. /sessions/042/issues/007/issue.md): ${file}`);
    if (!file.toLowerCase().endsWith(".md")) fail(`not a Markdown document (.md expected): ${file}`);

    if (!values.priority) fail(`--priority is required\n${USAGE}`);
    const priority = PRIORITIES.find(p => p.toLowerCase() === values.priority.toLowerCase());
    if (!priority) fail(`invalid priority "${values.priority}" (expected one of ${PRIORITIES.join(", ")})`);

    let team;
    if (values.team !== undefined) {
      team = TEAMS.find(t => t.toLowerCase() === values.team.toLowerCase());
      if (!team) fail(`invalid team "${values.team}" (expected one of ${TEAMS.join(", ")})`);
    }

    const related = values.related.map(parseRelated);
    return { ...common, file, priority, team, security: values.security, draft: values.draft, related };
  }

  if (positionals.length !== 0) fail(`unexpected argument: ${positionals[0]}\n${USAGE}`);
  if (!values.iid) fail(`--iid is required\n${USAGE}`);
  if (!values["body-file"]) fail(`--body-file is required\n${USAGE}`);
  const mediaBase = values["media-base"];
  if (mediaBase !== undefined && !mediaBase.startsWith("/")) fail(`not an absolute memory folder (e.g. /sessions/042/issues/007/): ${mediaBase}`);
  return { ...common, iid: parseIid(values.iid, "--iid"), bodyFile: values["body-file"], mediaBase };
}

function parseIid(value, flag) {
  const iid = value.replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(iid)) fail(`invalid issue iid for ${flag}: ${value}`);
  return iid;
}

/**
 * A related issue: "1234" or "#1234" in the project, "group/project#1234" or a GitLab issue URL
 * (".../-/issues/1234" or ".../-/work_items/1234") in any project.
 */
function parseRelated(value) {
  const url = value.match(/^https:\/\/gitlab\.com\/([^?#]+?)\/-\/(?:issues|work_items)\/([1-9][0-9]*)\/?(?:[?#].*)?$/);
  const ref = url ?? value.match(/^([\w.-]+(?:\/[\w.-]+)+)#([1-9][0-9]*)$/);
  if (ref) return { project: ref[1], iid: ref[2] };
  if (value.includes("/")) fail(`invalid issue for --related (expected 1234, #1234, group/project#1234 or an issue URL): ${value}`);
  return { project: PROJECT, iid: parseIid(value, "--related") };
}

function issueRef({ project, iid }) {
  return project === PROJECT ? `#${iid}` : `${project}#${iid}`;
}

/** GET on the store's REST API; fails with the server's message. */
async function memoryGet(memory, route, what) {
  let res;
  try {
    res = await fetch(`${memory.url}/api/stores/${encodeURIComponent(memory.store)}${route}`, {
      headers: { Authorization: `Bearer ${memory.token}` },
    });
  } catch (e) {
    fail(`memory server unreachable at ${memory.url}: ${e.cause?.message ?? e.message}`);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => undefined);
    fail(`cannot read ${what} from the memory server (HTTP ${res.status}): ${json?.error?.message ?? res.statusText}`);
  }
  return res;
}

const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function readBug(memory, path) {
  return (await memoryGet(memory, `/docs${encodePath(path)}`, path)).json();
}

async function readMedia(memory, path) {
  return Buffer.from(await (await memoryGet(memory, `/files${encodePath(path)}`, `referenced file ${path}`)).arrayBuffer());
}

function splitTitle(markdown, file) {
  const match = markdown.match(/^# (.+)$/m);
  if (!match) fail(`no level-1 heading ("# Title") found in ${file}`);
  const before = markdown.slice(0, match.index);
  const after  = markdown.slice(match.index + match[0].length).replace(/^\s*\n/, "");
  return { title: match[1].trim(), body: before + after };
}

/** Refuses a text GitLab would run as quick actions: only this script adds them. */
function rejectQuickActions(text, what) {
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence === null && QUICK_ACTION_RE.test(line)) {
      fail(`line ${i + 1} of ${what} would run as a GitLab quick action: ${line.trim()}`);
    }
  });
}

/**
 * Memory path of a referenced image or video, relative to `baseDir` or absolute; null for anything else.
 * Without `baseDir`, a relative reference fails.
 */
function memoryMediaPath(target, baseDir) {
  const raw = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
  const path = decodeURIComponent(raw.split(/[?#]/)[0]);
  if (!(posix.extname(path).toLowerCase() in MEDIA_TYPES)) return null;
  if (!path.startsWith("/") && baseDir === undefined) fail(`relative reference ${target} needs --media-base`);
  const resolved = posix.normalize(path.startsWith("/") ? path : posix.join(baseDir, path));
  if (!resolved.startsWith("/") || resolved.startsWith("/..")) fail(`referenced file outside the store: ${target}`);
  return resolved;
}

function collectMedia(body, baseDir) {
  const paths = new Set();
  for (const m of body.matchAll(MD_MEDIA_RE)) {
    const p = memoryMediaPath(m[2], baseDir);
    if (p) paths.add(p);
  }
  for (const m of body.matchAll(HTML_MEDIA_RE)) {
    const p = memoryMediaPath(m[3], baseDir);
    if (p) paths.add(p);
  }
  return [...paths];
}

function replaceMedia(body, baseDir, urls) {
  return body
    .replace(MD_MEDIA_RE, (all, pre, target, post) => {
      const p = memoryMediaPath(target, baseDir);
      return p ? `${pre}${urls.get(p)}${post}` : all;
    })
    .replace(HTML_MEDIA_RE, (all, pre, quote, target) => {
      const p = memoryMediaPath(target, baseDir);
      return p ? `${pre}${quote}${urls.get(p)}${quote}` : all;
    });
}

/** Reads every referenced media from the memory server, then uploads them to GitLab; returns the body with GitLab URLs. */
async function withUploadedMedia(opts, body, baseDir) {
  // Everything is read from the memory server before anything is written to GitLab.
  const media = new Map();
  for (const path of collectMedia(body, baseDir)) {
    media.set(path, await readMedia(opts.memory, path));
  }
  const urls = new Map();
  for (const [path, data] of media) {
    urls.set(path, await uploadMedia(opts.token, path, data));
  }
  return replaceMedia(body, baseDir, urls).trimEnd();
}

async function gitlab(token, method, path, body) {
  const res = await fetch(`${GITLAB_URL}/api/v4${path}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": token,
      ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
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

const projectPath = encodeURIComponent(PROJECT);

async function uploadMedia(token, path, data) {
  const form = new FormData();
  form.append("file", new Blob([data], { type: MEDIA_TYPES[posix.extname(path).toLowerCase()] }), posix.basename(path));
  const { url } = await gitlab(token, "POST", `/projects/${projectPath}/uploads`, form);
  return url;
}

function quickActions(labels, { security, draft }) {
  const lines = [`/label ${labels.map(l => `~"${l}"`).join(" ")}`];
  if (security) lines.push("/confidential");
  if (draft) lines.push("/assign me");
  return lines.join("\n");
}

function checkIssue(issue, labels, { security, draft }) {
  const warnings = [];
  const missing = labels.filter(l => !issue.labels?.includes(l));
  if (missing.length) warnings.push(`labels not applied: ${missing.join(", ")}`);
  if (security && !issue.confidential) warnings.push("issue is not confidential");
  const assigned = (issue.assignees ?? []).length > 0;
  if (draft && !assigned) warnings.push("issue is not assigned");
  if (!draft && assigned) warnings.push("issue is unexpectedly assigned");
  for (const w of warnings) process.stderr.write(`Warning: ${w}\n`);
}

/** Links the new issue to each related one; a failure is only a warning, since the issue exists. */
async function linkRelated(token, iid, related) {
  for (const target of related) {
    try {
      await gitlab(token, "POST", `/projects/${projectPath}/issues/${iid}/links`, JSON.stringify({
        target_project_id: target.project, target_issue_iid: target.iid, link_type: "relates_to",
      }));
    } catch (e) {
      process.stderr.write(`Warning: not linked to ${issueRef(target)}: ${e.message}\n`);
    }
  }
}

function openInBrowser(url) {
  const candidates =
    process.platform === "darwin" ? [["open", [url]]] :
    process.platform === "win32"  ? [["cmd", ["/c", "start", "", url]]] :
    release().toLowerCase().includes("microsoft")
      ? [["wslview", [url]], ["explorer.exe", [url]], ["xdg-open", [url]]]
      : [["xdg-open", [url]], ["wslview", [url]]];

  const tryNext = (i) => new Promise((done) => {
    if (i >= candidates.length) {
      process.stderr.write("Warning: could not open the browser\n");
      return done();
    }
    const [cmd, args] = candidates[i];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => tryNext(i + 1).then(done));
    child.on("spawn", () => { child.unref(); done(); });
  });
  return tryNext(0);
}

async function publishIssue(opts) {
  const baseDir = posix.dirname(opts.file);
  const doc = await readBug(opts.memory, opts.file);
  const published = doc.metadata?.gitlab_issue;
  if (published) fail(`${opts.file} is already published as ${published}; comment on that issue instead`);
  const { title, body } = splitTitle(doc.content, opts.file);
  rejectQuickActions(body, opts.file);

  const labels = [
    "Type::Bug",
    "ProdImpact::ToBeAnalyzed",
    `Priority::${opts.priority}`,
    ...(opts.team ? [`Team::${opts.team}`] : []),
    opts.draft ? "Status::Draft" : "Status::Backlog",
    ...(opts.security ? ["Security"] : []),
  ];

  const description = `${await withUploadedMedia(opts, body, baseDir)}\n\n${quickActions(labels, opts)}\n`;
  const issue = await gitlab(opts.token, "POST", `/projects/${projectPath}/issues`,
    JSON.stringify({ title, description }));

  checkIssue(issue, labels, opts);
  await linkRelated(opts.token, issue.iid, opts.related);
  return issue.web_url;
}

async function publishNote(opts) {
  let body;
  try {
    body = readFileSync(opts.bodyFile, "utf8");
  } catch (e) {
    fail(`cannot read ${opts.bodyFile}: ${e.message}`);
  }
  if (!body.trim()) fail(`${opts.bodyFile} is empty`);
  rejectQuickActions(body, opts.bodyFile);
  collectMedia(body, opts.mediaBase); // fails on a relative reference without --media-base
  // Fails on an unknown issue before anything is uploaded.
  const issue = await gitlab(opts.token, "GET", `/projects/${projectPath}/issues/${opts.iid}`);
  const note = await gitlab(opts.token, "POST", `/projects/${projectPath}/issues/${opts.iid}/notes`,
    JSON.stringify({ body: `${await withUploadedMedia(opts, body, opts.mediaBase)}\n` }));
  return `${issue.web_url}#note_${note.id}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
try {
  const opts = parseCli();
  const url = opts.command === "issue" ? await publishIssue(opts) : await publishNote(opts);
  process.stdout.write(`${url}\n`);
  if (opts.display) await openInBrowser(url);
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
