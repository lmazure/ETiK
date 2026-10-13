# Memory server: MCP tools and REST API

Reference of the two interfaces of the memory container. Keep it in step with the code (see [`../AGENTS.md`](../AGENTS.md)).

One Fastify process, on port `9501` by default, serves:

| Path | What | Auth |
| --- | --- | --- |
| `/mcp` | MCP Streamable HTTP, nine `memory_*` tools, for agents | agent or admin token |
| `/api/...` | JSON REST API, for people, the web app and other clients | any token |
| `/api/openapi.json` | OpenAPI 3.1 document of `/api` | none |
| `/health` | Liveness: `{"status":"ok"}` | none |
| `/` | Read-only web app (served only when it has been built) | viewer token, entered in the page |

MCP and REST are two thin layers over the same `MemoryCore` ([`src/core/memory-core.ts`](src/core/memory-core.ts)). MCP does not call REST. Every rule (paths, versions, sections, limits, access) is enforced in the core, so both interfaces behave the same.

Where the definitions live:

- tool inputs, descriptions and REST body validation: [`src/schemas.ts`](src/schemas.ts);
- MCP registration and text results: [`src/mcp/server.ts`](src/mcp/server.ts), [`src/mcp/format.ts`](src/mcp/format.ts);
- REST routes, status codes and headers: [`src/api/rest.ts`](src/api/rest.ts), OpenAPI in [`src/api/openapi.ts`](src/api/openapi.ts);
- tokens and store selection: [`src/auth.ts`](src/auth.ts); limits: [`src/config.ts`](src/config.ts).

When this document and the code disagree, the code is right and this document must be fixed.

## Authentication and stores

Every call except `/health` and `/api/openapi.json` needs `Authorization: Bearer <token>`. Tokens are static and set in the environment:

| Token | Variable | Stores | Read | Write | Restore | `/mcp` |
| --- | --- | --- | --- | --- | --- | --- |
| admin | `MEMORY_ADMIN_TOKEN` | all | yes | yes | yes | yes |
| agent | `MEMORY_AGENT_TOKENS=store=token,…` | its own store(s) | yes | yes | no | yes |
| viewer | `MEMORY_VIEWER_TOKEN` | all | yes | no (403) | no | no (403) |

The three kinds of tokens must all differ. A token listed for several stores in `MEMORY_AGENT_TOKENS` reaches all of them.

**Store.** A store is an independent set of documents. Its name matches `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. A store is created by its first write; reading an unknown store gives an empty root.

- MCP: the `X-Memory-Store` header. It can be omitted when the agent token reaches exactly one store; otherwise the call fails (400, `No store selected; set the x-memory-store header`).
- REST: the `{store}` segment of the URL. `X-Memory-Store` is ignored.

**Actor.** The history records, with each change, the actor that made it: `admin` or `agent:<store>[+<store>…]`.

The store never comes from tool arguments.

## Common rules

### Paths

- Absolute, `/`-separated, case-sensitive: `/entities/requirement.md`.
- No empty segment (`//`), no `.` or `..` segment, no control characters.
- At most 1024 characters; at most 255 characters per segment.
- A document path cannot end with `/`. A folder path may end with one `/`, which is dropped. `/` is the root folder.
- Folders exist implicitly, as long as they contain a document. A path cannot be both a document and a folder, and a document cannot be below another document.

Violations give `INVALID_PATH` (or `IS_FOLDER` when the path is an existing folder).

### Documents

- Content is UTF-8 text, Markdown expected but not enforced. `\r\n` and `\r` are normalized to `\n`.
- Metadata, never mixed into the text: `description` (one line, shown by `memory_list`), `tags` (strings, trimmed, empty and duplicate ones dropped), `metadata` (string-to-string map).
- Maximum size: `MEMORY_MAX_DOCUMENT_BYTES` (default 1 MiB) of UTF-8 content; beyond it, `TOO_LARGE`.
- `size` in results is in bytes; dates are ISO 8601 UTC strings.

### Versions

- Each document has a version, starting at 1 and incremented by every change: create, overwrite, edit, move, delete, restore.
- A write that changes nothing (same text, description, tags and metadata) creates no version and reports `unchanged`.
- `if_version` on a write fails with `VERSION_CONFLICT` and changes nothing when the current version differs.
- `change_note` is free text, like a commit message, kept in the history.
- A document keeps a stable numeric id across moves and deletion.

### Sections

- A section is named by its exact heading line, with its `#` characters: `## UI pages`. Leading and trailing spaces are ignored.
- Only ATX headings (`#` to `######`, up to three leading spaces) count; headings inside fenced code blocks are ignored.
- A section runs from its heading to the line before the next heading of the same or higher level, or to the end of the document.
- A `section` argument that is not a heading line gives `INVALID_ARGUMENT`; a missing heading gives `SECTION_NOT_FOUND` (with the existing headings); a heading present twice gives `SECTION_AMBIGUOUS` (with the line numbers).

### Atomicity, soft delete, history

- Every write call, and every batch, runs in one transaction and records one changeset (actor, change note). On any error nothing is applied.
- Deletion is soft: the document leaves listings and searches, its path is free again, all its versions stay. Only the admin can restore it (REST `restore`).
- Versions are append-only; nothing is ever overwritten.

## MCP

### Transport

- `POST /mcp`, JSON-RPC 2.0, Streamable HTTP in **stateless** mode with JSON responses (`Accept: application/json, text/event-stream`).
- Stateless: `tools/list` and `tools/call` work without a prior `initialize`.
- `GET /mcp` and `DELETE /mcp` return 405 with `Allow: POST`.
- Server info: name `memory-server`, version `0.1.0`.
- Authentication and store selection happen before any MCP processing. Failures are JSON-RPC errors with HTTP status 401 (with `WWW-Authenticate: Bearer`), 403 or 400:

```json
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Invalid bearer token"},"id":null}
```

### Results and errors

- A result is text only: `{"content":[{"type":"text","text":"…"}]}`. There is no `structuredContent`.
- An error is `{"content":[{"type":"text","text":"Error: <message>"}],"isError":true}`. The message says what failed, where and what to do; the error code is not shown. Unexpected failures give `Error: internal error in the memory service`.
- Invalid arguments (wrong type, missing required field, out-of-range number) are rejected by the MCP SDK, also as an `isError` result.

Tool annotations:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| --- | --- | --- | --- |
| `memory_list`, `memory_read`, `memory_search`, `memory_history` | true | false | true |
| `memory_edit` | false | false | false |
| `memory_write`, `memory_move`, `memory_delete`, `memory_batch` | false | true | false |

`openWorldHint` is false for all tools.

### `memory_list`

> List memory folders and documents under a path without reading their content. Each document entry gives path, description, tags, size, last update and version. Use it to discover what exists before reading anything.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | `"/"` | Folder to list. A document path lists that document alone. |
| `depth` | integer 1–5 | 2 | Levels below `path` to show. Deeper documents are not listed; they are counted in their folder's entry. |
| `tags` | string[] | — | Only documents carrying all these tags. |
| `limit` | integer 1–500 | 200 | Page size. |
| `offset` | integer ≥ 0 | 0 | Page start. |

Entries (folders and documents) are sorted by path. A folder's count is the number of documents below it that pass the tag filter. A missing folder other than `/` gives `NOT_FOUND`.

```
/ · 3 entries
/entities/ · 2 documents
/entities/requirement.md · v4 · 1.3 KB · 2026-10-11T08:12:45.120Z · [entity] · Requirement entity
/overview.md · v1 · 312 B · 2026-10-10T16:02:11.007Z · Map of the application
```

When the page is truncated, a last line says `next_offset=N (more entries: call again with offset=N)`.

### `memory_read`

> Read one memory document, whole or in part. Returns numbered lines, the document's metadata and its current version. Read only the documents relevant to the task; use section or view_range for large documents.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | required | Document path. |
| `section` | string | — | Exact heading line, e.g. `## UI pages`. Returns only that section, heading included. |
| `view_range` | [integer, integer] | — | `[start_line, end_line]`, 1-based, inclusive; `end_line` −1 means end of document. |
| `version` | integer ≥ 1 | — | Read a past version instead of the current one. |

`section` and `view_range` cannot be combined (`INVALID_ARGUMENT`). A range outside the document gives `INVALID_ARGUMENT`; an unknown version gives `NOT_FOUND`. A folder path gives `IS_FOLDER`; a path whose document was deleted gives `NOT_FOUND` saying so.

```
path: /entities/requirement.md
version: 4
description: Requirement entity
tags: entity
metadata: source=user-guide
updated: 2026-10-11T08:12:45.120Z
section: ## UI pages
lines 12-15 of 40

    12	## UI pages
    13	
    14	- Page URL: /req
    15	
```

- Header lines without a value (description, tags, metadata, section) are omitted. A past version shows `version: 2 (past version; current is 4)`; an empty document shows `(empty document)`.
- Output is limited to `MEMORY_MCP_MAX_OUTPUT_CHARS` (default 40000) characters. Beyond it, the last line is `[truncated after line X of N; read the rest with view_range [X+1, to]]`.

### `memory_search`

> Search the content of memory documents. Returns matches with path, line number, enclosing section heading, a short snippet and a score. Use it to check whether something is already recorded before adding it, or to find all passages matching a pattern.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `query` | string | required | Text or pattern; must not be empty. |
| `mode` | `keyword` \| `regex` \| `semantic` \| `hybrid` | `keyword` | `semantic` and `hybrid` give `UNSUPPORTED`. |
| `path_prefix` | string | `"/"` | Folder or single document to search. |
| `tags` | string[] | — | Only documents carrying all these tags. |
| `metadata` | map string→string | — | Only documents whose metadata has all these key/value pairs. |
| `limit` | integer 1–100 | 20 | Page size. |
| `offset` | integer ≥ 0 | 0 | Page start. |

- Matching is line by line. `keyword` is a case-insensitive literal and cannot contain a newline. `regex` is a JavaScript regular expression (flag `g`, case-sensitive unless written otherwise), at most 500 characters; an invalid one gives `INVALID_ARGUMENT`.
- One hit per matching line; `score` is the number of matches in the line. Hits are ordered by document path, then line.
- `section` is the innermost heading above the line, absent before the first heading. The snippet is the line, cut to 200 characters around the first match with `…`.

```
2 matches
/entities/requirement.md:14 · ## UI pages · 1
    - Page URL: /req
/overview.md:3 · (before first heading) · 2
    Requirements link to requirements
```

No hit gives `No match`. A truncated page ends with `next_offset=N (more matches: call again with offset=N)`.

### `memory_write`

> Create a document, or replace the whole content of an existing one. mode 'create' fails if the path exists; mode 'overwrite' fails if it does not. For small changes prefer memory_edit.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | required | Document path. |
| `file_text` | string | required | Whole content. |
| `mode` | `create` \| `overwrite` | `create` | |
| `description` | string | — | One line stating the document's scope. |
| `tags` | string[] | — | |
| `metadata` | map string→string | — | |
| `if_version` | integer ≥ 1 | — | Overwrite only: expected current version. |
| `change_note` | string | — | Kept in the history. |

- `create`: `ALREADY_EXISTS` if the path is a document, `IS_FOLDER` if it is a folder, `INVALID_PATH` if an ancestor is a document; `if_version` is rejected. Missing metadata fields are empty.
- `overwrite`: `NOT_FOUND` (or `IS_FOLDER`) if there is no document; `VERSION_CONFLICT` on `if_version` mismatch. Omitted `description`, `tags` and `metadata` keep their current values; given ones replace them entirely.

```
OK /entities/requirement.md version=1 (created)
OK /entities/requirement.md version=5
OK /entities/requirement.md version=5 (unchanged: nothing differed from the current version)
```

### `memory_edit`

> Apply one or more targeted edits to one document, in order, all or nothing. Use append with a section to add an entry under a heading; str_replace to change an exact passage; replace_section to rewrite one section; set_metadata to change description, tags or metadata.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | required | Existing document. |
| `operations` | operation[] (at least 1) | required | Applied in order; each sees the result of the previous ones. |
| `if_version` | integer ≥ 1 | — | Expected current version. |
| `change_note` | string | — | Kept in the history. |

Operations, selected by `op`:

| `op` | Fields | Effect |
| --- | --- | --- |
| `str_replace` | `old_str` (required, not empty), `new_str` (default `""`), `replace_all` (default false) | Replace `old_str`. It must occur exactly once unless `replace_all`. `NO_MATCH` if absent; `NOT_UNIQUE` (with line numbers) if repeated. Empty `new_str` deletes. |
| `append` | `text` (required), `section`, `create_section` (default false) | Add lines at the end of the document, or of the section after its last non-blank line. |
| `prepend` | same as `append` | Add lines at the start of the document, or of the section before its first non-blank body line. |
| `insert` | `insert_line` (integer ≥ 0, required), `insert_text` (required) | Insert after that line; 0 is the top. Beyond the last line: `INVALID_ARGUMENT`. |
| `replace_section` | `section` (required), `text` (required) | Replace the section's body, heading kept. A blank line is kept before the next heading. |
| `set_metadata` | `description`, `tags`, `metadata` (map string→string\|null) | Replace description and tags when given; merge `metadata`, a `null` value removing the key. |

For `append` and `prepend` with a `section` that does not exist: `SECTION_NOT_FOUND`, or, with `create_section`, the heading is added at the end of the document (after a blank line) followed by the text.

- With several operations, an error message is prefixed `Operation i (op) failed: …; no operation was applied`, and `details.operation` is `i`.
- The result content is checked against the size limit.
- On success the result lists the changed region of the new text (at most 40 lines shown):

```
OK /entities/requirement.md version=5
Changed lines:
    15	- Page URL: /req
```

When lines were only removed, the second line is `Lines removed after line N`. A metadata-only edit shows no changed lines.

### `memory_move`

> Rename or move a document or a folder. Fails if new_path exists unless overwrite is true.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `old_path` | string | required | Document or folder. |
| `new_path` | string | required | Target path. |
| `overwrite` | boolean | false | Replace existing target documents (they are soft-deleted). |
| `change_note` | string | — | Kept in the history. |

- A document moves to `new_path`. A folder moves with all the documents below it, each keeping its relative path.
- Errors: root or identical paths, folder into itself: `INVALID_ARGUMENT`; nothing at `old_path`: `NOT_FOUND`; existing target without `overwrite`: `ALREADY_EXISTS` (lists up to 10 conflicting paths); a folder onto a document: `ALREADY_EXISTS`; target is an existing folder or below a document: `IS_FOLDER` / `INVALID_PATH`.
- Each moved document gets a new version (`op` `move`) and keeps its id.

```
OK moved 2 documents
/entities/a.md → /model/a.md version=3
/entities/b.md → /model/b.md version=2
Replaced (kept in history): /model/b.md
```

### `memory_delete`

> Delete a document, or a folder when recursive is true. The root folder cannot be deleted.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | required | Document or folder. |
| `recursive` | boolean | false | Required to delete a folder. |
| `if_version` | integer ≥ 1 | — | Document only: expected current version. |
| `change_note` | string | — | Kept in the history. |

Errors: root: `INVALID_ARGUMENT`; folder without `recursive`: `IS_FOLDER`; `if_version` on a folder: `INVALID_ARGUMENT`; nothing at the path: `NOT_FOUND`. Deletion is soft and adds a version (`op` `delete`).

```
OK deleted 1 document (kept in history)
/entities/requirement.md version=6
```

### `memory_batch`

> Apply several write calls atomically: either all succeed or none is applied. Use it when documents must stay consistent with each other, e.g. a new document and the index entry that points to it.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `operations` | 1–50 items `{tool, arguments}` | required | `tool` is `memory_write`, `memory_edit`, `memory_move` or `memory_delete`; `arguments` are that tool's arguments. |
| `change_note` | string | — | Used for every operation that has no `change_note` of its own. |

- Operations run in order in one transaction and one changeset; each sees the effects of the previous ones.
- Each item's `arguments` are validated against its tool's schema. Any failure gives `Batch operation i (tool path) failed: …; no operation was applied` (or `…: invalid arguments: …`), with `details.operation` = `i`.

```
OK 2 operations applied atomically
1. memory_write: OK /entities/user.md version=1 (created)
2. memory_edit: OK /overview.md version=2
   Changed lines:
        5	- [User](entities/user.md)
```

### `memory_history`

> List past versions of a document, newest first, with date and change note. Read one with memory_read(version).

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | string | required | Current path of a live document. |
| `limit` | integer 1–100 | 20 | Number of versions. |

```
History of /entities/requirement.md: 5 versions, current 5 (newest first)
v5 · 2026-10-11T08:12:45.120Z · edit · agent:squashtm · 1.3 KB · "Add the UI page"
v4 · 2026-10-10T16:05:02.441Z · move to /entities/requirement.md · admin · 1.2 KB
```

`op` is `create`, `overwrite`, `edit`, `move`, `delete` or `restore`; moves and restores show the path they led to. When versions are left out, a last line says `(N older versions not shown; raise limit)`.

## REST API

### Conventions

- Base: `http://<host>:9501/api`. Store-scoped routes are under `/api/stores/{store}`.
- Document paths follow `/docs/` and `/history/` without their leading `/`, URL-encoded per segment: `/api/stores/squashtm/docs/entities/requirement.md`.
- Request and response bodies are JSON (`Content-Type: application/json`). A body that is not a JSON object gives 400. Body size is limited to twice `MEMORY_MAX_DOCUMENT_BYTES` plus 64 KiB.
- Numeric and boolean query values are given as text (`depth=3`, `recursive=true`); invalid values give 400.
- Results are the core's JSON objects; the MCP text above is a rendering of the same data.
- `ETag: "<version>"` is returned by reads of the current version and by writes. `If-Match: "<version>"` (also `7` or `W/"7"`; `*` means no check) maps to `if_version`; a malformed value gives 400.
- Every response carries `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. No CORS headers are sent: browsers can only call the API from the same origin.

Errors:

```json
{"error": {"code": "VERSION_CONFLICT", "message": "Version conflict on /x.md: expected 7, current 9; re-read and retry", "details": {"path": "/x.md", "expected": 7, "current": 9}}}
```

See [Error codes](#error-codes) for the status of each code. `401` responses also carry `WWW-Authenticate: Bearer`.

### Endpoint summary

| Method | Path | Token | Tool |
| --- | --- | --- | --- |
| GET | `/health` | none | |
| GET | `/api/openapi.json` | none | |
| GET | `/api/stores` | any | |
| GET | `/api/stores/{store}/list` | read | `memory_list` |
| GET | `/api/stores/{store}/docs/{path}` | read | `memory_read` |
| PUT | `/api/stores/{store}/docs/{path}` | write | `memory_write` |
| PATCH | `/api/stores/{store}/docs/{path}` | write | `memory_edit` |
| DELETE | `/api/stores/{store}/docs/{path}` | write | `memory_delete` |
| POST | `/api/stores/{store}/search` | read | `memory_search` |
| POST | `/api/stores/{store}/move` | write | `memory_move` |
| POST | `/api/stores/{store}/batch` | write | `memory_batch` |
| GET | `/api/stores/{store}/history/{path}` | read | `memory_history` |
| GET | `/api/stores/{store}/deleted` | read | |
| GET | `/api/stores/{store}/changes` | read | |
| GET | `/api/stores/{store}/documents/{id}` | read | |
| GET | `/api/stores/{store}/documents/{id}/history` | read | |
| GET | `/api/stores/{store}/documents/{id}/versions/{version}` | read | |
| POST | `/api/stores/{store}/restore` | admin | |

"read": any token reaching the store; "write": admin, or an agent token reaching the store (the viewer gets 403); an agent token on another store gets 403.

### `GET /api/stores`

The stores the token reaches (an agent token sees only its own), sorted by name. Stores appear once something has been written to them.

```json
{"stores": [{"name": "squashtm", "created_at": "2026-10-01T09:00:00.000Z", "documents": 42, "deleted_documents": 3}]}
```

### `GET /api/stores/{store}/list`

Query: `path`, `depth`, `tags` (comma-separated), `limit`, `offset`, as in `memory_list`.

```json
{"path": "/", "total": 2, "entries": [
  {"type": "folder", "path": "/entities", "documents": 2},
  {"type": "document", "id": 7, "path": "/overview.md", "version": 1, "size": 312, "updated_at": "…", "tags": [], "description": "Map of the application"}
], "next_offset": 2}
```

`next_offset` is present only when more entries remain.

### `GET /api/stores/{store}/docs/{path}`

Query: `section`; `from` and `to` (giving either sets `view_range` to `[from or 1, to or -1]`); `version`.

Returns the `memory_read` data with the selected lines joined into `content` (ending with `\n`, or `""` when no line) instead of a `lines` array. `ETag` is set unless a past version was read.

```json
{"path": "/entities/requirement.md", "version": 4, "current_version": 4, "is_past_version": false,
 "description": "Requirement entity", "tags": ["entity"], "metadata": {}, "updated_at": "…",
 "total_lines": 40, "from": 12, "to": 15, "section": "## UI pages", "content": "## UI pages\n\n- Page URL: /req\n\n"}
```

### `PUT /api/stores/{store}/docs/{path}`

`memory_write`. Body: `{file_text, description?, tags?, metadata?, change_note?}`; `path`, `mode` and `if_version` in the body are ignored.

- `If-None-Match: *`: create (409 if the document exists).
- Otherwise: overwrite (404 if it does not exist), with `If-Match` as `if_version`.
- Both headers together: 400.

Response: `201` when created, else `200`, with `ETag` and the write result:

```json
{"path": "/entities/requirement.md", "version": 1, "created": true}
```

`unchanged: true` is set when nothing changed.

### `PATCH /api/stores/{store}/docs/{path}`

`memory_edit`. Body: `{operations, if_version?, change_note?}`; an `If-Match` header takes precedence over `if_version`. Response with `ETag`:

```json
{"path": "/entities/requirement.md", "version": 5, "changed": {"from": 15, "to": 15, "lines": ["- Page URL: /req"]}}
```

`changed` is absent when the text did not change; `changed.to` is `from - 1` when lines were only removed.

### `DELETE /api/stores/{store}/docs/{path}`

`memory_delete`. Query: `recursive=true|false` (required to delete a folder), `change_note`. Header: `If-Match`.

```json
{"deleted": [{"path": "/entities/requirement.md", "version": 6}]}
```

### `POST /api/stores/{store}/search`

`memory_search`. Body: the tool's arguments.

```json
{"hits": [{"path": "/entities/requirement.md", "line": 14, "section": "## UI pages", "snippet": "- Page URL: /req", "score": 1}], "total": 1}
```

`section` is absent before the first heading; `next_offset` as in `list`.

### `POST /api/stores/{store}/move`

`memory_move`. Body: the tool's arguments.

```json
{"moved": [{"from": "/entities/a.md", "to": "/model/a.md", "version": 3}], "replaced": []}
```

### `POST /api/stores/{store}/batch`

`memory_batch`. Body: the tool's arguments. The result lists each operation's own result:

```json
{"results": [{"tool": "memory_write", "result": {"path": "/entities/user.md", "version": 1, "created": true}},
             {"tool": "memory_edit", "result": {"path": "/overview.md", "version": 2, "changed": {"from": 5, "to": 5, "lines": ["- [User](entities/user.md)"]}}}]}
```

### `GET /api/stores/{store}/history/{path}`

`memory_history`. Query: `limit` (1–100, default 20).

```json
{"path": "/entities/requirement.md", "doc_id": 3, "current_version": 5, "total": 5, "versions": [
  {"version": 5, "op": "edit", "path": "/entities/requirement.md", "created_at": "…", "change_note": "Add the UI page", "actor": "agent:squashtm", "size": 1290}
]}
```

### `GET /api/stores/{store}/deleted`

Deleted documents, most recently deleted first. `version` is the deletion version; `doc_id` is what `restore` takes.

```json
{"deleted": [{"doc_id": 9, "path": "/old.md", "version": 3, "size": 120, "deleted_at": "…", "deleted_by": "agent:squashtm"}]}
```

### `GET /api/stores/{store}/changes`

The change feed: one change per write call or batch, with the versions it created. Used by the web app to follow a store live.

Query: `since` (changes after this id, oldest first) or `before` (changes before this id, newest first; default: from the latest), not both (400); `limit` 1–500, default 100.

```json
{"latest": 57, "changes": [
  {"id": 57, "created_at": "…", "actor": "agent:squashtm", "change_note": "Add the UI page",
   "items": [{"doc_id": 3, "path": "/entities/requirement.md", "version": 5, "op": "edit"}]}
]}
```

`latest` is the store's last change id (0 when empty), the cursor to poll from. An item has `previous_path` when the version moved the document.

### `GET /api/stores/{store}/documents/{id}`

A document by id, live or deleted, without content:

```json
{"id": 3, "path": "/entities/requirement.md", "version": 5, "description": "…", "tags": ["entity"], "metadata": {},
 "size": 1290, "created_at": "…", "updated_at": "…", "deleted": false}
```

### `GET /api/stores/{store}/documents/{id}/history`

Same as `history/{path}` plus `deleted`, and works for deleted documents. Query: `limit` (1–500, default 100).

### `GET /api/stores/{store}/documents/{id}/versions/{version}`

One stored version with its content:

```json
{"doc_id": 3, "version": 4, "current_version": 5, "deleted": false, "op": "move", "path": "/entities/requirement.md",
 "content": "# Requirement\n…", "description": "…", "tags": [], "metadata": {}, "size": 1210,
 "created_at": "…", "actor": "admin", "change_note": null}
```

### `POST /api/stores/{store}/restore`

Admin only. Restores a deleted document as a new version (`op` `restore`) of the same document id.

| Field | Meaning |
| --- | --- |
| `doc_id` | Id of the deleted document (from `deleted`). |
| `path` | Or its last path; the most recently deleted document at that path is restored. |
| `version` | Version to restore; default: the last one before deletion. |
| `new_path` | Restore at this path instead of the last one. |
| `change_note` | Kept in the history. |

Errors: neither `doc_id` nor `path`: 400; no such deleted document or version: 404; target path taken: 409. Response with `ETag`:

```json
{"doc_id": 9, "path": "/old.md", "version": 4, "restored_from_version": 2}
```

## Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `INVALID_ARGUMENT` | 400 | Invalid or contradictory arguments, malformed header or body, invalid store name, schema validation failure (`Invalid arguments: …`) |
| `INVALID_PATH` | 400 | Path breaks the path rules, or lies below a document |
| `UNAUTHORIZED` | 401 | Missing or unknown bearer token (REST only; MCP returns a JSON-RPC error) |
| `FORBIDDEN` | 403 | Store not reachable by the token, write with the viewer token, admin route without the admin token |
| `NOT_FOUND` | 404 | Document, folder, version or deleted document not found |
| `ALREADY_EXISTS` | 409 | Target document exists (create, move, restore) |
| `IS_FOLDER` | 409 | A document was expected but the path is a folder |
| `VERSION_CONFLICT` | 412 | `if_version` / `If-Match` differs from the current version |
| `TOO_LARGE` | 413 | Document over `MEMORY_MAX_DOCUMENT_BYTES`, or request body over the body limit |
| `NO_MATCH` | 422 | `str_replace`: `old_str` not found |
| `NOT_UNIQUE` | 422 | `str_replace`: `old_str` found several times without `replace_all` |
| `SECTION_NOT_FOUND` | 422 | Heading not in the document |
| `SECTION_AMBIGUOUS` | 422 | Heading present several times |
| `UNSUPPORTED` | 501 | Search mode `semantic` or `hybrid` |
| `INTERNAL` | 500 | Unexpected failure (logged by the server) |

Over MCP, the same failures come back as `Error: <message>` with `isError: true`; the code itself is only in REST responses.
