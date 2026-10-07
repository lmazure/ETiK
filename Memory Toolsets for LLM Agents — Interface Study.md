# Memory Toolsets for LLM Agents — Interface Study

Oct 7, 2026 · @Laurent Mazuré

## Summary

There is no formal standard for memory tools: neither MCP nor any vendor defines one. There are, however, three de facto interface families, and one of them has become the reference point for agent memory.

1. **File / document style** — memory is a tree of text documents addressed by path. Reference: Anthropic's `memory` tool (`memory_20250818`), with the commands `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Letta's newer MemFS and Basic Memory follow the same idea.
2. **Record / fact store** — memory is a flat set of short text records with ids, metadata and semantic search: `add`, `search`, `get`, `update`, `delete`. Examples: Mem0, LangMem, Letta archival memory, AWS AgentCore, Google ADK.
3. **Knowledge graph** — memory is entities, observations and relations. Examples: the MCP reference "memory" server, Graphiti (Zep).

Your prototype is already a document-style memory: hierarchical Markdown files, an index loaded first, section-level appends, and periodic rewrites. The recommendation is therefore a **document-style toolset whose parameter vocabulary matches Anthropic's memory tool** (`path`, `old_str`, `new_str`, `insert_line`…), extended with what that tool lacks for your use: search, per-document description and metadata, heading-anchored edits, optimistic concurrency and an atomic batch. Section 6 gives the full definitions.

The toolset carries no notion of entity, source tag or session. Those stay in your instructions, so you can change your knowledge-management rules without touching the tools.

## Requirements

Each requirement below is derived from a rule of the current prototype, then restated so it no longer depends on that rule.

| Id | Generic capability | Why (prototype rule) |
| --- | --- | --- |
| R1 | Hierarchical, human-readable addressing | `index.md`, `entities/<name>.md`, `business-rules.md` |
| R2 | Cheap discovery: list what exists with a one-line scope, without reading content | "Index first, then only what's relevant"; never bulk-read |
| R3 | Read a whole document or only a part of it | Open only relevant files; large entity files |
| R4 | Create a document; fail if it already exists | New entity file |
| R5 | Append or insert inside a named section, without resending the document | Capture phase is append-only, per section (`## UI pages`, `## Business rules`…) |
| R6 | Targeted in-place replacement of a passage | Promote `assumed` → `observed`, resolve contradictions |
| R7 | Full rewrite of a document | Consolidation merges duplicates |
| R8 | Delete and move/rename | Prune dead ends, reorganize |
| R9 | Search across documents (keyword, optionally semantic), filtered by location or metadata | Find all `assumed` facts; find where a URL or endpoint is already recorded |
| R10 | Atomic multi-step change | "Create the file and add its index row in the same step" |
| R11 | Safe concurrent updates (detect that a document changed since it was read) | Several sessions or agents writing to the same store |
| R12 | Optional document metadata (description, tags, free key/values) | Index scope line; provenance kept outside the text if you wish |
| R13 | Optional history of a document | Trace a fact back; undo a bad consolidation |

R1–R9 are the CRUD core. R10–R13 are what an external store adds over plain files and what most published toolsets skip.

## Survey of well-known memory toolsets

The most influential definition is Anthropic's `memory` tool: one tool, a `command` discriminator, and file-editor semantics the Claude models are trained on. The others split into record stores and graphs.

### File / document family

| Toolset | Tools and parameters | Notable interface choices |
| --- | --- | --- |
| [Anthropic memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (`memory_20250818`) | One tool `memory`, `command` = `view(path, view_range?)` · `create(path, file_text)` · `str_replace(path, old_str, new_str)` · `insert(path, insert_line, insert_text)` · `delete(path)` · `rename(old_path, new_path)` | All paths under `/memories`. `view` on a directory lists 2 levels with sizes; on a file returns numbered lines. `create` fails if the file exists. `str_replace` fails if `old_str` is absent or not unique and says on which lines. No search, no metadata, no concurrency control. The API injects a protocol: "always view your memory directory first". |
| [Basic Memory](https://docs.basicmemory.com/reference/mcp-tools-reference) (MCP) | `write_note`, `read_note`, `edit_note`, `move_note`, `delete_note`, `list_directory`, `search_notes`, `build_context`, `recent_activity` | Markdown notes with frontmatter, addressed by title, permalink or `memory://` URL. `edit_note` operations: `append`, `prepend`, `find_replace`, `replace_section`, `insert_before_section`, `insert_after_section`. Search modes: text, vector, hybrid, with filters on tags, types, dates, metadata. `build_context` follows links to depth 1–3. |
| [Letta MemFS](https://docs.letta.com/concepts/memfs) | No dedicated tools: ordinary file tools on a git-backed Markdown tree | Root files are always in context; subfolders carry their own `MEMORY.md` index and are read on demand. Each edit is a commit, so history comes for free. Very close to your prototype. |

### Record / fact family

| Toolset | Tools and parameters | Notable interface choices |
| --- | --- | --- |
| [Mem0 MCP](https://github.com/mem0ai/mem0-mcp) | `add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`, `delete_memory`, `delete_all_memories`, `list_entities`, `delete_entities` | Scope by `user_id` / `agent_id` / `app_id` / `run_id`. `add_memory` takes text or a conversation and lets Mem0 extract and deduplicate facts itself, so the stored text is not exactly what the model sent. |
| [LangMem](https://langchain-ai.github.io/langmem/reference/tools/) | `manage_memory(content?, id?, action = create\|update\|delete)` · `search_memory(query, limit, offset, filter)` | Two tools only. The namespace is fixed by the harness, not chosen by the model. `actions_permitted` can remove update or delete. |
| Letta archival and core memory ([docs](https://docs.letta.com/guides/agents/archival-memory)) | `archival_memory_insert(content, tags?)` · `archival_memory_search(query, tags?, page?)`; for in-context blocks `memory_insert`, `memory_replace`, `memory_rethink` (earlier `core_memory_append` / `core_memory_replace`) | Two tiers: small named blocks always in the prompt, edited by string replace or full rewrite ("rethink"); a large tagged store reached only by search. |
| [AWS AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.md) | API, not model tools: `CreateEvent` for short-term events; memory records retrieved, listed, read, deleted by id within a namespace | Long-term records are extracted from events by configured "strategies". Namespaces are paths such as `/actor/{actorId}/facts`. |
| [Google ADK](https://adk.dev/sessions/memory/) | Agent tools `load_memory(query)` and `preload_memory`; service methods `add_session_to_memory`, `add_memory`, `search_memory` | Read-only from the model's side by default; writing happens at session end. |

### Knowledge-graph family

| Toolset | Tools and parameters | Notable interface choices |
| --- | --- | --- |
| [MCP reference memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | `create_entities([{name, entityType, observations[]}])` · `create_relations([{from, to, relationType}])` · `add_observations([{entityName, contents[]}])` · `delete_entities`, `delete_observations`, `delete_relations` · `read_graph` · `search_nodes(query)` · `open_nodes(names[])` | Everything is batched (arrays). Entities addressed by name. Observations are atomic strings, so no in-place update: delete then add. Deletes are idempotent. |
| [Graphiti MCP](https://github.com/getzep/graphiti/blob/main/mcp_server/README.md) (Zep) | `add_memory` (an "episode"), `add_triplet`, `search_nodes`, `search_memory_facts`, `get_episodes`, `get_entity_edge`, `delete_entity_edge`, `delete_episode`, `clear_graph` | Writes are episodes; an LLM extracts entities and facts, with validity dates on facts. Provenance: each fact points back to the episode that produced it. |

The MCP specification itself has no memory primitive. MCP *resources* can expose memory read-only, but writing always goes through tools.

## Comparison against the requirements

No published toolset covers all requirements; Basic Memory covers the most, and none of the tool interfaces exposes concurrency control.

| Toolset | Path + discovery (R1, R2) | Section / partial edit (R5, R6) | Search (R9) | Metadata (R12) | Atomic / concurrency (R10, R11) | History (R13) | Writes stored as sent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Anthropic memory tool | Yes; listing shows sizes only, no description | Line insert + unique string replace | No | No | No | No | Yes |
| Basic Memory | Yes; titles, folders, recent activity | Yes, heading-anchored ops | Text, vector, hybrid + filters | Frontmatter, tags, types | Not exposed | Not exposed | Yes |
| Letta MemFS | Yes; folder `MEMORY.md` indexes | Through generic file tools | Optional add-on | Frontmatter | Through git commits | Git | Yes |
| Mem0 | Ids + user/agent/run scope | Whole-record overwrite | Semantic + filters | Free metadata | No | Not in MCP tools | No, facts are extracted |
| LangMem | Ids; namespace fixed by harness | Whole-record overwrite | Semantic + filter | Via filter | No | No | Yes |
| MCP memory server | Flat entity names; `read_graph` returns everything | Add/delete observations, no update | Keyword | Entity type only | Batched arrays | No | Yes |
| Graphiti | Ids, group ids | No direct edit | Hybrid on nodes and facts | Entity / edge types | No | Validity dates, episode provenance | No, facts are extracted |

The last column matters for you: in Mem0 and Graphiti an LLM rewrites what the agent stores. That is useful for chat assistants, but it defeats a curated knowledge base whose format your instructions define.

## Design dimensions and trade-offs

Each choice below is independent of the storage behind the tools; the recommendation is what fits a curated, instruction-driven knowledge base.

| Dimension | Options seen | Recommendation | Reason |
| --- | --- | --- | --- |
| Unit of memory | Document (Anthropic, Basic Memory) · record (Mem0, LangMem) · entity + observation (MCP graph) | Document | Your instructions define structure inside a document (sections, entries). A record or graph model would hard-code one structure into the tools. |
| Addressing | Path · opaque id · entity name | Path, `/`-separated, case-sensitive | The model can plan a hierarchy and guess where things are; ids force a lookup first. |
| Number of tools | One tool + `command` enum (Anthropic, LangMem) · one tool per verb (MCP servers) | One tool per verb, about 8 | Simpler per-tool schemas and clearer errors; a harness can withhold write tools for read-only sessions. If you target the Claude API only, the native single `memory` tool is the alternative. |
| Parameter vocabulary | `path`, `old_str`, `new_str`, `insert_line` (Anthropic and its text-editor tool) · ad hoc names | Reuse the Anthropic names | Models have seen this vocabulary heavily in training, which reduces malformed calls. |
| Partial edit | Line number · unique string replace · heading anchor · whole rewrite | String replace + heading anchor + whole rewrite | Line numbers go stale between calls. A unique string is robust; a heading anchor makes "append to `## UI pages`" one call. |
| Literal vs inferred writes | Stored as sent · extracted by an LLM | Literal | The instructions, not the store, decide what a fact looks like. |
| Discovery | Directory listing · listing with descriptions · maintained index file | Listing returns each document's `description` | A model-maintained `index.md` drifts; a description stored with each document makes the index derivable. You can still keep `index.md` if your instructions want it. |
| Search | None · keyword · semantic · hybrid; filters | Keyword required, semantic optional, filters on path prefix and metadata | Keyword search answers "where is endpoint X already recorded" exactly; semantic helps with paraphrases. |
| Metadata | None · fixed fields · free key/values | `description`, `tags`, free `metadata` map | Generic enough for any instructions; your source tags can live in text, in metadata, or both. |
| Concurrency | None · version check | Every read returns `version`; writes accept `if_version` | Detects that another session changed the document between read and write. |
| Atomicity | None · batch | `memory_batch` of write operations, all-or-nothing | Covers "create the file and its index row in the same step". |
| Scope | Chosen by the model · fixed by the harness | Fixed by the harness (e.g. one store per SUT) | Keeps the model from writing to the wrong project; paths stay short. |
| Errors | Generic · actionable | Actionable, Anthropic style | "`old_str` found on lines 12 and 40" lets the model self-correct in one step. |
| Output size | Unbounded · truncated · paginated | Line ranges, `limit` / `offset`, explicit truncation notice | Protects the context window on large documents and listings. |

## Proposed tool definitions

Eight core tools plus one optional tool cover R1–R13. Schemas are written in the MCP form (`name`, `description`, `inputSchema`); the same JSON Schema works as an Anthropic or OpenAI function definition.

### Shared conventions

- **Paths**: absolute, `/`-separated, case-sensitive, e.g. `/entities/requirement.md`. Folders exist implicitly. The store root is fixed by the harness (one store per SUT, for instance); the model never sees or chooses it.
- **Document**: UTF-8 text (Markdown expected, not enforced) plus metadata: `description` (one line), `tags` (strings), `metadata` (free string-to-string map). Metadata is optional and never mixed into the text.
- **Version**: an integer that increases on every change. Every read and write returns it. Any write accepts `if_version`; on mismatch the call fails and changes nothing.
- **Section**: an exact Markdown heading line, e.g. `## UI pages`. A section runs until the next heading of the same or higher level. If the heading occurs twice, the call fails and lists the line numbers.
- **Change note**: every write accepts an optional `change_note` (like a commit message), kept in the history.
- **Errors**: returned as tool errors with an actionable message: what failed, where, and what to do. Nothing is partially applied.

### 1. memory\_list

```json
{
  "name": "memory_list",
  "description": "List memory folders and documents under a path without reading their content. Each document entry gives path, description, tags, size, last update and version. Use it to discover what exists before reading anything.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":   { "type": "string", "default": "/", "description": "Folder to list." },
      "depth":  { "type": "integer", "minimum": 1, "maximum": 5, "default": 2 },
      "tags":   { "type": "array", "items": { "type": "string" }, "description": "Only documents carrying all these tags." },
      "limit":  { "type": "integer", "minimum": 1, "maximum": 500, "default": 200 },
      "offset": { "type": "integer", "minimum": 0, "default": 0 }
    }
  }
}
```

### 2. memory\_read

```json
{
  "name": "memory_read",
  "description": "Read one memory document, whole or in part. Returns numbered lines, the document's metadata and its current version. Read only the documents relevant to the task; use section or view_range for large documents.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":       { "type": "string" },
      "section":    { "type": "string", "description": "Exact heading line, e.g. '## UI pages'. Returns only that section." },
      "view_range": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2,
                      "description": "[start_line, end_line], 1-based; end_line -1 means end of document." },
      "version":    { "type": "integer", "description": "Read a past version (requires history support)." }
    },
    "required": ["path"]
  }
}
```

### 3. memory\_search

```json
{
  "name": "memory_search",
  "description": "Search the content of memory documents. Returns matches with path, line number, enclosing section heading, a short snippet and a score. Use it to check whether something is already recorded before adding it, or to find all passages matching a pattern.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":       { "type": "string" },
      "mode":        { "type": "string", "enum": ["keyword", "regex", "semantic", "hybrid"], "default": "keyword" },
      "path_prefix": { "type": "string", "default": "/" },
      "tags":        { "type": "array", "items": { "type": "string" } },
      "metadata":    { "type": "object", "additionalProperties": { "type": "string" },
                       "description": "Only documents whose metadata has all these key/value pairs." },
      "limit":       { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
      "offset":      { "type": "integer", "minimum": 0, "default": 0 }
    },
    "required": ["query"]
  }
}
```

A store that cannot do `semantic` or `hybrid` rejects them with an explicit error; `keyword` is mandatory.

### 4. memory\_write

```json
{
  "name": "memory_write",
  "description": "Create a document, or replace the whole content of an existing one. mode 'create' fails if the path exists; mode 'overwrite' fails if it does not. For small changes prefer memory_edit.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":        { "type": "string" },
      "file_text":   { "type": "string" },
      "mode":        { "type": "string", "enum": ["create", "overwrite"], "default": "create" },
      "description": { "type": "string", "description": "One line stating the document's scope; shown by memory_list." },
      "tags":        { "type": "array", "items": { "type": "string" } },
      "metadata":    { "type": "object", "additionalProperties": { "type": "string" } },
      "if_version":  { "type": "integer" },
      "change_note": { "type": "string" }
    },
    "required": ["path", "file_text"]
  }
}
```

### 5. memory\_edit

```json
{
  "name": "memory_edit",
  "description": "Apply one or more targeted edits to one document, in order, all or nothing. Use append with a section to add an entry under a heading; str_replace to change an exact passage; replace_section to rewrite one section; set_metadata to change description, tags or metadata.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string" },
      "operations": {
        "type": "array", "minItems": 1,
        "items": { "oneOf": [
          { "type": "object", "required": ["op", "old_str"], "properties": {
              "op": { "const": "str_replace" },
              "old_str": { "type": "string", "description": "Must match exactly once unless replace_all is true." },
              "new_str": { "type": "string", "default": "", "description": "Empty string deletes old_str." },
              "replace_all": { "type": "boolean", "default": false } } },
          { "type": "object", "required": ["op", "text"], "properties": {
              "op": { "enum": ["append", "prepend"] },
              "section": { "type": "string", "description": "Heading line; omitted = whole document." },
              "create_section": { "type": "boolean", "default": false,
                                  "description": "If the section is missing, add it at the end of the document." },
              "text": { "type": "string" } } },
          { "type": "object", "required": ["op", "insert_line", "insert_text"], "properties": {
              "op": { "const": "insert" },
              "insert_line": { "type": "integer", "minimum": 0, "description": "Insert after this line; 0 = top." },
              "insert_text": { "type": "string" } } },
          { "type": "object", "required": ["op", "section", "text"], "properties": {
              "op": { "const": "replace_section" },
              "section": { "type": "string" },
              "text": { "type": "string", "description": "New body of the section, heading excluded." } } },
          { "type": "object", "required": ["op"], "properties": {
              "op": { "const": "set_metadata" },
              "description": { "type": "string" },
              "tags": { "type": "array", "items": { "type": "string" } },
              "metadata": { "type": "object", "additionalProperties": { "type": ["string", "null"] },
                            "description": "Merged into existing metadata; null removes a key." } } }
        ] }
      },
      "if_version":  { "type": "integer" },
      "change_note": { "type": "string" }
    },
    "required": ["path", "operations"]
  }
}
```

### 6. memory\_move

```json
{
  "name": "memory_move",
  "description": "Rename or move a document or a folder. Fails if new_path exists unless overwrite is true.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "old_path":    { "type": "string" },
      "new_path":    { "type": "string" },
      "overwrite":   { "type": "boolean", "default": false },
      "change_note": { "type": "string" }
    },
    "required": ["old_path", "new_path"]
  }
}
```

### 7. memory\_delete

```json
{
  "name": "memory_delete",
  "description": "Delete a document, or a folder when recursive is true. The root folder cannot be deleted.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":        { "type": "string" },
      "recursive":   { "type": "boolean", "default": false },
      "if_version":  { "type": "integer" },
      "change_note": { "type": "string" }
    },
    "required": ["path"]
  }
}
```

### 8. memory\_batch

```json
{
  "name": "memory_batch",
  "description": "Apply several write calls atomically: either all succeed or none is applied. Use it when documents must stay consistent with each other, e.g. a new document and the index entry that points to it.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "operations": {
        "type": "array", "minItems": 1, "maxItems": 50,
        "items": {
          "type": "object",
          "properties": {
            "tool":      { "enum": ["memory_write", "memory_edit", "memory_move", "memory_delete"] },
            "arguments": { "type": "object", "description": "Same arguments as the named tool." }
          },
          "required": ["tool", "arguments"]
        }
      },
      "change_note": { "type": "string" }
    },
    "required": ["operations"]
  }
}
```

### 9. memory\_history (optional)

```json
{
  "name": "memory_history",
  "description": "List past versions of a document, newest first, with date and change note. Read one with memory_read(version).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":  { "type": "string" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
    },
    "required": ["path"]
  }
}
```

### Results

| Tool | Success result |
| --- | --- |
| `memory_list` | One line per entry: `path · version · size · updated · tags · description`; a `next_offset` when truncated |
| `memory_read` | Header with path, version, metadata; then `line_number<TAB>text`; a truncation notice beyond a size limit |
| `memory_search` | One block per hit: `path:line · section · score`, then the snippet |
| Write tools | `OK path version=N` plus, for edits, the changed lines with numbers so the model can check the result |

Typical error messages: `old_str found 2 times (lines 12, 40); make it unique or set replace_all` · `Section '## UI pages' not found; existing sections: ## Docs, ## Business rules` · `Version conflict on /entities/requirement.md: expected 7, current 9; re-read and retry` · `Path exists; use mode 'overwrite'`.

### Alternative: a single multiplexed tool

If you prefer one tool, expose `memory` with a `command` enum and the same parameters. Keep Anthropic's six command names (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) with their exact parameter names, and add `search`, `append`, `replace_section`, `set_metadata`, `batch`, `history`. A Claude model then uses the common commands as trained, and other models still get one explicit schema. The cost is a larger `oneOf` schema and less precise validation errors.

## Mapping the prototype instructions onto the tools

Every rule of the current instructions maps onto one or two calls; only the wording of the instructions changes ("file" becomes "memory document").

| Prototype rule | Calls |
| --- | --- |
| Load `index.md` every session | `memory_read(path="/index.md")`, or drop the file and call `memory_list(path="/", depth=2)`, which returns each document's description |
| Open only the relevant files | `memory_read(path, section?)`; `memory_search(query, path_prefix="/entities")` when the name is unknown |
| New entity file + its index row in the same step | `memory_batch([memory_write(create "/entities/x.md"), memory_edit("/index.md", append)])` |
| Capture: append an entry to `## UI pages` | `memory_edit(path, [{op:"append", section:"## UI pages", create_section:true, text:"- Page URL: …"}])` |
| Check before capturing (no duplicate page or endpoint) | `memory_search(query="/backend/requirements", mode="keyword")` |
| Source tags `observed, session_03, 2026-06-24` | Kept in the text, as today; optionally also `set_metadata` at document level, and `change_note: "session_03"` on each write |
| Consolidate: list all `assumed` facts | `memory_search(query="assumed,", mode="keyword")` |
| Promote `assumed` → `observed` | `memory_edit` with `str_replace` on the exact entry |
| Merge true duplicates, rewrite a section | `memory_read` (gets `version`) → `memory_edit(replace_section, if_version)` or `memory_write(overwrite, if_version)` |
| Prune dead ends | `memory_edit(str_replace, new_str="")` or `memory_delete` |
| Verify `index.md` matches the folder | `memory_list` compared with `memory_read("/index.md")` |
| Trace a fact back to its session | Unchanged (session logs stay outside the memory); with history, `memory_history(path)` shows which session changed what |

The instruction file keeps everything that is policy: the schema of an entity document, the tag format, when to capture and when to consolidate. The toolset only guarantees addressing, editing, search, consistency and history.

## Architecture

One memory container serves everyone: the agent through MCP over HTTP, people through a web app on a REST API. Both go through the same core, which enforces every rule.

&#91;embedded content: memory service architecture · 1 container, 3 entry points\]

The dashed path is why every rule sits in the core: the MCP layer can be bypassed.

| Component | Role | Notes |
| --- | --- | --- |
| Core service | Paths, versions, atomic batches, history, soft delete, search | The only place rules are enforced |
| `/mcp` (Streamable HTTP) | Exposes the nine tools to agents | Formats results for the LLM: numbered lines, actionable errors |
| `/api` (REST, JSON) | Used by the web app and future clients | `ETag` / `If-Match`, `412` on version conflict, structured errors |
| Web app | Browse, search, history with diffs, optional editing | Static files served by the same container; edits send `If-Match` |
| Dev container | Claude Code in YOLO mode | No memory component installed, only the MCP configuration |

Claude Code registration, with store and session set by the harness rather than by the model:

```bash
claude mcp add --transport http memory http://memory:8080/mcp \
  --header "Authorization: Bearer $MEMORY_AGENT_TOKEN" \
  --header "X-Memory-Store: squashtm" \
  --header "X-Memory-Session: session_07"
```

### Tool to REST mapping

| Tool | REST |
| --- | --- |
| `memory_list` | `GET /api/stores/{store}/list?path=&depth=&tags=` |
| `memory_read` | `GET /api/stores/{store}/docs/{path}?section=&from=&to=&version=` |
| `memory_search` | `POST /api/stores/{store}/search` |
| `memory_write` | `PUT /api/stores/{store}/docs/{path}` (`If-None-Match: *` for create, `If-Match` for overwrite) |
| `memory_edit` | `PATCH /api/stores/{store}/docs/{path}` with the operations array |
| `memory_move` | `POST /api/stores/{store}/move` |
| `memory_delete` | `DELETE /api/stores/{store}/docs/{path}?recursive=` |
| `memory_batch` | `POST /api/stores/{store}/batch` |
| `memory_history` | `GET /api/stores/{store}/history/{path}` |

### Rules that follow from YOLO mode

The agent has a shell, so it can read its own MCP configuration and call `/api` directly. The design must hold even then.

- Enforce everything in the core; the MCP layer only translates and formats.
- The agent token reaches one store, with no admin operations (delete store, restore, export). The web app uses separate credentials.
- Store and session come from headers set in the harness configuration, never from tool arguments; the core writes them into history.
- History and soft delete are the undo for a wrong `memory_delete(recursive)`. Volume backups stay out of the agent's reach.
- Allow the memory host and port in the dev container's firewall allowlist.
- Define the tool schemas once and generate both the MCP tool list and the OpenAPI spec from them.

A harness without MCP (Pi, for instance) can be added later with a CLI on `/api`, without changing the core or the tool definitions.

## Sources

- [Anthropic — Memory tool (memory\_20250818)](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Basic Memory — MCP tools reference](https://docs.basicmemory.com/reference/mcp-tools-reference)
- [Letta — MemFS](https://docs.letta.com/concepts/memfs)
- [Letta — Archival memory](https://docs.letta.com/guides/agents/archival-memory)
- [Mem0 MCP server](https://github.com/mem0ai/mem0-mcp)
- [LangMem — Tools reference](https://langchain-ai.github.io/langmem/reference/tools/)
- [MCP reference Knowledge Graph Memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
- [Graphiti MCP server README](https://github.com/getzep/graphiti/blob/main/mcp_server/README.md)
- [AWS Bedrock AgentCore — Memory terminology](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.md)
- [Google ADK — Memory](https://adk.dev/sessions/memory/)
