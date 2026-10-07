import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./core/db.js";

const config = loadConfig();
if (!config.adminToken && config.agentTokens.length === 0) {
  console.error("No token configured: set MEMORY_ADMIN_TOKEN and/or MEMORY_AGENT_TOKENS (store=token,...)");
  process.exit(1);
}
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const app = buildApp(config, db, { logger: { level: process.env.LOG_LEVEL ?? "info" } });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
