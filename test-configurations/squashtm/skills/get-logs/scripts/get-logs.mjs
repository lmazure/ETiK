import { getToken } from "../../squashtm-api-token/scripts/squashtm-api-token.mjs";

const BASE_URL = "http://host.docker.internal:8090/squash";
const LOG_FILE = "squash-tm.log";

function downloadLog(token) {
  return fetch(
    `${BASE_URL}/api/rest/latest/logs/${encodeURIComponent(LOG_FILE)}/download`,
    {
      headers: {
        Accept: "text/plain",
        Authorization: `Bearer ${token}`,
      },
    }
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
let res = await downloadLog(await getToken());

// The cached token may have been revoked, or SquashTM reset: retry with a new one.
if (res.status === 401) {
  res = await downloadLog(await getToken({ refresh: true }));
}

if (!res.ok) {
  throw new Error(`Failed to download log (HTTP ${res.status})`);
}

process.stdout.write(await res.text());
