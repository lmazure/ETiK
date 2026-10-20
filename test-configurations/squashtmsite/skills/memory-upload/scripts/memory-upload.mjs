import { existsSync, readFileSync } from "fs";
import { extname } from "path";
import { parseArgs } from "util";

const MEMORY_URL = process.env.MEMORY_URL || "http://host.docker.internal:9501";
const STORE      = "squashtmsite";

const USAGE = "Usage: memory-upload.mjs <local file> <memory path> [--overwrite] [--description <text>] [--change-note <text>]";

const MEDIA_TYPES = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
};

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
        overwrite:     { type: "boolean", default: false },
        description:   { type: "string" },
        "change-note": { type: "string" },
      },
    });
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;

  if (positionals.length !== 2) fail(`expected a local file and a memory path\n${USAGE}`);
  const [file, path] = positionals;
  if (!existsSync(file)) fail(`file not found: ${file}`);
  if (!path.startsWith("/")) fail(`the memory path must be absolute, e.g. /sessions/001/log/home-page.png: ${path}`);

  const type = MEDIA_TYPES[extname(path).toLowerCase()];
  if (!type) fail(`unsupported extension for ${path} (expected one of ${Object.keys(MEDIA_TYPES).join(", ")})`);
  if (extname(file).toLowerCase() !== extname(path).toLowerCase()) {
    fail(`the local file and the memory path must have the same extension: ${file}, ${path}`);
  }

  const token = process.env.MEMORY_AGENT_TOKEN;
  if (!token) fail("MEMORY_AGENT_TOKEN environment variable is not set");

  return { file, path, type, token, overwrite: values.overwrite, description: values.description, changeNote: values["change-note"] };
}

async function upload({ file, path, type, token, overwrite, description, changeNote }) {
  const query = new URLSearchParams();
  if (description !== undefined) query.set("description", description);
  if (changeNote !== undefined) query.set("change_note", changeNote);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${MEMORY_URL}/api/stores/${STORE}/files${encodedPath}${query.size ? "?" + query : ""}`;

  let response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": type,
        ...(!overwrite && { "If-None-Match": "*" }),
      },
      body: readFileSync(file),
    });
  } catch (e) {
    fail(`memory server unreachable at ${MEMORY_URL}: ${e.cause?.message ?? e.message}`);
  }
  const json = await response.json().catch(() => undefined);
  if (json?.error?.code === "ALREADY_EXISTS") fail(`${path} already exists; choose another name, or pass --overwrite to replace it`);
  if (!response.ok) fail(json?.error?.message ?? `HTTP ${response.status}`);
  return json;
}

try {
  const result = await upload(parseCli());
  console.log(`OK ${result.path} version=${result.version}${result.created ? " (created)" : ""}${result.unchanged ? " (unchanged)" : ""}`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
