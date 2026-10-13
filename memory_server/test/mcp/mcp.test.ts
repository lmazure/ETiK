import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/core/db.js";
import { AGENT_TOKEN, testConfig } from "../helpers.js";

let app: FastifyInstance;
let url: URL;

beforeAll(async () => {
  app = buildApp(testConfig(), openDatabase(":memory:"));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  url = new URL("/mcp", address);
});

afterAll(async () => {
  await app.close();
});

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

const agentHeaders = { Authorization: `Bearer ${AGENT_TOKEN}`, "X-Memory-Store": "squashtm" };

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<TextResult> {
  return (await client.callTool({ name, arguments: args })) as TextResult;
}

describe("MCP server", () => {
  it("lists the nine tools with their schemas", async () => {
    const client = await connect(agentHeaders);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_batch", "memory_delete", "memory_edit", "memory_history", "memory_list",
      "memory_move", "memory_read", "memory_search", "memory_write",
    ]);
    const edit = tools.find((t) => t.name === "memory_edit")!;
    expect(edit.inputSchema.required).toEqual(["path", "operations"]);
    expect(tools.find((t) => t.name === "memory_list")!.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("creates, appends to a section and reads back numbered lines", async () => {
    const client = await connect(agentHeaders);
    const created = await call(client, "memory_write", {
      path: "/entities/requirement.md", file_text: "# Entity: Requirement\n\n## UI pages\n- Page URL: /req\n", description: "Requirements",
    });
    expect(created.content[0]!.text).toBe("OK /entities/requirement.md version=1 (created)");

    const edited = await call(client, "memory_edit", {
      path: "/entities/requirement.md",
      operations: [{ op: "append", section: "## UI pages", create_section: true, text: "- Page URL: /req/new" }],
      change_note: "found creation page",
    });
    expect(edited.content[0]!.text).toBe("OK /entities/requirement.md version=2\nChanged lines:\n     5\t- Page URL: /req/new");

    const read = await call(client, "memory_read", { path: "/entities/requirement.md", section: "## UI pages" });
    const lines = read.content[0]!.text.split("\n");
    expect(lines[3]).toMatch(/^updated: \d{4}-\d\d-\d\dT/);
    expect([...lines.slice(0, 3), ...lines.slice(4)]).toEqual([
      "path: /entities/requirement.md",
      "version: 2",
      "description: Requirements",
      "section: ## UI pages",
      "lines 3-5 of 5",
      "",
      "     3\t## UI pages",
      "     4\t- Page URL: /req",
      "     5\t- Page URL: /req/new",
    ]);

    const list = await call(client, "memory_list", {});
    expect(list.content[0]!.text).toContain("/entities/ · 1 document");

    const search = await call(client, "memory_search", { query: "/req/new" });
    expect(search.content[0]!.text).toBe("1 match\n/entities/requirement.md:5 · ## UI pages · 1\n    - Page URL: /req/new");
    await client.close();
  });

  it("returns actionable errors as tool errors", async () => {
    const client = await connect(agentHeaders);
    await call(client, "memory_write", { path: "/conflict.md", file_text: "x\n" });
    await call(client, "memory_edit", { path: "/conflict.md", operations: [{ op: "append", text: "y" }] });
    const conflict = await call(client, "memory_edit", { path: "/conflict.md", if_version: 1, operations: [{ op: "append", text: "z" }] });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]!.text).toBe("Error: Version conflict on /conflict.md: expected 1, current 2; re-read and retry");

    const invalid = await call(client, "memory_read", {});
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it("records the actor and change note in the history", async () => {
    const client = await connect(agentHeaders);
    await call(client, "memory_write", { path: "/h.md", file_text: "x\n", change_note: "first" });
    const history = await call(client, "memory_history", { path: "/h.md" });
    expect(history.content[0]!.text).toMatch(/^History of \/h\.md: 1 version, current 1 \(newest first\)\nv1 · .* · create · agent:squashtm · 2 B · "first"$/);
    await client.close();
  });

  it("truncates long reads with a notice", async () => {
    const client = await connect(agentHeaders);
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n");
    await call(client, "memory_write", { path: "/long.md", file_text: text });
    const read = await call(client, "memory_read", { path: "/long.md" });
    expect(read.content[0]!.text.length).toBeLessThanOrEqual(2_200);
    expect(read.content[0]!.text).toMatch(/\[truncated after line \d+ of 200; read the rest with view_range \[\d+, 200\]\]$/);
    await client.close();
  });

  it("rejects missing or foreign credentials before any MCP processing", async () => {
    await expect(connect({ "X-Memory-Store": "squashtm" })).rejects.toThrow();
    await expect(connect({ Authorization: `Bearer ${AGENT_TOKEN}`, "X-Memory-Store": "other" })).rejects.toThrow();
    const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
    expect(response.status).toBe(405);
  });
});
