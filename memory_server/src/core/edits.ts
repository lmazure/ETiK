import type { EditOperation } from "../schemas.js";
import { MemoryError } from "./errors.js";
import { findSection, fromLines, normalizeNewlines, requireSection, sectionNotFound, toLines, validateSectionArgument } from "./markdown.js";

export interface DocState {
  text: string;
  description: string;
  tags: string[];
  metadata: Record<string, string>;
  /** Bytes of a binary document (its text is then empty). */
  data?: Buffer | undefined;
}

export interface ChangedLines {
  /** First changed line of the new text (1-based). */
  from: number;
  /** Last changed line of the new text; `from - 1` when lines were only removed. */
  to: number;
  lines: string[];
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t !== ""))];
}

/** 1-based line numbers where each occurrence of `needle` starts. */
function occurrenceLines(text: string, needle: string): number[] {
  const result: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    result.push(text.slice(0, index).split("\n").length);
    index = text.indexOf(needle, index + needle.length);
  }
  return result;
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/** Adds a missing section at the end of the document, separated by a blank line. Returns its heading line. */
function addSection(lines: string[], section: string): number {
  if (lines.length > 0 && !isBlank(lines[lines.length - 1])) lines.push("");
  lines.push(section.trim());
  return lines.length;
}

function applyStrReplace(text: string, op: Extract<EditOperation, { op: "str_replace" }>, path: string): string {
  const oldStr = normalizeNewlines(op.old_str);
  const newStr = normalizeNewlines(op.new_str);
  if (oldStr === "") throw new MemoryError("INVALID_ARGUMENT", "old_str must not be empty");
  const lines = occurrenceLines(text, oldStr);
  if (lines.length === 0) {
    throw new MemoryError("NO_MATCH", `old_str not found in ${path}; re-read the document and copy the passage exactly`, { path });
  }
  if (lines.length > 1 && !op.replace_all) {
    throw new MemoryError(
      "NOT_UNIQUE",
      `old_str found ${lines.length} times (lines ${lines.join(", ")}); make it unique or set replace_all`,
      { path, lines },
    );
  }
  return text.split(oldStr).join(newStr);
}

function applyAppendPrepend(
  lines: string[],
  op: Extract<EditOperation, { op: "append" | "prepend" }>,
  path: string,
): string[] {
  const added = toLines(normalizeNewlines(op.text));
  if (op.section === undefined) {
    return op.op === "append" ? [...lines, ...added] : [...added, ...lines];
  }
  const result = [...lines];
  const section = findSection(result, op.section, path);
  if (!section) {
    if (!op.create_section) {
      throw sectionNotFound(result, op.section, path, "; set create_section to add it");
    }
    addSection(result, op.section);
    result.push(...added);
    return result;
  }
  const start = section.heading.line; // index of the first body line (0-based)
  let at: number;
  if (op.op === "append") {
    // After the last non-blank line of the section, so trailing blank lines keep separating the next heading.
    at = section.end;
    while (at > start && isBlank(result[at - 1])) at--;
  } else {
    // Before the first non-blank body line, so a blank line right after the heading is kept.
    at = start;
    while (at < section.end && isBlank(result[at])) at++;
    if (at === section.end) at = start;
  }
  result.splice(at, 0, ...added);
  return result;
}

function applyInsert(lines: string[], op: Extract<EditOperation, { op: "insert" }>, path: string): string[] {
  if (op.insert_line > lines.length) {
    throw new MemoryError(
      "INVALID_ARGUMENT",
      `insert_line ${op.insert_line} is out of range: ${path} has ${lines.length} lines (use 0 to ${lines.length})`,
      { path, insert_line: op.insert_line, line_count: lines.length },
    );
  }
  const result = [...lines];
  result.splice(op.insert_line, 0, ...toLines(normalizeNewlines(op.insert_text)));
  return result;
}

function applyReplaceSection(lines: string[], op: Extract<EditOperation, { op: "replace_section" }>, path: string): string[] {
  const section = requireSection(lines, op.section, path);
  const body = toLines(normalizeNewlines(op.text));
  const followed = section.end < lines.length;
  if (followed && body.length > 0 && !isBlank(body[body.length - 1])) body.push("");
  return [...lines.slice(0, section.heading.line), ...body, ...lines.slice(section.end)];
}

function applySetMetadata(state: DocState, op: Extract<EditOperation, { op: "set_metadata" }>): DocState {
  const metadata = { ...state.metadata };
  for (const [key, value] of Object.entries(op.metadata ?? {})) {
    if (value === null) delete metadata[key];
    else metadata[key] = value;
  }
  return {
    ...state,
    description: op.description ?? state.description,
    tags: op.tags ? normalizeTags(op.tags) : state.tags,
    metadata,
  };
}

function applyOne(state: DocState, op: EditOperation, path: string): DocState {
  switch (op.op) {
    case "str_replace":
      return { ...state, text: applyStrReplace(state.text, op, path) };
    case "append":
    case "prepend":
      return { ...state, text: fromLines(applyAppendPrepend(toLines(state.text), op, path)) };
    case "insert":
      return { ...state, text: fromLines(applyInsert(toLines(state.text), op, path)) };
    case "replace_section":
      return { ...state, text: fromLines(applyReplaceSection(toLines(state.text), op, path)) };
    case "set_metadata":
      return applySetMetadata(state, op);
  }
}

/** Applies the operations in order; any failure throws and nothing is applied. */
export function applyEdits(state: DocState, operations: EditOperation[], path: string): DocState {
  let current = state;
  operations.forEach((op, index) => {
    if ("section" in op && op.section !== undefined) validateSectionArgument(op.section);
    try {
      current = applyOne(current, op, path);
    } catch (error) {
      if (error instanceof MemoryError && operations.length > 1) {
        throw new MemoryError(error.code, `Operation ${index + 1} (${op.op}) failed: ${error.message}; no operation was applied`, {
          ...error.details,
          operation: index + 1,
        });
      }
      throw error;
    }
  });
  return current;
}

/** The region of `after` that differs from `before` (common prefix and suffix removed). */
export function changedLines(before: string, after: string): ChangedLines | undefined {
  if (before === after) return undefined;
  const a = toLines(before);
  const b = toLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
         && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { from: prefix + 1, to: b.length - suffix, lines: b.slice(prefix, b.length - suffix) };
}

export function sameState(a: DocState, b: DocState): boolean {
  const sameData = a.data === undefined || b.data === undefined ? a.data === b.data : a.data.equals(b.data);
  return a.text === b.text && sameData && a.description === b.description
    && JSON.stringify(a.tags) === JSON.stringify(b.tags)
    && JSON.stringify(Object.entries(a.metadata).sort()) === JSON.stringify(Object.entries(b.metadata).sort());
}
