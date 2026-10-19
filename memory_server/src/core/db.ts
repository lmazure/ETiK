import Database from "better-sqlite3";

export type DB = Database.Database;

/**
 * Schema. `versions` and `changesets` are append-only (enforced by triggers): every change of a document
 * adds a full snapshot. `documents` only holds the head pointer of each document, and what is fixed at its
 * creation: the append-only flag and, for a binary document, its media type (`content_type`, NULL for text).
 * A binary version keeps its bytes in `data` and an empty `content`.
 * Each later schema change is a new entry, applied once to existing databases (`user_version`).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE stores (
    name       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE changesets (
    id          INTEGER PRIMARY KEY,
    store       TEXT NOT NULL REFERENCES stores(name),
    actor       TEXT NOT NULL,
    change_note TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX changesets_by_store ON changesets(store, id);

  CREATE TABLE documents (
    id           INTEGER PRIMARY KEY,
    store        TEXT NOT NULL REFERENCES stores(name),
    path         TEXT NOT NULL,
    head_version INTEGER NOT NULL,
    deleted      INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    append_only  INTEGER NOT NULL DEFAULT 0 CHECK (append_only IN (0, 1)),
    content_type TEXT
  );
  CREATE UNIQUE INDEX documents_live_path ON documents(store, path) WHERE deleted = 0;
  CREATE INDEX documents_by_store ON documents(store, deleted, path);

  CREATE TABLE versions (
    doc_id       INTEGER NOT NULL REFERENCES documents(id),
    version      INTEGER NOT NULL,
    changeset_id INTEGER NOT NULL REFERENCES changesets(id),
    op           TEXT NOT NULL CHECK (op IN ('create', 'overwrite', 'edit', 'move', 'delete', 'restore')),
    path         TEXT NOT NULL,
    content      TEXT NOT NULL,
    data         BLOB,
    description  TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    metadata     TEXT NOT NULL DEFAULT '{}',
    size         INTEGER NOT NULL,
    change_note  TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (doc_id, version)
  );
  CREATE INDEX versions_by_changeset ON versions(changeset_id);

  CREATE TRIGGER versions_no_update BEFORE UPDATE ON versions
    BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
  CREATE TRIGGER versions_no_delete BEFORE DELETE ON versions
    BEGIN SELECT RAISE(ABORT, 'versions are append-only'); END;
  CREATE TRIGGER changesets_no_update BEFORE UPDATE ON changesets
    BEGIN SELECT RAISE(ABORT, 'changesets are append-only'); END;
  CREATE TRIGGER changesets_no_delete BEFORE DELETE ON changesets
    BEGIN SELECT RAISE(ABORT, 'changesets are append-only'); END;
  `,
];

export function openDatabase(file: string): DB {
  const db = new Database(file);
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
