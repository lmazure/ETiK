export interface AgentToken {
  store: string;
  token: string;
}

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  adminToken: string | undefined;
  agentTokens: AgentToken[];
  /** Maximum size of one document, in UTF-8 bytes. */
  maxDocumentBytes: number;
  /** Maximum size of one MCP tool result, in characters; longer reads are truncated with a notice. */
  mcpMaxOutputChars: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got '${raw}'`);
  return value;
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
    port: integer(env, "PORT", 8080),
    dbPath: env.MEMORY_DB_PATH ?? "./data/memory.db",
    adminToken: env.MEMORY_ADMIN_TOKEN || undefined,
    agentTokens: parseAgentTokens(env.MEMORY_AGENT_TOKENS),
    maxDocumentBytes: integer(env, "MEMORY_MAX_DOCUMENT_BYTES", 1024 * 1024),
    mcpMaxOutputChars: integer(env, "MEMORY_MCP_MAX_OUTPUT_CHARS", 40_000),
  };
}
