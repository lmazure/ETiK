export interface AgentToken {
  store: string;
  token: string;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  adminToken: string | undefined;
  /** Read-only token for people (web app): reads every store, never writes. */
  viewerToken: string | undefined;
  agentTokens: AgentToken[];
  /** Maximum size of one text document, in UTF-8 bytes. */
  maxDocumentBytes: number;
  /** Maximum size of one binary document (image, video), in bytes. */
  maxFileBytes: number;
  /** Maximum size of one MCP tool result, in characters; longer reads are truncated with a notice. */
  mcpMaxOutputChars: number;
  /** Largest image `memory_read` returns as an MCP image, in bytes; bigger ones are described only. */
  mcpMaxImageBytes: number;
  /** Directory of the built web app; not served when missing. */
  webRoot: string | undefined;
  /** Hugging Face id of the embedding model of the semantic and hybrid search modes; undefined when disabled (`none`). */
  embeddingModel: string | undefined;
  /** Cache directory of the embedding model; undefined: the transformers.js default. */
  modelDir: string | undefined;
  /** Whether the model may be downloaded from Hugging Face when it is not in the cache. */
  modelDownload: boolean;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw !== "true" && raw !== "false") throw new Error(`${name} must be 'true' or 'false', got '${raw}'`);
  return raw === "true";
}

/** Names accepted by MEMORY_EMBEDDING_MODEL besides `none` and a Hugging Face model id. */
export const EMBEDDING_MODELS: Record<string, string> = {
  english: "Xenova/e5-small-v2",
  multilingual: "Xenova/multilingual-e5-small",
};
export const DEFAULT_EMBEDDING_MODEL = "english";

/** `none` disables semantic search; a name of EMBEDDING_MODELS gives its model; anything else is a Hugging Face id. */
function embeddingModel(raw: string | undefined): string | undefined {
  const value = raw || DEFAULT_EMBEDDING_MODEL;
  if (value === "none") return undefined;
  return Object.hasOwn(EMBEDDING_MODELS, value) ? EMBEDDING_MODELS[value] : value;
}

/** Parses `store=token,store=token`. */
export function parseAgentTokens(raw: string | undefined): AgentToken[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "").map((entry) => {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`MEMORY_AGENT_TOKENS entries must look like 'store=token', got '${entry}'`);
    }
    return { store: entry.slice(0, eq).trim(), token: entry.slice(eq + 1).trim() };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: integer(env, "PORT", 9501),
    dbPath: env.MEMORY_DB_PATH ?? "./data/memory.db",
    adminToken: env.MEMORY_ADMIN_TOKEN || undefined,
    viewerToken: env.MEMORY_VIEWER_TOKEN || undefined,
    agentTokens: parseAgentTokens(env.MEMORY_AGENT_TOKENS),
    maxDocumentBytes: integer(env, "MEMORY_MAX_DOCUMENT_BYTES", 1024 * 1024),
    maxFileBytes: integer(env, "MEMORY_MAX_FILE_BYTES", 10 * 1024 * 1024),
    mcpMaxOutputChars: integer(env, "MEMORY_MCP_MAX_OUTPUT_CHARS", 40_000),
    mcpMaxImageBytes: integer(env, "MEMORY_MCP_MAX_IMAGE_BYTES", 1024 * 1024),
    webRoot: env.MEMORY_WEB_ROOT || undefined,
    embeddingModel: embeddingModel(env.MEMORY_EMBEDDING_MODEL),
    modelDir: env.MEMORY_MODEL_DIR || undefined,
    modelDownload: boolean(env, "MEMORY_MODEL_DOWNLOAD", true),
  };
}
