import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 18_081);

export const E2E = {
  baseURL: `http://127.0.0.1:${PORT}`,
  viewerToken: "e2e-viewer",
  agentToken: "e2e-agent",
};

/**
 * End-to-end tests of the web app against the built server (`npm run build` first) on an in-memory database.
 * Chromium needs system libraries: the simplest is to run them in the Playwright image, see README.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  use: { baseURL: E2E.baseURL, screenshot: "only-on-failure" },
  outputDir: "test-results",
  webServer: {
    command: "node dist/index.js",
    url: `${E2E.baseURL}/health`,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      MEMORY_DB_PATH: ":memory:",
      MEMORY_VIEWER_TOKEN: E2E.viewerToken,
      MEMORY_AGENT_TOKENS: `squashtm=${E2E.agentToken}`,
      LOG_LEVEL: "warn",
      // Downloaded on the first run, then reused.
      MEMORY_MODEL_DIR: "models",
    },
  },
});
