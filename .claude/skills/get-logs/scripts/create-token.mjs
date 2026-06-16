import { randomUUID } from "crypto";

const BASE_URL = "http://host.docker.internal:8090/squash";
const LOGIN    = "admin";
const PASSWORD = "admin";

/**
 * Parses Set-Cookie headers and merges them into an existing cookie map.
 * Later values win (same behaviour as TokenHelper#mergeCookies).
 */
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

/** Serialises a cookie map to a Cookie header string. */
function serializeCookies(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Throws if the response status is not in the 2xx–3xx range. */
function assertSuccessful(response, operation) {
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`Unexpected status for ${operation}: ${response.status}`);
  }
}

/** Returns an ISO-8601 timestamp one year from now, with no milliseconds. */
function expiryDateOneYearFromNow() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  d.setMilliseconds(0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Authenticates with SquashTM and creates a new API token.
 *
 * @returns {Promise<string>} The decoded (plain-text) API token.
 */
async function generateApiToken(baseUrl, login, password) {
  // ── Step 1 : fetch the login page to obtain the initial XSRF token ──────
  const loginPageRes = await fetch(`${baseUrl}/login`);
  assertSuccessful(loginPageRes, "GET /login");

  let cookies = parseCookies(loginPageRes.headers.getSetCookie());
  const firstXsrfToken = cookies["XSRF-TOKEN"];
  if (!firstXsrfToken) {
    throw new Error("XSRF-TOKEN cookie not found after GET /login");
  }

  // ── Step 2 : post credentials ────────────────────────────────────────────
  const loginRes = await fetch(`${baseUrl}/backend/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Xsrf-Token": firstXsrfToken,
      Cookie: serializeCookies(cookies),
    },
    body: new URLSearchParams({ username: login, password }),
    redirect: "manual",
  });
  assertSuccessful(loginRes, "POST /backend/login");

  cookies = parseCookies(loginRes.headers.getSetCookie(), cookies);
  const secondXsrfToken = cookies["XSRF-TOKEN"] ?? firstXsrfToken;

  // ── Step 3 : create the API token ────────────────────────────────────────
  const payload = {
    name:        `api-test-${randomUUID().slice(0, 8)}`,
    expiryDate:  expiryDateOneYearFromNow(),
    permissions: "READ_WRITE",
  };

  const tokenRes = await fetch(`${baseUrl}/backend/api-token/generate-api-token`, {
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

// ── Entry point ──────────────────────────────────────────────────────────────
const token = await generateApiToken(BASE_URL, LOGIN, PASSWORD);
console.log("API token:", token);
