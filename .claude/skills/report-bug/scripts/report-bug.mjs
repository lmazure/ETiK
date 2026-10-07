import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { release } from "os";
import { basename, dirname, extname, resolve } from "path";
import { parseArgs } from "util";

const GITLAB_URL = "https://gitlab.com";
const PROJECT    = "henixdevelopment/squash/squash-tm/core/squashtest-tm-staging";
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];

const USAGE = "Usage: report-bug.mjs <file.md> --priority <Highest|High|Medium|Low|Lowest> [--security] [--draft] [--display]";

const MEDIA_TYPES = { ".png": "image/png", ".webm": "video/webm" };

const MD_MEDIA_RE   = /(!?\[[^\]]*\]\(\s*)(<[^>]+>|[^\s)]+)((?:\s+"[^"]*")?\s*\))/g;
const HTML_MEDIA_RE = /(<(?:img|video|source)\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

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
        priority: { type: "string" },
        security: { type: "boolean", default: false },
        draft:    { type: "boolean", default: false },
        display:  { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  if (positionals.length !== 1) fail(`expected exactly one Markdown file\n${USAGE}`);
  const file = positionals[0];
  if (!file.toLowerCase().endsWith(".md")) fail(`not a Markdown file (.md expected): ${file}`);
  if (!existsSync(file)) fail(`file not found: ${file}`);

  if (!values.priority) fail(`--priority is required\n${USAGE}`);
  const priority = PRIORITIES.find(p => p.toLowerCase() === values.priority.toLowerCase());
  if (!priority) fail(`invalid priority "${values.priority}" (expected one of ${PRIORITIES.join(", ")})`);

  const token = process.env.GITLAB_TOKEN;
  if (!token) fail("GITLAB_TOKEN environment variable is not set");

  return { file, priority, token, security: values.security, draft: values.draft, display: values.display };
}

function splitTitle(markdown, file) {
  const match = markdown.match(/^# (.+)$/m);
  if (!match) fail(`no level-1 heading ("# Title") found in ${file}`);
  const before = markdown.slice(0, match.index);
  const after  = markdown.slice(match.index + match[0].length).replace(/^\s*\n/, "");
  return { title: match[1].trim(), body: before + after };
}

function localMediaPath(target, baseDir) {
  const raw = target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) return null;
  const path = decodeURIComponent(raw.split(/[?#]/)[0]);
  if (!(extname(path).toLowerCase() in MEDIA_TYPES)) return null;
  return resolve(baseDir, path);
}

function collectMedia(body, baseDir) {
  const paths = new Set();
  for (const m of body.matchAll(MD_MEDIA_RE)) {
    const p = localMediaPath(m[2], baseDir);
    if (p) paths.add(p);
  }
  for (const m of body.matchAll(HTML_MEDIA_RE)) {
    const p = localMediaPath(m[3], baseDir);
    if (p) paths.add(p);
  }
  for (const p of paths) {
    if (!existsSync(p)) fail(`referenced file not found: ${p}`);
  }
  return [...paths];
}

function replaceMedia(body, baseDir, urls) {
  return body
    .replace(MD_MEDIA_RE, (all, pre, target, post) => {
      const p = localMediaPath(target, baseDir);
      return p ? `${pre}${urls.get(p)}${post}` : all;
    })
    .replace(HTML_MEDIA_RE, (all, pre, quote, target) => {
      const p = localMediaPath(target, baseDir);
      return p ? `${pre}${quote}${urls.get(p)}${quote}` : all;
    });
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

async function uploadMedia(token, projectPath, file) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type: MEDIA_TYPES[extname(file).toLowerCase()] }), basename(file));
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

// ── Main ─────────────────────────────────────────────────────────────────────
try {
  const opts = parseCli();
  const baseDir = dirname(resolve(opts.file));
  const { title, body } = splitTitle(readFileSync(opts.file, "utf-8"), opts.file);
  const media = collectMedia(body, baseDir);

  const labels = [
    "Type::Bug",
    "ProdImpact::ToBeAnalyzed",
    `Priority::${opts.priority}`,
    opts.draft ? "Status::Draft" : "Status::Backlog",
    ...(opts.security ? ["Security"] : []),
  ];

  const projectPath = encodeURIComponent(PROJECT);
  const urls = new Map();
  for (const file of media) {
    urls.set(file, await uploadMedia(opts.token, projectPath, file));
  }

  const description = `${replaceMedia(body, baseDir, urls).trimEnd()}\n\n${quickActions(labels, opts)}\n`;
  const issue = await gitlab(opts.token, "POST", `/projects/${projectPath}/issues`,
    JSON.stringify({ title, description }));

  checkIssue(issue, labels, opts);
  process.stdout.write(`${issue.web_url}\n`);

  if (opts.display) await openInBrowser(issue.web_url);
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
