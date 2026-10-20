/**
 * Text results for the model: compact, numbered lines, explicit truncation, actionable errors.
 * See the "Results" section of the README.
 */
import type { ChangedLines } from "../core/edits.js";
import { MemoryError } from "../core/errors.js";
import type {
  BatchResult, DeleteResult, HistoryResult, ListResult, MoveResult, ReadResult, SearchResult, WriteResult,
} from "../core/memory-core.js";

const MAX_CHANGED_LINES = 40;

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function plural(n: number, word: string, words = word + "s"): string {
  return `${n} ${n === 1 ? word : words}`;
}

function numbered(line: number, text: string): string {
  return `${String(line).padStart(6)}\t${text}`;
}

export function formatList(result: ListResult): string {
  const out = [`${result.path} · ${plural(result.total, "entry", "entries")}`];
  for (const entry of result.entries) {
    if (entry.type === "folder") {
      out.push(`${entry.path}/ · ${plural(entry.documents, "document")}`);
    } else {
      out.push([
        entry.path, `v${entry.version}`, size(entry.size), entry.updated_at,
        entry.content_type ?? "", entry.append_only ? "append-only" : "",
        entry.tags.length ? `[${entry.tags.join(", ")}]` : "", entry.description,
      ].filter((s) => s !== "").join(" · "));
    }
  }
  if (result.next_offset !== undefined) out.push(`next_offset=${result.next_offset} (more entries: call again with offset=${result.next_offset})`);
  return out.join("\n");
}

/** `note`, for a binary document: why its content is not shown; without it, an image follows the text. */
export function formatRead(result: ReadResult, maxChars: number, note?: string): string {
  const header = [`path: ${result.path}`];
  header.push(`version: ${result.version}` + (result.is_past_version ? ` (past version; current is ${result.current_version})` : ""));
  if (result.description) header.push(`description: ${result.description}`);
  if (result.tags.length) header.push(`tags: ${result.tags.join(", ")}`);
  const metadata = Object.entries(result.metadata);
  if (metadata.length) header.push(`metadata: ${metadata.map(([k, v]) => `${k}=${v}`).join("; ")}`);
  header.push(`updated: ${result.updated_at}`);
  if (result.append_only) header.push("append-only: yes (only additions at the end are accepted)");
  if (result.content_type !== undefined) {
    header.push(`binary: ${result.content_type}, ${size(result.size)}`);
    if (note) header.push(note);
    return header.join("\n");
  }
  if (result.section) header.push(`section: ${result.section}`);
  header.push(result.total_lines === 0 ? "(empty document)" : `lines ${result.from}-${result.to} of ${result.total_lines}`);

  const out = [...header, ""];
  let length = out.join("\n").length;
  for (let i = 0; i < result.lines.length; i++) {
    const lineNumber = result.from + i;
    const text = numbered(lineNumber, result.lines[i]!);
    if (length + text.length + 1 > maxChars && i > 0) {
      out.push(`[truncated after line ${lineNumber - 1} of ${result.total_lines}; read the rest with view_range [${lineNumber}, ${result.to}]]`);
      break;
    }
    out.push(text);
    length += text.length + 1;
  }
  return out.join("\n");
}

/** Keyword and regex: one hit per line. Semantic and hybrid: one hit per section chunk, `path:from-to`, most relevant first. */
export function formatSearch(result: SearchResult): string {
  if (result.total === 0) return "No match";
  const ranked = result.mode === "semantic" || result.mode === "hybrid";
  const out = [ranked
    ? `${plural(result.total, "section")}, ${result.mode === "semantic" ? "most similar first" : "most relevant first (similarity and key words)"}`
    : plural(result.total, "match", "matches")];
  for (const hit of result.hits) {
    const lines = hit.end_line !== undefined && hit.end_line !== hit.line ? `${hit.line}-${hit.end_line}` : `${hit.line}`;
    out.push(`${hit.path}:${lines} · ${hit.section ?? "(before first heading)"} · ${hit.score}`);
    out.push(`    ${hit.snippet}`);
  }
  const more = ranked ? "more results" : "more matches";
  if (result.next_offset !== undefined) out.push(`next_offset=${result.next_offset} (${more}: call again with offset=${result.next_offset})`);
  return out.join("\n");
}

function formatChanged(changed: ChangedLines | undefined): string[] {
  if (!changed) return [];
  if (changed.to < changed.from) return [`Lines removed after line ${changed.from - 1}`];
  const shown = changed.lines.slice(0, MAX_CHANGED_LINES).map((text, i) => numbered(changed.from + i, text));
  const hidden = changed.lines.length - shown.length;
  return ["Changed lines:", ...shown, ...(hidden > 0 ? [`… ${plural(hidden, "more line")} (lines ${changed.from + shown.length}-${changed.to})`] : [])];
}

export function formatWrite(result: WriteResult): string {
  let first = `OK ${result.path} version=${result.version}`;
  if (result.created) first += " (created)";
  if (result.unchanged) first += " (unchanged: nothing differed from the current version)";
  return [first, ...formatChanged(result.changed)].join("\n");
}

export function formatMove(result: MoveResult): string {
  return [
    `OK moved ${plural(result.moved.length, "document")}`,
    ...result.moved.map((m) => `${m.from} → ${m.to} version=${m.version}`),
    ...(result.replaced.length ? [`Replaced (kept in history): ${result.replaced.join(", ")}`] : []),
  ].join("\n");
}

export function formatDelete(result: DeleteResult): string {
  return [
    `OK deleted ${plural(result.deleted.length, "document")} (kept in history)`,
    ...result.deleted.map((d) => `${d.path} version=${d.version}`),
  ].join("\n");
}

export function formatBatch(result: BatchResult): string {
  const out = [`OK ${plural(result.results.length, "operation")} applied atomically`];
  result.results.forEach((item, index) => {
    const text = item.tool === "memory_move" ? formatMove(item.result)
      : item.tool === "memory_delete" ? formatDelete(item.result)
      : formatWrite(item.result);
    out.push(`${index + 1}. ${item.tool}: ${text.split("\n").join("\n   ")}`);
  });
  return out.join("\n");
}

export function formatHistory(result: HistoryResult): string {
  const out = [`History of ${result.path}: ${plural(result.total, "version")}, current ${result.current_version} (newest first)`];
  for (const v of result.versions) {
    out.push([
      `v${v.version}`, v.created_at, v.op === "move" || v.op === "restore" ? `${v.op} to ${v.path}` : v.op,
      v.actor, size(v.size), v.change_note ? `"${v.change_note}"` : "",
    ].filter((s) => s !== "").join(" · "));
  }
  if (result.total > result.versions.length) out.push(`(${result.total - result.versions.length} older versions not shown; raise limit)`);
  return out.join("\n");
}

export function formatError(error: unknown): string {
  if (error instanceof MemoryError) return `Error: ${error.message}`;
  return "Error: internal error in the memory service";
}
