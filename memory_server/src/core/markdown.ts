import { MemoryError } from "./errors.js";

export interface Heading {
  /** 1-based line number. */
  line: number;
  level: number;
  /** The heading line, trailing whitespace removed. */
  text: string;
}

export interface Section {
  heading: Heading;
  /** Last line of the section (1-based, inclusive); equals heading.line when the section has no body. */
  end: number;
}

/** Splits a text into lines; a final newline does not create an extra empty line. */
export function toLines(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** Joins lines into a text ending with a newline (empty text for no line). */
export function fromLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX headings of a document, ignoring those inside fenced code blocks. */
export function parseHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length
          && line.trim() === fenceMatch[1]) {
        fence = null;
      }
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      return;
    }
    const headingMatch = HEADING.exec(line);
    if (headingMatch) headings.push({ line: index + 1, level: headingMatch[1]!.length, text: line.trimEnd() });
  });
  return headings;
}

function sameHeading(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Checks that `section` looks like a heading line, e.g. `## UI pages`. */
export function validateSectionArgument(section: string): void {
  if (!HEADING.test(section.trim())) {
    throw new MemoryError(
      "INVALID_ARGUMENT",
      `Invalid section '${section}': give the exact heading line, including its '#' characters, e.g. '## UI pages'`,
      { section },
    );
  }
}

/**
 * Finds a section by its heading line. Returns `undefined` when missing; throws when the heading occurs twice.
 * The section runs until the next heading of the same or higher level.
 */
export function findSection(lines: string[], section: string, path: string): Section | undefined {
  validateSectionArgument(section);
  const headings = parseHeadings(lines);
  const matches = headings.filter((h) => sameHeading(h.text, section));
  if (matches.length > 1) {
    throw new MemoryError(
      "SECTION_AMBIGUOUS",
      `Section '${section.trim()}' occurs ${matches.length} times in ${path} (lines ${matches.map((h) => h.line).join(", ")}); ` +
        "make the headings unique or use str_replace / insert",
      { path, section, lines: matches.map((h) => h.line) },
    );
  }
  const heading = matches[0];
  if (!heading) return undefined;
  const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
  return { heading, end: next ? next.line - 1 : lines.length };
}

export function sectionNotFound(lines: string[], section: string, path: string, hint = ""): MemoryError {
  const existing = parseHeadings(lines).map((h) => h.text);
  return new MemoryError(
    "SECTION_NOT_FOUND",
    `Section '${section.trim()}' not found in ${path}; existing sections: ${existing.length ? existing.join(", ") : "(none)"}${hint}`,
    { path, section, existing },
  );
}

/** Like findSection, but a missing section is an error. */
export function requireSection(lines: string[], section: string, path: string): Section {
  const found = findSection(lines, section, path);
  if (!found) throw sectionNotFound(lines, section, path);
  return found;
}

/** The innermost heading above a line, or `undefined` before the first heading. */
export function enclosingHeading(headings: Heading[], line: number): string | undefined {
  let result: string | undefined;
  for (const heading of headings) {
    if (heading.line > line) break;
    result = heading.text;
  }
  return result;
}
