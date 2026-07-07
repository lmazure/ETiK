# SUT Knowledge Base — Format and Rules

This directory is a durable, cross-Session memory about the SUT. It is intentionally **tool-neutral**: these rules describe plain Markdown files on disk, so any tool can load and update them.

## What this is — and is not

- **Is:** distilled, deduplicated, reusable truth about the SUT — how features are reached in the UI, stable business rules, documentation pages, private backend API calls the web app emits.
- **Is not:** a Session log. A Session's `log.md` is a replay trace of one run. Knowledge files are the curated facts extracted from many runs.
- **Never** store here: Session-specific Charter/checklist content or bug reports (they are transient and may be fixed).

## How loading works — index first, then only what's relevant

`index.md` is the **only** file loaded every Session. It is a compact table of pointers — one line per file, never facts. The model reads `index.md`, then opens **only** the files relevant to the current charter/test. Never bulk-read this folder.

When a new knowledge file is created, its row must be added to `index.md` in the same step. When facts are only added to an existing file, the index is left alone unless that file's one-line scope changed.

## Source tags

Every fact carries a tag so the memory can be trusted and curated:

- `documented` — from a source the user provided (User Documentation, User Story, Bug Report…). Note the source name.
- `observed` — seen first-hand during testing (UI behavior, network traffic).
- `assumed` — an unverified inference. Must be re-checked before being relied upon.

Always record the **Session** and **date**, plus — for `documented` — the source name.
Format: `<tag>, session_##, YYYY-MM-DD[, <source name>]` (e.g. `observed, session_03, 2026-06-24`).
The Session lets you trace a fact back to its `session_##/log.md` for the full context.

## Entity file schema

One file per business entity under `entities/`. Use these exact headings so the model always knows where to read and where to write. Each section is a **growing list of entries** — there can be several docs, several UI pages, and several API endpoints, and new ones may be discovered in different Sessions. **Append** a new entry rather than overwriting; never collapse distinct items into one. Omit a section only while it has no entries yet.

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

Cross-cutting rules that span entities go in `business-rules.md` using the same `## Business rules` / source-tag conventions.

## Update protocol (two phases)

1. **Capture — continuously, append-only.** The moment a durable fact is confirmed (from a provided source in Stage 1, or during testing in Stage 3/4), append it to the relevant file with a source tag, Session, and date. Create files and update `index.md` as needed. Capture is cheap and resists Session crashes.
2. **Consolidate — periodically (end of Session, Stage 5).** Merge only true duplicates (the same doc/page/endpoint recorded twice) while keeping genuinely distinct entries separate; resolve contradictions (keep newest, note Session and date); promote confirmed `assumed` facts to `observed`; prune dead ends; and verify `index.md` matches the folder (one row per file, no orphans, accurate scope lines).
