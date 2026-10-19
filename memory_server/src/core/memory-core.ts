import { z } from "zod";
import {
  deleteArgs, editArgs, moveArgs, writeArgs,
  type BatchArgs, type BatchableTool, type ChangesArgs, type DeleteArgs, type DocHistoryArgs, type DocVersionArgs, type EditArgs, type HistoryArgs, type ListArgs, type MoveArgs,
  type ReadArgs, type RestoreArgs, type SearchArgs, type WriteArgs,
} from "../schemas.js";
import type { DB } from "./db.js";
import { applyEdits, changedLines, normalizeTags, sameState, type ChangedLines, type DocState } from "./edits.js";
import { MemoryError } from "./errors.js";
import { enclosingHeading, normalizeNewlines, parseHeadings, requireSection, toLines } from "./markdown.js";
import { checkMedia, decodeBase64, mediaTypeOf } from "./media.js";
import { ROOT, ancestorsOf, normalizeDocPath, normalizeFolderPath, rebase } from "./paths.js";
import { Repository, type Change, type Doc, type DocInfo, type DocSummary, type VersionOp } from "./repository.js";

export type { Change, ChangeItem, DocInfo, VersionOp } from "./repository.js";

/** Who is calling and on which store; set by the entry point from the credentials and headers, never by tool arguments. */
export interface Context {
  store: string;
  actor: string;
  /** True for the admin token, which may also move and delete append-only documents. */
  admin?: boolean;
}

export interface CoreOptions {
  maxDocumentBytes: number;
  /** Maximum size of a binary document, in bytes. */
  maxFileBytes: number;
}

export interface FolderEntry {
  type: "folder";
  path: string;
  documents: number;
}

export interface DocumentEntry {
  type: "document";
  id: number;
  path: string;
  version: number;
  size: number;
  updated_at: string;
  tags: string[];
  description: string;
  append_only: boolean;
  content_type?: string;
}

export interface ListResult {
  path: string;
  entries: (FolderEntry | DocumentEntry)[];
  total: number;
  next_offset?: number;
}

export interface ReadResult {
  path: string;
  version: number;
  current_version: number;
  is_past_version: boolean;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  updated_at: string;
  append_only: boolean;
  /** Media type of a binary document, which has no lines; absent for a text document. */
  content_type?: string;
  size: number;
  total_lines: number;
  from: number;
  to: number;
  section?: string;
  lines: string[];
}

/** The bytes of one version of a binary document. */
export interface FileResult {
  path: string;
  version: number;
  current_version: number;
  content_type: string;
  data: Buffer;
}

/** Arguments of a binary write coming as raw bytes (REST); the other fields are those of memory_write. */
export type FileWriteArgs = Omit<WriteArgs, "file_text" | "encoding"> & { data: Buffer; content_type?: string | undefined };

/** Content of a write: text, or the bytes of a binary document with the type its sender declared. */
interface Content {
  text: string;
  data?: Buffer;
  declaredType?: string | undefined;
}

export interface SearchHit {
  path: string;
  line: number;
  section?: string;
  snippet: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  next_offset?: number;
}

export interface WriteResult {
  path: string;
  version: number;
  created?: boolean;
  unchanged?: boolean;
  changed?: ChangedLines;
}

export interface MoveResult {
  moved: { from: string; to: string; version: number }[];
  replaced: string[];
}

export interface DeleteResult {
  deleted: { path: string; version: number }[];
}

export type BatchItemResult =
  | { tool: "memory_write" | "memory_edit"; result: WriteResult }
  | { tool: "memory_move"; result: MoveResult }
  | { tool: "memory_delete"; result: DeleteResult };

export interface BatchResult {
  results: BatchItemResult[];
}

export interface HistoryEntry {
  version: number;
  op: VersionOp;
  path: string;
  created_at: string;
  change_note: string | null;
  actor: string;
  size: number;
}

export interface HistoryResult {
  path: string;
  doc_id: number;
  current_version: number;
  total: number;
  versions: HistoryEntry[];
}

export interface DocumentHistoryResult extends HistoryResult {
  deleted: boolean;
}

export interface ChangesResult {
  /** Id of the latest changeset of the store (0 when empty): the cursor to poll from. */
  latest: number;
  changes: Change[];
}

/** One stored version of a document, with its content. */
export interface VersionResult {
  doc_id: number;
  version: number;
  current_version: number;
  deleted: boolean;
  op: VersionOp;
  path: string;
  content: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  size: number;
  created_at: string;
  actor: string;
  change_note: string | null;
  append_only: boolean;
  content_type?: string;
}

export interface RestoreResult {
  doc_id: number;
  path: string;
  version: number;
  restored_from_version: number;
}

/** State of one write call or batch: one transaction, at most one changeset. */
interface Tx {
  ctx: Context;
  now: string;
  changeNote: string | undefined;
  changesetId(): number;
}

const STORE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_REGEX_LENGTH = 500;
const SNIPPET_LENGTH = 200;

export function validateStoreName(store: string): void {
  if (!STORE_NAME.test(store)) {
    throw new MemoryError("INVALID_ARGUMENT", `Invalid store name '${store}': use letters, digits, '.', '_' or '-' (64 characters max)`, { store });
  }
}

export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error).replace(/\n+/g, "; ");
}

function stateOf(doc: Doc): DocState {
  return { text: doc.content, data: doc.data, description: doc.description, tags: doc.tags, metadata: doc.metadata };
}

function hasAllTags(doc: DocSummary, tags: string[] | undefined): boolean {
  return !tags || tags.every((t) => doc.tags.includes(t));
}

function snippetOf(line: string, matchIndex: number): string {
  if (line.length <= SNIPPET_LENGTH) return line.trim();
  const start = Math.max(0, Math.min(matchIndex - SNIPPET_LENGTH / 4, line.length - SNIPPET_LENGTH));
  const end = start + SNIPPET_LENGTH;
  return (start > 0 ? "…" : "") + line.slice(start, end).trim() + (end < line.length ? "…" : "");
}

function paginate<T>(items: T[], offset: number, limit: number): { page: T[]; next_offset?: number } {
  const page = items.slice(offset, offset + limit);
  return offset + limit < items.length ? { page, next_offset: offset + limit } : { page };
}

/**
 * The memory core: the only place where the rules are enforced. Both the REST API and the MCP server call it.
 * Every write call runs in one SQLite transaction and appends immutable versions; nothing is ever overwritten.
 */
export class MemoryCore {
  private readonly repo: Repository;

  constructor(private readonly db: DB, private readonly options: CoreOptions) {
    this.repo = new Repository(db);
  }

  // ---------------------------------------------------------------- reads

  list(ctx: Context, args: ListArgs): ListResult {
    validateStoreName(ctx.store);
    const folder = normalizeFolderPath(args.path);
    const single = folder === ROOT ? undefined : this.repo.getLiveDoc(ctx.store, folder);
    const docs = single ? [single] : this.repo.listLiveDocs(ctx.store, folder);
    if (docs.length === 0 && folder !== ROOT) {
      throw new MemoryError("NOT_FOUND", `Folder not found: ${folder}; list '/' to see what exists`, { path: folder });
    }
    const folders = new Map<string, number>();
    const entries: (FolderEntry | DocumentEntry)[] = [];
    for (const doc of docs.filter((d) => hasAllTags(d, args.tags))) {
      const relative = single ? [doc.path.slice(doc.path.lastIndexOf("/") + 1)] : doc.path.slice(folder === ROOT ? 1 : folder.length + 1).split("/");
      for (let level = 1; level < relative.length && level <= args.depth; level++) {
        const subfolder = (folder === ROOT ? "" : folder) + "/" + relative.slice(0, level).join("/");
        folders.set(subfolder, (folders.get(subfolder) ?? 0) + 1);
      }
      if (relative.length <= args.depth) {
        entries.push({
          type: "document", id: doc.id, path: doc.path, version: doc.version, size: doc.size,
          updated_at: doc.updated_at, tags: doc.tags, description: doc.description, append_only: doc.append_only,
          ...(doc.content_type !== undefined && { content_type: doc.content_type }),
        });
      }
    }
    for (const [path, count] of folders) entries.push({ type: "folder", path, documents: count });
    const key = (e: FolderEntry | DocumentEntry) => (e.type === "folder" ? e.path + "/" : e.path);
    entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const { page, next_offset } = paginate(entries, args.offset, args.limit);
    return { path: folder, entries: page, total: entries.length, ...(next_offset !== undefined && { next_offset }) };
  }

  read(ctx: Context, args: ReadArgs): ReadResult {
    validateStoreName(ctx.store);
    const path = normalizeDocPath(args.path);
    const doc = this.requireDoc(ctx.store, path);
    if (args.section !== undefined && args.view_range !== undefined) {
      throw new MemoryError("INVALID_ARGUMENT", "Give either section or view_range, not both");
    }
    if (doc.content_type !== undefined && (args.section !== undefined || args.view_range !== undefined)) {
      throw new MemoryError("INVALID_ARGUMENT", `${path} is a binary document (${doc.content_type}): it has no sections nor lines`,
        { path, content_type: doc.content_type });
    }
    let state = { ...stateOf(doc), version: doc.version, updated_at: doc.updated_at, size: doc.size };
    if (args.version !== undefined && args.version !== doc.version) {
      const past = this.repo.getVersion(doc.id, args.version);
      if (!past) {
        throw new MemoryError("NOT_FOUND", `Version ${args.version} of ${path} does not exist; current version is ${doc.version}`,
          { path, version: args.version, current_version: doc.version });
      }
      state = {
        text: past.content, description: past.description, tags: past.tags, metadata: past.metadata,
        version: past.version, updated_at: past.created_at, size: past.size,
      };
    }
    const lines = toLines(state.text);
    let from = 1;
    let to = lines.length;
    if (args.section !== undefined) {
      const section = requireSection(lines, args.section, path);
      from = section.heading.line;
      to = section.end;
    } else if (args.view_range !== undefined) {
      const [start, end] = args.view_range as [number, number];
      const last = end === -1 ? lines.length : end;
      if (start < 1 || last < start || last > lines.length) {
        if (!(lines.length === 0 && start === 1 && end === -1)) {
          throw new MemoryError("INVALID_ARGUMENT",
            `view_range [${start}, ${end}] is out of range: ${path} has ${lines.length} lines`,
            { path, view_range: args.view_range, line_count: lines.length });
        }
      }
      from = start;
      to = last;
    }
    return {
      path, version: state.version, current_version: doc.version, is_past_version: state.version !== doc.version,
      description: state.description, tags: state.tags, metadata: state.metadata, updated_at: state.updated_at,
      append_only: doc.append_only, ...(doc.content_type !== undefined && { content_type: doc.content_type }), size: state.size,
      total_lines: lines.length, from, to, lines: lines.slice(from - 1, to),
      ...(args.section !== undefined && { section: args.section.trim() }),
    };
  }

  /** The bytes of a binary document, current or past version. */
  readFile(ctx: Context, args: { path: string; version?: number | undefined }): FileResult {
    validateStoreName(ctx.store);
    const path = normalizeDocPath(args.path);
    const doc = this.requireDoc(ctx.store, path);
    if (doc.content_type === undefined) {
      throw new MemoryError("INVALID_ARGUMENT", `${path} is a text document, not a binary one; read it with memory_read`, { path });
    }
    let version = doc.version;
    let data = doc.data;
    if (args.version !== undefined && args.version !== doc.version) {
      const past = this.repo.getVersion(doc.id, args.version);
      if (!past) {
        throw new MemoryError("NOT_FOUND", `Version ${args.version} of ${path} does not exist; current version is ${doc.version}`,
          { path, version: args.version, current_version: doc.version });
      }
      version = past.version;
      data = past.data;
    }
    return { path, version, current_version: doc.version, content_type: doc.content_type, data: data ?? Buffer.alloc(0) };
  }

  search(ctx: Context, args: SearchArgs): SearchResult {
    validateStoreName(ctx.store);
    if (args.mode === "semantic" || args.mode === "hybrid") {
      throw new MemoryError("UNSUPPORTED", `Search mode '${args.mode}' is not supported by this store; use 'keyword' or 'regex'`,
        { mode: args.mode });
    }
    if (args.query === "") throw new MemoryError("INVALID_ARGUMENT", "query must not be empty");
    const matcher = this.matcher(args.query, args.mode);
    const prefix = normalizeFolderPath(args.path_prefix);
    const single = prefix === ROOT ? undefined : this.repo.getLiveDoc(ctx.store, prefix);
    const docs = (single ? [single] : this.repo.listLiveDocsWithContent(ctx.store, prefix))
      .filter((d) => hasAllTags(d, args.tags))
      .filter((d) => Object.entries(args.metadata ?? {}).every(([k, v]) => d.metadata[k] === v));
    const hits: SearchHit[] = [];
    for (const doc of docs) {
      const lines = toLines(doc.content);
      const headings = parseHeadings(lines);
      lines.forEach((line, index) => {
        const match = matcher(line);
        if (!match) return;
        const section = enclosingHeading(headings, index + 1);
        hits.push({
          path: doc.path, line: index + 1, ...(section !== undefined && { section }),
          snippet: snippetOf(line, match.index), score: match.count,
        });
      });
    }
    const { page, next_offset } = paginate(hits, args.offset, args.limit);
    return { hits: page, total: hits.length, ...(next_offset !== undefined && { next_offset }) };
  }

  history(ctx: Context, args: HistoryArgs): HistoryResult {
    validateStoreName(ctx.store);
    const path = normalizeDocPath(args.path);
    return this.historyOf(this.requireDoc(ctx.store, path), args.limit);
  }

  // ---------------------------------------------------------------- change feed and reads by id (web app)

  changes(ctx: Context, args: ChangesArgs): ChangesResult {
    validateStoreName(ctx.store);
    return {
      latest: this.repo.latestChangesetId(ctx.store),
      changes: this.repo.listChanges(ctx.store, args),
    };
  }

  /** A document by id, live or deleted: ids stay valid across moves and deletions. */
  documentById(ctx: Context, docId: number): DocInfo {
    validateStoreName(ctx.store);
    const doc = this.repo.getDocById(ctx.store, docId);
    if (!doc) throw new MemoryError("NOT_FOUND", `Document ${docId} not found in store ${ctx.store}`, { doc_id: docId });
    return doc;
  }

  historyById(ctx: Context, args: DocHistoryArgs): DocumentHistoryResult {
    const doc = this.documentById(ctx, args.doc_id);
    return { ...this.historyOf(doc, args.limit), deleted: doc.deleted };
  }

  versionById(ctx: Context, args: DocVersionArgs): VersionResult {
    const doc = this.documentById(ctx, args.doc_id);
    const version = this.repo.getVersion(doc.id, args.version);
    if (!version) {
      throw new MemoryError("NOT_FOUND", `Version ${args.version} of ${doc.path} does not exist; current version is ${doc.version}`,
        { doc_id: doc.id, version: args.version, current_version: doc.version });
    }
    const { changeset_id: _changeset, data: _data, ...rest } = version;
    return {
      ...rest, current_version: doc.version, deleted: doc.deleted, append_only: doc.append_only,
      ...(doc.content_type !== undefined && { content_type: doc.content_type }),
    };
  }

  /** The bytes of one version of a binary document by id, live or deleted. */
  fileById(ctx: Context, args: DocVersionArgs): FileResult {
    const doc = this.documentById(ctx, args.doc_id);
    if (doc.content_type === undefined) {
      throw new MemoryError("INVALID_ARGUMENT", `Document ${doc.id} (${doc.path}) is a text document, not a binary one`, { doc_id: doc.id });
    }
    const version = this.repo.getVersion(doc.id, args.version);
    if (!version) {
      throw new MemoryError("NOT_FOUND", `Version ${args.version} of ${doc.path} does not exist; current version is ${doc.version}`,
        { doc_id: doc.id, version: args.version, current_version: doc.version });
    }
    return {
      path: version.path, version: version.version, current_version: doc.version, content_type: doc.content_type,
      data: version.data ?? Buffer.alloc(0),
    };
  }

  // ---------------------------------------------------------------- writes

  write(ctx: Context, args: WriteArgs): WriteResult {
    return this.inTransaction(ctx, args.change_note, (tx) => this.doWrite(tx, args));
  }

  /** memory_write with the bytes of a binary document given as is (REST). */
  writeFile(ctx: Context, args: FileWriteArgs): WriteResult {
    return this.inTransaction(ctx, args.change_note, (tx) => {
      const { data, content_type, ...rest } = args;
      return this.doPut(tx, normalizeDocPath(args.path), { text: "", data, declaredType: content_type }, rest);
    });
  }

  edit(ctx: Context, args: EditArgs): WriteResult {
    return this.inTransaction(ctx, args.change_note, (tx) => this.doEdit(tx, args));
  }

  move(ctx: Context, args: MoveArgs): MoveResult {
    return this.inTransaction(ctx, args.change_note, (tx) => this.doMove(tx, args));
  }

  delete(ctx: Context, args: DeleteArgs): DeleteResult {
    return this.inTransaction(ctx, args.change_note, (tx) => this.doDelete(tx, args));
  }

  batch(ctx: Context, args: BatchArgs): BatchResult {
    return this.inTransaction(ctx, args.change_note, (tx) => ({
      results: args.operations.map((operation, index) => this.batchItem(tx, operation.tool, operation.arguments, index + 1)),
    }));
  }

  // ---------------------------------------------------------------- administration

  listStores(): ReturnType<Repository["listStores"]> {
    return this.repo.listStores();
  }

  listDeleted(ctx: Context): ReturnType<Repository["listDeletedDocs"]> {
    validateStoreName(ctx.store);
    return this.repo.listDeletedDocs(ctx.store);
  }

  restore(ctx: Context, args: RestoreArgs): RestoreResult {
    return this.inTransaction(ctx, args.change_note, (tx) => {
      const store = ctx.store;
      let deleted;
      if (args.doc_id !== undefined) {
        deleted = this.repo.getDeletedDoc(store, args.doc_id);
      } else if (args.path !== undefined) {
        deleted = this.repo.listDeletedDocs(store, normalizeDocPath(args.path))[0];
      } else {
        throw new MemoryError("INVALID_ARGUMENT", "Give doc_id or path of the deleted document");
      }
      if (!deleted) throw new MemoryError("NOT_FOUND", "No such deleted document; list the deleted documents to find it");
      const sourceVersion = args.version ?? deleted.version - 1;
      const source = this.repo.getVersion(deleted.doc_id, sourceVersion);
      if (!source || source.op === "delete") {
        throw new MemoryError("NOT_FOUND", `Version ${sourceVersion} of deleted document ${deleted.doc_id} does not exist or is a deletion`,
          { doc_id: deleted.doc_id, version: sourceVersion });
      }
      const target = args.new_path !== undefined ? normalizeDocPath(args.new_path) : deleted.path;
      if (this.repo.getLiveDoc(store, target)) {
        throw new MemoryError("ALREADY_EXISTS", `Path exists: ${target}; restore with another new_path`, { path: target });
      }
      this.checkPlacement(store, target);
      const version = deleted.version + 1;
      this.appendVersion(tx, deleted.doc_id, version, "restore", target,
        { text: source.content, data: source.data, description: source.description, tags: source.tags, metadata: source.metadata },
        undefined);
      return { doc_id: deleted.doc_id, path: target, version, restored_from_version: sourceVersion };
    });
  }

  // ---------------------------------------------------------------- internals

  private inTransaction<T>(ctx: Context, changeNote: string | undefined, fn: (tx: Tx) => T): T {
    validateStoreName(ctx.store);
    const run = this.db.transaction(() => {
      const now = new Date().toISOString();
      let changesetId: number | undefined;
      const tx: Tx = {
        ctx, now, changeNote,
        changesetId: () => {
          if (changesetId === undefined) {
            this.repo.ensureStore(ctx.store, now);
            changesetId = this.repo.createChangeset(ctx.store, ctx.actor, changeNote, now);
          }
          return changesetId;
        },
      };
      return fn(tx);
    });
    return run.immediate();
  }

  private appendVersion(tx: Tx, docId: number, version: number, op: VersionOp, path: string, state: DocState,
                        changeNote: string | undefined): void {
    this.repo.appendVersion({
      docId, version, changesetId: tx.changesetId(), op, path, content: state.text, data: state.data,
      description: state.description, tags: state.tags, metadata: state.metadata,
      changeNote: changeNote ?? tx.changeNote, now: tx.now,
    });
  }

  private historyOf(doc: DocSummary, limit: number): HistoryResult {
    return {
      path: doc.path, doc_id: doc.id, current_version: doc.version, total: this.repo.countVersions(doc.id),
      versions: this.repo.listVersions(doc.id, limit).map((v) => ({
        version: v.version, op: v.op, path: v.path, created_at: v.created_at,
        change_note: v.change_note, actor: v.actor, size: v.size,
      })),
    };
  }

  private requireDoc(store: string, path: string): Doc {
    const doc = this.repo.getLiveDoc(store, path);
    if (doc) return doc;
    const under = this.repo.countLiveDocsUnder(store, path);
    if (under > 0) {
      throw new MemoryError("IS_FOLDER", `'${path}' is a folder containing ${under} documents, not a document; list it to see its content`,
        { path, documents: under });
    }
    const wasDeleted = this.repo.listDeletedDocs(store, path).length > 0;
    throw new MemoryError("NOT_FOUND",
      `Document not found: ${path}` + (wasDeleted
        ? " (a document at this path was deleted; an administrator can restore it)"
        : "; list or search the memory to find existing documents"),
      { path });
  }

  private checkVersion(doc: { path: string; version: number }, ifVersion: number | undefined): void {
    if (ifVersion !== undefined && ifVersion !== doc.version) {
      throw new MemoryError("VERSION_CONFLICT",
        `Version conflict on ${doc.path}: expected ${ifVersion}, current ${doc.version}; re-read and retry`,
        { path: doc.path, expected: ifVersion, current: doc.version });
    }
  }

  private checkSize(path: string, text: string): void {
    const size = Buffer.byteLength(text, "utf8");
    if (size > this.options.maxDocumentBytes) {
      throw new MemoryError("TOO_LARGE", `${path} would be ${size} bytes; the limit is ${this.options.maxDocumentBytes} bytes. Split it into several documents`,
        { path, size, limit: this.options.maxDocumentBytes });
    }
  }

  private checkFileSize(path: string, size: number): void {
    if (size > this.options.maxFileBytes) {
      throw new MemoryError("TOO_LARGE", `${path} would be ${size} bytes; the limit for a binary document is ${this.options.maxFileBytes} bytes`,
        { path, size, limit: this.options.maxFileBytes });
    }
  }

  /** The new text of an append-only document must start with its current text. */
  private checkAppendOnly(doc: Doc, text: string): void {
    if (doc.append_only && !text.startsWith(doc.content)) {
      throw new MemoryError("APPEND_ONLY",
        `${doc.path} is append-only: only additions at its end are accepted; add text with memory_edit op 'append' without section`,
        { path: doc.path });
    }
  }

  /** Only the admin may move, replace or delete append-only documents. */
  private checkRemovable(tx: Tx, docs: DocSummary[], action: string): void {
    if (tx.ctx.admin) return;
    const paths = docs.filter((d) => d.append_only).map((d) => d.path);
    if (paths.length > 0) {
      throw new MemoryError("APPEND_ONLY",
        `Cannot ${action} append-only ${paths.length === 1 ? "document" : "documents"} ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}; only the admin can`,
        { paths });
    }
  }

  /** A document cannot be a folder, nor be below another document. Documents in `ignore` are about to move away. */
  private checkPlacement(store: string, path: string, ignore: Set<number> = new Set()): void {
    const below = this.repo.listLiveDocs(store, path).filter((d) => !ignore.has(d.id));
    if (below.length > 0) {
      throw new MemoryError("IS_FOLDER", `'${path}' is an existing folder (${below.length} documents); choose another path`,
        { path, documents: below.length });
    }
    for (const ancestor of ancestorsOf(path)) {
      const doc = this.repo.getLiveDoc(store, ancestor);
      if (doc && !ignore.has(doc.id)) {
        throw new MemoryError("INVALID_PATH", `'${ancestor}' is a document, so it cannot contain '${path}'`, { path, document: ancestor });
      }
    }
  }

  private doWrite(tx: Tx, args: WriteArgs): WriteResult {
    const path = normalizeDocPath(args.path);
    const { file_text, encoding, ...rest } = args;
    const content: Content = encoding === "base64"
      ? { text: "", data: decodeBase64(path, file_text) }
      : { text: normalizeNewlines(file_text) };
    return this.doPut(tx, path, content, rest);
  }

  /** Creates or overwrites a text or binary document; whether it is binary depends on its extension. */
  private doPut(tx: Tx, path: string, content: Content, args: Omit<WriteArgs, "file_text" | "encoding">): WriteResult {
    const store = tx.ctx.store;
    const { text, data } = content;
    let contentType: string | undefined;
    if (data !== undefined) {
      contentType = checkMedia(path, data, content.declaredType);
      this.checkFileSize(path, data.length);
      if (args.append_only) {
        throw new MemoryError("INVALID_ARGUMENT", `append_only applies to text documents; ${path} is a binary document`, { path });
      }
    } else {
      const mediaType = mediaTypeOf(path);
      if (mediaType !== undefined) {
        throw new MemoryError("INVALID_ARGUMENT",
          `${path} is a binary document path (${mediaType}): write its bytes in base64 with encoding 'base64'`, { path });
      }
      this.checkSize(path, text);
    }
    const existing = this.repo.getLiveDoc(store, path);
    if (args.mode === "create") {
      if (args.if_version !== undefined) {
        throw new MemoryError("INVALID_ARGUMENT", "if_version cannot be used with mode 'create'");
      }
      if (existing) {
        throw new MemoryError("ALREADY_EXISTS", `Path exists: ${path} (version ${existing.version}); use mode 'overwrite'`,
          { path, current_version: existing.version });
      }
      this.checkPlacement(store, path);
      tx.changesetId(); // creates the store row before the document row refers to it
      const docId = this.repo.insertDocument(store, path, tx.now, args.append_only ?? false, contentType);
      this.appendVersion(tx, docId, 1, "create", path, {
        text, data, description: args.description ?? "", tags: normalizeTags(args.tags ?? []), metadata: args.metadata ?? {},
      }, args.change_note);
      return { path, version: 1, created: true };
    }
    if (args.append_only !== undefined) {
      throw new MemoryError("INVALID_ARGUMENT", "append_only can only be given when creating a document (mode 'create')");
    }
    if (!existing) this.requireDoc(store, path);
    const doc = existing!;
    if (doc.content_type !== contentType) {
      throw new MemoryError("INVALID_ARGUMENT", `${path} is a ${doc.content_type ?? "text"} document; it cannot be replaced by ${contentType ?? "text"}`,
        { path });
    }
    this.checkVersion(doc, args.if_version);
    const next: DocState = {
      text,
      data,
      description: args.description ?? doc.description,
      tags: args.tags ? normalizeTags(args.tags) : doc.tags,
      metadata: args.metadata ?? doc.metadata,
    };
    if (sameState(stateOf(doc), next)) return { path, version: doc.version, unchanged: true };
    this.checkAppendOnly(doc, next.text);
    this.appendVersion(tx, doc.id, doc.version + 1, "overwrite", path, next, args.change_note);
    return { path, version: doc.version + 1 };
  }

  private doEdit(tx: Tx, args: EditArgs): WriteResult {
    const path = normalizeDocPath(args.path);
    const doc = this.requireDoc(tx.ctx.store, path);
    this.checkVersion(doc, args.if_version);
    if (doc.content_type !== undefined && args.operations.some((op) => op.op !== "set_metadata")) {
      throw new MemoryError("INVALID_ARGUMENT",
        `${path} is a binary document (${doc.content_type}): only set_metadata applies; replace its content with memory_write`,
        { path, content_type: doc.content_type });
    }
    const before = stateOf(doc);
    const after = applyEdits(before, args.operations, path);
    this.checkSize(path, after.text);
    if (sameState(before, after)) return { path, version: doc.version, unchanged: true };
    this.checkAppendOnly(doc, after.text);
    this.appendVersion(tx, doc.id, doc.version + 1, "edit", path, after, args.change_note);
    const changed = changedLines(before.text, after.text);
    return { path, version: doc.version + 1, ...(changed && { changed }) };
  }

  private softDelete(tx: Tx, doc: Doc, changeNote: string | undefined): { path: string; version: number } {
    this.appendVersion(tx, doc.id, doc.version + 1, "delete", doc.path, stateOf(doc), changeNote);
    return { path: doc.path, version: doc.version + 1 };
  }

  private doMove(tx: Tx, args: MoveArgs): MoveResult {
    const store = tx.ctx.store;
    const from = normalizeFolderPath(args.old_path);
    const to = normalizeFolderPath(args.new_path);
    if (from === ROOT || to === ROOT) throw new MemoryError("INVALID_ARGUMENT", "The root folder cannot be moved, nor replaced");
    if (from === to) throw new MemoryError("INVALID_ARGUMENT", "old_path and new_path are the same");

    const doc = this.repo.getLiveDoc(store, from);
    if (doc) {
      if (mediaTypeOf(to) !== doc.content_type) {
        throw new MemoryError("INVALID_ARGUMENT",
          `${from} is a ${doc.content_type ?? "text"} document; ${to} would make it ${mediaTypeOf(to) ?? "text"}: keep the kind of extension`,
          { path: from, new_path: to });
      }
      const replaced: string[] = [];
      const target = this.repo.getLiveDoc(store, to);
      this.checkRemovable(tx, target ? [doc, target] : [doc], "move or replace");
      if (target) {
        if (!args.overwrite) {
          throw new MemoryError("ALREADY_EXISTS", `Path exists: ${to}; set overwrite to replace it`, { path: to });
        }
        this.softDelete(tx, target, args.change_note);
        replaced.push(to);
      }
      this.checkPlacement(store, to, new Set([doc.id]));
      this.appendVersion(tx, doc.id, doc.version + 1, "move", to, stateOf(doc), args.change_note);
      return { moved: [{ from, to, version: doc.version + 1 }], replaced };
    }

    const docs = this.repo.listLiveDocsWithContent(store, from);
    if (docs.length === 0) {
      throw new MemoryError("NOT_FOUND", `Nothing to move: no document or folder at ${from}`, { path: from });
    }
    if (to.startsWith(from + "/")) {
      throw new MemoryError("INVALID_ARGUMENT", `Cannot move folder ${from} into itself (${to})`);
    }
    const moving = new Set(docs.map((d) => d.id));
    const plan = docs.map((d) => ({ doc: d, target: rebase(d.path, from, to) }));
    const conflicts = plan
      .map((p) => this.repo.getLiveDoc(store, p.target))
      .filter((d): d is Doc => d !== undefined && !moving.has(d.id));
    const targetDoc = this.repo.getLiveDoc(store, to);
    if (targetDoc) {
      throw new MemoryError("ALREADY_EXISTS", `${to} is a document; a folder cannot be moved onto it`, { path: to });
    }
    if (conflicts.length > 0 && !args.overwrite) {
      const paths = conflicts.map((d) => d.path);
      throw new MemoryError("ALREADY_EXISTS",
        `${paths.length} target paths exist (${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}); set overwrite to replace them`,
        { paths });
    }
    this.checkRemovable(tx, [...docs, ...conflicts], "move or replace");
    const replaced = conflicts.map((d) => this.softDelete(tx, d, args.change_note).path);
    for (const p of plan) this.checkPlacement(store, p.target, moving);
    // Park first so that no move collides with a document that has not moved yet.
    for (const p of plan) this.repo.parkDocument(p.doc.id);
    const moved = plan.map((p) => {
      this.appendVersion(tx, p.doc.id, p.doc.version + 1, "move", p.target, stateOf(p.doc), args.change_note);
      return { from: p.doc.path, to: p.target, version: p.doc.version + 1 };
    });
    return { moved, replaced };
  }

  private doDelete(tx: Tx, args: DeleteArgs): DeleteResult {
    const store = tx.ctx.store;
    const path = normalizeFolderPath(args.path);
    if (path === ROOT) throw new MemoryError("INVALID_ARGUMENT", "The root folder cannot be deleted");
    const doc = this.repo.getLiveDoc(store, path);
    if (doc) {
      this.checkVersion(doc, args.if_version);
      this.checkRemovable(tx, [doc], "delete");
      return { deleted: [this.softDelete(tx, doc, args.change_note)] };
    }
    const docs = this.repo.listLiveDocsWithContent(store, path);
    if (docs.length === 0) this.requireDoc(store, path);
    if (!args.recursive) {
      throw new MemoryError("IS_FOLDER", `'${path}' is a folder containing ${docs.length} documents; set recursive to delete it`,
        { path, documents: docs.length });
    }
    if (args.if_version !== undefined) {
      throw new MemoryError("INVALID_ARGUMENT", "if_version applies to a document, not to a folder");
    }
    this.checkRemovable(tx, docs, "delete");
    return { deleted: docs.map((d) => this.softDelete(tx, d, args.change_note)) };
  }

  private batchItem(tx: Tx, tool: BatchableTool, rawArguments: Record<string, unknown>, index: number): BatchItemResult {
    const schemas = { memory_write: writeArgs, memory_edit: editArgs, memory_move: moveArgs, memory_delete: deleteArgs };
    const parsed = schemas[tool].safeParse(rawArguments);
    const target = String(rawArguments.path ?? rawArguments.old_path ?? "");
    const label = `Batch operation ${index} (${tool}${target ? " " + target : ""})`;
    if (!parsed.success) {
      throw new MemoryError("INVALID_ARGUMENT", `${label}: invalid arguments: ${formatZodError(parsed.error)}; no operation was applied`,
        { operation: index });
    }
    try {
      switch (tool) {
        case "memory_write": return { tool, result: this.doWrite(tx, parsed.data as WriteArgs) };
        case "memory_edit": return { tool, result: this.doEdit(tx, parsed.data as EditArgs) };
        case "memory_move": return { tool, result: this.doMove(tx, parsed.data as MoveArgs) };
        case "memory_delete": return { tool, result: this.doDelete(tx, parsed.data as DeleteArgs) };
      }
    } catch (error) {
      if (error instanceof MemoryError) {
        throw new MemoryError(error.code, `${label} failed: ${error.message}; no operation was applied`,
          { ...error.details, operation: index });
      }
      throw error;
    }
  }

  private matcher(query: string, mode: "keyword" | "regex"): (line: string) => { index: number; count: number } | undefined {
    if (mode === "keyword") {
      if (query.includes("\n")) {
        throw new MemoryError("INVALID_ARGUMENT", "A keyword query is matched line by line and cannot contain a newline");
      }
      const needle = query.toLowerCase();
      return (line) => {
        const haystack = line.toLowerCase();
        let index = haystack.indexOf(needle);
        if (index === -1) return undefined;
        const first = index;
        let count = 0;
        while (index !== -1) {
          count++;
          index = haystack.indexOf(needle, index + needle.length);
        }
        return { index: first, count };
      };
    }
    if (query.length > MAX_REGEX_LENGTH) {
      throw new MemoryError("INVALID_ARGUMENT", `A regex query is limited to ${MAX_REGEX_LENGTH} characters`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(query, "g");
    } catch (error) {
      throw new MemoryError("INVALID_ARGUMENT", `Invalid regex: ${(error as Error).message}`);
    }
    return (line) => {
      const matches = [...line.matchAll(regex)];
      return matches.length === 0 ? undefined : { index: matches[0]!.index, count: matches.length };
    };
  }
}
