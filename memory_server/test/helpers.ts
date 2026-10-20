import type { Config } from "../src/config.js";
import { openDatabase } from "../src/core/db.js";
import { MemoryCore, type Context } from "../src/core/memory-core.js";
import {
  deleteArgs, editArgs, historyArgs, listArgs, moveArgs, readArgs, searchArgs, writeArgs,
} from "../src/schemas.js";

export const ADMIN_TOKEN = "admin-secret";
export const AGENT_TOKEN = "agent-secret";
export const OTHER_TOKEN = "other-secret";
export const VIEWER_TOKEN = "viewer-secret";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    adminToken: ADMIN_TOKEN,
    viewerToken: VIEWER_TOKEN,
    agentTokens: [{ store: "squashtm", token: AGENT_TOKEN }, { store: "other", token: OTHER_TOKEN }],
    maxDocumentBytes: 10_000,
    maxFileBytes: 20_000,
    mcpMaxOutputChars: 2_000,
    mcpMaxImageBytes: 1_000,
    webRoot: undefined,
    ...overrides,
  };
}

/** A core on a fresh in-memory database, with helpers that parse raw arguments like the entry points do. */
export function testCore(maxDocumentBytes = 10_000, maxFileBytes = 20_000) {
  const db = openDatabase(":memory:");
  const core = new MemoryCore(db, { maxDocumentBytes, maxFileBytes });
  const ctx: Context = { store: "squashtm", actor: "agent:squashtm" };
  const admin: Context = { store: "squashtm", actor: "admin", admin: true };
  return {
    db,
    core,
    ctx,
    admin,
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

/** A real 1×1 PNG. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
