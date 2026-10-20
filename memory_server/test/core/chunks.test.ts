import { describe, expect, it } from "vitest";
import { MAX_CHUNK_CHARS, chunkDocument } from "../../src/core/chunks.js";

const DOC = `Intro line

# Entity: Requirement

## UI pages
- Page URL: /req

## Business rules
\`\`\`
## not a heading
\`\`\`
- rule 1

### Deletion
- A requirement linked to a test case cannot be deleted
`;

describe("chunkDocument", () => {
  it("cuts at every heading, keeps the text before the first one and leaves out heading-only chunks", () => {
    const chunks = chunkDocument(DOC, "Requirement entity");
    expect(chunks.map((c) => [c.from, c.to, c.section])).toEqual([
      [1, 1, undefined],
      [5, 6, "## UI pages"],
      [8, 12, "## Business rules"],
      [14, 15, "### Deletion"],
    ]);
    expect(chunks[2]!.body).toEqual(["```", "## not a heading", "```", "- rule 1"]);
  });

  it("embeds the description and the heading chain, without Markdown markers, with the body", () => {
    const deletion = chunkDocument(DOC, "Requirement entity")[3]!;
    expect(deletion.embedText).toBe(
      "Requirement entity. Entity: Requirement, Business rules, Deletion: - A requirement linked to a test case cannot be deleted");
    expect(deletion.searchText).toBe(
      "Entity: Requirement\nBusiness rules\nDeletion\n- A requirement linked to a test case cannot be deleted");
    expect(chunkDocument(DOC, "Requirement entity.")[0]!.embedText).toBe("Requirement entity. Intro line");
    expect(chunkDocument("plain\n", "").map((c) => c.embedText)).toEqual(["plain"]);
    expect(chunkDocument("## Closed ##\ntext\n", "").map((c) => c.embedText)).toEqual(["Closed: text"]);
  });

  it("gives no chunk for an empty or blank document", () => {
    expect(chunkDocument("", "x")).toEqual([]);
    expect(chunkDocument("\n\n# Title\n\n", "x")).toEqual([]);
  });

  it("splits a long section after a blank line, every piece keeping the section", () => {
    const paragraph = Array.from({ length: 10 }, (_, i) => `- entry ${i} ${"x".repeat(60)}`);
    const lines = ["## Log", ...paragraph, "", ...paragraph, "", ...paragraph];
    const chunks = chunkDocument(lines.join("\n") + "\n", "");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.section === "## Log")).toBe(true);
    expect(chunks.every((c) => c.body.join("\n").length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks[0]!.from).toBe(1);
    expect(chunks[1]!.from).toBe(chunks[0]!.to + 2);
    expect(chunks[chunks.length - 1]!.to).toBe(lines.length);
    expect(chunks.flatMap((c) => c.body).filter((l) => l !== "")).toEqual(lines.slice(1).filter((l) => l !== ""));
  });

  it("splits a long section without blank line at line boundaries", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"y".repeat(40)}`);
    const chunks = chunkDocument(lines.join("\n"), "");
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.flatMap((c) => c.body)).toEqual(lines);
  });
});
