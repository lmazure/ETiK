import type {
  ChangesResult, DocInfo, DocumentEntry, DocumentHistoryResult, ListResult, SearchResult, VersionResult,
} from "../../src/core/memory-core.js";
import type { DeletedDoc } from "../../src/core/repository.js";

export type { Change, ChangeItem, DocInfo, DocumentEntry, DocumentHistoryResult, HistoryEntry, SearchHit, VersionResult } from "../../src/core/memory-core.js";
export type { DeletedDoc } from "../../src/core/repository.js";

export interface StoreInfo {
  name: string;
  created_at: string;
  documents: number;
  deleted_documents: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const TOKEN_KEY = "memory-token";

/** The token stays in this tab (sessionStorage) unless the user asked to remember it (localStorage). */
export function loadToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string, remember: boolean): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    if (remember) localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable: the token lives only in memory for this page
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored
  }
}

let token: string | undefined = loadToken();
let onUnauthorized: () => void = () => {};

export function setToken(value: string | undefined): void {
  token = value;
}

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function request<T>(method: "GET" | "POST", path: string, params?: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) query.set(key, String(value));
  const q = query.toString();
  const response = await fetch(path + (q ? "?" + q : ""), {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) onUnauthorized();
    const error = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(response.status, error?.code ?? "HTTP_" + response.status, error?.message ?? response.statusText);
  }
  return json as T;
}

const storePath = (store: string) => `/api/stores/${encodeURIComponent(store)}`;

/** Every live document of a store. Listings stop at depth 5, so deeper folders are listed in turn. */
async function listAll(store: string): Promise<DocumentEntry[]> {
  const documents: DocumentEntry[] = [];
  const pending = ["/"];
  while (pending.length > 0) {
    const folder = pending.shift()!;
    const base = folder === "/" ? 0 : folder.split("/").length - 1;
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page: ListResult = await request<ListResult>("GET", `${storePath(store)}/list`, { path: folder, depth: 5, limit: 500, offset });
      for (const entry of page.entries) {
        if (entry.type === "document") documents.push(entry);
        else if (entry.path.split("/").length - 1 - base === 5) pending.push(entry.path);
      }
      offset = page.next_offset;
    }
  }
  return documents;
}

export const api = {
  stores: () => request<{ stores: StoreInfo[] }>("GET", "/api/stores").then((r) => r.stores),
  listAll,
  deleted: (store: string) => request<{ deleted: DeletedDoc[] }>("GET", `${storePath(store)}/deleted`).then((r) => r.deleted),
  changes: (store: string, params: { since?: number; before?: number; limit?: number }) =>
    request<ChangesResult>("GET", `${storePath(store)}/changes`, params),
  document: (store: string, id: number) => request<DocInfo>("GET", `${storePath(store)}/documents/${id}`),
  history: (store: string, id: number) =>
    request<DocumentHistoryResult>("GET", `${storePath(store)}/documents/${id}/history`, { limit: 500 }),
  version: (store: string, id: number, version: number) =>
    request<VersionResult>("GET", `${storePath(store)}/documents/${id}/versions/${version}`),
  search: (store: string, query: string, offset = 0) =>
    request<SearchResult>("POST", `${storePath(store)}/search`, undefined, { query, mode: "keyword", limit: 100, offset }),
};
