# Memory server

A versioned document memory for LLM agents.
One container exposes the same core through:

- `/mcp`: MCP Streamable HTTP (stateless) with nine `memory_*` tools, for agents;
- `/api`: a JSON REST API (OpenAPI at `/api/openapi.json`), for people and other clients;
- `/health`: liveness, without authentication.

## Design choices

| Choice | Reason |
| --- | --- |
| The unit of memory is a **document** (Markdown text plus metadata), addressed by a **path** | The agent instructions define the structure inside documents (sections, entries); a record or graph model would hard-code one structure into the tools. A path lets the model plan a hierarchy and guess where things are. |
| **One tool per verb** | Simpler per-tool schemas and clearer errors; a harness can withhold the write tools for a read-only session. |
| Parameter names reuse those of **Anthropic's `memory` tool** (`path`, `old_str`, `new_str`, `insert_line`, `view_range`, `file_text`…) | Models have seen this vocabulary heavily in training, which reduces malformed calls. |
| Partial edits by **unique string replace** and **heading anchor**, not by line number | Line numbers go stale between calls; "append to `## UI pages`" is one call. |
| **Literal writes**: the store keeps exactly what the model sends | The instructions, not the store, decide what a fact looks like (unlike stores where an LLM extracts and rewrites facts). |
| Each document carries a one-line **description** returned by `memory_list` | A model-maintained index file drifts; descriptions make the index derivable. An index document can still be kept if the instructions want one. |
| **Keyword search** first | It answers "where is endpoint X already recorded" exactly. Semantic search is a later addition. |
| **Optimistic concurrency**, **atomic batch**, **history** | Several sessions or agents may write the same store; "create the file and its index row in the same step"; trace a fact back, undo a bad consolidation. |
| **Store and session fixed by the harness**, never by tool arguments | Keeps the model from writing to the wrong project; paths stay short. |
| No notion of entity, source tag or session in the tools | That is policy and stays in the agent instructions, which can change without touching the tools. |

## Concepts

- **Store**: an independent set of documents, e.g. one per system under test. Chosen by the `X-Memory-Store` header.
- **Path**: absolute, `/`-separated, case-sensitive, e.g. `/entities/requirement.md`. No empty, `.` or `..` segment. Folders exist implicitly; a path cannot be both a document and a folder.
- **Document**: UTF-8 text (Markdown expected, not enforced; line endings normalized to `\n`) plus optional metadata: `description` (one line), `tags` (strings), `metadata` (free string-to-string map). Metadata is never mixed into the text.
- **Version**: an integer per document, starting at 1 and growing by one on every change (content, metadata, move, delete, restore). Every read and write returns it. Writes accept `if_version`: on mismatch the call fails and changes nothing. A call that changes nothing creates no version.
- **Section**: an exact Markdown heading line, e.g. `## UI pages`. It runs until the next heading of the same or higher level; headings inside fenced code blocks are ignored. A heading occurring twice makes the call fail with the line numbers.
- **Change note**: every write accepts an optional `change_note` (like a commit message), kept in the history together with the session and the token that made the change.
- **Errors**: actionable messages saying what failed, where, and what to do. Nothing is ever partially applied.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_list` | List folders and documents under a path, to a depth, with version, size, date, tags and description, without reading content. Filter by tags; paginated. |
| `memory_read` | Read a document whole, one `section`, or a `view_range`; returns numbered lines, metadata and version. `version` reads a past version. |
| `memory_search` | Search document content: `keyword` (case-insensitive literal) or `regex`; filters on `path_prefix` (a folder or a document), tags and metadata. Returns path, line, enclosing section, snippet, score. `semantic` and `hybrid` are rejected for now. |
| `memory_write` | `create` a document (fails if it exists) or `overwrite` it (fails if it does not), with optional metadata. |
| `memory_edit` | Apply operations to one document, in order, all or nothing: `str_replace` (unique unless `replace_all`), `append` / `prepend` (whole document or a `section`, optionally `create_section`), `insert` (after a line), `replace_section`, `set_metadata` (merge; `null` removes a key). |
| `memory_move` | Rename or move a document or a folder; `overwrite` to replace an existing target. |
| `memory_delete` | Delete a document, or a folder with `recursive`. The root cannot be deleted. Deletion is soft (see below). |
| `memory_batch` | Apply up to 50 write / edit / move / delete calls atomically, in one change. |
| `memory_history` | List the versions of a document, newest first, with date, operation, session, author and change note. |

The exact definitions (descriptions, parameters, defaults, JSON schemas) are defined once in [`src/schemas.ts`](src/schemas.ts) and published by the running server, so they are never copied here. To get them:

```bash
# Raw tools/list call (the server is stateless: no initialize needed)
curl -s http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" -H "X-Memory-Store: squashtm" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools'

# MCP Inspector, command line (needs Node >= 22.19; @latest avoids an older cached version without --header)
npx @modelcontextprotocol/inspector@latest --cli http://localhost:8080/mcp --transport http \
  --header "Authorization: Bearer $TOKEN" --header "X-Memory-Store: squashtm" \
  --method tools/list

# Same, with an older local Node: run the Inspector in a container
docker run --rm --network host node:24-bookworm-slim \
  npx -y @modelcontextprotocol/inspector@latest --cli http://localhost:8080/mcp --transport http \
  --header "Authorization: Bearer $TOKEN" --header "X-Memory-Store: squashtm" \
  --method tools/list

# REST equivalent of the same schemas
curl -s http://localhost:8080/api/openapi.json | jq
```

To try the tools interactively, run `npx @modelcontextprotocol/inspector@latest`, open the URL it prints, select the Streamable HTTP transport with URL `http://localhost:8080/mcp`, add the `Authorization` and `X-Memory-Store` headers, connect, then list and call the tools.

### Results

| Tool | Result |
| --- | --- |
| `memory_list` | One line per entry: `path · version · size · updated · [tags] · description`; folders as `path/ · N documents`; a `next_offset` when truncated |
| `memory_read` | Header (path, version, metadata, line range), then `line_number<TAB>text`; a truncation notice telling which `view_range` to read next |
| `memory_search` | One block per hit: `path:line · section · score`, then the snippet |
| Write tools | `OK path version=N`; for edits, the changed lines with their numbers so the model can check the result |

Typical errors: `old_str found 2 times (lines 12, 40); make it unique or set replace_all` · `Section '## UI pages' not found in /x.md; existing sections: ## Docs, ## Business rules` · `Version conflict on /x.md: expected 7, current 9; re-read and retry` · `Path exists: /x.md (version 3); use mode 'overwrite'`.

## Storage model

Nothing is ever overwritten or deleted:

- `versions` holds a full snapshot (content, description, tags, metadata, path) for every version of every document. It is append-only, enforced by SQLite triggers.
- `changesets` records, for each tool call or batch, the actor (token), the session (`X-Memory-Session` header) and the change note.
- `documents` is the only mutable table: it points to the head version of each document and keeps a stable id across moves.

Deleting is a soft delete: the document leaves listings and its path is free again, but all its versions stay; the admin can restore it.

## Security model

The agent may run with full shell access (e.g. Claude Code in YOLO mode in a dev container). It can then read its own MCP configuration and call `/api` directly, so the design must hold even when MCP is bypassed:

- Every rule is enforced in the core; the MCP and REST layers only translate and format.
- An agent token reaches only its own store and no admin operation (list stores, list deleted documents, restore). People and the future web app use other credentials.
- Store and session come from headers set in the harness configuration, never from tool arguments; the core writes them into the history.
- History and soft delete are the undo for a wrong deletion. Volume backups stay out of the agent's reach.
- The memory host and port must be allowed in the dev container's firewall allowlist.

## Run

```bash
cp .env.example .env   # then set real tokens
docker compose up -d --build
curl http://localhost:8080/health
```

Data is kept in the `memory-data` volume (`/data/memory.db`, SQLite).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MEMORY_ADMIN_TOKEN` | — | Token reaching every store and the admin routes |
| `MEMORY_AGENT_TOKENS` | — | `store=token,store=token`; an agent token reaches only its store(s) |
| `MEMORY_DB_PATH` | `/data/memory.db` in the image | SQLite file |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listening address |
| `MEMORY_MAX_DOCUMENT_BYTES` | `1048576` | Maximum size of one document |
| `MEMORY_MCP_MAX_OUTPUT_CHARS` | `40000` | MCP read results beyond this are truncated with a notice |
| `LOG_LEVEL` | `info` | Fastify log level |

At least one token must be set, otherwise the server refuses to start.

## Access

Registration in Claude Code, with store and session set by the harness:

```bash
claude mcp add --transport http memory http://memory:8080/mcp \
  --header "Authorization: Bearer $MEMORY_AGENT_TOKEN" \
  --header "X-Memory-Store: squashtm" \
  --header "X-Memory-Session: session_07"
```

`X-Memory-Store` can be omitted when the token reaches a single store.

REST examples (`{store}` in the URL; document paths follow `/docs/`):

```bash
H=(-H "Authorization: Bearer $TOKEN" -H "X-Memory-Session: session_07" -H "Content-Type: application/json")
B=http://localhost:8080/api/stores/squashtm

# create (If-None-Match: *), read (ETag), edit with optimistic concurrency (If-Match)
curl "${H[@]}" -X PUT -H 'If-None-Match: *' $B/docs/entities/requirement.md \
  -d '{"file_text":"# Requirement\n\n## UI pages\n","description":"Requirement entity"}'
curl "${H[@]}" "$B/docs/entities/requirement.md?section=%23%23%20UI%20pages"
curl "${H[@]}" -X PATCH -H 'If-Match: "1"' $B/docs/entities/requirement.md \
  -d '{"operations":[{"op":"append","section":"## UI pages","text":"- Page URL: /req"}]}'

curl "${H[@]}" "$B/list?path=/&depth=2"
curl "${H[@]}" -X POST $B/search -d '{"query":"assumed"}'
curl "${H[@]}" $B/history/entities/requirement.md
```

| Tool | REST |
| --- | --- |
| `memory_list` | `GET /api/stores/{store}/list?path=&depth=&tags=a,b&limit=&offset=` |
| `memory_read` | `GET /api/stores/{store}/docs/{path}?section=&from=&to=&version=` |
| `memory_search` | `POST /api/stores/{store}/search` |
| `memory_write` | `PUT /api/stores/{store}/docs/{path}` (`If-None-Match: *` to create, otherwise overwrite; `If-Match` for the version) |
| `memory_edit` | `PATCH /api/stores/{store}/docs/{path}` |
| `memory_move` | `POST /api/stores/{store}/move` |
| `memory_delete` | `DELETE /api/stores/{store}/docs/{path}?recursive=` |
| `memory_batch` | `POST /api/stores/{store}/batch` |
| `memory_history` | `GET /api/stores/{store}/history/{path}` |
| (admin) | `GET /api/stores`, `GET /api/stores/{store}/deleted`, `POST /api/stores/{store}/restore` |

Errors are `{"error": {"code", "message", "details"}}`: 400 invalid arguments or path, 401 missing or unknown token, 403 forbidden store or admin route, 404 not found, 409 already exists or is a folder, 412 version conflict, 413 too large, 422 edit failure (`old_str` absent or not unique, section missing or duplicated), 501 unsupported search mode.

## Mapping the current knowledge-base rules onto the tools

The test environment currently keeps its knowledge as files in `test_environment/knowledge/`. Each of its rules maps onto one or two calls; only the wording of the instructions changes ("file" becomes "memory document").

| Current rule | Calls |
| --- | --- |
| Load `index.md` every session | `memory_read(path="/index.md")`, or drop the file and call `memory_list(path="/", depth=2)`, which returns each document's description |
| Open only the relevant files | `memory_read(path, section?)`; `memory_search(query, path_prefix="/entities")` when the name is unknown |
| New entity file and its index row in the same step | `memory_batch([memory_write(create "/entities/x.md"), memory_edit("/index.md", append)])` |
| Capture: append an entry to `## UI pages` | `memory_edit(path, [{op:"append", section:"## UI pages", create_section:true, text:"- Page URL: …"}])` |
| Check before capturing (no duplicate page or endpoint) | `memory_search(query="/backend/requirements")` |
| Source tags `observed, session_03, 2026-06-24` | Kept in the text, as today; optionally also `set_metadata`, and the session is recorded automatically from the header |
| Consolidate: list all `assumed` facts | `memory_search(query="assumed,")` |
| Promote `assumed` → `observed` | `memory_edit` with `str_replace` on the exact entry |
| Merge true duplicates, rewrite a section | `memory_read` (gets the version) → `memory_edit(replace_section, if_version)` or `memory_write(overwrite, if_version)` |
| Prune dead ends | `memory_edit(str_replace, new_str="")` or `memory_delete` |
| Verify `index.md` matches the folder | `memory_list` compared with `memory_read("/index.md")` |
| Trace a fact back to its session | `memory_history(path)` shows which session changed what |

The instructions keep everything that is policy: the schema of an entity document, the tag format, when to capture and when to consolidate.

## Not done yet

- Wiring into the test dev container: MCP registration, firewall allowlist, rewriting `CLAUDE.md` and `knowledge/INSTRUCTIONS.md` to use the tools.
- Semantic and hybrid search (embeddings).
- Web app to browse, search and compare versions.
- A CLI on `/api` for harnesses without MCP (e.g. Pi), with no change to the core or the tool definitions.
- If a single tool is preferred over nine: one `memory` tool with a `command` enum, keeping Anthropic's command names (`view`, `create`, `str_replace`, `insert`, `delete`, `rename`) and adding `search`, `append`, `replace_section`, `set_metadata`, `batch`, `history`.

## Develop

Requires Node 24.

```bash
npm install
npm test           # unit tests (core) + REST (fastify.inject) + MCP (SDK client over HTTP)
npm run typecheck
MEMORY_ADMIN_TOKEN=dev MEMORY_DB_PATH=./data/memory.db npm run dev
```

Layout: `src/schemas.ts` holds the tool schemas (single source for MCP, REST validation and OpenAPI); `src/core/` holds every rule (`memory-core.ts`) on top of SQLite (`db.ts`, `repository.ts`); `src/api/` and `src/mcp/` only translate and format.
