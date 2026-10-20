import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthError, headerValue, type Authenticator } from "../auth.js";
import { MemoryError, type ErrorCode } from "../core/errors.js";
import { MEDIA_TYPES } from "../core/media.js";
import { formatZodError, type Context, type FileResult, type MemoryCore } from "../core/memory-core.js";
import {
  batchArgs, changesArgs, deleteArgs, docHistoryArgs, docIdArgs, docVersionArgs, editArgs, fileArgs, fileWriteArgs, historyArgs, listArgs,
  moveArgs, readArgs, restoreArgs, searchArgs, writeArgs,
} from "../schemas.js";

const STATUS: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  INVALID_PATH: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  IS_FOLDER: 409,
  VERSION_CONFLICT: 412,
  APPEND_ONLY: 409,
  TOO_LARGE: 413,
  NO_MATCH: 422,
  NOT_UNIQUE: 422,
  SECTION_NOT_FOUND: 422,
  SECTION_AMBIGUOUS: 422,
  UNSUPPORTED: 501,
};

function sendError(reply: FastifyReply, status: number, code: string, message: string, details: Record<string, unknown> = {}) {
  return reply.status(status).send({ error: { code, message, details } });
}

/** Maps every error to `{error: {code, message, details}}` with the matching HTTP status. */
export function errorHandler(error: FastifyError | Error, _request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof MemoryError) return sendError(reply, STATUS[error.code], error.code, error.message, error.details);
  if (error instanceof AuthError) {
    if (error.status === 401) reply.header("WWW-Authenticate", "Bearer");
    return sendError(reply, error.status, error.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", error.message);
  }
  if (error instanceof z.ZodError) return sendError(reply, 400, "INVALID_ARGUMENT", `Invalid arguments: ${formatZodError(error)}`);
  const status = (error as FastifyError).statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    return sendError(reply, status, status === 413 ? "TOO_LARGE" : "INVALID_ARGUMENT", error.message);
  }
  reply.log.error(error);
  return sendError(reply, 500, "INTERNAL", "Internal error");
}

type Query = Record<string, string | undefined>;

/** Numeric query values become numbers; anything else is left for the schema to reject. */
function num(value: string | undefined): number | string | undefined {
  return value !== undefined && /^-?\d+$/.test(value) ? Number(value) : value;
}

function bool(value: string | undefined): boolean | string | undefined {
  return value === "true" ? true : value === "false" ? false : value;
}

function list(value: string | undefined): string[] | undefined {
  return value === undefined || value === "" ? undefined : value.split(",").map((s) => s.trim());
}

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Buffer.isBuffer(value)) {
    throw new MemoryError("INVALID_ARGUMENT", "The request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** `If-Match: "7"` (or `7`, `W/"7"`) → 7; `*` → undefined. */
function ifMatch(request: FastifyRequest): number | undefined {
  const raw = headerValue(request.headers["if-match"]);
  if (raw === undefined || raw.trim() === "*") return undefined;
  const match = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  if (!match) throw new MemoryError("INVALID_ARGUMENT", `Invalid If-Match header '${raw}': expected a version, e.g. "7"`);
  return Number(match[1]);
}

const etag = (version: number) => `"${version}"`;

const mediaTypes = [...new Set(Object.values(MEDIA_TYPES))];

/** `If-None-Match: *` creates; otherwise the document is overwritten, with `If-Match` as the expected version. */
function writeMode(request: FastifyRequest): { mode: "create" | "overwrite"; if_version: number | undefined } {
  const create = headerValue(request.headers["if-none-match"])?.trim() === "*";
  const ifVersion = ifMatch(request);
  if (create && ifVersion !== undefined) {
    throw new MemoryError("INVALID_ARGUMENT", "Use either If-None-Match: * (create) or If-Match (overwrite), not both");
  }
  return { mode: create ? "create" : "overwrite", if_version: ifVersion };
}

/** The bytes of a binary document; past versions get no ETag, like document reads. */
function sendFile(reply: FastifyReply, file: FileResult) {
  if (file.version === file.current_version) reply.header("ETag", etag(file.version));
  return reply
    .header("Content-Type", file.content_type)
    .header("Content-Disposition", "inline")
    .header("Cache-Control", "private, no-cache")
    .send(file.data);
}

export function registerRest(app: FastifyInstance, core: MemoryCore, auth: Authenticator, maxFileBytes: number): void {
  // The body of PUT .../files/... is the file itself.
  app.addContentTypeParser(mediaTypes, { parseAs: "buffer", bodyLimit: maxFileBytes }, (_request, data, done) => done(null, data));

  /** Context of a read; `write` also requires a token allowed to write. */
  const context = (request: FastifyRequest, write = false): Context => {
    const principal = auth.authenticate(request.headers.authorization);
    if (write) auth.requireWriter(principal);
    const { store } = request.params as { store: string };
    return auth.context(principal, store);
  };
  const writeContext = (request: FastifyRequest) => context(request, true);
  const admin = (request: FastifyRequest) => auth.requireAdmin(auth.authenticate(request.headers.authorization));
  const docPath = (request: FastifyRequest) => "/" + (request.params as { "*": string })["*"];
  const docId = (request: FastifyRequest) => num((request.params as { id: string }).id);

  app.get("/api/stores", async (request) => {
    const principal = auth.authenticate(request.headers.authorization);
    return { stores: core.listStores().filter((s) => auth.canAccess(principal, s.name)) };
  });

  app.get("/api/stores/:store/list", async (request) => {
    const ctx = context(request);
    const q = request.query as Query;
    return core.list(ctx, listArgs.parse({
      path: q.path, depth: num(q.depth), tags: list(q.tags), limit: num(q.limit), offset: num(q.offset),
    }));
  });

  app.get("/api/stores/:store/docs/*", async (request, reply) => {
    const ctx = context(request);
    const q = request.query as Query;
    const viewRange = q.from !== undefined || q.to !== undefined ? [num(q.from ?? "1"), num(q.to ?? "-1")] : undefined;
    const { lines, ...result } = core.read(ctx, readArgs.parse({
      path: docPath(request), section: q.section, view_range: viewRange, version: num(q.version),
    }));
    if (result.content_type !== undefined) {
      throw new MemoryError("INVALID_ARGUMENT",
        `${result.path} is a binary document (${result.content_type}); download it with GET /api/stores/${ctx.store}/files${result.path}`,
        { path: result.path, content_type: result.content_type });
    }
    if (!result.is_past_version) reply.header("ETag", etag(result.version));
    return { ...result, content: lines.length === 0 ? "" : lines.join("\n") + "\n" };
  });

  app.put("/api/stores/:store/docs/*", async (request, reply) => {
    const ctx = writeContext(request);
    const result = core.write(ctx, writeArgs.parse({ ...body(request), path: docPath(request), ...writeMode(request) }));
    reply.header("ETag", etag(result.version));
    if (result.created) reply.status(201);
    return result;
  });

  app.patch("/api/stores/:store/docs/*", async (request, reply) => {
    const ctx = writeContext(request);
    const b = body(request);
    const result = core.edit(ctx, editArgs.parse({ ...b, path: docPath(request), if_version: ifMatch(request) ?? b.if_version }));
    reply.header("ETag", etag(result.version));
    return result;
  });

  app.delete("/api/stores/:store/docs/*", async (request) => {
    const ctx = writeContext(request);
    const q = request.query as Query;
    return core.delete(ctx, deleteArgs.parse({
      path: docPath(request), recursive: bool(q.recursive), if_version: ifMatch(request), change_note: q.change_note,
    }));
  });

  app.get("/api/stores/:store/files/*", async (request, reply) => {
    const ctx = context(request);
    const q = request.query as Query;
    return sendFile(reply, core.readFile(ctx, fileArgs.parse({ path: docPath(request), version: num(q.version) })));
  });

  app.put("/api/stores/:store/files/*", async (request, reply) => {
    const ctx = writeContext(request);
    if (!Buffer.isBuffer(request.body)) {
      throw new MemoryError("INVALID_ARGUMENT", `The body must be the file itself, sent with Content-Type ${mediaTypes.join(", ")}`);
    }
    const q = request.query as Query;
    const args = fileWriteArgs.parse({
      path: docPath(request), ...writeMode(request), description: q.description, tags: list(q.tags), change_note: q.change_note,
    });
    const contentType = headerValue(request.headers["content-type"])?.split(";")[0]!.trim().toLowerCase();
    const result = core.writeFile(ctx, { ...args, data: request.body, content_type: contentType });
    reply.header("ETag", etag(result.version));
    if (result.created) reply.status(201);
    return result;
  });

  app.post("/api/stores/:store/search", async (request) => await core.search(context(request), searchArgs.parse(body(request))));

  app.post("/api/stores/:store/move", async (request) => core.move(writeContext(request), moveArgs.parse(body(request))));

  app.post("/api/stores/:store/batch", async (request) => core.batch(writeContext(request), batchArgs.parse(body(request))));

  app.get("/api/stores/:store/history/*", async (request) => {
    const ctx = context(request);
    const q = request.query as Query;
    return core.history(ctx, historyArgs.parse({ path: docPath(request), limit: num(q.limit) }));
  });

  app.get("/api/stores/:store/deleted", async (request) => ({ deleted: core.listDeleted(context(request)) }));

  app.get("/api/stores/:store/changes", async (request) => {
    const ctx = context(request);
    const q = request.query as Query;
    return core.changes(ctx, changesArgs.parse({ since: num(q.since), before: num(q.before), limit: num(q.limit) }));
  });

  app.get("/api/stores/:store/documents/:id", async (request) => {
    const ctx = context(request);
    return core.documentById(ctx, docIdArgs.parse({ doc_id: docId(request) }).doc_id);
  });

  app.get("/api/stores/:store/documents/:id/history", async (request) => {
    const ctx = context(request);
    const q = request.query as Query;
    return core.historyById(ctx, docHistoryArgs.parse({ doc_id: docId(request), limit: num(q.limit) }));
  });

  app.get("/api/stores/:store/documents/:id/versions/:version", async (request) => {
    const ctx = context(request);
    const { version } = request.params as { version: string };
    return core.versionById(ctx, docVersionArgs.parse({ doc_id: docId(request), version: num(version) }));
  });

  app.get("/api/stores/:store/documents/:id/versions/:version/file", async (request, reply) => {
    const ctx = context(request);
    const { version } = request.params as { version: string };
    return sendFile(reply, core.fileById(ctx, docVersionArgs.parse({ doc_id: docId(request), version: num(version) })));
  });

  app.post("/api/stores/:store/restore", async (request, reply) => {
    admin(request);
    const result = core.restore(context(request), restoreArgs.parse(body(request)));
    reply.header("ETag", etag(result.version));
    return result;
  });
}
