import type { Change, DocumentEntry } from "../../src/core/memory-core.js";

/**
 * What happened to an entry since the page was loaded:
 * changed (edited/overwritten), new (created/restored), moved-in (arrived by a move).
 */
export type Badge = "changed" | "new" | "moved-in";

/** One document of the tree, keyed by path. Deleted and moved-away entries stay, struck, until reload. */
export interface TreeDoc {
  id: number;
  path: string;
  version: number;
  description: string;
  tags: string[];
  badge?: Badge;
  /** The document left this path since load. */
  gone?: "deleted" | "moved";
  movedTo?: string;
  movedFrom?: string;
}

export interface FolderNode {
  kind: "folder";
  path: string;
  name: string;
  folders: FolderNode[];
  docs: TreeDoc[];
  /** Some document below changed since load. */
  changed: boolean;
}

export type TreeDocs = ReadonlyMap<string, TreeDoc>;

export function fromList(entries: DocumentEntry[]): Map<string, TreeDoc> {
  return new Map(entries.map((e) => [e.path, {
    id: e.id, path: e.path, version: e.version, description: e.description, tags: e.tags,
  }]));
}

/** Applies one changeset to the tree entries; returns a new map (the input is not modified). */
export function applyChange(docs: TreeDocs, change: Change): Map<string, TreeDoc> {
  const result = new Map(docs);
  for (const item of change.items) {
    const existing = result.get(item.path);
    switch (item.op) {
      case "create":
      case "restore":
        result.set(item.path, { id: item.doc_id, path: item.path, version: item.version, description: "", tags: [], badge: "new" });
        break;
      case "edit":
      case "overwrite":
        result.set(item.path, existing && !existing.gone
          ? { ...existing, version: item.version, badge: existing.badge ?? "changed" }
          : { id: item.doc_id, path: item.path, version: item.version, description: "", tags: [], badge: "changed" });
        break;
      case "delete":
        result.set(item.path, { ...(existing ?? { id: item.doc_id, path: item.path, description: "", tags: [] }),
          version: item.version, gone: "deleted" });
        break;
      case "move": {
        const from = item.previous_path;
        const source = from !== undefined ? result.get(from) : undefined;
        if (from !== undefined) {
          result.set(from, { ...(source ?? { id: item.doc_id, path: from, description: "", tags: [] }),
            version: item.version, gone: "moved", movedTo: item.path });
        }
        result.set(item.path, {
          id: item.doc_id, path: item.path, version: item.version,
          description: source?.description ?? "", tags: source?.tags ?? [],
          badge: "moved-in", ...(from !== undefined && { movedFrom: from }),
        });
        break;
      }
    }
  }
  return result;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** Builds the folder tree: folders first, then documents, each sorted by name. */
export function buildTree(docs: TreeDocs): FolderNode {
  const root: FolderNode = { kind: "folder", path: "/", name: "/", folders: [], docs: [], changed: false };
  const folders = new Map<string, FolderNode>([["/", root]]);
  const folderOf = (path: string): FolderNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parent = folderOf(parentPath(path));
    const node: FolderNode = { kind: "folder", path, name: baseName(path), folders: [], docs: [], changed: false };
    parent.folders.push(node);
    folders.set(path, node);
    return node;
  };
  for (const doc of docs.values()) {
    const folder = folderOf(parentPath(doc.path));
    folder.docs.push(doc);
    if (doc.badge || doc.gone) {
      for (let path = folder.path; ; path = parentPath(path)) {
        folders.get(path)!.changed = true;
        if (path === "/") break;
      }
    }
  }
  const sort = (node: FolderNode) => {
    node.folders.sort((a, b) => compareNames(a.name, b.name));
    node.docs.sort((a, b) => compareNames(a.path, b.path));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
