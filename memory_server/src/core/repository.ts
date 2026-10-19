import type { DB } from "./db.js";

export type VersionOp = "create" | "overwrite" | "edit" | "move" | "delete" | "restore";

/** Head state of a live document, without its content. */
export interface DocSummary {
  id: number;
  path: string;
  version: number;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  size: number;
  created_at: string;
  updated_at: string;
  /** Only additions at the end of the content are accepted; set at creation. */
  append_only: boolean;
  /** Media type of a binary document, fixed at creation; absent for a text document. */
  content_type?: string;
}

export interface Doc extends DocSummary {
  /** Text content; empty for a binary document. */
  content: string;
  /** Bytes of a binary document. */
  data?: Buffer;
}

export interface VersionEntry {
  doc_id: number;
  version: number;
  op: VersionOp;
  path: string;
  content: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  size: number;
  change_note: string | null;
  created_at: string;
  actor: string;
  changeset_id: number;
  data?: Buffer;
}

/** Head state of a document, live or deleted. */
export interface DocInfo extends DocSummary {
  deleted: boolean;
}

export interface ChangeItem {
  doc_id: number;
  path: string;
  /** Path before this version, when it differs (moves). */
  previous_path?: string;
  version: number;
  op: VersionOp;
}

/** One changeset: everything one tool call or batch changed. */
export interface Change {
  id: number;
  created_at: string;
  actor: string;
  change_note: string | null;
  items: ChangeItem[];
}

export interface DeletedDoc {
  doc_id: number;
  path: string;
  version: number;
  size: number;
  deleted_at: string;
  deleted_by: string;
}

export interface NewVersion {
  docId: number;
  version: number;
  changesetId: number;
  op: VersionOp;
  path: string;
  content: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  data: Buffer | undefined;
  changeNote: string | undefined;
  now: string;
}

interface SummaryRow {
  id: number;
  path: string;
  version: number;
  description: string;
  tags: string;
  metadata: string;
  size: number;
  created_at: string;
  updated_at: string;
  append_only: number;
  content_type: string | null;
  content?: string;
  data?: Buffer | null;
}

interface VersionRow {
  doc_id: number;
  version: number;
  op: VersionOp;
  path: string;
  content: string;
  description: string;
  tags: string;
  metadata: string;
  size: number;
  change_note: string | null;
  created_at: string;
  actor: string;
  changeset_id: number;
  data?: Buffer | null;
}

interface ChangeItemRow {
  changeset_id: number;
  doc_id: number;
  path: string;
  previous_path: string | null;
  version: number;
  op: VersionOp;
}

function toSummary(row: SummaryRow): DocSummary {
  return {
    id: row.id,
    path: row.path,
    version: row.version,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    size: row.size,
    created_at: row.created_at,
    updated_at: row.updated_at,
    append_only: row.append_only === 1,
    ...(row.content_type !== null && { content_type: row.content_type }),
  };
}

function toDoc(row: SummaryRow): Doc {
  return { ...toSummary(row), content: row.content ?? "", ...(row.data != null && { data: row.data }) };
}

function toVersion(row: VersionRow): VersionEntry {
  const { data, ...rest } = row;
  return {
    ...rest,
    tags: JSON.parse(row.tags) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    ...(data != null && { data }),
  };
}

/** `path` is the folder itself or below it. LIKE is avoided so that `%` and `_` in paths need no escaping. */
const UNDER_FOLDER = "(? = '/' OR substr(d.path, 1, length(?) + 1) = ? || '/')";

const HEAD_COLUMNS = `d.id, d.path, d.head_version AS version, v.description, v.tags, v.metadata, v.size,
  d.created_at, d.updated_at, d.append_only, d.content_type`;

/** SQL access. All methods are synchronous and run inside the caller's transaction when there is one. */
export class Repository {
  constructor(private readonly db: DB) {}

  ensureStore(store: string, now: string): void {
    this.db.prepare("INSERT OR IGNORE INTO stores (name, created_at) VALUES (?, ?)").run(store, now);
  }

  listStores(): { name: string; created_at: string; documents: number; deleted_documents: number }[] {
    return this.db.prepare(`
      SELECT s.name, s.created_at,
        (SELECT count(*) FROM documents d WHERE d.store = s.name AND d.deleted = 0) AS documents,
        (SELECT count(*) FROM documents d WHERE d.store = s.name AND d.deleted = 1) AS deleted_documents
      FROM stores s ORDER BY s.name`).all() as { name: string; created_at: string; documents: number; deleted_documents: number }[];
  }

  createChangeset(store: string, actor: string, changeNote: string | undefined, now: string): number {
    const result = this.db.prepare(
      "INSERT INTO changesets (store, actor, change_note, created_at) VALUES (?, ?, ?, ?)",
    ).run(store, actor, changeNote ?? null, now);
    return Number(result.lastInsertRowid);
  }

  getLiveDoc(store: string, path: string): Doc | undefined {
    const row = this.db.prepare(`
      SELECT ${HEAD_COLUMNS}, v.content, v.data FROM documents d
      JOIN versions v ON v.doc_id = d.id AND v.version = d.head_version
      WHERE d.store = ? AND d.path = ? AND d.deleted = 0`).get(store, path) as SummaryRow | undefined;
    return row && toDoc(row);
  }

  /** Live documents strictly below `folder`, sorted by path. */
  listLiveDocs(store: string, folder: string): DocSummary[] {
    const rows = this.db.prepare(`
      SELECT ${HEAD_COLUMNS} FROM documents d
      JOIN versions v ON v.doc_id = d.id AND v.version = d.head_version
      WHERE d.store = ? AND d.deleted = 0 AND ${UNDER_FOLDER}
      ORDER BY d.path`).all(store, folder, folder, folder) as SummaryRow[];
    return rows.map(toSummary);
  }

  listLiveDocsWithContent(store: string, folder: string): Doc[] {
    const rows = this.db.prepare(`
      SELECT ${HEAD_COLUMNS}, v.content, v.data FROM documents d
      JOIN versions v ON v.doc_id = d.id AND v.version = d.head_version
      WHERE d.store = ? AND d.deleted = 0 AND ${UNDER_FOLDER}
      ORDER BY d.path`).all(store, folder, folder, folder) as SummaryRow[];
    return rows.map(toDoc);
  }

  countLiveDocsUnder(store: string, folder: string): number {
    const row = this.db.prepare(`
      SELECT count(*) AS n FROM documents d
      WHERE d.store = ? AND d.deleted = 0 AND ${UNDER_FOLDER}`).get(store, folder, folder, folder) as { n: number };
    return row.n;
  }

  insertDocument(store: string, path: string, now: string, appendOnly: boolean, contentType: string | undefined): number {
    const result = this.db.prepare(`
      INSERT INTO documents (store, path, head_version, deleted, created_at, updated_at, append_only, content_type)
      VALUES (?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(store, path, now, now, appendOnly ? 1 : 0, contentType ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Appends a version and moves the head pointer to it. */
  appendVersion(v: NewVersion): void {
    this.db.prepare(`
      INSERT INTO versions (doc_id, version, changeset_id, op, path, content, data, description, tags, metadata, size, change_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      v.docId, v.version, v.changesetId, v.op, v.path, v.content, v.data ?? null, v.description,
      JSON.stringify(v.tags), JSON.stringify(v.metadata), v.data ? v.data.length : Buffer.byteLength(v.content, "utf8"),
      v.changeNote ?? null, v.now,
    );
    this.db.prepare("UPDATE documents SET head_version = ?, path = ?, deleted = ?, updated_at = ? WHERE id = ?")
      .run(v.version, v.path, v.op === "delete" ? 1 : 0, v.now, v.docId);
  }

  /** Temporarily parks a document on a unique placeholder path (used by folder moves). */
  parkDocument(docId: number): void {
    this.db.prepare("UPDATE documents SET path = '~parked:' || id WHERE id = ?").run(docId);
  }

  getVersion(docId: number, version: number): VersionEntry | undefined {
    const row = this.db.prepare(`
      SELECT v.*, c.actor FROM versions v JOIN changesets c ON c.id = v.changeset_id
      WHERE v.doc_id = ? AND v.version = ?`).get(docId, version) as VersionRow | undefined;
    return row && toVersion(row);
  }

  /** Versions of a document, newest first, without their content. */
  listVersions(docId: number, limit: number): Omit<VersionEntry, "content">[] {
    const rows = this.db.prepare(`
      SELECT v.doc_id, v.version, v.changeset_id, v.op, v.path, '' AS content, v.description, v.tags, v.metadata,
        v.size, v.change_note, v.created_at, c.actor
      FROM versions v JOIN changesets c ON c.id = v.changeset_id
      WHERE v.doc_id = ? ORDER BY v.version DESC LIMIT ?`).all(docId, limit) as VersionRow[];
    return rows.map((row) => {
      const { content: _content, ...version } = toVersion(row);
      return version;
    });
  }

  /** A document by id, live or deleted, scoped to a store. */
  getDocById(store: string, docId: number): DocInfo | undefined {
    const row = this.db.prepare(`
      SELECT ${HEAD_COLUMNS}, d.deleted FROM documents d
      JOIN versions v ON v.doc_id = d.id AND v.version = d.head_version
      WHERE d.store = ? AND d.id = ?`).get(store, docId) as (SummaryRow & { deleted: number }) | undefined;
    return row && { ...toSummary(row), deleted: row.deleted === 1 };
  }

  /** Id of the last changeset of a store; 0 when there is none. */
  latestChangesetId(store: string): number {
    const row = this.db.prepare("SELECT max(id) AS id FROM changesets WHERE store = ?").get(store) as { id: number | null };
    return row.id ?? 0;
  }

  /**
   * Changesets with the versions they created. With `since`: the ones after it, oldest first;
   * otherwise the ones before `before` (default: all), newest first.
   */
  listChanges(store: string, options: { since?: number | undefined; before?: number | undefined; limit: number }): Change[] {
    const changesets = (options.since !== undefined
      ? this.db.prepare(`
          SELECT id, created_at, actor, change_note FROM changesets
          WHERE store = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(store, options.since, options.limit)
      : this.db.prepare(`
          SELECT id, created_at, actor, change_note FROM changesets
          WHERE store = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(store, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    ) as Omit<Change, "items">[];
    if (changesets.length === 0) return [];
    const ids = changesets.map((c) => c.id);
    const items = this.db.prepare(`
      SELECT v.changeset_id, v.doc_id, v.path, v.version, v.op,
        (SELECT p.path FROM versions p WHERE p.doc_id = v.doc_id AND p.version = v.version - 1) AS previous_path
      FROM versions v
      WHERE v.changeset_id IN (${ids.map(() => "?").join(",")})
      ORDER BY v.changeset_id, v.doc_id, v.version`).all(...ids) as ChangeItemRow[];
    const byChangeset = new Map<number, ChangeItem[]>(ids.map((id) => [id, []]));
    for (const { changeset_id, previous_path, ...item } of items) {
      byChangeset.get(changeset_id)!.push(
        previous_path !== null && previous_path !== item.path ? { ...item, previous_path } : item,
      );
    }
    return changesets.map((c) => ({ ...c, items: byChangeset.get(c.id)! }));
  }

  countVersions(docId: number): number {
    return (this.db.prepare("SELECT count(*) AS n FROM versions WHERE doc_id = ?").get(docId) as { n: number }).n;
  }

  listDeletedDocs(store: string, path?: string): DeletedDoc[] {
    return this.db.prepare(`
      SELECT d.id AS doc_id, d.path, d.head_version AS version, v.size, v.created_at AS deleted_at,
        c.actor AS deleted_by
      FROM documents d
      JOIN versions v ON v.doc_id = d.id AND v.version = d.head_version
      JOIN changesets c ON c.id = v.changeset_id
      WHERE d.store = ? AND d.deleted = 1 AND (? IS NULL OR d.path = ?)
      ORDER BY v.created_at DESC, d.id DESC`).all(store, path ?? null, path ?? null) as DeletedDoc[];
  }

  getDeletedDoc(store: string, docId: number): DeletedDoc | undefined {
    return this.listDeletedDocs(store).find((d) => d.doc_id === docId);
  }
}
