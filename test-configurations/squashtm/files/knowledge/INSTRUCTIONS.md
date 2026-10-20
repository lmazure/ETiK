# SUT Knowledge Base — Format and Rules

The knowledge base is a durable, cross-Session memory about the SUT. It lives in the **memory server**, in the store `squashtm`, and is reached **only** through the `memory_*` tools (`memory_list`, `memory_read`, `memory_search`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_batch`, `memory_history`). It is the set of Markdown **documents** under `/knowledge/` (e.g. `/knowledge/requirement.md`). The same store also holds the Sessions, under `/sessions/` (see the system prompt): they are never part of the knowledge base.

The memory server keeps every version of every document and records, for each change, its `change_note`, which starts with the Session that made it (see "Update protocol"). Nothing is ever lost: an overwritten passage or a deleted document can always be found in the history. People watch the knowledge base live in the memory server's web app.

Never keep SUT knowledge in local files, and never fall back to local files: if the `memory_*` tools are missing or report that the server is unreachable, tell the user and stop.

## What this is — and is not

- **Is:** distilled, deduplicated, reusable truth about the SUT — how features are reached in the UI, stable business rules, documentation pages, private backend API calls the web app emits, public REST API endpoints and how they behave.
- **Is not:** a Session log. A Session's log (`/sessions/NNN/log/log.md`) is a replay trace of one run. Knowledge documents are the curated facts extracted from many runs.
- **Never** store under `/knowledge/`: Session-specific Charter/checklist content or bug reports (they are transient and may be fixed; they live under `/sessions/`).

## How loading works — list first, then only what's relevant

There is no index document: every document carries a one-line `description` stating its scope, and `memory_list(path="/knowledge/", depth=5)` returns path, description and tags of every knowledge document. Call it at the start of each Session; it is the index.

Then read **only** the documents relevant to the current charter/test with `memory_read`; for a large document, read only the section you need (`section="## UI pages"`). When you do not know which document holds something, use `memory_search` with `path_prefix="/knowledge/"`: the default `keyword` mode for exact text (e.g. a page URL, an endpoint, an entity name), `mode="hybrid"` for a question or a description (e.g. "can a requirement linked to a test case be deleted?"); a hybrid hit gives the section to read with `memory_read(section=…)`. Never read every document.

## Documents

- `/knowledge/<entity>.md` — one document per business entity (lowercase, hyphenated name, e.g. `/knowledge/test-case.md`), tag `entity`, following the entity document schema below.
- `/knowledge/business-rules.md` — cross-cutting rules that span more than one entity, tag `cross-cutting`. Create it the first time such a rule is captured, with this content:

  ```markdown
  # Cross-cutting Business Rules

  Rules that span more than one entity. Entity-specific rules live in that entity's document under `/knowledge/`.

  ## Business rules
  ```

- Every document is created with a `description`: one line stating its scope (e.g. `Requirement entity: docs, UI pages, private API, REST API, rules`). Keep it accurate when the content changes (`memory_edit` with `set_metadata`).

## Source tags

Every fact carries a tag so the memory can be trusted and curated:

- `documented` — from a source the user provided (User Documentation, User Story, Bug Report…). Note the source name.
- `observed` — seen first-hand during testing (UI behavior, network traffic, REST API responses).
- `assumed` — an unverified inference. Must be re-checked before being relied upon.

Always record the **Session** and **date**, plus — for `documented` — the source name.
Format: `<tag>, session_NNN, YYYY-MM-DD[, <source name>]` (e.g. `observed, session_042, 2026-10-19`), where `session_NNN` is the name of the current Session (its folder is `/sessions/NNN/`).
The Session lets you trace a fact back to its log `/sessions/NNN/log/log.md` for the full context; `memory_history` also shows which Session changed what, through the change notes.

## Entity document schema

Use these exact headings so you always know where to read and where to write. Each section is a **growing list of entries** — there can be several docs, several UI pages, and several private or public API endpoints, and new ones may be discovered in different Sessions. **Append** a new entry rather than overwriting; never collapse distinct items into one. Omit a section only while it has no entries yet.

```markdown
# Entity: <Name>

## Docs
<!-- one entry per doc page -->
- URL: <doc page url>
  - Summary: <2–4 sentences>
  - Source: documented, session_NNN, <date>, <source name>
- URL: <another doc page url>
  - Summary: <2–4 sentences>
  - Source: documented, session_NNN, <date>, <source name>

## UI pages
<!-- one entry per page where this entity is managed -->
- Page URL: <url>
  - How to reach it: <nav path / menu / selectors / required auth>
  - Key interactions: create / read / update / delete — concrete steps
  - Source: observed, session_NNN, <date>
- Page URL: <another url>
  - How to reach it: ...
  - Key interactions: ...
  - Source: observed, session_NNN, <date>

## Private backend API (observed via UI network traffic)
<!-- one entry per endpoint -->
- POST /backend/... — Create
  - Payload: {...}
  - Response: <status> {...}
  - Source: observed, session_NNN, <date>
- GET /backend/.../{id} — Read
  - Response: <status> {...}
  - Source: observed, session_NNN, <date>

## Public REST API
<!-- one entry per endpoint, under /api/rest/latest/ -->
- POST /api/rest/latest/... — Create
  - Payload: {...}
  - Response: <status> {...}
  - Differences from the UI: <rules or validation that differ, or none seen>
  - Source: documented|observed, session_NNN, <date>[, <source name>]
- GET /api/rest/latest/.../{id} — Read
  - Response: <status> {...}
  - Source: documented|observed, session_NNN, <date>[, <source name>]

## Business rules
- <rule>  (source: observed|documented, session_NNN, <date>)

## Open questions / unverified
- <thing guessed but not yet confirmed>
```

Cross-cutting rules go in `/knowledge/business-rules.md` using the same `## Business rules` / source-tag conventions.

## Update protocol (two phases)

Give every change a short `change_note` that starts with the current Session and says why the change is made (e.g. `session_042: Requirement creation page observed`), like a commit message.

1. **Capture — continuously, append-only.** The moment a durable fact is confirmed (from a provided source in Stage 1, or during testing in Stage 3/4), record it with a source tag, Session, and date. Capture is cheap and resists Session crashes.
   - First check that it is not already recorded: `memory_search` with `path_prefix="/knowledge/"` for the page URL or the endpoint path (keyword), and, for a business rule or a behaviour, with `mode="hybrid"` and the fact stated in a sentence: it also finds it written in other words.
   - Add an entry to an existing document with `memory_edit`, operation `{"op": "append", "section": "## UI pages", "create_section": true, "text": "- Page URL: …"}` (no need to read the document first).
   - Create a new entity document with `memory_write` (mode `create`, a `description`, tags `["entity"]`), with the schema headings that already have entries.
2. **Consolidate — periodically (end of Session, Stage 5).**
   - Merge only true duplicates (the same doc/page/endpoint recorded twice) while keeping genuinely distinct entries separate.
   - Resolve contradictions (keep newest, note Session and date).
   - Promote confirmed `assumed` facts to `observed`: find them with `memory_search(query="assumed,", path_prefix="/knowledge/")`, then `memory_edit` with `str_replace` on the exact entry.
   - Prune dead ends and anything that turned out wrong: `memory_edit` with `str_replace` and an empty `new_str`, or `memory_delete` for a whole document. The history keeps the removed text.
   - To rewrite a section or a document, `memory_read` it first (the result gives its version), then `memory_edit` with `replace_section` or `memory_write` with mode `overwrite`, passing `if_version`. On a `VERSION_CONFLICT` error, read it again and redo the change on the new content.
   - A change spanning several documents (e.g. moving a rule from an entity document to `/knowledge/business-rules.md`) goes in one `memory_batch`, so it is applied entirely or not at all. Rename a document with `memory_move`.
   - Finally, check with `memory_list(path="/knowledge/", depth=5)` that every document's description still matches its content and that each document has the right tags; fix them with `set_metadata`.
