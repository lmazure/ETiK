import type { Config } from "../src/config.js";
import { openDatabase } from "../src/core/db.js";
import { MemoryCore, type Context } from "../src/core/memory-core.js";
import {
  deleteArgs, editArgs, historyArgs, listArgs, moveArgs, readArgs, searchArgs, writeArgs,
} from "../src/schemas.js";

export const ADMIN_TOKEN = "admin-secret";
export const AGENT_TOKEN = "agent-secret";
export const OTHER_TOKEN = "other-secret";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    adminToken: ADMIN_TOKEN,
    agentTokens: [{ store: "squashtm", token: AGENT_TOKEN }, { store: "other", token: OTHER_TOKEN }],
    maxDocumentBytes: 10_000,
    mcpMaxOutputChars: 2_000,
    ...overrides,
  };
}

/** A core on a fresh in-memory database, with helpers that parse raw arguments like the entry points do. */
export function testCore(maxDocumentBytes = 10_000) {
  const db = openDatabase(":memory:");
  const core = new MemoryCore(db, { maxDocumentBytes });
  const ctx: Context = { store: "squashtm", actor: "agent:squashtm", session: "session_01" };
  return {
    db,
    core,
    ctx,
    list: (args: unknown = {}, c = ctx) => core.list(c, listArgs.parse(args)),
    read: (args: unknown, c = ctx) => core.read(c, readArgs.parse(args)),
    search: (args: unknown, c = ctx) => core.search(c, searchArgs.parse(args)),
    write: (args: unknown, c = ctx) => core.write(c, writeArgs.parse(args)),
    edit: (args: unknown, c = ctx) => core.edit(c, editArgs.parse(args)),
    move: (args: unknown, c = ctx) => core.move(c, moveArgs.parse(args)),
    remove: (args: unknown, c = ctx) => core.delete(c, deleteArgs.parse(args)),
    history: (args: unknown, c = ctx) => core.history(c, historyArgs.parse(args)),
  };
}
