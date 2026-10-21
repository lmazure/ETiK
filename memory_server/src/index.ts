import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./core/db.js";
import { TransformersEmbedder } from "./embedding/transformers.js";

const config = loadConfig();
// The web app is built next to the server code (dist/web); a dev run from src/ simply has none.
config.webRoot ??= fileURLToPath(new URL("./web", import.meta.url));
if (!config.adminToken && !config.viewerToken && config.agentTokens.length === 0) {
  console.error("No token configured: set MEMORY_ADMIN_TOKEN, MEMORY_VIEWER_TOKEN and/or MEMORY_AGENT_TOKENS (store=token,...)");
  process.exit(1);
}
if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);
const embedder = config.embeddingModel === undefined ? undefined
  : new TransformersEmbedder({ model: config.embeddingModel, cacheDir: config.modelDir, allowDownload: config.modelDownload });
const app = buildApp(config, db, { logger: { level: process.env.LOG_LEVEL ?? "info" } }, { embedder });
if (!embedder) app.log.info("Semantic search disabled (MEMORY_EMBEDDING_MODEL=none)");

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
