import { api, type SearchHit } from "../api.js";
import { treeDocs } from "../state.js";
import { ErrorMessage, Link, Loading, useAsync } from "./common.js";

/** Keyword search over the current content of the store. */
export function SearchResults({ store, query }: { store: string; query: string }) {
  const state = useAsync(() => api.search(store, query), [store, query]);
  if (state.error) return <ErrorMessage message={state.error} />;
  if (!state.data) return <Loading />;
  const { hits, total } = state.data;
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) groups.set(hit.path, [...(groups.get(hit.path) ?? []), hit]);
  return (
    <article class="search-results">
      <h2>“{query}” <span class="muted">{total} match{total === 1 ? "" : "es"}{total > hits.length ? `, first ${hits.length} shown` : ""}</span></h2>
      {total === 0 && <p class="muted">No match in the current documents.</p>}
      {[...groups].map(([path, pathHits]) => {
        const id = treeDocs.value.get(path)?.id;
        return (
          <section key={path}>
            <h3>{id !== undefined ? <Link to={{ name: "doc", store, id }}>{path}</Link> : path}</h3>
            <ul>
              {pathHits.map((hit) => (
                <li key={hit.line}>
                  {id !== undefined
                    ? <Link to={{ name: "doc", store, id, line: hit.line }}><Hit hit={hit} /></Link>
                    : <Hit hit={hit} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </article>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  return (
    <>
      <span class="ln">{hit.line}</span>
      {hit.section && <span class="muted"> {hit.section} · </span>}
      <code>{hit.snippet}</code>
    </>
  );
}
