import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/core/db.js";
import { ADMIN_TOKEN, AGENT_TOKEN, VIEWER_TOKEN, testConfig } from "../helpers.js";

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp(testConfig(), openDatabase(":memory:"));
});

afterEach(async () => {
  await app.close();
});

const agent = { authorization: `Bearer ${AGENT_TOKEN}`, "x-memory-session": "session_03" };
const viewer = { authorization: `Bearer ${VIEWER_TOKEN}` };
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const base = "/api/stores/squashtm";

async function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) {
  const response = await app.inject({ method, url, headers, ...(payload !== undefined && { payload: payload as object }) });
  return { status: response.statusCode, body: response.body ? response.json() : undefined };
}

const create = (path: string, text: string) =>
  call("PUT", `${base}/docs${path}`, { ...agent, "if-none-match": "*" }, { file_text: text });
const append = (path: string, text: string) =>
  call("PATCH", `${base}/docs${path}`, agent, { operations: [{ op: "append", text }], change_note: `add ${text}` });

describe("viewer token", () => {
  it("reads every store but never writes", async () => {
    await create("/a.md", "a\n");
    await call("PUT", "/api/stores/other/docs/b.md", { authorization: `Bearer ${ADMIN_TOKEN}`, "if-none-match": "*" }, { file_text: "b\n" });
    expect((await call("GET", `${base}/docs/a.md`, viewer)).status).toBe(200);
    expect((await call("GET", "/api/stores/other/docs/b.md", viewer)).status).toBe(200);
    expect((await call("GET", "/api/stores", viewer)).body.stores.map((s: { name: string }) => s.name)).toEqual(["other", "squashtm"]);

    const writes = [
      call("PUT", `${base}/docs/a.md`, viewer, { file_text: "x" }),
      call("PUT", `${base}/docs/new.md`, { ...viewer, "if-none-match": "*" }, { file_text: "x" }),
      call("PATCH", `${base}/docs/a.md`, viewer, { operations: [{ op: "append", text: "x" }] }),
      call("DELETE", `${base}/docs/a.md`, viewer),
      call("POST", `${base}/move`, viewer, { old_path: "/a.md", new_path: "/c.md" }),
      call("POST", `${base}/batch`, viewer, { operations: [{ tool: "memory_delete", arguments: { path: "/a.md" } }] }),
      call("POST", `${base}/restore`, viewer, { doc_id: 1 }),
    ];
    for (const result of await Promise.all(writes)) expect(result.status).toBe(403);
    expect((await call("GET", `${base}/docs/a.md`, viewer)).body.version).toBe(1);
  });

  it("cannot use MCP", async () => {
    const response = await app.inject({
      method: "POST", url: "/mcp", headers: { ...viewer, "x-memory-store": "squashtm", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("lists only reachable stores for an agent", async () => {
    await create("/a.md", "a\n");
    await call("PUT", "/api/stores/other/docs/b.md", { ...admin, "if-none-match": "*" }, { file_text: "b\n" });
    expect((await call("GET", "/api/stores", agent)).body.stores.map((s: { name: string }) => s.name)).toEqual(["squashtm"]);
  });
});

describe("change feed", () => {
  it("returns the latest cursor and the changes after it, oldest first", async () => {
    expect((await call("GET", `${base}/changes`, viewer)).body).toEqual({ latest: 0, changes: [] });
    await create("/a.md", "a\n");
    const cursor = (await call("GET", `${base}/changes?limit=1`, viewer)).body.latest;
    await append("/a.md", "b");
    await call("POST", `${base}/move`, agent, { old_path: "/a.md", new_path: "/z/a.md" });

    const after = (await call("GET", `${base}/changes?since=${cursor}`, viewer)).body;
    expect(after.latest).toBe(cursor + 2);
    expect(after.changes).toEqual([
      expect.objectContaining({
        id: cursor + 1, actor: "agent:squashtm", session: "session_03", change_note: "add b",
        items: [{ doc_id: 1, path: "/a.md", version: 2, op: "edit" }],
      }),
      expect.objectContaining({
        id: cursor + 2,
        items: [{ doc_id: 1, path: "/z/a.md", previous_path: "/a.md", version: 3, op: "move" }],
      }),
    ]);
  });

  it("pages backwards with before, newest first, and groups a batch", async () => {
    await create("/a.md", "a\n");
    await call("POST", `${base}/batch`, agent, { operations: [
      { tool: "memory_write", arguments: { path: "/b.md", file_text: "b" } },
      { tool: "memory_delete", arguments: { path: "/a.md" } },
    ] });
    const recent = (await call("GET", `${base}/changes?limit=1`, viewer)).body;
    expect(recent.changes).toHaveLength(1);
    expect(recent.changes[0].items.map((i: { path: string; op: string }) => [i.path, i.op])).toEqual([["/a.md", "delete"], ["/b.md", "create"]]);
    const older = (await call("GET", `${base}/changes?before=${recent.changes[0].id}`, viewer)).body;
    expect(older.changes.map((c: { id: number }) => c.id)).toEqual([recent.changes[0].id - 1]);
    expect((await call("GET", `${base}/changes?since=1&before=3`, viewer)).status).toBe(400);
  });

  it("is scoped to the store", async () => {
    await create("/a.md", "a\n");
    expect((await call("GET", "/api/stores/other/changes", viewer)).body).toEqual({ latest: 0, changes: [] });
  });
});

describe("documents by id", () => {
  it("follows a document through moves and deletion", async () => {
    await create("/a.md", "one\n");
    await append("/a.md", "two");
    await call("POST", `${base}/move`, agent, { old_path: "/a.md", new_path: "/b.md" });
    await call("DELETE", `${base}/docs/b.md`, agent);

    const doc = (await call("GET", `${base}/documents/1`, viewer)).body;
    expect(doc).toMatchObject({ id: 1, path: "/b.md", version: 4, deleted: true });

    const history = (await call("GET", `${base}/documents/1/history`, viewer)).body;
    expect(history.deleted).toBe(true);
    expect(history.versions.map((v: { version: number; op: string; path: string }) => [v.version, v.op, v.path])).toEqual([
      [4, "delete", "/b.md"], [3, "move", "/b.md"], [2, "edit", "/a.md"], [1, "create", "/a.md"],
    ]);
    expect(history.versions[2]).toMatchObject({ change_note: "add two", session: "session_03" });
    expect(history.versions[0].content).toBeUndefined();

    const v2 = (await call("GET", `${base}/documents/1/versions/2`, viewer)).body;
    expect(v2).toMatchObject({ doc_id: 1, version: 2, current_version: 4, deleted: true, path: "/a.md", content: "one\ntwo\n", op: "edit" });
  });

  it("returns 404 for unknown ids, versions and other stores' documents", async () => {
    await create("/a.md", "a\n");
    expect((await call("GET", `${base}/documents/99`, viewer)).status).toBe(404);
    expect((await call("GET", `${base}/documents/1/versions/9`, viewer)).status).toBe(404);
    expect((await call("GET", "/api/stores/other/documents/1", viewer)).status).toBe(404);
    expect((await call("GET", `${base}/documents/abc`, viewer)).status).toBe(400);
  });

  it("gives document ids in listings", async () => {
    await create("/a.md", "a\n");
    expect((await call("GET", `${base}/list`, viewer)).body.entries[0]).toMatchObject({ type: "document", id: 1, path: "/a.md" });
  });
});

describe("web app serving", () => {
  it("serves the built app with security headers", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "web-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>memory</title>");
    const withWeb = buildApp(testConfig({ webRoot: root }), openDatabase(":memory:"));
    const page = await withWeb.inject({ method: "GET", url: "/" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>memory</title>");
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect((await withWeb.inject({ method: "GET", url: "/api/stores", headers: viewer })).statusCode).toBe(200);
    await withWeb.close();
  });

  it("serves no page when the app is not built", async () => {
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});
