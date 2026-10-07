# Memory server

A versioned document memory for LLM agents, as specified in [Memory Toolsets for LLM Agents — Interface Study](../Memory%20Toolsets%20for%20LLM%20Agents%20—%20Interface%20Study.md).
One container exposes the same core through:

- `/mcp`: MCP Streamable HTTP (stateless) with the nine `memory_*` tools, for agents;
- `/api`: a JSON REST API (OpenAPI at `/api/openapi.json`), for people and other clients;
- `/health`: liveness, without authentication.

Not implemented yet: semantic / hybrid search (rejected with an explicit error), the web app.

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

## Storage model

Nothing is ever overwritten or deleted:

- `versions` holds a full snapshot (content, description, tags, metadata, path) for every version of every document. It is append-only, enforced by SQLite triggers.
- `changesets` records, for each tool call or batch, the actor (token), the session (`X-Memory-Session` header) and the change note.
- `documents` is the only mutable table: it points to the head version of each document and keeps a stable id across moves.

A version number is per document and grows by one on every change, including moves, deletions and restores.
Deleting is a soft delete: the document leaves listings and its path is free again, but all its versions stay; the admin can restore it.

## Access

Store and session are chosen by the harness through headers, never by tool arguments:

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

## Develop

Requires Node 24.

```bash
npm install
npm test           # unit tests (core) + REST (fastify.inject) + MCP (SDK client over HTTP)
npm run typecheck
MEMORY_ADMIN_TOKEN=dev MEMORY_DB_PATH=./data/memory.db npm run dev
```

Layout: `src/schemas.ts` holds the tool schemas (single source for MCP, REST validation and OpenAPI); `src/core/` holds every rule (`memory-core.ts`) on top of SQLite (`db.ts`, `repository.ts`); `src/api/` and `src/mcp/` only translate and format.
