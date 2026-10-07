import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import { MemoryError } from "./core/errors.js";
import { validateStoreName, type Context } from "./core/memory-core.js";

export interface Principal {
  name: string;
  /**
   * admin: every store, read and write, admin operations.
   * viewer: every store, read only (people, web app).
   * agent: its own store(s), read and write.
   */
  role: "admin" | "viewer" | "agent";
  /** Stores an agent may reach; admin and viewer reach every store. */
  stores: string[];
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export const STORE_HEADER = "x-memory-store";
export const SESSION_HEADER = "x-memory-session";

/**
 * Static bearer tokens. An agent token reaches only its own store(s) and no admin operation;
 * the viewer token reads every store and never writes; the admin token reaches everything.
 */
export class Authenticator {
  private readonly entries: { digest: Buffer; principal: Principal }[] = [];

  constructor(config: Pick<Config, "adminToken" | "viewerToken" | "agentTokens">) {
    const seen = new Set<string>();
    const add = (token: string, principal: Principal) => {
      if (seen.has(token)) throw new Error("The admin, viewer and agent tokens must all differ");
      seen.add(token);
      this.entries.push({ digest: digest(token), principal });
    };
    if (config.adminToken) add(config.adminToken, { name: "admin", role: "admin", stores: [] });
    if (config.viewerToken) add(config.viewerToken, { name: "viewer", role: "viewer", stores: [] });
    const byToken = new Map<string, string[]>();
    for (const { store, token } of config.agentTokens) {
      validateStoreName(store);
      byToken.set(token, [...(byToken.get(token) ?? []), store]);
    }
    for (const [token, stores] of byToken) {
      add(token, { name: `agent:${stores.join("+")}`, role: "agent", stores });
    }
  }

  get configured(): boolean {
    return this.entries.length > 0;
  }

  /** Resolves the `Authorization: Bearer …` header; throws a 401 AuthError when missing or unknown. */
  authenticate(authorization: string | undefined): Principal {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match) throw new AuthError(401, "Missing bearer token (Authorization: Bearer <token>)");
    const presented = digest(match[1]!.trim());
    // Compare against every entry so the time taken does not depend on which token matched.
    let found: Principal | undefined;
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, presented)) found = entry.principal;
    }
    if (!found) throw new AuthError(401, "Invalid bearer token");
    return found;
  }

  requireAdmin(principal: Principal): void {
    if (principal.role !== "admin") throw new AuthError(403, "This operation requires the admin token");
  }

  requireWriter(principal: Principal): void {
    if (principal.role === "viewer") throw new AuthError(403, "The viewer token is read-only");
  }

  /** Whether the principal may reach a store (admin and viewer reach every store). */
  canAccess(principal: Principal, store: string): boolean {
    return principal.role !== "agent" || principal.stores.includes(store);
  }

  /** Builds the core context for a store; the store must be reachable by the principal. */
  context(principal: Principal, store: string | undefined, session: string | undefined): Context {
    let resolved = store;
    if (resolved === undefined || resolved === "") {
      if (principal.role === "agent" && principal.stores.length === 1) resolved = principal.stores[0]!;
      else throw new MemoryError("INVALID_ARGUMENT", `No store selected; set the ${STORE_HEADER} header`);
    }
    validateStoreName(resolved);
    if (!this.canAccess(principal, resolved)) {
      throw new AuthError(403, `This token cannot access store '${resolved}'`);
    }
    return { store: resolved, actor: principal.name, session: session || undefined };
  }
}

/** First value of a header that may be repeated. */
export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
