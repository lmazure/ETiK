import { describe, expect, it, vi } from "vitest";
import { MemoryError } from "../../src/core/errors.js";
import { batchArgs, restoreArgs } from "../../src/schemas.js";
import { FakeEmbedder, PNG, testCore } from "../helpers.js";

function errorOf(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) return error;
    throw error;
  }
  throw new Error("expected a MemoryError");
}

function count(t: ReturnType<typeof testCore>, table: string): number {
  return (t.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("write and read", () => {
  it("creates, then refuses to create again", () => {
    const t = testCore();
    expect(t.write({ path: "/index.md", file_text: "# Index\n", description: "Pointers" })).toEqual({ path: "/index.md", version: 1, created: true });
    const error = errorOf(() => t.write({ path: "/index.md", file_text: "x" }));
    expect(error.code).toBe("ALREADY_EXISTS");
    expect(error.message).toContain("use mode 'overwrite'");
  });

  it("overwrites only an existing document, keeping metadata not given", () => {
    const t = testCore();
    expect(errorOf(() => t.write({ path: "/a.md", file_text: "x", mode: "overwrite" })).code).toBe("NOT_FOUND");
    t.write({ path: "/a.md", file_text: "one\n", description: "d", tags: ["t"] });
    expect(t.write({ path: "/a.md", file_text: "two\n", mode: "overwrite" }).version).toBe(2);
    const doc = t.read({ path: "/a.md" });
    expect(doc).toMatchObject({ version: 2, description: "d", tags: ["t"], lines: ["two"] });
  });

  it("reads a section, a range and a past version", () => {
    const t = testCore();
    t.write({ path: "/e.md", file_text: "# E\n## A\na1\na2\n## B\nb1\n" });
    t.edit({ path: "/e.md", operations: [{ op: "append", section: "## B", text: "b2" }] });
    expect(t.read({ path: "/e.md", section: "## A" })).toMatchObject({ from: 2, to: 4, lines: ["## A", "a1", "a2"] });
    expect(t.read({ path: "/e.md", view_range: [5, -1] })).toMatchObject({ from: 5, to: 7, lines: ["## B", "b1", "b2"] });
    expect(t.read({ path: "/e.md", version: 1 })).toMatchObject({ version: 1, current_version: 2, is_past_version: true, total_lines: 6 });
    expect(errorOf(() => t.read({ path: "/e.md", version: 9 })).message).toBe("Version 9 of /e.md does not exist; current version is 2");
    expect(errorOf(() => t.read({ path: "/e.md", view_range: [3, 99] })).code).toBe("INVALID_ARGUMENT");
  });

  it("keeps CRLF out of the store and enforces the size limit", () => {
    const t = testCore(100);
    t.write({ path: "/a.md", file_text: "a\r\nb\r\n" });
    expect(t.read({ path: "/a.md" }).lines).toEqual(["a", "b"]);
    expect(errorOf(() => t.write({ path: "/big.md", file_text: "x".repeat(101) })).code).toBe("TOO_LARGE");
  });

  it("keeps documents and folders apart", () => {
    const t = testCore();
    t.write({ path: "/entities/a.md", file_text: "a" });
    expect(errorOf(() => t.write({ path: "/entities", file_text: "x" })).code).toBe("IS_FOLDER");
    expect(errorOf(() => t.write({ path: "/entities/a.md/b.md", file_text: "x" })).code).toBe("INVALID_PATH");
    expect(errorOf(() => t.read({ path: "/entities" })).code).toBe("IS_FOLDER");
  });
});

describe("edit and concurrency", () => {
  it("appends to a section and returns the changed lines", () => {
    const t = testCore();
    t.write({ path: "/e.md", file_text: "# E\n\n## UI pages\n- p1\n\n## Rules\n- r1\n" });
    const result = t.edit({ path: "/e.md", operations: [{ op: "append", section: "## UI pages", text: "- p2" }], change_note: "found p2" });
    expect(result).toEqual({ path: "/e.md", version: 2, changed: { from: 5, to: 5, lines: ["- p2"] } });
  });

  it("rejects a stale if_version and leaves the document unchanged", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "v1\n" });
    t.edit({ path: "/a.md", operations: [{ op: "append", text: "v2" }] });
    const error = errorOf(() => t.edit({ path: "/a.md", if_version: 1, operations: [{ op: "append", text: "v3" }] }));
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.message).toBe("Version conflict on /a.md: expected 1, current 2; re-read and retry");
    expect(t.read({ path: "/a.md" })).toMatchObject({ version: 2, lines: ["v1", "v2"] });
    expect(t.edit({ path: "/a.md", if_version: 2, operations: [{ op: "append", text: "v3" }] }).version).toBe(3);
  });

  it("does not create a version when nothing changes", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "x\n", tags: ["a"] });
    expect(t.edit({ path: "/a.md", operations: [{ op: "set_metadata", tags: ["a"] }] })).toEqual({ path: "/a.md", version: 1, unchanged: true });
    expect(count(t, "versions")).toBe(1);
  });

  it("writes nothing when one operation of an edit fails", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "x\n" });
    const changesets = count(t, "changesets");
    expect(() => t.edit({ path: "/a.md", operations: [{ op: "append", text: "y" }, { op: "str_replace", old_str: "nope" }] })).toThrow();
    expect(count(t, "changesets")).toBe(changesets);
    expect(t.read({ path: "/a.md" }).version).toBe(1);
  });
});

describe("list and search", () => {
  function seeded() {
    const t = testCore();
    t.write({ path: "/index.md", file_text: "# Index\n", description: "Pointers" });
    t.write({ path: "/business-rules.md", file_text: "## Business rules\n- a rule (source: assumed, session_01)\n" });
    t.write({ path: "/entities/requirement.md", file_text: "# Requirement\n## Private backend API\n- POST /backend/requirements\n", tags: ["entity"], metadata: { kind: "entity" } });
    t.write({ path: "/entities/campaign.md", file_text: "# Campaign\n## Business rules\n- assumed, session_01: x Assumed\n", tags: ["entity"] });
    t.write({ path: "/entities/deep/x.md", file_text: "x\n" });
    return t;
  }

  it("lists to a depth, with folder summaries and descriptions", () => {
    const t = seeded();
    const result = t.list({ path: "/", depth: 1 });
    expect(result.entries).toEqual([
      expect.objectContaining({ type: "document", path: "/business-rules.md" }),
      { type: "folder", path: "/entities", documents: 3 },
      expect.objectContaining({ type: "document", path: "/index.md", description: "Pointers", version: 1 }),
    ]);
    expect(t.list({ path: "/entities", depth: 1 }).entries.map((e) => e.path)).toEqual(["/entities/campaign.md", "/entities/deep", "/entities/requirement.md"]);
    expect(t.list({ path: "/", depth: 5, tags: ["entity"] }).entries.filter((e) => e.type === "document")).toHaveLength(2);
    expect(errorOf(() => t.list({ path: "/missing" })).code).toBe("NOT_FOUND");
  });

  it("paginates listings", () => {
    const t = seeded();
    const first = t.list({ path: "/", depth: 5, limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.next_offset).toBe(2);
    expect(t.list({ path: "/", depth: 5, limit: 2, offset: 6 }).next_offset).toBeUndefined();
  });

  it("finds keywords case-insensitively, with section and score", async () => {
    const t = seeded();
    const result = await t.search({ query: "assumed" });
    expect(result.mode).toBe("keyword");
    expect(result.total).toBe(2);
    expect(result.hits[1]).toEqual({
      path: "/entities/campaign.md", line: 3, section: "## Business rules", snippet: "- assumed, session_01: x Assumed", score: 2,
    });
  });

  it("filters by path prefix, tags and metadata, and supports regex", async () => {
    const t = seeded();
    expect((await t.search({ query: "assumed", path_prefix: "/entities" })).total).toBe(1);
    expect((await t.search({ query: "/backend/requirements", metadata: { kind: "entity" } })).hits[0]!.path).toBe("/entities/requirement.md");
    expect((await t.search({ query: "^- (POST|GET) ", mode: "regex", tags: ["entity"] })).total).toBe(1);
    await expect(t.search({ query: "(", mode: "regex" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("refuses semantic and hybrid search when no embedding model is configured", async () => {
    const t = seeded();
    for (const mode of ["semantic", "hybrid"]) {
      await expect(t.search({ query: "x", mode })).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: `Search mode '${mode}' is not available: semantic search is disabled on this server (MEMORY_EMBEDDING_MODEL=none); use 'keyword' or 'regex'`,
      });
    }
  });
});

describe("semantic and hybrid search", () => {
  /** "removed" and "deleted" share a dimension of the fake model, as they would share a meaning. */
  function seeded(options: { refreshDelayMs?: number } = {}) {
    const embedder = new FakeEmbedder({ removed: "deleted", remove: "delete" });
    const t = testCore(10_000, 20_000, { embedder, refreshDelayMs: options.refreshDelayMs ?? 60_000 });
    t.write({
      path: "/knowledge/requirement.md", description: "Requirement entity", tags: ["entity"], metadata: { kind: "entity" },
      file_text: "# Requirement\n\n## UI pages\n- Page URL: /req\n\n## Deletion\n- A requirement linked to a test case cannot be deleted\n",
    });
    t.write({ path: "/knowledge/campaign.md", file_text: "# Campaign\n\n## Business rules\n- A campaign groups iterations\n" });
    t.core.writeFile(t.ctx, { path: "/knowledge/shot.png", mode: "create", data: PNG });
    return { ...t, embedder };
  }

  it("ranks section chunks by similarity, with their line range", async () => {
    const t = seeded();
    const result = await t.search({ query: "can a requirement linked to a test case be removed?", mode: "semantic" });
    expect(result.mode).toBe("semantic");
    expect(result.total).toBe(3);
    expect(result.hits.map((h) => `${h.path}:${h.line}-${h.end_line}`))
      .toEqual(["/knowledge/requirement.md:6-7", "/knowledge/requirement.md:3-4", "/knowledge/campaign.md:3-4"]);
    expect(result.hits[0]).toMatchObject({ section: "## Deletion", snippet: "- A requirement linked to a test case cannot be deleted" });
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    expect(result.hits.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
    t.core.close();
  });

  it("applies the filters and pages the results", async () => {
    const t = seeded();
    expect((await t.search({ query: "campaign", mode: "semantic", path_prefix: "/knowledge/campaign.md" })).total).toBe(1);
    expect((await t.search({ query: "campaign", mode: "hybrid", tags: ["entity"] })).hits.map((h) => h.path))
      .toEqual(["/knowledge/requirement.md", "/knowledge/requirement.md"]);
    expect((await t.search({ query: "campaign", mode: "semantic", metadata: { kind: "entity" } })).total).toBe(2);
    expect((await t.search({ query: "campaign", mode: "semantic", path_prefix: "/sessions" })).total).toBe(0);
    const page = await t.search({ query: "campaign", mode: "semantic", limit: 1, offset: 1 });
    expect(page.hits).toHaveLength(1);
    expect(page.next_offset).toBe(2);
    t.core.close();
  });

  it("refuses an empty or too long query", async () => {
    const t = seeded();
    await expect(t.search({ query: "  ", mode: "semantic" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(t.search({ query: "x".repeat(1001), mode: "hybrid" })).rejects
      .toMatchObject({ code: "INVALID_ARGUMENT", message: "A hybrid query is limited to 1000 characters; describe what you look for in fewer words" });
    t.core.close();
  });

  it("fuses similarity and key words in hybrid mode", async () => {
    const t = testCore(10_000, 20_000, { embedder: new FakeEmbedder({ remove: "delete" }), refreshDelayMs: 60_000 });
    t.write({ path: "/a.md", file_text: "delete requirement\n" });      // most similar, one query word
    t.write({ path: "/b.md", file_text: "remove requirement later\n" }); // similar, both query words
    t.write({ path: "/c.md", file_text: "requirement requirement\n" });  // least similar, one query word twice
    const semantic = await t.search({ query: "remove requirement", mode: "semantic" });
    expect(semantic.hits.map((h) => h.path)).toEqual(["/a.md", "/b.md", "/c.md"]);
    const hybrid = await t.search({ query: "remove requirement", mode: "hybrid" });
    expect(hybrid.mode).toBe("hybrid");
    expect(hybrid.hits.map((h) => h.path)).toEqual(["/b.md", "/a.md", "/c.md"]);
    expect(hybrid.hits[0]!.score).toBe(Math.round((1 / 62 + 1 / 61) * 10_000) / 10_000);
    t.core.close();
  });

  it("embeds each chunk once: a move reuses the vectors, an edit re-embeds only the changed chunk", async () => {
    const t = seeded();
    await t.search({ query: "requirement", mode: "semantic" });
    expect([t.embedder.passages, t.embedder.queries]).toEqual([3, 1]);
    await t.search({ query: "campaign", mode: "hybrid" });
    expect([t.embedder.passages, t.embedder.queries]).toEqual([3, 2]);
    t.move({ old_path: "/knowledge/campaign.md", new_path: "/knowledge/old/campaign.md" });
    await t.search({ query: "campaign", mode: "semantic" });
    expect(t.embedder.passages).toBe(3);
    t.edit({ path: "/knowledge/requirement.md", operations: [{ op: "str_replace", old_str: "/req", new_str: "/requirements" }] });
    await t.search({ query: "campaign", mode: "semantic" });
    expect(t.embedder.passages).toBe(4);
    t.core.close();
  });

  it("embeds the chunks of a write in the background", async () => {
    const t = seeded({ refreshDelayMs: 0 });
    await vi.waitFor(() => expect(t.embedder.passages).toBe(3));
    await t.search({ query: "campaign", mode: "semantic" });
    expect(t.embedder.passages).toBe(3);
    t.core.close();
  });
});

describe("move, delete, history and restore", () => {
  it("moves a document and keeps its history", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "a\n" });
    t.move({ old_path: "/a.md", new_path: "/archive/a.md", change_note: "archive" });
    expect(errorOf(() => t.read({ path: "/a.md" })).code).toBe("NOT_FOUND");
    const history = t.history({ path: "/archive/a.md" });
    expect(history.versions.map((v) => [v.version, v.op, v.path])).toEqual([[2, "move", "/archive/a.md"], [1, "create", "/a.md"]]);
    expect(history.versions[0]).toMatchObject({ change_note: "archive", actor: "agent:squashtm" });
  });

  it("refuses to move onto an existing document unless overwrite", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "a\n" });
    t.write({ path: "/b.md", file_text: "b\n" });
    expect(errorOf(() => t.move({ old_path: "/a.md", new_path: "/b.md" })).code).toBe("ALREADY_EXISTS");
    expect(t.move({ old_path: "/a.md", new_path: "/b.md", overwrite: true }).replaced).toEqual(["/b.md"]);
    expect(t.read({ path: "/b.md" }).lines).toEqual(["a"]);
  });

  it("moves a folder, including into its parent", () => {
    const t = testCore();
    t.write({ path: "/x/y/a.md", file_text: "a\n" });
    t.write({ path: "/x/y/y/b.md", file_text: "b\n" });
    const result = t.move({ old_path: "/x/y", new_path: "/x" });
    expect(result.moved.map((m) => m.to).sort()).toEqual(["/x/a.md", "/x/y/b.md"]);
    expect(t.list({ path: "/", depth: 5 }).entries.filter((e) => e.type === "document").map((e) => e.path)).toEqual(["/x/a.md", "/x/y/b.md"]);
    expect(errorOf(() => t.move({ old_path: "/x", new_path: "/x/z" })).code).toBe("INVALID_ARGUMENT");
  });

  it("soft-deletes documents and folders", () => {
    const t = testCore();
    t.write({ path: "/f/a.md", file_text: "a\n" });
    t.write({ path: "/f/b.md", file_text: "b\n" });
    expect(errorOf(() => t.remove({ path: "/f" })).code).toBe("IS_FOLDER");
    expect(errorOf(() => t.remove({ path: "/" })).code).toBe("INVALID_ARGUMENT");
    expect(t.remove({ path: "/f", recursive: true }).deleted).toHaveLength(2);
    expect(t.list().total).toBe(0);
    expect(count(t, "versions")).toBe(4);
    expect(errorOf(() => t.read({ path: "/f/a.md" })).message).toContain("an administrator can restore it");
    // the path is free again, for a new document
    expect(t.write({ path: "/f/a.md", file_text: "new\n" }).version).toBe(1);
  });

  it("restores a deleted document from its last version", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "one\n" });
    t.edit({ path: "/a.md", operations: [{ op: "append", text: "two" }] });
    t.remove({ path: "/a.md" });
    const [deleted] = t.core.listDeleted(t.ctx);
    expect(deleted).toMatchObject({ path: "/a.md", version: 3 });
    const restored = t.core.restore(t.ctx, restoreArgs.parse({ doc_id: deleted!.doc_id }));
    expect(restored).toMatchObject({ path: "/a.md", version: 4, restored_from_version: 2 });
    expect(t.read({ path: "/a.md" }).lines).toEqual(["one", "two"]);
    expect(t.history({ path: "/a.md" }).versions.map((v) => v.op)).toEqual(["restore", "delete", "edit", "create"]);
  });

  it("does not allow updating or deleting stored versions", () => {
    const t = testCore();
    t.write({ path: "/a.md", file_text: "a\n" });
    expect(() => t.db.prepare("UPDATE versions SET content = 'x'").run()).toThrow(/append-only/);
    expect(() => t.db.prepare("DELETE FROM versions").run()).toThrow(/append-only/);
  });
});

describe("batch", () => {
  it("applies all operations in one changeset", () => {
    const t = testCore();
    t.write({ path: "/index.md", file_text: "| File | Scope |\n|---|---|\n" });
    const result = t.core.batch(t.ctx, batchArgs.parse({
      change_note: "new entity",
      operations: [
        { tool: "memory_write", arguments: { path: "/entities/x.md", file_text: "# X\n" } },
        { tool: "memory_edit", arguments: { path: "/index.md", operations: [{ op: "append", text: "| entities/x.md | X |" }] } },
      ],
    }));
    expect(result.results).toHaveLength(2);
    expect(t.read({ path: "/index.md" }).version).toBe(2);
    const changesets = t.db.prepare("SELECT change_note FROM changesets ORDER BY id").all();
    expect(changesets).toEqual([{ change_note: null }, { change_note: "new entity" }]);
  });

  it("rolls everything back when an operation fails", () => {
    const t = testCore();
    t.write({ path: "/index.md", file_text: "index\n" });
    const before = { versions: count(t, "versions"), changesets: count(t, "changesets"), documents: count(t, "documents") };
    const error = errorOf(() => t.core.batch(t.ctx, batchArgs.parse({
      operations: [
        { tool: "memory_write", arguments: { path: "/entities/x.md", file_text: "# X\n" } },
        { tool: "memory_edit", arguments: { path: "/index.md", operations: [{ op: "append", text: "row" }] } },
        { tool: "memory_edit", arguments: { path: "/index.md", operations: [{ op: "str_replace", old_str: "missing" }] } },
      ],
    })));
    expect(error.message).toMatch(/^Batch operation 3 \(memory_edit \/index\.md\) failed: old_str not found/);
    expect(error.details.operation).toBe(3);
    expect({ versions: count(t, "versions"), changesets: count(t, "changesets"), documents: count(t, "documents") }).toEqual(before);
  });

  it("lets later operations see earlier ones, and validates arguments", () => {
    const t = testCore();
    t.core.batch(t.ctx, batchArgs.parse({
      operations: [
        { tool: "memory_write", arguments: { path: "/a.md", file_text: "a\n" } },
        { tool: "memory_move", arguments: { old_path: "/a.md", new_path: "/b.md" } },
        { tool: "memory_edit", arguments: { path: "/b.md", operations: [{ op: "append", text: "b" }] } },
      ],
    }));
    expect(t.read({ path: "/b.md" })).toMatchObject({ version: 3, lines: ["a", "b"] });
    const error = errorOf(() => t.core.batch(t.ctx, batchArgs.parse({
      operations: [{ tool: "memory_write", arguments: { path: "/c.md" } }],
    })));
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(error.message).toContain("Batch operation 1 (memory_write /c.md): invalid arguments");
  });
});

describe("append-only documents", () => {
  function withLog() {
    const t = testCore();
    t.write({ path: "/s/log.md", file_text: "# Log\n\n## Setup\ns1\n\n## Run\nr1\n", append_only: true });
    return t;
  }

  it("accepts additions at the end and metadata changes", () => {
    const t = withLog();
    expect(t.edit({ path: "/s/log.md", operations: [{ op: "append", text: "r2" }] }).version).toBe(2);
    expect(t.edit({ path: "/s/log.md", operations: [{ op: "append", section: "## Run", text: "r3" }] }).version).toBe(3);
    expect(t.edit({ path: "/s/log.md", operations: [{ op: "append", section: "## Next", create_section: true, text: "n1" }] }).version).toBe(4);
    expect(t.edit({ path: "/s/log.md", operations: [{ op: "set_metadata", description: "Log", tags: ["log"] }] }).version).toBe(5);
    const current = t.read({ path: "/s/log.md" });
    expect(t.write({ path: "/s/log.md", file_text: current.lines.join("\n") + "\nmore\n", mode: "overwrite" }).version).toBe(6);
    expect(t.read({ path: "/s/log.md" })).toMatchObject({ append_only: true, description: "Log" });
    expect(t.list().entries.find((e) => e.path === "/s")).toBeDefined();
    expect(t.list({ path: "/s" }).entries[0]).toMatchObject({ path: "/s/log.md", append_only: true });
  });

  it("refuses any other change of the content", () => {
    const t = withLog();
    const refused: unknown[] = [
      { op: "str_replace", old_str: "s1", new_str: "S1" },
      { op: "str_replace", old_str: "r1", new_str: "R1" },
      { op: "prepend", text: "x" },
      { op: "insert", insert_line: 1, insert_text: "x" },
      { op: "replace_section", section: "## Run", text: "r2" },
      { op: "append", section: "## Setup", text: "s2" },
    ];
    for (const op of refused) {
      const error = errorOf(() => t.edit({ path: "/s/log.md", operations: [op] }));
      expect(error.code).toBe("APPEND_ONLY");
      expect(error.message).toBe("/s/log.md is append-only: only additions at its end are accepted; add text with memory_edit op 'append' without section");
    }
    expect(errorOf(() => t.write({ path: "/s/log.md", file_text: "# Log\n", mode: "overwrite" })).code).toBe("APPEND_ONLY");
    expect(t.read({ path: "/s/log.md" }).version).toBe(1);
    // The rule is on the result: any operation that only adds at the end passes.
    expect(t.edit({ path: "/s/log.md", operations: [{ op: "str_replace", old_str: "r1", new_str: "r1\nr2" }] }).version).toBe(2);
  });

  it("sets the flag only at creation", () => {
    const t = withLog();
    t.write({ path: "/a.md", file_text: "a\n" });
    expect(errorOf(() => t.write({ path: "/a.md", file_text: "b\n", mode: "overwrite", append_only: true })).message)
      .toBe("append_only can only be given when creating a document (mode 'create')");
    expect(errorOf(() => t.write({ path: "/s/log.md", file_text: "x", mode: "overwrite", append_only: false })).code).toBe("INVALID_ARGUMENT");
    expect(t.read({ path: "/a.md" }).append_only).toBe(false);
  });

  it("lets only the admin move or delete it, directly or through a folder", () => {
    const t = withLog();
    t.write({ path: "/s/notes.md", file_text: "n\n" });
    t.write({ path: "/other.md", file_text: "o\n" });
    const moved = errorOf(() => t.move({ old_path: "/s/log.md", new_path: "/s/log2.md" }));
    expect(moved.code).toBe("APPEND_ONLY");
    expect(moved.message).toBe("Cannot move or replace append-only document /s/log.md; only the admin can");
    expect(errorOf(() => t.move({ old_path: "/other.md", new_path: "/s/log.md", overwrite: true })).code).toBe("APPEND_ONLY");
    expect(errorOf(() => t.move({ old_path: "/s", new_path: "/t" })).code).toBe("APPEND_ONLY");
    expect(errorOf(() => t.remove({ path: "/s/log.md" })).message).toBe("Cannot delete append-only document /s/log.md; only the admin can");
    expect(errorOf(() => t.remove({ path: "/s", recursive: true })).code).toBe("APPEND_ONLY");
    expect(t.list({ path: "/", depth: 5 }).total).toBe(4); // folder /s, and its two documents, and /other.md

    expect(t.move({ old_path: "/s", new_path: "/t" }, t.admin).moved).toHaveLength(2);
    expect(t.remove({ path: "/t/log.md" }, t.admin).deleted).toHaveLength(1);
    const [deleted] = t.core.listDeleted(t.admin);
    t.core.restore(t.admin, restoreArgs.parse({ doc_id: deleted!.doc_id }));
    expect(t.read({ path: "/t/log.md" }).append_only).toBe(true);
  });

  it("rolls a batch back when an operation breaks the rule", () => {
    const t = withLog();
    const error = errorOf(() => t.core.batch(t.ctx, batchArgs.parse({
      operations: [
        { tool: "memory_edit", arguments: { path: "/s/log.md", operations: [{ op: "append", text: "ok" }] } },
        { tool: "memory_delete", arguments: { path: "/s/log.md" } },
      ],
    })));
    expect(error.code).toBe("APPEND_ONLY");
    expect(t.read({ path: "/s/log.md" }).version).toBe(1);
  });
});

describe("binary documents", () => {
  const base64 = PNG.toString("base64");

  it("stores a base64 image and reads it back, current and past versions", () => {
    const t = testCore();
    expect(t.write({ path: "/s/shot.png", file_text: base64, encoding: "base64", description: "Login page" }))
      .toEqual({ path: "/s/shot.png", version: 1, created: true });
    const other = Buffer.concat([PNG, Buffer.from("x")]);
    expect(t.write({ path: "/s/shot.png", file_text: other.toString("base64"), encoding: "base64", mode: "overwrite" }).version).toBe(2);
    expect(t.write({ path: "/s/shot.png", file_text: other.toString("base64"), encoding: "base64", mode: "overwrite" }).unchanged).toBe(true);
    expect(t.read({ path: "/s/shot.png" })).toMatchObject({
      content_type: "image/png", size: other.length, total_lines: 0, lines: [], description: "Login page",
    });
    expect(t.core.readFile(t.ctx, { path: "/s/shot.png" }).data.equals(other)).toBe(true);
    expect(t.core.readFile(t.ctx, { path: "/s/shot.png", version: 1 })).toMatchObject({ version: 1, current_version: 2, content_type: "image/png" });
    expect(t.core.readFile(t.ctx, { path: "/s/shot.png", version: 1 }).data.equals(PNG)).toBe(true);
    expect(t.list({ path: "/s" }).entries[0]).toMatchObject({ content_type: "image/png", size: other.length });
  });

  it("checks the extension, the content and the size", () => {
    const t = testCore(10_000, 100);
    expect(errorOf(() => t.write({ path: "/a.png", file_text: "text" })).message)
      .toBe("/a.png is a binary document path (image/png): write its bytes in base64 with encoding 'base64'");
    expect(errorOf(() => t.write({ path: "/a.md", file_text: base64, encoding: "base64" })).message)
      .toContain("is not a binary document path");
    expect(errorOf(() => t.write({ path: "/a.png", file_text: "not base64!", encoding: "base64" })).message).toBe("file_text of /a.png is not valid base64");
    expect(errorOf(() => t.write({ path: "/a.jpg", file_text: base64, encoding: "base64" })).message).toBe("The content of /a.jpg is not a valid image/jpeg file");
    expect(errorOf(() => t.write({ path: "/a.png", file_text: base64, encoding: "base64", append_only: true })).code).toBe("INVALID_ARGUMENT");
    expect(errorOf(() => t.core.writeFile(t.ctx, { path: "/a.png", mode: "create", data: PNG, content_type: "image/gif" })).message)
      .toBe("Content type image/gif does not match the extension of /a.png (image/png)");
    expect(errorOf(() => t.core.writeFile(t.ctx, { path: "/a.png", mode: "create", data: Buffer.concat([PNG, Buffer.alloc(100)]) })).code)
      .toBe("TOO_LARGE");
  });

  it("allows only metadata edits, no sections and no change of kind", async () => {
    const t = testCore();
    t.core.writeFile(t.ctx, { path: "/a.png", mode: "create", data: PNG });
    expect(errorOf(() => t.edit({ path: "/a.png", operations: [{ op: "append", text: "x" }] })).message)
      .toBe("/a.png is a binary document (image/png): only set_metadata applies; replace its content with memory_write");
    expect(t.edit({ path: "/a.png", operations: [{ op: "set_metadata", tags: ["shot"] }] }).version).toBe(2);
    expect(errorOf(() => t.read({ path: "/a.png", section: "# A" })).code).toBe("INVALID_ARGUMENT");
    expect(errorOf(() => t.move({ old_path: "/a.png", new_path: "/a.md" })).code).toBe("INVALID_ARGUMENT");
    expect(errorOf(() => t.core.readFile(t.ctx, { path: "/b.md" })).code).toBe("NOT_FOUND");
    t.write({ path: "/b.md", file_text: "PNG\n" });
    expect(errorOf(() => t.core.readFile(t.ctx, { path: "/b.md" })).code).toBe("INVALID_ARGUMENT");
    expect((await t.search({ query: "PNG" })).hits.map((h) => h.path)).toEqual(["/b.md"]);
  });

  it("keeps the bytes across folder moves, deletion and restore", () => {
    const t = testCore();
    t.core.writeFile(t.ctx, { path: "/bugs/001/shot.png", mode: "create", data: PNG });
    t.move({ old_path: "/bugs", new_path: "/old" });
    expect(t.core.readFile(t.ctx, { path: "/old/001/shot.png" }).data.equals(PNG)).toBe(true);
    t.remove({ path: "/old/001/shot.png" });
    const [deleted] = t.core.listDeleted(t.ctx);
    t.core.restore(t.ctx, restoreArgs.parse({ doc_id: deleted!.doc_id }));
    const restored = t.core.readFile(t.ctx, { path: "/old/001/shot.png" });
    expect(restored).toMatchObject({ version: 4, content_type: "image/png" });
    expect(restored.data.equals(PNG)).toBe(true);
    expect(t.core.fileById(t.ctx, { doc_id: deleted!.doc_id, version: 1 })).toMatchObject({ path: "/bugs/001/shot.png", version: 1 });
    expect(t.core.versionById(t.ctx, { doc_id: deleted!.doc_id, version: 1 })).not.toHaveProperty("data");
  });
});
