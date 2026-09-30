import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";

const BASE_URL = "http://host.docker.internal:8090/squash";
const LOGIN    = "admin";
const PASSWORD = "admin";
const LOG_FILE = "squash-tm.log";

const CACHE_FILE = `/tmp/squashtm_api_token_${LOGIN}`;

function parseCookies(setCookieHeaders, existing = {}) {
  const cookies = { ...existing };
  for (const header of setCookieHeaders ?? []) {
    const [pair] = header.split(";");
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const name  = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies[name] = value;
  }
  return cookies;
}

function serializeCookies(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function assertSuccessful(response, operation) {
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`Unexpected status for ${operation}: ${response.status}`);
  }
}

function expiryDateOneYearFromNow() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function generateApiToken() {
  const loginPageRes = await fetch(`${BASE_URL}/login`);
  assertSuccessful(loginPageRes, "GET /login");

  let cookies = parseCookies(loginPageRes.headers.getSetCookie());
  const firstXsrfToken = cookies["XSRF-TOKEN"];
  if (!firstXsrfToken) {
    throw new Error("XSRF-TOKEN cookie not found after GET /login");
  }

  const loginRes = await fetch(`${BASE_URL}/backend/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Xsrf-Token": firstXsrfToken,
      Cookie: serializeCookies(cookies),
    },
    body: new URLSearchParams({ username: LOGIN, password: PASSWORD }),
    redirect: "manual",
  });
  assertSuccessful(loginRes, "POST /backend/login");

  cookies = parseCookies(loginRes.headers.getSetCookie(), cookies);
  const secondXsrfToken = cookies["XSRF-TOKEN"] ?? firstXsrfToken;

  const payload = {
    name:        `api-test-${randomUUID().slice(0, 8)}`,
    expiryDate:  expiryDateOneYearFromNow(),
    permissions: "READ_WRITE",
  };

  const tokenRes = await fetch(`${BASE_URL}/backend/api-token/generate-api-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Xsrf-Token": secondXsrfToken,
      Cookie: serializeCookies(cookies),
    },
    body: JSON.stringify(payload),
  });
  assertSuccessful(tokenRes, "POST /backend/api-token/generate-api-token");

  const { token: encodedToken } = await tokenRes.json();
  if (!encodedToken) {
    throw new Error("Missing token field in API token response");
  }

  return Buffer.from(encodedToken, "base64").toString("utf-8");
}

async function getToken() {
  try {
    return readFileSync(CACHE_FILE, "utf-8").trim();
  } catch {
    const token = await generateApiToken();
    writeFileSync(CACHE_FILE, token, { mode: 0o600 });
    return token;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
const token = await getToken();

const res = await fetch(
  `${BASE_URL}/api/rest/latest/logs/${encodeURIComponent(LOG_FILE)}/download`,
  {
    headers: {
      Accept: "text/plain",
      Authorization: `Bearer ${token}`,
    },
  }
);

if (!res.ok) {
  throw new Error(`Failed to download log (HTTP ${res.status})`);
}

process.stdout.write(await res.text());
