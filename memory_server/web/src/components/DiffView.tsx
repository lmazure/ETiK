import { useMemo, useState } from "preact/hooks";
import { api, type VersionResult } from "../api.js";
import { foldContext, lineDiff, metadataDiff, type DiffLine, type Fold } from "../diffs.js";
import { formatTime, OP_LABEL } from "../format.js";
import { ErrorMessage, Link, Loading, useAsync } from "./common.js";
import { Media } from "./DocumentView.js";

/** Differences between two versions of a document: metadata first, then a unified line diff. */
export function DiffView({ store, id, from, to }: { store: string; id: number; from: number; to: number }) {
  const state = useAsync<[VersionResult, VersionResult]>(
    () => Promise.all([api.version(store, id, from), api.version(store, id, to)]),
    [store, id, from, to],
  );
  if (state.error) return <ErrorMessage message={state.error} />;
  if (!state.data) return <Loading />;
  const [before, after] = state.data;
  return (
    <article class="diff">
      <header class="doc-header">
        <h2>
          {after.path}
          <span class="chip chip-past">v{from} → v{to}</span>
        </h2>
        <p class="muted">
          v{to}: {OP_LABEL[after.op]} {formatTime(after.created_at)} by {after.actor}
          {after.change_note && <> · “{after.change_note}”</>}
        </p>
        <nav class="diff-nav">
          {from > 1 && <Link to={{ name: "diff", store, id, from: from - 1, to: from }}>← previous change</Link>}
          <Link to={{ name: "doc", store, id, version: from }}>view v{from}</Link>
          <Link to={{ name: "doc", store, id, version: to }}>view v{to}</Link>
          {to < after.current_version && <Link to={{ name: "diff", store, id, from: to, to: to + 1 }}>next change →</Link>}
        </nav>
      </header>
      <MetadataChanges before={before} after={after} />
      {after.content_type !== undefined
        ? (
          <div class="media-diff">
            <figure><figcaption>v{from}</figcaption><Media store={store} id={id} version={from} contentType={after.content_type} label={`v${from}`} /></figure>
            <figure><figcaption>v{to}</figcaption><Media store={store} id={id} version={to} contentType={after.content_type} label={`v${to}`} /></figure>
          </div>
        )
        : <LineChanges before={before.content} after={after.content} />}
    </article>
  );
}

function MetadataChanges({ before, after }: { before: VersionResult; after: VersionResult }) {
  const changes = metadataDiff(before, after);
  if (changes.length === 0) return null;
  return (
    <table class="meta-diff">
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <th>{c.field}</th>
            <td class="del">{c.before || <span class="muted">(none)</span>}</td>
            <td class="add">{c.after || <span class="muted">(none)</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LineChanges({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => foldContext(lineDiff(before, after)), [before, after]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  if (before === after) return <p class="muted">The content did not change.</p>;
  return (
    <table class="line-diff">
      <tbody>
        {rows.flatMap((row, index) => {
          if (row.kind !== "fold") return [<Row key={index} line={row} />];
          if (expanded.has(index)) return (row as Fold).lines.map((l, i) => <Row key={`${index}-${i}`} line={l} />);
          return [(
            <tr key={index} class="fold">
              <td colSpan={3}>
                <button type="button" class="link" onClick={() => setExpanded(new Set(expanded).add(index))}>
                  ⋯ {row.lines.length} unchanged line{row.lines.length === 1 ? "" : "s"}
                </button>
              </td>
            </tr>
          )];
        })}
      </tbody>
    </table>
  );
}

function Row({ line }: { line: DiffLine }) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <tr class={line.kind}>
      <td class="ln">{line.oldLine ?? ""}</td>
      <td class="ln">{line.newLine ?? ""}</td>
      <td class="text"><span class="sign" aria-hidden="true">{sign}</span>{line.text}</td>
    </tr>
  );
}
