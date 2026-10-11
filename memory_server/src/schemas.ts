/**
 * Input schemas of the memory tools: the single source of truth for the MCP tool list,
 * the REST request validation and the OpenAPI document.
 * Parameter names reuse those of Anthropic's memory tool (path, old_str, new_str, insert_line, view_range…).
 */
import { z } from "zod";

const tagsSchema = z.array(z.string().min(1));
const metadataSchema = z.record(z.string(), z.string());
const ifVersion = z.number().int().min(1).optional()
  .describe("Fail without changing anything if the document's current version differs.");
const changeNote = z.string().optional().describe("Why this change was made, like a commit message; kept in the history.");

export const listArgs = z.object({
  path: z.string().default("/").describe("Folder to list."),
  depth: z.number().int().min(1).max(5).default(2),
  tags: tagsSchema.optional().describe("Only documents carrying all these tags."),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

export const readArgs = z.object({
  path: z.string(),
  section: z.string().optional().describe("Exact heading line, e.g. '## UI pages'. Returns only that section."),
  view_range: z.array(z.number().int()).min(2).max(2).optional()
    .describe("[start_line, end_line], 1-based; end_line -1 means end of document."),
  version: z.number().int().min(1).optional().describe("Read a past version (requires history support)."),
});

export const searchArgs = z.object({
  query: z.string(),
  mode: z.enum(["keyword", "regex", "semantic", "hybrid"]).default("keyword"),
  path_prefix: z.string().default("/"),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional().describe("Only documents whose metadata has all these key/value pairs."),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const writeArgs = z.object({
  path: z.string(),
  file_text: z.string(),
  mode: z.enum(["create", "overwrite"]).default("create"),
  description: z.string().optional().describe("One line stating the document's scope; shown by memory_list."),
  tags: tagsSchema.optional(),
  metadata: metadataSchema.optional(),
  if_version: ifVersion,
  change_note: changeNote,
});

const strReplaceOp = z.object({
  op: z.literal("str_replace"),
  old_str: z.string().describe("Must match exactly once unless replace_all is true."),
  new_str: z.string().default("").describe("Empty string deletes old_str."),
  replace_all: z.boolean().default(false),
});

const sectionText = {
  section: z.string().optional().describe("Heading line; omitted = whole document."),
  create_section: z.boolean().default(false).describe("If the section is missing, add it at the end of the document."),
  text: z.string(),
};
const appendOp = z.object({ op: z.literal("append"), ...sectionText });
const prependOp = z.object({ op: z.literal("prepend"), ...sectionText });

const insertOp = z.object({
  op: z.literal("insert"),
  insert_line: z.number().int().min(0).describe("Insert after this line; 0 = top."),
  insert_text: z.string(),
});

const replaceSectionOp = z.object({
  op: z.literal("replace_section"),
  section: z.string(),
  text: z.string().describe("New body of the section, heading excluded."),
});

const setMetadataOp = z.object({
  op: z.literal("set_metadata"),
  description: z.string().optional(),
  tags: tagsSchema.optional(),
  metadata: z.record(z.string(), z.string().nullable()).optional()
    .describe("Merged into existing metadata; null removes a key."),
});

export const editOperation = z.discriminatedUnion("op", [
  strReplaceOp, appendOp, prependOp, insertOp, replaceSectionOp, setMetadataOp,
]);

export const editArgs = z.object({
  path: z.string(),
  operations: z.array(editOperation).min(1),
  if_version: ifVersion,
  change_note: changeNote,
});

export const moveArgs = z.object({
  old_path: z.string(),
  new_path: z.string(),
  overwrite: z.boolean().default(false),
  change_note: changeNote,
});

export const deleteArgs = z.object({
  path: z.string(),
  recursive: z.boolean().default(false),
  if_version: ifVersion,
  change_note: changeNote,
});

export const batchableTools = ["memory_write", "memory_edit", "memory_move", "memory_delete"] as const;

export const batchArgs = z.object({
  operations: z.array(z.object({
    tool: z.enum(batchableTools),
    arguments: z.record(z.string(), z.unknown()).describe("Same arguments as the named tool."),
  })).min(1).max(50),
  change_note: changeNote,
});

export const historyArgs = z.object({
  path: z.string(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const restoreArgs = z.object({
  doc_id: z.number().int().optional().describe("Id of the deleted document, from the deleted documents listing."),
  path: z.string().optional().describe("Last path of the deleted document; the most recently deleted one is restored."),
  version: z.number().int().min(1).optional().describe("Version to restore; default: the last one before deletion."),
  new_path: z.string().optional().describe("Restore at this path instead of the last one."),
  change_note: changeNote,
});

export const changesArgs = z.object({
  since: z.number().int().min(0).optional().describe("Changes after this changeset id, oldest first."),
  before: z.number().int().min(1).optional().describe("Changes before this changeset id, newest first (default: the latest)."),
  limit: z.number().int().min(1).max(500).default(100),
}).refine((args) => args.since === undefined || args.before === undefined, { message: "Give since or before, not both" });

const docId = z.number().int().min(1);

export const docIdArgs = z.object({ doc_id: docId });

export const docVersionArgs = z.object({
  doc_id: docId,
  version: z.number().int().min(1),
});

export const docHistoryArgs = z.object({
  doc_id: docId,
  limit: z.number().int().min(1).max(500).default(100),
});

export type ListArgs = z.infer<typeof listArgs>;
export type ReadArgs = z.infer<typeof readArgs>;
export type SearchArgs = z.infer<typeof searchArgs>;
export type WriteArgs = z.infer<typeof writeArgs>;
export type EditOperation = z.infer<typeof editOperation>;
export type EditArgs = z.infer<typeof editArgs>;
export type MoveArgs = z.infer<typeof moveArgs>;
export type DeleteArgs = z.infer<typeof deleteArgs>;
export type BatchArgs = z.infer<typeof batchArgs>;
export type HistoryArgs = z.infer<typeof historyArgs>;
export type RestoreArgs = z.infer<typeof restoreArgs>;
export type ChangesArgs = z.infer<typeof changesArgs>;
export type DocVersionArgs = z.infer<typeof docVersionArgs>;
export type DocHistoryArgs = z.infer<typeof docHistoryArgs>;
export type BatchableTool = (typeof batchableTools)[number];

export const tools = {
  memory_list: {
    description: "List memory folders and documents under a path without reading their content. Each document entry gives path, description, tags, size, last update and version. Use it to discover what exists before reading anything.",
    schema: listArgs,
    readOnly: true,
  },
  memory_read: {
    description: "Read one memory document, whole or in part. Returns numbered lines, the document's metadata and its current version. Read only the documents relevant to the task; use section or view_range for large documents.",
    schema: readArgs,
    readOnly: true,
  },
  memory_search: {
    description: "Search the content of memory documents. Returns matches with path, line number, enclosing section heading, a short snippet and a score. Use it to check whether something is already recorded before adding it, or to find all passages matching a pattern.",
    schema: searchArgs,
    readOnly: true,
  },
  memory_write: {
    description: "Create a document, or replace the whole content of an existing one. mode 'create' fails if the path exists; mode 'overwrite' fails if it does not. For small changes prefer memory_edit.",
    schema: writeArgs,
    readOnly: false,
  },
  memory_edit: {
    description: "Apply one or more targeted edits to one document, in order, all or nothing. Use append with a section to add an entry under a heading; str_replace to change an exact passage; replace_section to rewrite one section; set_metadata to change description, tags or metadata.",
    schema: editArgs,
    readOnly: false,
  },
  memory_move: {
    description: "Rename or move a document or a folder. Fails if new_path exists unless overwrite is true.",
    schema: moveArgs,
    readOnly: false,
  },
  memory_delete: {
    description: "Delete a document, or a folder when recursive is true. The root folder cannot be deleted.",
    schema: deleteArgs,
    readOnly: false,
  },
  memory_batch: {
    description: "Apply several write calls atomically: either all succeed or none is applied. Use it when documents must stay consistent with each other, e.g. a new document and the index entry that points to it.",
    schema: batchArgs,
    readOnly: false,
  },
  memory_history: {
    description: "List past versions of a document, newest first, with date and change note. Read one with memory_read(version).",
    schema: historyArgs,
    readOnly: true,
  },
} as const;

export type ToolName = keyof typeof tools;
