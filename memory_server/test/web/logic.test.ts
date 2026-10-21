import { describe, expect, it } from "vitest";
import type { Change, DocumentEntry } from "../../src/core/memory-core.js";
import { foldContext, lineDiff, metadataDiff } from "../../web/src/diffs.js";
import { formatRoute, parseRoute, type Route } from "../../web/src/routes.js";
import { applyChange, buildTree, folderPaths, fromList } from "../../web/src/tree.js";

function entry(id: number, path: string): DocumentEntry {
  return { type: "document", id, path, version: 1, size: 1, updated_at: "", tags: [], description: `desc ${id}`, append_only: false };
}

function change(items: Change["items"]): Change {
  return { id: 1, created_at: "", actor: "agent", change_note: null, items };
}

describe("tree", () => {
  const initial = fromList([entry(1, "/index.md"), entry(2, "/entities/a.md"), entry(3, "/entities/b.md"), entry(4, "/x/y/z.md")]);

  it("builds folders first, then documents, without change markers", () => {
    const root = buildTree(initial);
    expect(root.folders.map((f) => f.path)).toEqual(["/entities", "/x"]);
    expect(root.docs.map((d) => d.path)).toEqual(["/index.md"]);
    expect(root.folders[1]!.folders[0]!.docs[0]!.path).toBe("/x/y/z.md");
    expect(root.changed).toBe(false);
  });

  it("marks edits, creations, deletions and moves, and their folders", () => {
    let docs = applyChange(initial, change([{ doc_id: 2, path: "/entities/a.md", version: 2, op: "edit" }]));
    docs = applyChange(docs, change([{ doc_id: 5, path: "/entities/c.md", version: 1, op: "create" }]));
    docs = applyChange(docs, change([{ doc_id: 3, path: "/entities/b.md", version: 2, op: "delete" }]));
    docs = applyChange(docs, change([{ doc_id: 4, path: "/archive/z.md", previous_path: "/x/y/z.md", version: 2, op: "move" }]));

    expect(docs.get("/entities/a.md")).toMatchObject({ version: 2, badge: "changed", description: "desc 2" });
    expect(docs.get("/entities/c.md")).toMatchObject({ id: 5, badge: "new" });
    expect(docs.get("/entities/b.md")).toMatchObject({ gone: "deleted", version: 2 });
    expect(docs.get("/x/y/z.md")).toMatchObject({ gone: "moved", movedTo: "/archive/z.md" });
    expect(docs.get("/archive/z.md")).toMatchObject({ id: 4, badge: "moved-in", movedFrom: "/x/y/z.md", description: "desc 4" });
    expect(initial.get("/entities/a.md")!.badge).toBeUndefined();

    const root = buildTree(docs);
    expect(root.changed).toBe(true);
    const byPath = new Map(root.folders.map((f) => [f.path, f]));
    expect(byPath.get("/entities")!.changed).toBe(true);
    expect(byPath.get("/x")!.changed).toBe(true);
    expect(byPath.get("/x")!.folders[0]!.changed).toBe(true);
  });

  it("keeps the new badge when a new document is then edited", () => {
    let docs = applyChange(initial, change([{ doc_id: 5, path: "/n.md", version: 1, op: "create" }]));
    docs = applyChange(docs, change([{ doc_id: 5, path: "/n.md", version: 2, op: "edit" }]));
    expect(docs.get("/n.md")).toMatchObject({ badge: "new", version: 2 });
  });

  it("lists every folder below the root, depth first", () => {
    const docs = fromList([entry(1, "/a/b/x.md"), entry(2, "/a/y.md"), entry(3, "/c/z.md"), entry(4, "/top.md")]);
    expect(folderPaths(buildTree(docs))).toEqual(["/a", "/a/b", "/c"]);
  });
});

describe("routes", () => {
  const routes: Route[] = [
    { name: "store", store: "squashtm" },
    { name: "doc", store: "squashtm", id: 12 },
    { name: "doc", store: "squashtm", id: 12, version: 3, line: 40 },
    { name: "diff", store: "squashtm", id: 12, from: 3, to: 5 },
    { name: "search", store: "squashtm", query: "/backend/x & y" },
    { name: "search", store: "squashtm", query: "deleting a requirement", mode: "semantic" },
    { name: "search", store: "squashtm", query: "x", mode: "hybrid" },
  ];

  it.each(routes)("round-trips %o", (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("reads a missing, keyword or unknown search mode as keyword", () => {
    expect(formatRoute({ name: "search", store: "s", query: "x", mode: "keyword" })).toBe("#/s/s/search?q=x");
    expect(parseRoute("#/s/s/search?q=x&mode=keyword")).toEqual({ name: "search", store: "s", query: "x" });
    expect(parseRoute("#/s/s/search?q=x&mode=fuzzy")).toEqual({ name: "search", store: "s", query: "x" });
  });

  it("falls back on unknown or invalid hashes", () => {
    expect(parseRoute("")).toEqual({ name: "none" });
    expect(parseRoute("#/s/squashtm/doc/abc")).toEqual({ name: "store", store: "squashtm" });
    expect(parseRoute("#/s/squashtm/diff/1/3..x")).toEqual({ name: "store", store: "squashtm" });
  });
});

describe("diffs", () => {
  it("numbers lines on both sides", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "same", text: "a", oldLine: 1, newLine: 1 },
      { kind: "del", text: "b", oldLine: 2 },
      { kind: "add", text: "B", newLine: 2 },
      { kind: "same", text: "c", oldLine: 3, newLine: 3 },
      { kind: "add", text: "d", newLine: 4 },
    ]);
  });

  it("folds unchanged runs beyond the context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const after = before.replace("l10\n", "L10\n");
    const folded = foldContext(lineDiff(before, after), 2);
    expect(folded.map((l) => (l.kind === "fold" ? `fold ${l.lines.length}` : `${l.kind} ${l.text}`))).toEqual([
      "fold 7", "same l8", "same l9", "del l10", "add L10", "same l11", "same l12", "fold 8",
    ]);
  });

  it("lists metadata changes", () => {
    expect(metadataDiff(
      { path: "/a.md", description: "d", tags: ["x"], metadata: { k: "1", gone: "g" } },
      { path: "/b.md", description: "d", tags: ["x", "y"], metadata: { k: "2" } },
    )).toEqual([
      { field: "path", before: "/a.md", after: "/b.md" },
      { field: "tags", before: "x", after: "x, y" },
      { field: "metadata.gone", before: "g", after: "" },
      { field: "metadata.k", before: "1", after: "2" },
    ]);
  });
});
