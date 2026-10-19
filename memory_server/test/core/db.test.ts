import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/core/db.js";

describe("migrations", () => {
  it("drops the session of the changesets of a version 2 database, keeping them", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-db-"));
    try {
      const file = join(dir, "memory.db");
      const old = new Database(file);
      old.exec(`
        CREATE TABLE stores (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        CREATE TABLE changesets (
          id INTEGER PRIMARY KEY, store TEXT NOT NULL REFERENCES stores(name), actor TEXT NOT NULL,
          session TEXT, change_note TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX changesets_by_store ON changesets(store, id);
        CREATE TRIGGER changesets_no_update BEFORE UPDATE ON changesets
          BEGIN SELECT RAISE(ABORT, 'changesets are append-only'); END;
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY, store TEXT NOT NULL REFERENCES stores(name), path TEXT NOT NULL,
          head_version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE versions (doc_id INTEGER NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL);
        INSERT INTO stores VALUES ('squashtm', 't0');
        INSERT INTO changesets (store, actor, session, change_note, created_at) VALUES
          ('squashtm', 'agent:squashtm', 'session_01', 'first', 't1'),
          ('squashtm', 'admin', NULL, NULL, 't2');
      `);
      old.pragma("user_version = 2");
      old.close();

      const db = openDatabase(file);
      const columns = (db.prepare("PRAGMA table_info(changesets)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(["id", "store", "actor", "change_note", "created_at"]);
      expect(db.prepare("SELECT actor, change_note FROM changesets ORDER BY id").all())
        .toEqual([{ actor: "agent:squashtm", change_note: "first" }, { actor: "admin", change_note: null }]);
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the documents of a version 3 database as text documents that are not append-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-db-"));
    try {
      const file = join(dir, "memory.db");
      const old = new Database(file);
      old.exec(`
        CREATE TABLE stores (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        CREATE TABLE changesets (id INTEGER PRIMARY KEY, store TEXT NOT NULL, actor TEXT NOT NULL, change_note TEXT, created_at TEXT NOT NULL);
        CREATE TABLE documents (
          id INTEGER PRIMARY KEY, store TEXT NOT NULL REFERENCES stores(name), path TEXT NOT NULL,
          head_version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE versions (
          doc_id INTEGER NOT NULL, version INTEGER NOT NULL, changeset_id INTEGER NOT NULL, op TEXT NOT NULL, path TEXT NOT NULL,
          content TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
          metadata TEXT NOT NULL DEFAULT '{}', size INTEGER NOT NULL, change_note TEXT, created_at TEXT NOT NULL,
          PRIMARY KEY (doc_id, version)
        );
        CREATE TRIGGER versions_no_update BEFORE UPDATE ON versions
          BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
        INSERT INTO stores VALUES ('squashtm', 't0');
        INSERT INTO changesets VALUES (1, 'squashtm', 'admin', NULL, 't1');
        INSERT INTO documents VALUES (1, 'squashtm', '/a.md', 1, 0, 't1', 't1');
        INSERT INTO versions VALUES (1, 1, 1, 'create', '/a.md', 'hello\n', '', '[]', '{}', 6, NULL, 't1');
      `);
      old.pragma("user_version = 3");
      old.close();

      const db = openDatabase(file);
      expect(db.pragma("user_version", { simple: true })).toBe(4);
      expect(db.prepare("SELECT append_only, content_type FROM documents").get()).toEqual({ append_only: 0, content_type: null });
      expect(db.prepare("SELECT content, data FROM versions").get()).toEqual({ content: "hello\n", data: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
