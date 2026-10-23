import { buildApp, gitLabClient } from "./app.js";
import { loadConfig } from "./config.js";
import { tokenProblem } from "./gitlab/client.js";

const config = loadConfig();
if (!config.analystToken || !config.gitlabToken) {
  console.error("Set ANALYST_TOKEN (the callers' token) and GITLAB_READ_TOKEN (a read-only GitLab token)");
  process.exit(1);
}

// The analyst must never be able to write to GitLab: refuse to start with a token that could.
try {
  const info = await gitLabClient(config).tokenInfo();
  const problem = tokenProblem(info);
  if (problem) {
    console.error(`Refusing to start: ${problem}`);
    process.exit(1);
  }
  console.log(`GitLab token '${info.name}' (${info.scopes.join(", ")}) on ${config.gitlabUrl}`);
} catch (error) {
  console.error(`Cannot check the GitLab token on ${config.gitlabUrl}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const app = buildApp(config, { logger: { level: process.env.LOG_LEVEL ?? "info" } });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
