# Marketing Site Knowledge Base — Format and Rules

The knowledge base is a durable, cross-Session memory about the **site under review** (the "Site"). It lives in the **memory server**, in the store `squashtmsite`, and is reached **only** through the `memory_*` tools (`memory_list`, `memory_read`, `memory_search`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_batch`, `memory_history`). It is the set of Markdown **documents** under `/knowledge/` (e.g. `/knowledge/pages/pricing.md`). The same store also holds the Sessions, under `/sessions/` (see the system prompt): they are never part of the knowledge base.

The memory server keeps every version of every document and records, for each change, its `change_note`, which starts with the Session that made it (see "Update protocol"). Nothing is ever lost: an overwritten passage or a deleted document can always be found in the history. People watch the knowledge base live in the memory server's web app.

Never keep Site knowledge in local files, and never fall back to local files: if the `memory_*` tools are missing or report that the server is unreachable, tell the user and stop.

## What this is — and is not

- **Is:** distilled, deduplicated, reusable facts about the Site: its pages and how to reach them, its positioning and messaging, calls to action and conversion paths, forms and integrations, tracking setup, SEO metadata, and the brand, tone and compliance rules it is meant to follow.
- **Is not:** a Session log or a findings list. A Session's log (`/sessions/NNN/log/log.md`) is a replay trace of one review run. Knowledge documents are the curated facts extracted from many runs.
- **Never** store under `/knowledge/`: Session-specific review findings, scores, recommendations, or draft report text (they are transient and the Site may change). Findings belong in the Session's issue reports (`/sessions/NNN/issues/MMM/issue.md`).

## How loading works — list first, then only what's relevant

There is no index document: every document carries a one-line `description` stating its scope, and `memory_list(path="/knowledge/", depth=5)` returns path, description and tags of every knowledge document. Call it at the start of each Session; it is the index.

Then read **only** the documents relevant to the current review scope with `memory_read`; for a large document, read only the section you need (`section="## Calls to action"`). When you do not know which document holds something, use `memory_search` with `path_prefix="/knowledge/"` (e.g. a page URL, a headline, a tracking ID, a competitor name). Never read every document.

## Documents

- `/knowledge/pages/<page>.md` — one document per page or page type (lowercase, hyphenated, e.g. `/knowledge/pages/home.md`, `/knowledge/pages/pricing.md`, `/knowledge/pages/blog-post-template.md`), tag `page`, following the page document schema below. For templated pages (blog posts, product pages, landing pages from one template), document the template once and list the distinct instances inside it.
- `/knowledge/brand-and-voice.md` — the Site's intended positioning, target audiences, tone of voice, terminology, visual identity rules and claims policy, tag `cross-cutting`. Create it the first time such a rule is captured, with this content:

```markdown
  # Brand, Voice and Messaging Rules

  Rules and facts that apply to the whole Site. Page-specific content lives in that page's document under `/knowledge/pages/`.

  ## Audiences and goals
  ## Positioning and value proposition
  ## Tone of voice and terminology
  ## Visual identity and design system
  ## Claims, legal and compliance rules
```

- `/knowledge/site-structure.md` — global navigation, footer, sitemap, URL conventions, locales/languages, redirects, tag `cross-cutting`. Create it when first needed.
- `/knowledge/tracking-and-tech.md` — analytics, tag manager, pixels, consent management, CMS/stack, third-party scripts and integrations that apply Site-wide, tag `cross-cutting`. Create it when first needed.
- Every document is created with a `description`: one line stating its scope (e.g. `Pricing page: messaging, CTAs, forms, tracking, SEO`). Keep it accurate when the content changes (`memory_edit` with `set_metadata`).

## Source tags

Every fact carries a tag so the memory can be trusted and curated:

- `documented` — from a source the user provided (brand guidelines, creative brief, style guide, analytics export, competitor brief, legal policy…). Note the source name.
- `observed` — seen first-hand during the review (page content, behavior, rendered layout, network requests, output of a tool such as Lighthouse or a crawler — name the tool).
- `assumed` — an unverified inference (e.g. the intended audience of a page, the purpose of an unknown script). Must be re-checked before being relied upon.

Always record the **Session** and **date**, plus — for `documented` — the source name. For `observed` facts that depend on viewport, locale, logged-in state, A/B variant or consent state, say so in the entry.
Format: `<tag>, session_NNN, YYYY-MM-DD[, <source name>]` (e.g. `observed, session_042, 2026-10-20`), where `session_NNN` is the name of the current Session (its folder is `/sessions/NNN/`).
The Session lets you trace a fact back to its log `/sessions/NNN/log/log.md` for the full context; `memory_history` also shows which Session changed what, through the change notes.

Because marketing content changes often, facts about live copy (headlines, prices, offers, claims) are **time-sensitive**: always keep the date, and treat them as stale when a later Session sees something different (see Consolidate).

## Page document schema

Use these exact headings so you always know where to read and where to write. Each section is a **growing list of entries**. **Append** a new entry rather than overwriting; never collapse distinct items into one. Omit a section only while it has no entries yet.

```markdown
# Page: <Name>

## Purpose and audience
- Purpose: <what the page is for, funnel stage>
  - Audience: <who it targets>
  - Source: documented|observed|assumed, session_NNN, <date>[, <source name>]

## URLs and access
<!-- one entry per URL or variant (locale, device, A/B variant) -->
- URL: <url>
  - How to reach it: <nav path / link / campaign source / required state>
  - Variants: <locale, viewport, logged-in, consent state, if relevant>
  - Source: observed, session_NNN, <date>

## Content and messaging
<!-- one entry per key block or claim -->
- Headline / value proposition: <text or short paraphrase>
  - Supporting proof: <testimonials, logos, stats, awards>
  - Source: observed, session_NNN, <date>
- Claim: <factual, pricing, comparative or performance claim as stated>
  - Evidence / substantiation: <link or "none found">
  - Source: observed, session_NNN, <date>

## Calls to action and conversion paths
<!-- one entry per CTA -->
- CTA: "<label>" — location: <hero / sticky header / footer…>
  - Destination: <url or action>
  - Path: <steps to completion, e.g. click → form → thank-you page>
  - Source: observed, session_NNN, <date>

## Forms and integrations
<!-- one entry per form or embedded tool -->
- Form: <name> — fields: <list, required/optional>
  - Submission: <endpoint or service if visible, e.g. POST /api/..., HubSpot, Marketo>
  - Result: <thank-you page, confirmation email, error handling observed>
  - Consent / privacy: <checkbox, link to policy, double opt-in if known>
  - Source: observed, session_NNN, <date>

## Tracking and third-party scripts
<!-- one entry per tag, pixel or event observed on this page -->
- <tool / pixel / event name> — trigger: <page view, click, form submit>
  - Details: <ID, payload, request URL>
  - Fires before/after consent: <observed>
  - Source: observed, session_NNN, <date>

## SEO and metadata
- Title: <…>; Meta description: <…>; H1: <…>; Canonical: <…>; Open Graph/Twitter: <…>; Structured data: <…>; Indexing: <robots/noindex>
  - Source: observed, session_NNN, <date>

## Page rules
<!-- stable facts and rules specific to this page -->
- <rule or stable characteristic, e.g. "price shown excludes VAT", "page must carry the legal disclaimer">  (source: observed|documented, session_NNN, <date>)

## Open questions / unverified
- <thing guessed but not yet confirmed>
```

Cross-cutting rules go in `/knowledge/brand-and-voice.md`, `/knowledge/site-structure.md` or `/knowledge/tracking-and-tech.md` using the same source-tag conventions.

## Update protocol (two phases)

Give every change a short `change_note` that starts with the current Session and says why the change is made (e.g. `session_042: Pricing page CTAs and form observed`), like a commit message.

1. **Capture — continuously, append-only.** The moment a durable fact is confirmed (from a provided source early in the Session, or during the review), record it with a source tag, Session, and date. Capture is cheap and resists Session crashes.
   - First check that it is not already recorded: `memory_search` with `path_prefix="/knowledge/"` for the page URL, the headline, the tracking ID, or the rule's key words.
   - Add an entry to an existing document with `memory_edit`, operation `{"op": "append", "section": "## Calls to action and conversion paths", "create_section": true, "text": "- CTA: …"}` (no need to read the document first).
   - Create a new page document with `memory_write` (mode `create`, a `description`, tags `["page"]`), with the schema headings that already have entries.
2. **Consolidate — periodically (end of Session).**
   - Merge only true duplicates (the same URL, CTA, form or tag recorded twice) while keeping genuinely distinct entries separate.
   - Resolve contradictions and stale copy: when a later Session observes different content (new headline, price, offer, script), keep the newest, note Session and date, and record the change in the entry rather than silently dropping the old value when the change itself is meaningful.
   - Promote confirmed `assumed` facts to `observed` or `documented`: find them with `memory_search(query="assumed,", path_prefix="/knowledge/")`, then `memory_edit` with `str_replace` on the exact entry.
   - Prune dead ends, removed pages and anything that turned out wrong: `memory_edit` with `str_replace` and an empty `new_str`, or `memory_delete` for a whole document. The history keeps the removed text.
   - To rewrite a section or a document, `memory_read` it first (the result gives its version), then `memory_edit` with `replace_section` or `memory_write` with mode `overwrite`, passing `if_version`. On a `VERSION_CONFLICT` error, read it again and redo the change on the new content.
   - A change spanning several documents (e.g. moving a tone rule from a page document to `/knowledge/brand-and-voice.md`) goes in one `memory_batch`, so it is applied entirely or not at all. Rename a document with `memory_move`.
   - Finally, check with `memory_list(path="/knowledge/", depth=5)` that every document's description still matches its content and that each document has the right tags; fix them with `set_metadata`.
