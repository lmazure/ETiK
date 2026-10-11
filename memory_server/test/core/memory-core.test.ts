import { describe, expect, it } from "vitest";
import { MemoryError } from "../../src/core/errors.js";
import { batchArgs, restoreArgs } from "../../src/schemas.js";
import { testCore } from "../helpers.js";

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

  it("finds keywords case-insensitively, with section and score", () => {
    const t = seeded();
    const result = t.search({ query: "assumed" });
    expect(result.total).toBe(2);
    expect(result.hits[1]).toEqual({
      path: "/entities/campaign.md", line: 3, section: "## Business rules", snippet: "- assumed, session_01: x Assumed", score: 2,
    });
  });

  it("filters by path prefix, tags and metadata, and supports regex", () => {
    const t = seeded();
    expect(t.search({ query: "assumed", path_prefix: "/entities" }).total).toBe(1);
    expect(t.search({ query: "/backend/requirements", metadata: { kind: "entity" } }).hits[0]!.path).toBe("/entities/requirement.md");
    expect(t.search({ query: "^- (POST|GET) ", mode: "regex", tags: ["entity"] }).total).toBe(1);
    expect(errorOf(() => t.search({ query: "(", mode: "regex" })).code).toBe("INVALID_ARGUMENT");
  });

  it("rejects semantic search explicitly", () => {
    const t = seeded();
    const error = errorOf(() => t.search({ query: "x", mode: "semantic" }));
    expect(error.code).toBe("UNSUPPORTED");
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
    expect(history.versions[0]).toMatchObject({ change_note: "archive", session: "session_01", actor: "agent:squashtm" });
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
