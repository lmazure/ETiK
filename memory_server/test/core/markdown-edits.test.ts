import { describe, expect, it } from "vitest";
import { applyEdits, changedLines, type DocState } from "../../src/core/edits.js";
import { MemoryError } from "../../src/core/errors.js";
import { findSection, parseHeadings, toLines } from "../../src/core/markdown.js";
import { ancestorsOf, normalizeDocPath, normalizeFolderPath, rebase } from "../../src/core/paths.js";
import { editOperation } from "../../src/schemas.js";

const DOC = `# Entity: Requirement

## Docs
- URL: a

## UI pages
- Page URL: /req
  - How to reach it: menu

## Business rules
\`\`\`
## not a heading
\`\`\`
- rule 1
`;

function state(text: string): DocState {
  return { text, description: "", tags: [], metadata: {} };
}

function edit(text: string, ...ops: unknown[]): string {
  return applyEdits(state(text), ops.map((o) => editOperation.parse(o)), "/e.md").text;
}

function errorOf(fn: () => unknown): MemoryError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MemoryError) return error;
    throw error;
  }
  throw new Error("expected a MemoryError");
}

describe("paths", () => {
  it("accepts absolute document paths", () => {
    expect(normalizeDocPath("/entities/requirement.md")).toBe("/entities/requirement.md");
  });

  it.each(["", "relative.md", "/", "/a//b", "/a/../b", "/a/./b", "/a/", "/a\u0000b"])("rejects '%s'", (path) => {
    expect(errorOf(() => normalizeDocPath(path)).code).toBe("INVALID_PATH");
  });

  it("normalizes folders", () => {
    expect(normalizeFolderPath("/")).toBe("/");
    expect(normalizeFolderPath("/entities/")).toBe("/entities");
  });

  it("computes ancestors and rebases", () => {
    expect(ancestorsOf("/a/b/c.md")).toEqual(["/a", "/a/b"]);
    expect(rebase("/a/b/c.md", "/a", "/x")).toBe("/x/b/c.md");
    expect(rebase("/a/b/c.md", "/a/b", "/")).toBe("/c.md");
  });
});

describe("markdown", () => {
  it("ignores headings inside fenced code", () => {
    expect(parseHeadings(toLines(DOC)).map((h) => h.text)).toEqual(["# Entity: Requirement", "## Docs", "## UI pages", "## Business rules"]);
  });

  it("finds a section up to the next heading of same or higher level", () => {
    const section = findSection(toLines(DOC), "## UI pages", "/e.md")!;
    expect(section.heading.line).toBe(6);
    expect(section.end).toBe(9);
  });

  it("rejects duplicated headings with their lines", () => {
    const error = errorOf(() => findSection(toLines("## A\n## A\n"), "## A", "/e.md"));
    expect(error.code).toBe("SECTION_AMBIGUOUS");
    expect(error.message).toContain("lines 1, 2");
  });

  it("requires a heading-like section argument", () => {
    expect(errorOf(() => findSection(toLines(DOC), "UI pages", "/e.md")).code).toBe("INVALID_ARGUMENT");
  });
});

describe("edits", () => {
  it("appends to a section after its last entry", () => {
    const result = edit(DOC, { op: "append", section: "## UI pages", text: "- Page URL: /req/2" });
    expect(result).toContain("  - How to reach it: menu\n- Page URL: /req/2\n\n## Business rules");
  });

  it("appends to the last section of the document", () => {
    expect(edit(DOC, { op: "append", section: "## Business rules", text: "- rule 2" })).toMatch(/- rule 1\n- rule 2\n$/);
  });

  it("prepends after the blank line following a heading", () => {
    expect(edit("## A\n\n- old\n", { op: "prepend", section: "## A", text: "- new" })).toBe("## A\n\n- new\n- old\n");
  });

  it("creates a missing section when asked", () => {
    expect(edit("# T\ntext\n", { op: "append", section: "## New", create_section: true, text: "- x" })).toBe("# T\ntext\n\n## New\n- x\n");
  });

  it("lists existing sections when a section is missing", () => {
    const error = errorOf(() => edit(DOC, { op: "append", section: "## Nope", text: "x" }));
    expect(error.code).toBe("SECTION_NOT_FOUND");
    expect(error.message).toContain("existing sections: # Entity: Requirement, ## Docs, ## UI pages, ## Business rules");
  });

  it("replaces a unique string", () => {
    expect(edit("a assumed b\n", { op: "str_replace", old_str: "assumed", new_str: "observed" })).toBe("a observed b\n");
  });

  it("reports the lines of a non-unique string", () => {
    const error = errorOf(() => edit("x\ny\nx\n", { op: "str_replace", old_str: "x", new_str: "z" }));
    expect(error.code).toBe("NOT_UNIQUE");
    expect(error.message).toBe("old_str found 2 times (lines 1, 3); make it unique or set replace_all");
  });

  it("replaces all occurrences when asked, and deletes with an empty new_str", () => {
    expect(edit("x\ny\nx\n", { op: "str_replace", old_str: "x", new_str: "z", replace_all: true })).toBe("z\ny\nz\n");
    expect(edit("keep drop\n", { op: "str_replace", old_str: " drop" })).toBe("keep\n");
  });

  it("fails when old_str is absent", () => {
    expect(errorOf(() => edit("abc\n", { op: "str_replace", old_str: "zzz" })).code).toBe("NO_MATCH");
  });

  it("inserts after a line and checks the range", () => {
    expect(edit("a\nb\n", { op: "insert", insert_line: 1, insert_text: "x" })).toBe("a\nx\nb\n");
    expect(edit("a\nb\n", { op: "insert", insert_line: 0, insert_text: "x" })).toBe("x\na\nb\n");
    expect(errorOf(() => edit("a\n", { op: "insert", insert_line: 5, insert_text: "x" })).code).toBe("INVALID_ARGUMENT");
  });

  it("replaces a section body and keeps a blank line before the next heading", () => {
    expect(edit("## A\nold\n## B\nb\n", { op: "replace_section", section: "## A", text: "new" })).toBe("## A\nnew\n\n## B\nb\n");
  });

  it("merges metadata and removes null keys", () => {
    const result = applyEdits(
      { text: "", description: "d", tags: ["a"], metadata: { k: "v", gone: "x" } },
      [editOperation.parse({ op: "set_metadata", tags: ["b", "b"], metadata: { gone: null, new: "n" } })],
      "/e.md",
    );
    expect(result).toEqual({ text: "", description: "d", tags: ["b"], metadata: { k: "v", new: "n" } });
  });

  it("applies all operations or none, and names the failing one", () => {
    const error = errorOf(() => edit("a\n",
      { op: "append", text: "b" },
      { op: "str_replace", old_str: "zzz", new_str: "y" }));
    expect(error.message).toMatch(/^Operation 2 \(str_replace\) failed: .*no operation was applied$/);
    expect(error.details.operation).toBe(2);
  });

  it("computes the changed lines", () => {
    expect(changedLines("a\nb\nc\n", "a\nX\nY\nc\n")).toEqual({ from: 2, to: 3, lines: ["X", "Y"] });
    expect(changedLines("a\nb\nc\n", "a\nc\n")).toEqual({ from: 2, to: 1, lines: [] });
    expect(changedLines("a\n", "a\n")).toBeUndefined();
  });
});
