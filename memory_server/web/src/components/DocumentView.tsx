import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type ChangeItem, type DocInfo, type VersionResult } from "../api.js";
import { formatSize, formatTime, OP_LABEL } from "../format.js";
import { memoryLinkPath, renderMarkdown, type LinkResolver } from "../markdown.js";
import { formatRoute } from "../routes.js";
import { onLiveChange, shownVersion, treeDocs } from "../state.js";
import { ErrorMessage, Link, Loading, Tags, useAsync } from "./common.js";

/** Rendered Markdown or raw numbered lines; kept when moving between documents. */
const mode = signal<"rendered" | "raw">("rendered");

interface Loaded {
  doc: DocInfo;
  version: VersionResult;
}

interface Newer {
  version: number;
  item: ChangeItem;
  created_at: string;
  actor: string;
}

/**
 * One version of a document. The content shown is frozen: when the document changes, only a banner
 * appears, pointing to the new version and to the differences.
 */
export function DocumentView({ store, id, version, line }: { store: string; id: number; version?: number; line?: number }) {
  const state = useAsync<Loaded>(async () => {
    const doc = await api.document(store, id);
    return { doc, version: await api.version(store, id, version ?? doc.version) };
  }, [store, id, version]);
  const [newer, setNewer] = useState<Newer | undefined>();

  useEffect(() => {
    setNewer(undefined);
    return onLiveChange((change) => {
      for (const item of change.items) {
        if (item.doc_id === id) setNewer({ version: item.version, item, created_at: change.created_at, actor: change.actor });
      }
    });
  }, [store, id, version]);

  useEffect(() => {
    if (state.data) shownVersion.value = { id, version: state.data.version.version };
  }, [state.data]);

  if (state.error) return <ErrorMessage message={state.error} />;
  if (!state.data) return <Loading />;
  const { doc, version: shown } = state.data;
  const latest = Math.max(doc.version, newer?.version ?? 0);
  const deleted = newer ? newer.item.op === "delete" : doc.deleted;
  const openedAsCurrent = version === undefined;

  return (
    <article class="document">
      {latest > shown.version && (
        <div class="banner" role="status">
          <span>
            {openedAsCurrent && newer ? "Changed since you opened it: " : `You are viewing v${shown.version}; `}
            {deleted ? `the document was deleted in v${latest}` : `v${latest} is the current version`}
            {newer && <span class="muted"> ({OP_LABEL[newer.item.op]} · {newer.actor} · {formatTime(newer.created_at)})</span>}
          </span>
          <span class="actions">
            <Link to={{ name: "doc", store, id, version: latest }}>View v{latest}</Link>
            <Link to={{ name: "diff", store, id, from: shown.version, to: latest }}>Diff v{shown.version} → v{latest}</Link>
          </span>
        </div>
      )}
      <header class="doc-header">
        <h2>
          {shown.path}
          <span class={`chip ${shown.version === latest ? "chip-current" : "chip-past"}`}>
            v{shown.version}{shown.version === latest ? " · current" : ` of ${latest}`}
          </span>
          {deleted && <span class="chip chip-deleted">deleted</span>}
        </h2>
        {shown.description && <p class="description">{shown.description}</p>}
        <div class="meta">
          <Tags tags={shown.tags} />
          {Object.entries(shown.metadata).map(([k, v]) => <span class="kv" key={k}>{k}: {v}</span>)}
        </div>
        <p class="muted">
          {OP_LABEL[shown.op]} {formatTime(shown.created_at)} by {shown.actor} · {formatSize(shown.size)}
          {shown.change_note && <> · “{shown.change_note}”</>}
        </p>
        <div class="toggle" role="group" aria-label="Display">
          <button type="button" aria-pressed={mode.value === "rendered"} onClick={() => (mode.value = "rendered")}>Rendered</button>
          <button type="button" aria-pressed={mode.value === "raw"} onClick={() => (mode.value = "raw")}>Raw</button>
        </div>
      </header>
      {mode.value === "rendered" && line === undefined
        ? <Rendered store={store} path={shown.path} content={shown.content} />
        : <Raw content={shown.content} line={line} />}
    </article>
  );
}

function Rendered({ store, path, content }: { store: string; path: string; content: string }) {
  const docs = treeDocs.value;
  const html = useMemo(() => {
    // Links to other memory documents open them here, when they exist in the store as loaded.
    const links: LinkResolver = (href) => {
      const target = memoryLinkPath(href, path);
      if (target === undefined) return undefined;
      const doc = docs.get(target);
      return { path: target, href: doc && !doc.gone ? formatRoute({ name: "doc", store, id: doc.id }) : undefined };
    };
    return renderMarkdown(content, links);
  }, [store, path, content, docs]);
  if (content.trim() === "") return <p class="muted">(empty document)</p>;
  return <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Raw({ content, line }: { content: string; line?: number | undefined }) {
  const lines = useMemo(() => (content === "" ? [] : content.replace(/\n$/, "").split("\n")), [content]);
  const target = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [line, content]);
  if (lines.length === 0) return <p class="muted">(empty document)</p>;
  return (
    <table class="raw">
      <tbody>
        {lines.map((text, index) => (
          <tr key={index} class={line === index + 1 ? "highlight" : undefined} ref={line === index + 1 ? target : undefined}>
            <td class="ln">{index + 1}</td>
            <td class="text">{text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
