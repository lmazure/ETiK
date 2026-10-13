import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/core/db.js";
import { ADMIN_TOKEN, AGENT_TOKEN, OTHER_TOKEN, testConfig } from "../helpers.js";

let app: FastifyInstance;

beforeEach(() => {
  app = buildApp(testConfig(), openDatabase(":memory:"));
});

afterEach(async () => {
  await app.close();
});

const agent = { authorization: `Bearer ${AGENT_TOKEN}` };
const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const base = "/api/stores/squashtm";

function create(path: string, body: Record<string, unknown>) {
  return app.inject({ method: "PUT", url: `${base}/docs${path}`, headers: { ...agent, "if-none-match": "*" }, payload: body });
}

describe("authentication", () => {
  it("requires a bearer token", async () => {
    const response = await app.inject({ method: "GET", url: `${base}/list` });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    expect((await app.inject({ method: "GET", url: `${base}/list`, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
  });

  it("keeps an agent token in its own store and out of admin routes", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stores/other/list", headers: agent })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `${base}/restore`, headers: agent, payload: { doc_id: 1 } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/stores/other/list", headers: { authorization: `Bearer ${OTHER_TOKEN}` } })).statusCode).toBe(200);
  });

  it("lets the admin reach every store", async () => {
    await create("/a.md", { file_text: "a\n" });
    const stores = await app.inject({ method: "GET", url: "/api/stores", headers: admin });
    expect(stores.json().stores).toEqual([expect.objectContaining({ name: "squashtm", documents: 1 })]);
    expect((await app.inject({ method: "GET", url: `${base}/docs/a.md`, headers: admin })).statusCode).toBe(200);
  });

  it("serves health and OpenAPI without a token", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    const openApi = (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();
    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.paths["/api/stores/{store}/docs/{path}"].patch.requestBody.content["application/json"].schema.properties.operations).toBeDefined();
  });
});

describe("documents", () => {
  it("creates with If-None-Match, reads with an ETag, overwrites with If-Match", async () => {
    const created = await create("/entities/req.md", { file_text: "# Req\n## UI pages\n", description: "Requirement" });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect((await create("/entities/req.md", { file_text: "x" })).statusCode).toBe(409);

    const read = await app.inject({ method: "GET", url: `${base}/docs/entities/req.md`, headers: agent });
    expect(read.statusCode).toBe(200);
    expect(read.headers.etag).toBe('"1"');
    expect(read.json()).toMatchObject({ path: "/entities/req.md", version: 1, description: "Requirement", content: "# Req\n## UI pages\n" });

    const overwrite = (ifMatch: string) => app.inject({
      method: "PUT", url: `${base}/docs/entities/req.md`, headers: { ...agent, "if-match": ifMatch }, payload: { file_text: "# Req v2\n" },
    });
    expect((await overwrite('"1"')).statusCode).toBe(200);
    const conflict = await overwrite('"1"');
    expect(conflict.statusCode).toBe(412);
    expect(conflict.json().error).toMatchObject({ code: "VERSION_CONFLICT", details: { expected: 1, current: 2 } });
  });

  it("returns 404 when overwriting a missing document", async () => {
    const response = await app.inject({ method: "PUT", url: `${base}/docs/nope.md`, headers: agent, payload: { file_text: "x" } });
    expect(response.statusCode).toBe(404);
  });

  it("edits with PATCH and maps edit failures to 422", async () => {
    await create("/e.md", { file_text: "## A\n- one\n" });
    const ok = await app.inject({
      method: "PATCH", url: `${base}/docs/e.md`, headers: { ...agent, "if-match": '"1"' },
      payload: { operations: [{ op: "append", section: "## A", text: "- two" }], change_note: "two" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ path: "/e.md", version: 2, changed: { from: 3, to: 3, lines: ["- two"] } });
    const missing = await app.inject({
      method: "PATCH", url: `${base}/docs/e.md`, headers: agent, payload: { operations: [{ op: "append", section: "## B", text: "x" }] },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe("SECTION_NOT_FOUND");
  });

  it("reads sections, ranges and past versions through query parameters", async () => {
    await create("/e.md", { file_text: "## A\na\n## B\nb\n" });
    await app.inject({ method: "PATCH", url: `${base}/docs/e.md`, headers: agent, payload: { operations: [{ op: "append", text: "c" }] } });
    const section = await app.inject({ method: "GET", url: `${base}/docs/e.md?section=${encodeURIComponent("## B")}`, headers: agent });
    expect(section.json()).toMatchObject({ from: 3, to: 5, content: "## B\nb\nc\n" });
    const range = await app.inject({ method: "GET", url: `${base}/docs/e.md?from=2&to=3`, headers: agent });
    expect(range.json().content).toBe("a\n## B\n");
    const past = await app.inject({ method: "GET", url: `${base}/docs/e.md?version=1`, headers: agent });
    expect(past.json()).toMatchObject({ version: 1, is_past_version: true, total_lines: 4 });
    expect(past.headers.etag).toBeUndefined();
    const bad = await app.inject({ method: "GET", url: `${base}/docs/e.md?version=abc`, headers: agent });
    expect(bad.statusCode).toBe(400);
  });

  it("handles encoded paths", async () => {
    expect((await create("/notes/my%20note.md", { file_text: "x\n" })).statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `${base}/list?path=/notes`, headers: agent });
    expect(list.json().entries[0].path).toBe("/notes/my note.md");
  });

  it("rejects invalid bodies and paths", async () => {
    expect((await create("/a.md", { file_text: 42 })).statusCode).toBe(400);
    expect((await create("/a//b.md", { file_text: "x" })).statusCode).toBe(400);
    const tooLarge = await create("/big.md", { file_text: "x".repeat(10_001) });
    expect(tooLarge.statusCode).toBe(413);
  });
});

describe("other operations", () => {
  it("lists, searches, moves, deletes and shows history", async () => {
    await create("/entities/a.md", { file_text: "- assumed fact\n", tags: ["entity"] });
    await create("/index.md", { file_text: "index\n" });

    const list = await app.inject({ method: "GET", url: `${base}/list?depth=1&tags=entity`, headers: agent });
    expect(list.json().entries).toEqual([{ type: "folder", path: "/entities", documents: 1 }]);

    const search = await app.inject({ method: "POST", url: `${base}/search`, headers: agent, payload: { query: "ASSUMED" } });
    expect(search.json().hits).toEqual([{ path: "/entities/a.md", line: 1, snippet: "- assumed fact", score: 1 }]);
    const semantic = await app.inject({ method: "POST", url: `${base}/search`, headers: agent, payload: { query: "x", mode: "semantic" } });
    expect(semantic.statusCode).toBe(501);

    const move = await app.inject({ method: "POST", url: `${base}/move`, headers: agent, payload: { old_path: "/entities", new_path: "/archive" } });
    expect(move.json().moved).toEqual([{ from: "/entities/a.md", to: "/archive/a.md", version: 2 }]);

    const history = await app.inject({ method: "GET", url: `${base}/history/archive/a.md`, headers: agent });
    expect(history.json().versions.map((v: { op: string; actor: string }) => [v.op, v.actor])).toEqual([["move", "agent:squashtm"], ["create", "agent:squashtm"]]);

    expect((await app.inject({ method: "DELETE", url: `${base}/docs/archive`, headers: agent })).statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: `${base}/docs/archive?recursive=true`, headers: agent });
    expect(deleted.json().deleted).toEqual([{ path: "/archive/a.md", version: 3 }]);
  });

  it("applies a batch atomically", async () => {
    await create("/index.md", { file_text: "index\n" });
    const failed = await app.inject({
      method: "POST", url: `${base}/batch`, headers: agent,
      payload: { operations: [
        { tool: "memory_write", arguments: { path: "/x.md", file_text: "x" } },
        { tool: "memory_edit", arguments: { path: "/index.md", if_version: 7, operations: [{ op: "append", text: "x" }] } },
      ] },
    });
    expect(failed.statusCode).toBe(412);
    expect(failed.json().error.details.operation).toBe(2);
    expect((await app.inject({ method: "GET", url: `${base}/docs/x.md`, headers: agent })).statusCode).toBe(404);
  });

  it("lets the admin list and restore deleted documents", async () => {
    await create("/a.md", { file_text: "a\n" });
    await app.inject({ method: "DELETE", url: `${base}/docs/a.md`, headers: agent });
    const deleted = await app.inject({ method: "GET", url: `${base}/deleted`, headers: admin });
    const docId = deleted.json().deleted[0].doc_id;
    const restored = await app.inject({ method: "POST", url: `${base}/restore`, headers: admin, payload: { doc_id: docId } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ path: "/a.md", version: 3 });
    expect((await app.inject({ method: "POST", url: `${base}/restore`, headers: agent, payload: { doc_id: docId } })).statusCode).toBe(403);
  });
});
