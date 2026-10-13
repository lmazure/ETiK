# SUT Knowledge Base — Format and Rules

The knowledge base is a durable, cross-Session memory about the SUT. It lives in the **memory server**, in the store `squashtm`, and is reached **only** through the `memory_*` tools (`memory_list`, `memory_read`, `memory_search`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_batch`, `memory_history`). It is a set of Markdown **documents** addressed by path (e.g. `/entities/requirement.md`).

The memory server keeps every version of every document and records, for each change, its `change_note`, which starts with the Session that made it (see "Update protocol"). Nothing is ever lost: an overwritten passage or a deleted document can always be found in the history. People watch the knowledge base live in the memory server's web app.

Never keep SUT knowledge in local files, and never fall back to local files: if the `memory_*` tools are missing or report that the server is unreachable, tell the user and stop.

## What this is — and is not

- **Is:** distilled, deduplicated, reusable truth about the SUT — how features are reached in the UI, stable business rules, documentation pages, private backend API calls the web app emits.
- **Is not:** a Session log. A Session's `log.md` is a replay trace of one run. Knowledge documents are the curated facts extracted from many runs.
- **Never** store here: Session-specific Charter/checklist content or bug reports (they are transient and may be fixed).

## How loading works — list first, then only what's relevant

There is no index document: every document carries a one-line `description` stating its scope, and `memory_list(path="/", depth=5)` returns path, description and tags of every document. Call it at the start of each Session; it is the index.

Then read **only** the documents relevant to the current charter/test with `memory_read`; for a large document, read only the section you need (`section="## UI pages"`). When you do not know which document holds something, use `memory_search` (e.g. a page URL, an endpoint, an entity name). Never read every document.

## Documents

- `/entities/<entity>.md` — one document per business entity (lowercase, hyphenated name, e.g. `/entities/test-case.md`), tag `entity`, following the entity document schema below.
- `/business-rules.md` — cross-cutting rules that span more than one entity, tag `cross-cutting`. Create it the first time such a rule is captured, with this content:

  ```markdown
  # Cross-cutting Business Rules

  Rules that span more than one entity. Entity-specific rules live in that entity's document under `/entities/`.

  ## Business rules
  ```

- Every document is created with a `description`: one line stating its scope (e.g. `Requirement entity: docs, UI pages, private API, rules`). Keep it accurate when the content changes (`memory_edit` with `set_metadata`).

## Source tags

Every fact carries a tag so the memory can be trusted and curated:

- `documented` — from a source the user provided (User Documentation, User Story, Bug Report…). Note the source name.
- `observed` — seen first-hand during testing (UI behavior, network traffic).
- `assumed` — an unverified inference. Must be re-checked before being relied upon.

Always record the **Session** and **date**, plus — for `documented` — the source name.
Format: `<tag>, session_##, YYYY-MM-DD[, <source name>]` (e.g. `observed, session_03, 2026-06-24`), where `session_##` is the name of the current Session (its directory).
The Session lets you trace a fact back to its `session_##/log.md` for the full context; `memory_history` also shows which Session changed what, through the change notes.

## Entity document schema

Use these exact headings so you always know where to read and where to write. Each section is a **growing list of entries** — there can be several docs, several UI pages, and several API endpoints, and new ones may be discovered in different Sessions. **Append** a new entry rather than overwriting; never collapse distinct items into one. Omit a section only while it has no entries yet.

```markdown
# Entity: <Name>

## Docs
<!-- one entry per doc page -->
- URL: <doc page url>
  - Summary: <2–4 sentences>
  - Source: documented, session_##, <date>, <source name>
- URL: <another doc page url>
  - Summary: <2–4 sentences>
  - Source: documented, session_##, <date>, <source name>

## UI pages
<!-- one entry per page where this entity is managed -->
- Page URL: <url>
  - How to reach it: <nav path / menu / selectors / required auth>
  - Key interactions: create / read / update / delete — concrete steps
  - Source: observed, session_##, <date>
- Page URL: <another url>
  - How to reach it: ...
  - Key interactions: ...
  - Source: observed, session_##, <date>

## Private backend API (observed via UI network traffic)
<!-- one entry per endpoint -->
- POST /backend/... — Create
  - Payload: {...}
  - Response: <status> {...}
  - Source: observed, session_##, <date>
- GET /backend/.../{id} — Read
  - Response: <status> {...}
  - Source: observed, session_##, <date>

## Business rules
- <rule>  (source: observed|documented, session_##, <date>)

## Open questions / unverified
- <thing guessed but not yet confirmed>
```

Cross-cutting rules go in `/business-rules.md` using the same `## Business rules` / source-tag conventions.

## Update protocol (two phases)

Give every change a short `change_note` that starts with the current Session and says why the change is made (e.g. `session_03: Requirement creation page observed`), like a commit message.

1. **Capture — continuously, append-only.** The moment a durable fact is confirmed (from a provided source in Stage 1, or during testing in Stage 3/4), record it with a source tag, Session, and date. Capture is cheap and resists Session crashes.
   - First check that it is not already recorded: `memory_search` for the page URL, the endpoint path, or the rule's key words.
   - Add an entry to an existing document with `memory_edit`, operation `{"op": "append", "section": "## UI pages", "create_section": true, "text": "- Page URL: …"}` (no need to read the document first).
   - Create a new entity document with `memory_write` (mode `create`, a `description`, tags `["entity"]`), with the schema headings that already have entries.
2. **Consolidate — periodically (end of Session, Stage 5).**
   - Merge only true duplicates (the same doc/page/endpoint recorded twice) while keeping genuinely distinct entries separate.
   - Resolve contradictions (keep newest, note Session and date).
   - Promote confirmed `assumed` facts to `observed`: find them with `memory_search(query="assumed,")`, then `memory_edit` with `str_replace` on the exact entry.
   - Prune dead ends and anything that turned out wrong: `memory_edit` with `str_replace` and an empty `new_str`, or `memory_delete` for a whole document. The history keeps the removed text.
   - To rewrite a section or a document, `memory_read` it first (the result gives its version), then `memory_edit` with `replace_section` or `memory_write` with mode `overwrite`, passing `if_version`. On a `VERSION_CONFLICT` error, read it again and redo the change on the new content.
   - A change spanning several documents (e.g. moving a rule from an entity document to `/business-rules.md`) goes in one `memory_batch`, so it is applied entirely or not at all. Rename a document with `memory_move`.
   - Finally, check with `memory_list` that every document's description still matches its content and that each document has the right tags; fix them with `set_metadata`.
