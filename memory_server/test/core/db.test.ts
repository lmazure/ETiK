import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/core/db.js";

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

describe("schema", () => {
  it("creates the schema in a new database, and leaves it as is when reopened", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-db-"));
    try {
      const file = join(dir, "memory.db");
      const db = openDatabase(file);
      expect(db.pragma("user_version", { simple: true })).toBe(2);
      expect(columns(db, "changesets")).toEqual(["id", "store", "actor", "change_note", "created_at"]);
      expect(columns(db, "documents")).toContain("append_only");
      expect(columns(db, "documents")).toContain("content_type");
      expect(columns(db, "versions")).toContain("data");
      expect(columns(db, "embeddings")).toEqual(["model", "hash", "vector"]);
      db.prepare("INSERT INTO stores VALUES ('squashtm', 't0')").run();
      db.close();

      const reopened = openDatabase(file);
      expect(reopened.pragma("user_version", { simple: true })).toBe(2);
      expect(reopened.prepare("SELECT name FROM stores").all()).toEqual([{ name: "squashtm" }]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the embeddings cache to a database of the first schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-db-"));
    try {
      const file = join(dir, "memory.db");
      const db = openDatabase(file);
      db.exec("DROP TABLE embeddings");
      db.pragma("user_version = 1");
      db.prepare("INSERT INTO stores VALUES ('squashtm', 't0')").run();
      db.close();

      const upgraded = openDatabase(file);
      expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
      expect(columns(upgraded, "embeddings")).toEqual(["model", "hash", "vector"]);
      expect(upgraded.prepare("SELECT name FROM stores").all()).toEqual([{ name: "squashtm" }]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
