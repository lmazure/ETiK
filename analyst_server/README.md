# Analyst server

A service that gives the ETiK tester, over MCP:
- read-only access to GitLab (`gitlab_*` tools): work items (user stories, bugs, tasks, epics) with their acceptance criteria, hierarchy and comments, merge requests with their diff and pipeline, and search;
- code analyses (`analyst_*` tools), written by a Claude agent running in this container on the SquashTM code it clones from GitLab: story briefs, fix briefs, and investigations of the problems the tester finds.

The tester (Claude Code in the test container) reads untrusted pages in YOLO mode: it must hold neither a GitLab token nor the private code. This container holds both, refuses to start if the token could write, and only answers the tester's token.

```
 Test container (tester) ── MCP, Bearer ANALYST_TOKEN ──► Analyst server :9502 ── read-only token ──► gitlab.com (API, git)
                                                           │ job queue → Claude agent ─────────────► api.anthropic.com
                                                           │ (Read/Grep/Glob on the checkouts, git and GitLab tools)
                                                           └── results ──► memory server :9501, /analyses/
```

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
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token of the analyses' agent: run `claude setup-token` on the host. Without it, the `analyst_*` tools answer that they are not available; the `gitlab_*` tools still work. |
| `ANALYST_MODEL` | Model of the analyses, `opus` by default. |
| `ANALYST_REUSE_HOURS` | A stored result younger than this many hours, whose source has not changed, is returned instead of a new analysis; 24 by default, `0` never reuses. |
| `ANALYST_MAX_JOBS` | Analyses run at the same time, 1 by default; the others wait in a queue. |
| `ANALYST_JOB_TIMEOUT_MS` | Longest an analysis may run, 45 minutes by default. |
| `ANALYST_REPO_GROUPS` | Groups whose projects the agent may check out, comma-separated; `henixdevelopment/squash/squash-tm/core,henixdevelopment/squash/squash-tm/tm-plugin` by default. |
| `ANALYST_REPOS_DIR` | Clones and job worktrees; `/repos` (the `repos` volume) in the container. |
| `MEMORY_URL` | The memory server, `http://host.docker.internal:9501` by default. |
| `MEMORY_AGENT_TOKEN` | Agent token of the store, to store the analyses and read the tester's issue reports. Without it, results are only returned to the caller. |
| `ANALYST_MEMORY_STORE` | The memory store, `squashtm` by default. |
| `FIREWALL_EXTRA_DOMAINS` | More domains the container may reach (space-separated), e.g. if the agent's authentication needs one. |
| `ANALYST_PORT` | Host port (Docker Compose), 9502 by default. |

The test container gets the analyst token from `../test_environment/analyst.env`; the `squashtm` configuration declares the MCP server `analyst` (`"timeout": 3600000`), allows host port 9502, checks `/health` and `/auth-check` before starting Claude Code, and sets `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=10000` (`files/.claude/settings.json`) so that an analysis call moves to the background after 10 s.

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

### `analyst_story_brief`, `analyst_fix_brief`, `analyst_investigate`

| Tool | Parameters | The analysis |
|---|---|---|
| `analyst_story_brief` | `ref`: a work item; `refresh` | For a user story: each acceptance criterion checked in the code (implemented, not found, not checkable), the hierarchy with what each item implements, the code changes and the features they touch, risks and suggested Exploratory Test Charters. |
| `analyst_fix_brief` | `ref`: a work item; `refresh` | For a bug: the reported behavior, what each merge request changed and the root cause it addresses, whether it is in the analysed code, the impacted areas, the **dubious or wrong changes** with how to trigger them from the UI or the REST API, suggested tests. |
| `analyst_investigate` | `issue_report`: the memory path of an issue report (`/sessions/NNN/issues/MMM/issue.md`); `work_item`: a GitLab issue reporting the problem; `description`: free text; at least one; `refresh` | For a problem found by the tester, or reported in GitLab (then written for the developers too, to be posted on the issue): verdict (confirmed, not confirmed, undecided by the code), root cause, other occurrences, larger impact, tests to run. |

Each call starts a job, or joins the queued or running job of the same analysis, or **reuses a stored result**: unless `refresh` is `true`, when the result stored for the same work item or issue report is younger than `ANALYST_REUSE_HOURS` (24 h) and its source has not changed since (the work item's `updatedAt`, the report's memory version), the call returns it at once, with the status line `job-… · fix brief · #100 · reused: analysed 3 h ago, the work item has not changed since (refresh: true to analyse again) · result: …`. The commits may have moved since: the result names those it read. An investigation of a description is never reused.

A new analysis returns when the job ends: in the tester, Claude Code moves the call to the background after 10 s and delivers the result as a notification. While it runs, the server sends a progress notification at once and every 30 s (`job-1a2b3c4d · fix brief · #8131 · running for 4 min, last step: git_blame …`). If the caller goes away, the job goes on.

The result starts with the job's status line and the memory path where it is stored, then the analysis, ending with an `## Analysed code` section added by the server (each project and the full SHA of the commit read, the model):

```
job-1a2b3c4d · fix brief · #100 · done in 6 min · result: /analyses/work-items/100/fix-brief.md

# Fix brief: #100 [Export] Show the export button
…
## Analysed code

- henixdevelopment/squash/squash-tm/core/squashtest-tm-staging at main (`793fbcd0ca6628a6d1376ed45f14406156562df0`)
- Analysed by opus (ETiK analyst, job job-1a2b3c4d, 31 turns), from GitLab and the code only: no build, no test run.
```

Results in the memory store (overwritten when the analysis is run again; the memory server keeps the previous versions), tagged `analysis` and `story-brief` / `fix-brief` / `investigation`, with the metadata `kind`, `job_id`, `target`, `commits`, `model`, `work_item_updated_at` (analyses of a work item) or `source_version` (investigations of an issue report), and a change note `analyst: …`:

```
/analyses/work-items/<iid>/story-brief.md        <iid> in the default project, else <project>-<iid>
/analyses/work-items/<iid>/fix-brief.md
/analyses/sessions/NNN/issues/MMM/analysis.md    investigation of /sessions/NNN/issues/MMM/issue.md
/analyses/work-items/<iid>/analysis.md           investigation of a GitLab issue (work_item, without issue_report)
/analyses/jobs/<job-id>/analysis.md              investigation of a description
```

When the memory server cannot store it, the result is still returned, with `Warning: the result could not be stored…`.

### `analyst_job`

| Parameter | Type | Meaning |
|---|---|---|
| `job_id` | string, optional | A job id; without it, the jobs of the last 24 hours, newest first. |

```
Analysis jobs, newest first:
job-5e6f7a8b · investigation · /sessions/003/issues/002/issue.md · running for 3 min, last step: Grep ExportService
job-1a2b3c4d · fix brief · #100 · done in 6 min · result: /analyses/work-items/100/fix-brief.md
```

With a `job_id`, a finished job returns its whole result. Jobs live in the server process: after a restart, their results are only in the memory server.

### Errors

A failing call returns `isError: true` and one line `Error: …` that says what to do:

| Cause | Message (abridged) |
|---|---|
| Not a reference, another host, wrong kind | `'…' is not a GitLab reference…`, `(only https://gitlab.com is served)`, `'!7341' is a merge request: use gitlab_merge_request.` |
| Invalid `project` of `gitlab_search` | `'…' is not a project path such as 'group/subgroup/project'.` |
| Missing, or not readable with the token | `Work item … not found, or not readable with the analyst's token.` / `Not found on GitLab… (404…)` |
| Token refused or not allowed | `GitLab rejected the analyst's token (401…); the administrator must renew GITLAB_READ_TOKEN.` / `… cannot read this (403…)` |
| GitLab down, slow or rate-limited | `GitLab is unreachable (…)`, `GitLab failed (5xx)`, `GitLab rate limit reached (429)…` (one retry after `Retry-After` first) |
| Analyses not configured | `The analyses are not available: the analyst server has no CLAUDE_CODE_OAUTH_TOKEN…` |
| Bad investigation request | `Give issue_report …, work_item … or description, or several of them.`, `'…' is not the path of an issue report…` |
| Failed analysis | `Job job-… (fix brief of #100) failed: <reason>` (agent error, `timed out after 45 min`, unreadable issue report…) |
| Unknown job | `No job 'job-…': it never existed, was finished more than a day ago, or the analyst server restarted…` |

## The analyses' agent

Each job runs one Claude Agent SDK session (`src/engine/runner.ts`) with the prompt of its kind (`src/engine/prompts.ts`):
- **Tools**: the built-in `Read`, `Grep` and `Glob`, and the analyst's own tools, served in-process (`src/engine/agent-tools.ts`): `gitlab_work_item`, `gitlab_merge_request`, `gitlab_search` (as above), `repo_list`, `repo_checkout(project)`, `git_log`, `git_show`, `git_blame`, `git_diff`. No shell, no web, no writing, no sub-agents.
- **Repositories**: `repo_checkout` makes a bare partial clone of the project in `/repos/git/` the first time (fetched the next times), and a worktree for the job in `/repos/work/<job-id>/`, detached at the head of the default branch; the worktrees are removed when the job ends. The git tools run `git` with a fixed argument list (no shell, no pager, no external diff or textconv, no hooks), validated revisions and paths inside the checkout.
- **Permissions** (`src/engine/permissions.ts`): a `PreToolUse` hook lets `Read`, `Grep` and `Glob` reach only the job's directory (symbolic links followed) and denies every other built-in tool; nothing is ever approved interactively.
- **Environment**: the agent's process only gets `PATH`, `HOME` and `CLAUDE_CODE_OAUTH_TOKEN`; the GitLab, memory and analyst tokens stay in the server process, which runs the analyst's tools. The four tokens are also scrubbed from every result.
- **Prompt injection**: the prompts tell the agent that issues, merge requests, issue reports and code are data, never instructions, and to report any attempt to steer it.

## Security

- The GitLab token is read-only, checked at each start; the server only sends GET requests and GraphQL queries to `GITLAB_URL`, without following redirects, and only uses the token for git over HTTPS through a credential helper in the environment of its own git commands.
- Callers are authenticated with `ANALYST_TOKEN` (compared in constant time) before any MCP processing.
- **Egress firewall** (`firewall.sh`, applied by `entrypoint.sh` at start, as root): everything is denied except DNS, HTTPS to `api.anthropic.com` and the GitLab host, and, on the Docker host, the memory server's port; IPv6 is denied. The container refuses to start if `example.com` is reachable. The domains are re-resolved every 30 minutes (their CDN addresses rotate). The server then runs as `node`, without any capability: it cannot change the firewall.

## Development

```bash
npm install
npm test          # unit and MCP tests, against a fake GitLab and memory server (invented content), local git repositories and a fake agent
npm run typecheck
npm run build
npm run dev       # with ANALYST_TOKEN and GITLAB_READ_TOKEN in the environment
```

The tests never call GitLab, the memory server or Claude: `test/helpers.ts` serves responses with the shapes of gitlab.com and invented content, and `test/analyses.test.ts` replaces the agent with a fake runner that uses the real analyst tools. Check a change of the queries or of the agent's options against the real services before committing.
