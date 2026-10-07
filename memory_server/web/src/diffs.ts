import { diffLines } from "diff";

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  /** Line number in the old version (same, del). */
  oldLine?: number;
  /** Line number in the new version (same, add). */
  newLine?: number;
}

/** A run of unchanged lines hidden from the diff, expandable on demand. */
export interface Fold {
  kind: "fold";
  lines: DiffLine[];
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line-by-line differences between two texts, with line numbers on both sides. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffLines(before, after)) {
    for (const text of splitLines(part.value)) {
      if (part.added) result.push({ kind: "add", text, newLine: newLine++ });
      else if (part.removed) result.push({ kind: "del", text, oldLine: oldLine++ });
      else result.push({ kind: "same", text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return result;
}

/** Keeps `context` unchanged lines around each change and folds longer unchanged runs. */
export function foldContext(lines: DiffLine[], context = 3): (DiffLine | Fold)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep[i] = true;
  });
  const result: (DiffLine | Fold)[] = [];
  let hidden: DiffLine[] = [];
  const flush = () => {
    if (hidden.length > 0) result.push({ kind: "fold", lines: hidden });
    hidden = [];
  };
  lines.forEach((line, index) => {
    if (keep[index]) {
      flush();
      result.push(line);
    } else {
      hidden.push(line);
    }
  });
  flush();
  return result;
}

export interface VersionMeta {
  path: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
}

export interface MetaChange {
  field: string;
  before: string;
  after: string;
}

/** Differences of path, description, tags and each metadata key. */
export function metadataDiff(before: VersionMeta, after: VersionMeta): MetaChange[] {
  const changes: MetaChange[] = [];
  const compare = (field: string, a: string, b: string) => {
    if (a !== b) changes.push({ field, before: a, after: b });
  };
  compare("path", before.path, after.path);
  compare("description", before.description, after.description);
  compare("tags", before.tags.join(", "), after.tags.join(", "));
  const keys = [...new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)])].sort();
  for (const key of keys) compare(`metadata.${key}`, before.metadata[key] ?? "", after.metadata[key] ?? "");
  return changes;
}
