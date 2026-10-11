import { signal } from "@preact/signals";
import { api, clearToken, loadToken, setToken, setUnauthorizedHandler, type Change, type DeletedDoc, type StoreInfo } from "./api.js";
import { pollDelay, startPolling, type LiveStatus } from "./live.js";
import { formatRoute, parseRoute, type Route } from "./routes.js";
import { applyChange, fromList, type TreeDoc } from "./tree.js";

export interface ActivityEntry {
  change: Change;
  /** Received after the page was loaded. */
  live: boolean;
}

export const token = signal<string | undefined>(loadToken());
export const stores = signal<StoreInfo[]>([]);
/** The list of stores has been received at least once. */
export const storesLoaded = signal(false);
export const route = signal<Route>(parseRoute(location.hash));
export const sidebarTab = signal<"documents" | "activity">("documents");

/** State of the selected store; reset when the store changes. */
export const currentStore = signal<string | undefined>(undefined);
export const treeDocs = signal<ReadonlyMap<string, TreeDoc>>(new Map());
export const deletedDocs = signal<DeletedDoc[]>([]);
export const activity = signal<ActivityEntry[]>([]);
/** Activity holds every change of the store: nothing older to load. */
export const activityComplete = signal(false);
export const liveCount = signal(0);
export const liveStatus = signal<LiveStatus>("connecting");
export const loadError = signal<string | undefined>(undefined);
/** Version displayed by the document view, so that the history panel can highlight it. */
export const shownVersion = signal<{ id: number; version: number } | undefined>(undefined);

/** Listeners told about each change received live (document view, history panel). */
const changeListeners = new Set<(change: Change) => void>();

export function onLiveChange(listener: (change: Change) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function navigate(next: Route): void {
  const hash = formatRoute(next);
  if (location.hash !== hash) location.hash = hash;
  else route.value = next;
}

addEventListener("hashchange", () => {
  route.value = parseRoute(location.hash);
});

export function logIn(value: string): void {
  setToken(value);
  token.value = value;
}

export function logOut(): void {
  stopPolling?.();
  stopPolling = undefined;
  clearToken();
  setToken(undefined);
  token.value = undefined;
  currentStore.value = undefined;
  stores.value = [];
  storesLoaded.value = false;
}

setUnauthorizedHandler(logOut);

let stopPolling: (() => void) | undefined;

/**
 * Loads the list of stores and opens the first one when no store is selected. A store only exists once
 * something has been written to it: while there is none, the list is checked again at the polling rhythm,
 * and a store that appears is opened from its very first change, since all of them happened after page load.
 * Returns a function that stops checking.
 */
export function watchStores(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waited = false;
  const load = async () => {
    try {
      const list = await api.stores();
      if (stopped) return;
      stores.value = list;
      storesLoaded.value = true;
      const first = list[0];
      if (!first) {
        waited = true;
        timer = setTimeout(() => void load(), pollDelay());
        return;
      }
      if (route.value.name !== "none") return;
      if (waited) await openStore(first.name, { fromStart: true });
      navigate({ name: "store", store: first.name });
    } catch (error) {
      if (!stopped) loadError.value = (error as Error).message;
    }
  };
  void load();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

const RECENT_ACTIVITY = 50;

/**
 * Loads a store and starts following its changes. The cursor is read first, so every change after it is
 * "since page load" and shows a marker, even one that the listing already includes.
 * With `fromStart`, the whole store is new since page load: it is rebuilt from its first change, every change live.
 */
export async function openStore(store: string, { fromStart = false }: { fromStart?: boolean } = {}): Promise<void> {
  if (currentStore.value === store) return;
  stopPolling?.();
  currentStore.value = store;
  treeDocs.value = new Map();
  deletedDocs.value = [];
  activity.value = [];
  activityComplete.value = false;
  liveCount.value = 0;
  loadError.value = undefined;
  liveStatus.value = "connecting";
  if (fromStart) {
    activityComplete.value = true;
    stopPolling = startPolling(store, 0, receive, (status) => (liveStatus.value = status));
    return;
  }
  try {
    const recent = await api.changes(store, { limit: RECENT_ACTIVITY });
    const [documents, deleted] = await Promise.all([api.listAll(store), api.deleted(store)]);
    if (currentStore.value !== store) return;
    treeDocs.value = fromList(documents);
    deletedDocs.value = deleted;
    activity.value = recent.changes.map((change) => ({ change, live: false }));
    activityComplete.value = recent.changes.length < RECENT_ACTIVITY;
    stopPolling = startPolling(store, recent.latest, receive, (status) => (liveStatus.value = status));
  } catch (error) {
    if (currentStore.value === store) loadError.value = (error as Error).message;
  }
}

function receive(changes: Change[]): void {
  let docs = treeDocs.value;
  for (const change of changes) docs = applyChange(docs, change);
  treeDocs.value = docs;
  activity.value = [...changes.map((change) => ({ change, live: true })).reverse(), ...activity.value];
  liveCount.value += changes.length;
  for (const change of changes) for (const listener of changeListeners) listener(change);
  void fillDescriptions(changes);
}

/** Change items carry no description: fetch it for documents that appeared since load. */
async function fillDescriptions(changes: Change[]): Promise<void> {
  const store = currentStore.value;
  if (!store) return;
  const arrived = changes.flatMap((c) => c.items).filter((i) => i.op === "create" || i.op === "restore" || i.op === "move");
  for (const item of arrived) {
    try {
      const doc = await api.document(store, item.doc_id);
      const entry = treeDocs.value.get(doc.path);
      if (currentStore.value === store && entry && entry.id === doc.id && !entry.gone) {
        treeDocs.value = new Map(treeDocs.value).set(doc.path, { ...entry, description: doc.description, tags: doc.tags });
      }
    } catch {
      // the document may have been removed meanwhile; the tree keeps what it has
    }
  }
}
