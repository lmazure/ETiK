import { api, type SearchHit } from "../api.js";
import type { SearchMode } from "../routes.js";
import { treeDocs } from "../state.js";
import { ErrorMessage, Link, Loading, useAsync } from "./common.js";

/**
 * Search over the current content of the store. Keyword hits are lines, grouped by document;
 * semantic and hybrid hits are sections, in ranked order.
 */
export function SearchResults({ store, query, mode }: { store: string; query: string; mode: SearchMode }) {
  const state = useAsync(() => api.search(store, query, mode), [store, query, mode]);
  if (state.error) return <ErrorMessage message={state.error} />;
  if (!state.data) return <Loading />;
  const { hits, total } = state.data;
  if (mode !== "keyword") {
    return (
      <article class="search-results">
        <h2>“{query}” <span class="muted">{mode} · {total} section{total === 1 ? "" : "s"}{total > hits.length ? `, best ${hits.length} shown` : ""}</span></h2>
        {total === 0 && <p class="muted">No text document to search.</p>}
        <ol class="ranked">
          {hits.map((hit) => {
            const id = treeDocs.value.get(hit.path)?.id;
            const label = <RankedHit hit={hit} />;
            return (
              <li key={`${hit.path}:${hit.line}`}>
                {id !== undefined ? <Link to={{ name: "doc", store, id, line: hit.line }}>{label}</Link> : label}
              </li>
            );
          })}
        </ol>
      </article>
    );
  }
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

function RankedHit({ hit }: { hit: SearchHit }) {
  return (
    <>
      <span>{hit.path}:{hit.line}{hit.end_line !== undefined && hit.end_line !== hit.line ? `-${hit.end_line}` : ""}</span>
      {hit.section && <span class="muted"> · {hit.section}</span>}
      <span class="score"> · {hit.score}</span>
      <br />
      <code>{hit.snippet}</code>
    </>
  );
}
