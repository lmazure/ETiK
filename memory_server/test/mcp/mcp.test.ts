import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/core/db.js";
import { AGENT_TOKEN, FakeEmbedder, PNG, testConfig } from "../helpers.js";

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

describe("MCP binary and append-only documents", () => {
  type MixedResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

  it("writes an image in base64 and reads it back as an image", async () => {
    const client = await connect(agentHeaders);
    const written = await call(client, "memory_write", { path: "/s/shot.png", file_text: PNG.toString("base64"), encoding: "base64" });
    expect(written.content[0]!.text).toBe("OK /s/shot.png version=1 (created)");
    const read = (await client.callTool({ name: "memory_read", arguments: { path: "/s/shot.png" } })) as MixedResult;
    expect(read.content).toHaveLength(2);
    expect(read.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`binary: image/png, ${PNG.length} B`) });
    expect(read.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    const list = await call(client, "memory_list", { path: "/s" });
    expect(list.content[0]!.text).toMatch(/^\/s\/shot\.png · v1 · \d+ B · .* · image\/png$/m);
    await client.close();
  });

  it("describes an image over the size limit instead of returning it", async () => {
    const client = await connect(agentHeaders);
    const big = Buffer.concat([PNG, Buffer.alloc(1_000)]);
    await call(client, "memory_write", { path: "/big.png", file_text: big.toString("base64"), encoding: "base64" });
    const read = await call(client, "memory_read", { path: "/big.png" });
    expect(read.content).toHaveLength(1);
    expect(read.content[0]!.text.split("\n").at(-1))
      .toBe("(not shown: larger than the 1000 bytes limit for images; download it with GET /api/stores/squashtm/files/big.png)");
    await client.close();
  });

  it("shows the append-only flag and refuses a rewrite", async () => {
    const client = await connect(agentHeaders);
    await call(client, "memory_write", { path: "/log.md", file_text: "# Log\n", append_only: true });
    const read = await call(client, "memory_read", { path: "/log.md" });
    expect(read.content[0]!.text).toContain("append-only: yes (only additions at the end are accepted)");
    const list = await call(client, "memory_list", {});
    expect(list.content[0]!.text).toMatch(/^\/log\.md · v1 · 6 B · .* · append-only$/m);
    const refused = await call(client, "memory_edit", { path: "/log.md", operations: [{ op: "prepend", text: "x" }] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe("Error: /log.md is append-only: only additions at its end are accepted; add text with memory_edit op 'append' without section");
    await client.close();
  });
});

describe("MCP semantic search", () => {
  it("shows one hit per section chunk with its line range and similarity", async () => {
    const semanticApp = buildApp(testConfig(), openDatabase(":memory:"), {}, { embedder: new FakeEmbedder() });
    try {
      const semanticUrl = new URL("/mcp", await semanticApp.listen({ host: "127.0.0.1", port: 0 }));
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(semanticUrl, { requestInit: { headers: agentHeaders } }));
      await call(client, "memory_write", {
        path: "/entities/campaign.md", file_text: "# Campaign\n\nCampaigns.\n\n## Business rules\n- A campaign groups iterations\n- Iterations hold test suites\n",
      });
      const search = await call(client, "memory_search", { query: "campaign groups iterations", mode: "semantic", limit: 1 });
      expect(search.content[0]!.text).toMatch(new RegExp([
        "^2 sections, most similar first",
        "/entities/campaign\\.md:5-7 · ## Business rules · 0\\.\\d+",
        "    - A campaign groups iterations",
        "next_offset=1 \\(more results: call again with offset=1\\)$",
      ].join("\n")));
      await client.close();
    } finally {
      await semanticApp.close();
    }
  });
});
