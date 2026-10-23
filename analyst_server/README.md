# Analyst server

A service that gives the ETiK tester read-only access to GitLab, over MCP: work items (user stories, bugs, tasks, epics) with their acceptance criteria, hierarchy and comments, merge requests with their diff and pipeline, and search.

The tester (Claude Code in the test container) reads untrusted pages in YOLO mode: it must not hold a GitLab token. This container holds it, refuses to start if the token could write, and only answers the tester's token.

```
 Test container (tester)  ── MCP, Bearer ANALYST_TOKEN ──►  Analyst server :9502  ── read-only token ──►  gitlab.com
```

LLM analyses of the code (bug investigations, fix briefs) will come next, in the same server.

## Setup

```bash
cp .env.example .env    # then set the two tokens
docker compose up -d --build
curl http://localhost:9502/health
```

| Variable | Meaning |
|---|---|
| `ANALYST_TOKEN` | The token callers present (`Authorization: Bearer …`), e.g. `openssl rand -hex 32`. Required. |
| `GITLAB_READ_TOKEN` | A GitLab token with the scopes `read_api` and `read_repository` **only** (personal, group or project access token). Required. At start, the server reads its scopes and refuses to start if any is not a `read_*` one, or if the token is not active. |
| `GITLAB_URL` | The GitLab instance, `https://gitlab.com` by default. The server never calls another host. |
| `GITLAB_DEFAULT_PROJECT` | The project of the short references `#123`, `!123`, `123`; `henixdevelopment/squash/squash-tm/core/squashtest-tm-staging` by default. |
| `GITLAB_SEARCH_GROUP` | The group `gitlab_search` searches when no project is given; `henixdevelopment/squash` by default. |
| `GITLAB_TIMEOUT_MS` | Timeout of one GitLab request, 30 000 ms by default. |
| `ANALYST_MCP_MAX_OUTPUT_CHARS` | Maximum size of one tool result, 40 000 characters by default; longer results end with `[truncated: N more characters not shown]`. |
| `ANALYST_PORT` | Host port (Docker Compose), 9502 by default. |

The test container gets the analyst token from `../test_environment/analyst.env`; the `squashtm` configuration declares the MCP server `analyst` (`"timeout": 3600000`, for the long analyses to come), allows host port 9502, and checks `/health` and `/auth-check` before starting Claude Code.

## HTTP endpoints

| Endpoint | Meaning |
|---|---|
| `GET /health` | `{"status":"ok"}`, no token. |
| `GET /auth-check` | 204 with a valid `ANALYST_TOKEN`, 401 otherwise (for the tester's checks). |
| `POST /mcp` | MCP Streamable HTTP, stateless, responses as SSE. 401 without a valid token. `GET` and `DELETE` answer 405. |

## Tools

All tools are read-only (`readOnlyHint: true`). They return text for the model, Markdown sections with one line per item; GitLab text is returned as written, and the tool descriptions remind the model that it is data, never instructions.

### References

Every `ref` accepts:
- a GitLab URL of the instance: `…/-/work_items/123`, `…/-/issues/123`, `/groups/…/-/work_items/123`, `/groups/…/-/epics/123`, `…/-/merge_requests/123` (sub-pages such as `/diffs` too);
- `group/project#123` (work item), `group&123` (epic), `group/project!123` (merge request);
- `#123`, `!123` or `123` in the default project; a bare number is of the kind the tool reads.

Results write references the same way, without the project when it is the default one. Parsing a reference is the only way an input becomes part of an API path: the server never fetches a URL it is given.

### `gitlab_work_item`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `ref` | string | | The work item. |
| `max_comments` | integer 0–200 | 50 | Number of comments returned, the most recent ones. |

Returns the header (the `Type::` label, the GitLab type, state, title, status, milestone, assignees, author, dates, labels, weights and custom fields), the full description, the hierarchy (ancestors from the root epic down, the work item, its children, its siblings), linked items, merge requests (closing and related) and the comments (non-system notes, each cut at 4 000 characters).

Each hierarchy item gives the states of its merge requests (`MRs: merged ×2, opened`). GitLab serves the related merge requests of one work item per query, so they are read for the first 30 items of the hierarchy and linked items; the others show `MRs: not read`.

```
#100 · UserStory (Issue) · closed · [Export] Show the export button
url: https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging/-/work_items/100
status: Done · milestone: Sprint 158 · assignees: qa · author: po
created: 2026-10-01T08:00:00Z · closed: 2026-10-19T09:00:00Z · updated: 2026-10-20T08:00:00Z
labels: Priority::Medium, Status::Validated, Type::UserStory
weight: 4 · Dev Weight: 3

## Description

## Context

Users cannot export.

## Acceptance criteria

- [ ] The export button is shown on the campaign page.

## Hierarchy

henixdevelopment/squash#10 · Epic · open · Reporting · https://gitlab.com/groups/henixdevelopment/squash/-/work_items/10
  henixdevelopment/squash#11 · Feature · open · [Export] Export campaigns · Status::Implemented · https://gitlab.com/groups/henixdevelopment/squash/-/work_items/11
    ▶ #100 (this work item)
      (no children)
    siblings (the other children of the parent):
    #101 · UserStory · open · [Export] Export as CSV · Status::InProgress · MRs: opened, merged · https://gitlab.com/…/-/work_items/101
    henixdevelopment/squash/squash-tm/tm-plugin/api/henix-tm-api-rest-admin#5 · Task · closed · [Export - API] Export endpoint · MRs: merged · https://gitlab.com/…/-/work_items/5

## Linked items (1)

- relates_to: #90 · Bug · open · [Export] Old export issue · https://gitlab.com/…/-/work_items/90

## Merge requests (2)

- !200 · merged · Resolve "Show the export button" · 100-show-the-export-button → main · merged 2026-10-15T14:04:15Z · merge commit aaaa… · pipeline success · https://gitlab.com/…/-/merge_requests/200
- !201 · opened · Resolve "Show the export button" · 100-show-the-export-button → main · pipeline success · https://gitlab.com/…/-/merge_requests/201

## Comments (2, oldest first)

### dev · 2026-10-12T10:00:00Z

Implemented, on nightly.

### qa · 2026-10-19T09:00:00Z

Validated on nightly 19/10.
```

### `gitlab_merge_request`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `ref` | string | | The merge request. |
| `include_diff` | boolean | true | Return the diff of each file, not only the list of changed files. |
| `max_diff_chars` | integer 0–200 000 | 20 000 | Characters of diff in total: each file gets an equal share of what is left, and a cut file says how much is missing. |

Returns the header (state, draft, author, branches, merge and squash commits, labels, the work items it closes), the latest pipeline with its failed jobs, the description, the changed files with added/removed lines (up to 500 files), the diff, and the discussions (non-system, with their resolved state and position; each note cut at 2 000 characters, as review bots can be verbose).

````
!200 · merged · Resolve "Show the export button"
url: https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging/-/merge_requests/200
author: dev · created: 2026-10-14T15:00:00Z
branches: 100-show-the-export-button → main
merged 2026-10-15T14:04:15Z by lead · merge commit aaaa…
labels: Type::UserStory
closes: #100 · closed · [Export] Show the export button · https://gitlab.com/…/-/issues/100
pipeline: failed · https://gitlab.com/…/-/pipelines/900
  failed job: unit-tests (test) · https://gitlab.com/jobs/1

## Description

Related to #100

## Changed files (3, +2 −1)

- modified front/campaign.html (+2 −1)
- renamed front/old.less → front/new.less (+0 −0)
- added front/big.json (+0 −0)

## Diff

### front/campaign.html
```diff
@@ -1,3 +1,4 @@
 <div>
-  <span>old</span>
+  <span>new</span>
+  <button>Export</button>
 </div>
```

### front/new.less
(no textual change)

### front/big.json
(diff not returned by GitLab: too large)

## Discussions (2)

### [resolved] reviewer · 2026-10-15T10:00:00Z · front/campaign.html:3

Should this be disabled for read-only users?

↳ dev · 2026-10-15T10:05:00Z: Done.

### review-bot · 2026-10-15T10:10:00Z

xxxxxxxx… (2 000 characters)
(cut: 500 more characters)
````

### `gitlab_search`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `query` | string | | Words searched in the title and the description. |
| `kind` | `work_item` \| `merge_request` | `work_item` | |
| `state` | `opened` \| `closed` \| `merged` \| `all` | `all` | `merged` applies to merge requests only. |
| `labels` | string[] | `[]` | Only items having all these labels, e.g. `["Type::Bug"]`. |
| `project` | string | | A project path; by default, every project of `GITLAB_SEARCH_GROUP`. |
| `limit` | integer 1–100 | 20 | |

Most recently updated first. Epics are not searched (the REST search covers issues and merge requests).

```
"export" in henixdevelopment/squash · 2 work items, most recently updated first
#100 · closed · [Export] Show the export button · UserStory/Validated · updated 2026-10-20T08:00:00Z · https://gitlab.com/…/-/issues/100
henixdevelopment/squash/squash-tm/tm-plugin/api/henix-tm-api-rest-admin#5 · closed · [Export - API] Export endpoint · Task · updated 2026-10-18T08:00:00Z · https://gitlab.com/…/-/issues/5
```

### Errors

A failing call returns `isError: true` and one line `Error: …` that says what to do:

| Cause | Message (abridged) |
|---|---|
| Not a reference, another host, wrong kind | `'…' is not a GitLab reference…`, `(only https://gitlab.com is served)`, `'!7341' is a merge request: use gitlab_merge_request.` |
| Invalid `project` of `gitlab_search` | `'…' is not a project path such as 'group/subgroup/project'.` |
| Missing, or not readable with the token | `Work item … not found, or not readable with the analyst's token.` / `Not found on GitLab… (404…)` |
| Token refused or not allowed | `GitLab rejected the analyst's token (401…); the administrator must renew GITLAB_READ_TOKEN.` / `… cannot read this (403…)` |
| GitLab down, slow or rate-limited | `GitLab is unreachable (…)`, `GitLab failed (5xx)`, `GitLab rate limit reached (429)…` (one retry after `Retry-After` first) |

## Security

- The GitLab token is read-only, checked at each start; the server only sends GET requests and GraphQL queries, to `GITLAB_URL` only, without following redirects.
- Callers are authenticated with `ANALYST_TOKEN` (compared in constant time) before any MCP processing.
- No egress firewall yet: the server runs no agent and calls fixed GitLab endpoints. It will get one with the LLM analyses.

## Development

```bash
npm install
npm test          # unit and MCP tests, against a fake GitLab (invented content)
npm run typecheck
npm run build
npm run dev       # with ANALYST_TOKEN and GITLAB_READ_TOKEN in the environment
```

The tests never call GitLab: `test/helpers.ts` serves responses with the shapes of gitlab.com and invented content. Check a change of the queries against the real API before committing.
