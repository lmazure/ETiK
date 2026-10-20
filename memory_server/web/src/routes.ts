/**
 * Hash routes, so that every view has a shareable link and no server-side routing is needed:
 *   #/s/{store}                       store home
 *   #/s/{store}/doc/{id}?v=3&line=12  a document (current version when v is absent)
 *   #/s/{store}/diff/{id}/{a}..{b}    differences between two versions
 *   #/s/{store}/search?q=…&mode=…     search results (keyword when mode is absent)
 */
export const SEARCH_MODES = ["keyword", "semantic", "hybrid"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

export type Route =
  | { name: "none" }
  | { name: "store"; store: string }
  | { name: "doc"; store: string; id: number; version?: number; line?: number }
  | { name: "diff"; store: string; id: number; from: number; to: number }
  | { name: "search"; store: string; query: string; mode?: SearchMode };

function positiveInt(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const query = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter((s) => s !== "").map(decodeURIComponent);
  if (segments[0] !== "s" || !segments[1]) return { name: "none" };
  const store = segments[1];
  const [view, idText, range] = segments.slice(2);
  if (view === undefined) return { name: "store", store };
  const id = positiveInt(idText);
  if (view === "doc" && id !== undefined) {
    const version = positiveInt(query.get("v"));
    const line = positiveInt(query.get("line"));
    return { name: "doc", store, id, ...(version !== undefined && { version }), ...(line !== undefined && { line }) };
  }
  if (view === "diff" && id !== undefined && range) {
    const [from, to] = range.split("..").map(positiveInt);
    if (from !== undefined && to !== undefined) return { name: "diff", store, id, from, to };
  }
  if (view === "search") {
    const mode = SEARCH_MODES.find((m) => m !== "keyword" && m === query.get("mode"));
    return { name: "search", store, query: query.get("q") ?? "", ...(mode !== undefined && { mode }) };
  }
  return { name: "store", store };
}

export function formatRoute(route: Route): string {
  switch (route.name) {
    case "none":
      return "#/";
    case "store":
      return `#/s/${encodeURIComponent(route.store)}`;
    case "doc": {
      const query = new URLSearchParams();
      if (route.version !== undefined) query.set("v", String(route.version));
      if (route.line !== undefined) query.set("line", String(route.line));
      const q = query.toString();
      return `#/s/${encodeURIComponent(route.store)}/doc/${route.id}${q ? "?" + q : ""}`;
    }
    case "diff":
      return `#/s/${encodeURIComponent(route.store)}/diff/${route.id}/${route.from}..${route.to}`;
    case "search":
      return `#/s/${encodeURIComponent(route.store)}/search?${new URLSearchParams({
        q: route.query, ...(route.mode !== undefined && route.mode !== "keyword" && { mode: route.mode }),
      })}`;
  }
}
