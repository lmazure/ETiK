import { parseHeadings, toLines, type Heading } from "./markdown.js";

/** A passage of a text document indexed for semantic search: a section, or a part of a long one. */
export interface Chunk {
  /** First and last line (1-based, inclusive). */
  from: number;
  to: number;
  /** The innermost heading the chunk belongs to; absent before the first heading. */
  section?: string;
  /** Lines of the chunk without its heading line. */
  body: string[];
  /** Heading chain and body: what lexical (BM25) scoring reads. */
  searchText: string;
  /**
   * What is embedded: `Description. Heading, Subheading: body`. Markdown markers are left out of the headings, as
   * they blur the similarities; the path is left out so that a move re-embeds nothing.
   */
  embedText: string;
}

/** Above this many characters a section is split; the model reads 512 tokens at most. */
export const MAX_CHUNK_CHARS = 1500;

const isBlank = (line: string) => line.trim() === "";

/** `## UI pages ##` → `UI pages`. */
const headingTitle = (heading: Heading) => heading.text.trim().replace(/^#+\s*/, "").replace(/\s+#+$/, "");

/** Splits the lines `from..to` into pieces of at most MAX_CHUNK_CHARS, cutting after a blank line when there is one. */
function split(lines: string[], from: number, to: number): { from: number; to: number }[] {
  const pieces: { from: number; to: number }[] = [];
  let start = from;
  let length = 0;
  let lastBlank = -1;
  for (let n = from; n <= to; n++) {
    const size = lines[n - 1]!.length + 1;
    if (length + size > MAX_CHUNK_CHARS && n > start) {
      const end = lastBlank >= start ? lastBlank : n - 1;
      pieces.push({ from: start, to: end });
      start = end + 1;
      length = 0;
      lastBlank = -1;
      for (let m = start; m < n; m++) {
        length += lines[m - 1]!.length + 1;
        if (isBlank(lines[m - 1]!)) lastBlank = m;
      }
    }
    length += size;
    if (isBlank(lines[n - 1]!)) lastBlank = n;
  }
  pieces.push({ from: start, to });
  return pieces;
}

/**
 * Chunks of a text document: one per heading, running to the next heading of any level, plus the text before
 * the first heading; long ones are split at line boundaries. Chunks without any text besides their heading are left out.
 */
export function chunkDocument(content: string, description: string): Chunk[] {
  const lines = toLines(content);
  const headings = parseHeadings(lines);
  const spans: { from: number; to: number; chain: Heading[] }[] = [];
  const firstHeading = headings[0]?.line ?? lines.length + 1;
  if (firstHeading > 1) spans.push({ from: 1, to: firstHeading - 1, chain: [] });
  const stack: Heading[] = [];
  headings.forEach((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    stack.push(heading);
    spans.push({ from: heading.line, to: (headings[index + 1]?.line ?? lines.length + 1) - 1, chain: [...stack] });
  });

  const summary = description.trim();
  const intro = summary === "" || /[.!?:]$/.test(summary) ? summary : summary + ".";
  const chunks: Chunk[] = [];
  for (const span of spans) {
    const heading = span.chain[span.chain.length - 1];
    const titles = span.chain.map(headingTitle).filter((t) => t !== "");
    for (const piece of split(lines, span.from, span.to)) {
      let { from, to } = piece;
      const bodyFrom = heading?.line === from ? from + 1 : from;
      let first = bodyFrom;
      while (first <= to && isBlank(lines[first - 1]!)) first++;
      while (to >= first && isBlank(lines[to - 1]!)) to--;
      if (first > to) continue;
      if (bodyFrom === from) from = first;
      const body = lines.slice(first - 1, to);
      const text = body.join("\n");
      chunks.push({
        from, to, ...(heading && { section: heading.text }), body,
        searchText: [...titles, text].join("\n"),
        embedText: [intro, titles.length > 0 ? `${titles.join(", ")}: ${text}` : text].filter((s) => s !== "").join(" "),
      });
    }
  }
  return chunks;
}
