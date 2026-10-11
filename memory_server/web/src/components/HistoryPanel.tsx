import { useEffect, useRef, useState } from "preact/hooks";
import { api, type DocumentHistoryResult } from "../api.js";
import { formatDelta, formatTime, OP_LABEL } from "../format.js";
import { navigate, onLiveChange, shownVersion } from "../state.js";
import { ErrorMessage, Link, Loading, useAsync } from "./common.js";

/**
 * Versions of one document, newest first. Unlike the document view, it follows live changes:
 * versions that arrive after it was opened are highlighted.
 */
export function HistoryPanel({ store, id, diff }: {
  store: string;
  id: number;
  diff?: { from: number; to: number } | undefined;
}) {
  const state = useAsync<DocumentHistoryResult>(() => api.history(store, id), [store, id]);
  const knownAtOpen = useRef<number | undefined>(undefined);
  const [compare, setCompare] = useState<number[]>([]);

  useEffect(() => {
    knownAtOpen.current = undefined;
    setCompare([]);
    return onLiveChange((change) => {
      if (change.items.some((item) => item.doc_id === id)) state.reload();
    });
  }, [store, id]);

  if (state.error) return <aside class="history"><ErrorMessage message={state.error} /></aside>;
  if (!state.data) return <aside class="history"><Loading /></aside>;
  const history = state.data;
  knownAtOpen.current ??= history.current_version;
  const shown = shownVersion.value?.id === id ? shownVersion.value.version : undefined;

  const toggleCompare = (version: number) => {
    setCompare((current) => current.includes(version)
      ? current.filter((v) => v !== version)
      : [...current, version].slice(-2));
  };
  const [a, b] = [...compare].sort((x, y) => x - y);

  return (
    <aside class="history" aria-label="History">
      <h3>History <span class="muted">{history.total} version{history.total === 1 ? "" : "s"}{history.deleted ? " · deleted" : ""}</span></h3>
      {compare.length === 2 && a !== undefined && b !== undefined && (
        <button type="button" class="compare" onClick={() => navigate({ name: "diff", store, id, from: a, to: b })}>
          Compare v{a} ↔ v{b}
        </button>
      )}
      <ol class="versions">
        {history.versions.map((v, index) => {
          const older = history.versions[index + 1];
          const isNew = v.version > (knownAtOpen.current ?? Infinity);
          const inDiff = diff !== undefined && (v.version === diff.from || v.version === diff.to);
          const active = diff === undefined && v.version === shown;
          return (
            <li key={v.version} class={`${isNew ? "live-change " : ""}${active || inDiff ? "active" : ""}`}>
              <div class="version-head">
                <input type="checkbox" aria-label={`Select v${v.version} to compare`} checked={compare.includes(v.version)}
                  onChange={() => toggleCompare(v.version)} />
                <Link to={{ name: "doc", store, id, version: v.version }}>v{v.version}</Link>
                <span class={`op op-${v.op}`}>{OP_LABEL[v.op]}</span>
                {isNew && <span class="chip chip-new">new</span>}
                <span class="time">{formatTime(v.created_at)}</span>
              </div>
              <div class="muted">
                {v.session ?? "no session"} · {v.actor}
                {older && <> · {formatDelta(v.size - older.size)} B</>}
              </div>
              {v.op === "move" && older && <div class="muted">{older.path} → {v.path}</div>}
              {v.change_note && <div class="note">“{v.change_note}”</div>}
              {v.version > 1 && v.op !== "create" && (
                <Link class="small" to={{ name: "diff", store, id, from: v.version - 1, to: v.version }}>diff with v{v.version - 1}</Link>
              )}
            </li>
          );
        })}
      </ol>
      {history.total > history.versions.length && <p class="muted">{history.total - history.versions.length} older versions not shown.</p>}
    </aside>
  );
}
