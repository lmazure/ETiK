import { signal } from "@preact/signals";
import { useMemo, useState } from "preact/hooks";
import { api, type Change, type ChangeItem } from "../api.js";
import { formatTime, OP_LABEL } from "../format.js";
import type { Route } from "../routes.js";
import { activity, activityComplete, currentStore, deletedDocs, liveCount, route, sidebarTab, treeDocs, type ActivityEntry } from "../state.js";
import { baseName, buildTree, folderPaths, type FolderNode, type TreeDoc } from "../tree.js";
import { Link } from "./common.js";

const collapsed = signal<ReadonlySet<string>>(new Set());

function toggle(path: string) {
  const next = new Set(collapsed.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsed.value = next;
}

/** Collapses the given folders, or expands every folder when none is given. */
function setAllCollapsed(paths: string[] = []) {
  collapsed.value = new Set(paths);
}

function openDocId(): number | undefined {
  const r = route.value;
  return r.name === "doc" || r.name === "diff" ? r.id : undefined;
}

function BadgeChip({ doc }: { doc: TreeDoc }) {
  if (doc.gone === "deleted") return <span class="chip chip-deleted">deleted</span>;
  if (doc.gone === "moved") return <span class="chip chip-deleted" title={`moved to ${doc.movedTo}`}>moved → {doc.movedTo}</span>;
  if (doc.badge === "new") return <span class="chip chip-new">new</span>;
  if (doc.badge === "moved-in") return <span class="chip chip-new" title={`moved from ${doc.movedFrom}`}>moved here</span>;
  if (doc.badge === "changed") return <span class="chip chip-changed" title="changed since the page was loaded">●</span>;
  return null;
}

function DocRow({ store, doc }: { store: string; doc: TreeDoc }) {
  const active = openDocId() === doc.id && !doc.gone;
  return (
    <li class={`doc${active ? " active" : ""}${doc.gone ? " gone" : ""}`}>
      <Link to={{ name: "doc", store, id: doc.id }} title={doc.description || doc.path}>
        <span class="name">{baseName(doc.path)}</span>
        <BadgeChip doc={doc} />
        {doc.description && <span class="description">{doc.description}</span>}
      </Link>
    </li>
  );
}

function Folder({ store, node, filter }: { store: string; node: FolderNode; filter: string }) {
  const isCollapsed = collapsed.value.has(node.path) && filter === "";
  return (
    <li class="folder">
      <button type="button" class="folder-name" onClick={() => toggle(node.path)} aria-expanded={!isCollapsed}>
        <span class="caret" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
        {node.name}/
        {node.changed && <span class="chip chip-changed" title="something below changed since the page was loaded">●</span>}
      </button>
      {!isCollapsed && <FolderContent store={store} node={node} filter={filter} />}
    </li>
  );
}

function FolderContent({ store, node, filter }: { store: string; node: FolderNode; filter: string }) {
  return (
    <ul>
      {node.folders.map((f) => <Folder key={f.path} store={store} node={f} filter={filter} />)}
      {node.docs.map((d) => <DocRow key={d.path} store={store} doc={d} />)}
    </ul>
  );
}

function matches(doc: TreeDoc, filter: string): boolean {
  const f = filter.toLowerCase();
  return doc.path.toLowerCase().includes(f) || doc.description.toLowerCase().includes(f) || doc.tags.some((t) => t.toLowerCase().includes(f));
}

function DocumentsTab({ store }: { store: string }) {
  const [filter, setFilter] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const docs = treeDocs.value;
  const root = useMemo(() => {
    if (filter === "") return buildTree(docs);
    return buildTree(new Map([...docs].filter(([, d]) => matches(d, filter))));
  }, [docs, filter]);
  const folders = useMemo(() => folderPaths(root), [root]);
  const allCollapsed = folders.length > 0 && folders.every((p) => collapsed.value.has(p));
  const deleted = deletedDocs.value;
  return (
    <div class="documents">
      <div class="tree-tools">
        <input type="search" class="filter" placeholder="Filter by path, description, tag" aria-label="Filter documents"
          value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <button type="button" class="tree-toggle" disabled={filter !== "" || folders.length === 0}
          onClick={() => setAllCollapsed(allCollapsed ? undefined : folders)}>
          {allCollapsed ? "Expand all" : "Collapse all"}
        </button>
      </div>
      <ul class="tree" role="tree">
        <FolderContent store={store} node={root} filter={filter} />
      </ul>
      {docs.size === 0 && <p class="muted">No document in this store yet.</p>}
      {deleted.length > 0 && (
        <div class="deleted-group">
          <button type="button" class="folder-name" onClick={() => setShowDeleted(!showDeleted)} aria-expanded={showDeleted}>
            <span class="caret" aria-hidden="true">{showDeleted ? "▾" : "▸"}</span>Deleted before load ({deleted.length})
          </button>
          {showDeleted && (
            <ul>
              {deleted.map((d) => (
                <li class={`doc gone${openDocId() === d.doc_id ? " active" : ""}`} key={d.doc_id}>
                  <Link to={{ name: "doc", store, id: d.doc_id }} title={`deleted ${formatTime(d.deleted_at)} by ${d.deleted_by}`}>
                    <span class="name">{d.path}</span>
                    <span class="description">deleted {formatTime(d.deleted_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Where a click on a change item leads: the diff it introduced, or the document itself when there is no previous version. */
export function itemRoute(store: string, item: ChangeItem): Route {
  return item.version > 1 && item.op !== "create"
    ? { name: "diff", store, id: item.doc_id, from: item.version - 1, to: item.version }
    : { name: "doc", store, id: item.doc_id, version: item.version };
}

function ChangeEntry({ store, entry }: { store: string; entry: ActivityEntry }) {
  const { change, live } = entry;
  return (
    <li class={`change${live ? " live-change" : ""}`}>
      <div class="change-head">
        <span class="time">{formatTime(change.created_at)}</span>
        <span class="who">{change.actor}</span>
      </div>
      {change.change_note && <div class="note">“{change.change_note}”</div>}
      <ul class="items">
        {change.items.map((item) => (
          <li key={`${item.doc_id}-${item.version}`}>
            <Link to={itemRoute(store, item)}>
              <span class={`op op-${item.op}`}>{OP_LABEL[item.op]}</span>{" "}
              {item.previous_path ? `${item.previous_path} → ${item.path}` : item.path}
              <span class="muted"> v{item.version}</span>
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

function ActivityTab({ store }: { store: string }) {
  const [loadingOlder, setLoadingOlder] = useState(false);
  const entries = activity.value;
  const loadOlder = async () => {
    const oldest = entries[entries.length - 1]?.change.id;
    if (oldest === undefined) return;
    setLoadingOlder(true);
    try {
      const older: Change[] = (await api.changes(store, { before: oldest, limit: 50 })).changes;
      if (older.length < 50) activityComplete.value = true;
      if (currentStore.value === store) activity.value = [...activity.value, ...older.map((change) => ({ change, live: false }))];
    } finally {
      setLoadingOlder(false);
    }
  };
  return (
    <div class="activity">
      {entries.length === 0 && <p class="muted">No change yet.</p>}
      <ul>{entries.map((e) => <ChangeEntry key={e.change.id} store={store} entry={e} />)}</ul>
      {entries.length > 0 && !activityComplete.value && (
        <button type="button" class="link" disabled={loadingOlder} onClick={loadOlder}>Load older changes</button>
      )}
    </div>
  );
}

export function Sidebar() {
  const store = currentStore.value;
  if (!store) return <nav class="sidebar" />;
  const tab = sidebarTab.value;
  const count = liveCount.value;
  return (
    <nav class="sidebar">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "documents"} onClick={() => (sidebarTab.value = "documents")}>Documents</button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => (sidebarTab.value = "activity")}>
          Activity{count > 0 && <span class="chip chip-changed">{count}</span>}
        </button>
      </div>
      {tab === "documents" ? <DocumentsTab key={store} store={store} /> : <ActivityTab key={store} store={store} />}
    </nav>
  );
}
