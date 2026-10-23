# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. Security is improved (but this is not perfect!) by running Claude Code in a firewalled Docker container, driven from a browser.

## Big picture

```
 Host                                                               Internet
┌─────────────────────────────────────────────────────────────┐
│ SquashTM (SUT)        Memory server         Your browser    │
│ :8090                 :9501  ◄───────────── web app (read)  │
│   ▲                     ▲                                   │
│   │ UI (Playwright CLI) │ MCP (memory_* tools), REST upload │
│   │ and REST API        │                                   │
│ ┌─┴─────────────────────┴───────────────┐                   │
│ │ Test container (test_environment/)    │ ◄──── console ─── │
│ │ Claude Code in YOLO mode, firewalled  │ ──────────────────┼──► Anthropic API,
│ │ Sessions and knowledge go to the      │                   │    SquashTM docs
│ │ memory server (MCP + uploads)         │                   │
│ └─┬─────────────────────────────────────┘                   │
│   │ MCP (gitlab_* and analyst_* tools)                      │
│   ▼                                                         │
│ Analyst server :9502 (analyst_server/) ─────────────────────┼──► GitLab, read-only:
│ read-only GitLab token, code clones, Claude agent; writes   │    work items, MRs, clones;
│ its analyses to the memory server (/analyses/)  ────────────┼──► Anthropic API
└─────────────────────────────────────────────────────────────┘
```

- **SquashTM** is the System Under Test. It runs on the host, on port 8090.
- **The test container** (`test_environment/`) runs Claude Code with `--dangerously-skip-permissions`, so no command needs approval.
  - You chat with Claude Code from your browser, in the web terminal of the ETiK console (`http://localhost:7681`).
  - A configuration (`test-configurations/squashtm/`) defines the system prompt, the allowed Internet domains and host ports, the tools and the skills; you upload it from the console.
  - Claude Code tests SquashTM's UI, with Playwright CLI, and its public REST API, following the Exploratory Testing process in its system prompt (`test-configurations/squashtm/system-prompt.md`).
  - For each Exploratory Test Session, the agent creates a folder `/sessions/NNN/` in the memory server, where it writes the charter, checklist, replay log (append-only), issue reports and screenshots. The workspace only holds temporary files.
  - A firewall only lets the container reach the Anthropic API, and, while Claude Code runs, the domains and host ports of its configuration: the SquashTM documentation, and, on the host, SquashTM, the memory server and the analyst server.
- **The memory server** (`memory_server/`) holds the agent's durable knowledge about the SUT across Sessions (`/knowledge/`: UI pages, private API endpoints, public REST API endpoints, business rules) and the Sessions themselves (`/sessions/`).
  - It is a separate container, so the agent cannot tamper with its files.
  - It keeps every version of every document and the change note of each change; the agent starts each change note with its Session.
  - The agent reaches it through MCP (`memory_*` tools), and uploads screenshots through its REST API (`memory-upload` skill), with a token limited to its own store.
  - You watch it live in a read-only web app.
- **The analyst server** (`analyst_server/`) gives the agent read-only access to GitLab, and code analyses by another Claude, over MCP:
  - `gitlab_*` tools: work items (user stories, bugs) with their acceptance criteria, epic hierarchy and comments, merge requests with their diff and pipeline, search;
  - `analyst_*` tools: a Claude agent inside the analyst container reads the SquashTM code (cloned from GitLab) and writes a story brief (acceptance criteria checked in the code, what the hierarchy implements, impacted features), a fix brief (what the fix changed, dubious changes to test), or an investigation of an issue the tester found (confirmed or not, root cause, other occurrences). They take minutes: the tester keeps testing and gets the result as a notification; it is stored in the memory server under `/analyses/`.
  - It holds the GitLab token, a read-only one (it refuses to start with a token that could write), and the code: the tester, which reads untrusted pages, holds neither. Its agent has no shell and no web access, only reads the checkouts, and a firewall limits the container to GitLab, the Anthropic API and the memory server.
  - So the tester can run Charters such as "verify that User Story #8131 is properly implemented" or "verify the fix of bug #98765", and dig into the bugs it finds.

The bugs found then go to GitLab:

```
 Host                                                               Internet
┌─────────────────────────────────────────────────────────────┐
│ Claude Code at the root of this repository                  │
│ gitlab-sync, gitlab-post-analysis ──────────────────────────┼──► GitLab: issues, comments,
│   │ memory MCP, REST (read)      │ analyst MCP              │    each approved by you
│   ▼                              ▼                          │
│ Memory server :9501            Analyst server :9502         │
│ /sessions/ (issue reports)     analyses of GitLab issues,   │
│ /analyses/ (analyses)          written to /analyses/        │
└─────────────────────────────────────────────────────────────┘
```

- **Claude Code on the host**, started at the root of this repository, does every write to GitLab, and each one waits for your approval: it creates issues from the issue reports of the memory server, or comments on the existing ones (`gitlab-sync`), and posts the analyst's investigations on the issues (`gitlab-post-analysis`): those of the tester's issue reports, and those of GitLab issues it asks the analyst for.

## Usage example

### 1) Start SquashTM

Start SquashTM with Docker Compose, as described in the [SquashTM Docker quick start](https://tm-en.doc.squashtest.com/latest/install-guide/installation/install-squash/docker-install.html#quick-start).
Publish it on host port 8090: the agent expects it at `http://host.docker.internal:8090/squash`, and the firewall only allows that port.

```bash
docker compose up -d
```

Check that [`http://localhost:8090/squash/login`](http://localhost:8090/squash/login) answers, and that you can log in as `admin` / `admin`.

### 2) Start the memory server

```bash
cd memory_server
cp .env.example .env   # then replace the tokens, e.g. with `openssl rand -hex 32`
docker compose up -d --build
curl http://localhost:9501/health
```

`.env` holds three tokens: admin (everything), viewer (the web app, read-only) and the agent token of the store `squashtm` (`MEMORY_AGENT_TOKENS=squashtm=…`).
The memories are kept in the `memory-data` Docker volume.
Open [`http://localhost:9501/`](http://localhost:9501/) and log in with the viewer token to watch the memory.
See [`memory_server/README.md`](memory_server/README.md) for the server and the web app, and `memory_server/API.md` for the tools and the REST API.

### 3) Start the analyst server

```bash
cd analyst_server
cp .env.example .env   # then set the two tokens
docker compose up -d --build
curl http://localhost:9502/health
```

`.env` holds:
- `GITLAB_READ_TOKEN`: a GitLab token with the scopes `read_api` and `read_repository` only;
- `ANALYST_TOKEN`: the token the tester presents (e.g. `openssl rand -hex 32`);
- `CLAUDE_CODE_OAUTH_TOKEN`: the subscription token of the analyses' agent, from `claude setup-token` (without it, only the `gitlab_*` tools work);
- `MEMORY_AGENT_TOKEN`: the `squashtm` token from step 2, to store the analyses and read the issue reports.

The code projects are cloned into the `repos` Docker volume on first use.
See [`analyst_server/README.md`](analyst_server/README.md) for the tools.

### 4) Run Exploratory Tests in the test container

1. Give the agent its tokens:
   - copy `test_environment/memory.env.example` to `test_environment/memory.env`, and set `MEMORY_AGENT_TOKEN` to the `squashtm` agent token of step 2 (`MEMORY_AGENT_TOKENS` in `memory_server/.env`);
   - copy `test_environment/analyst.env.example` to `test_environment/analyst.env`, and set `ANALYST_TOKEN` to the `ANALYST_TOKEN` of step 3 (in `analyst_server/.env`).
2. Build and start the container:
   ```bash
   cd test_environment
   docker compose up -d --build
   ```
   Only `test_environment/workspace/` is mounted in the container, which keeps the memory server's admin token out of the agent's reach.
3. Open [`http://localhost:7681`](http://localhost:7681) (the ETiK console), click **Upload configuration folder…** and pick `test-configurations/squashtm`.
4. Select the configuration and click **Start Claude Code**.
   - The console opens the firewall to the configuration's domains and host ports, checks the memory server, the analyst server and their tokens, then starts Claude Code in the web terminal.
   - The first time, log in with your Claude subscription and accept the prompts; the login is kept in a Docker volume.
5. Give Claude Code an Exploratory Test Charter (or let it ask you for one), e.g. "verify that User Story #8131 is properly implemented", and follow the Session in the memory web app: it creates the next `/sessions/NNN/` folder, proposes a charter, builds a checklist, tests, writes issue reports into `/sessions/NNN/issues/`, and records what it learns about SquashTM in `/knowledge/`.

See [`test_environment/README.md`](test_environment/README.md) for more details.

### 5) Sync the issues with GitLab

Claude Code on the host, started from the root of this repository, does every write to GitLab, and each write waits for your approval. It uses:

- the MCP servers of `.mcp.json`: `gitlab` ([`@zereight/mcp-gitlab`](https://www.npmjs.com/package/@zereight/mcp-gitlab), issue tools only), `memory` (store `squashtm`) and `analyst` (the analyst server of step 3); Claude Code asks you to approve them the first time. `.claude/settings.json` lets the read-only tools run without a prompt (an analysis, which spends tokens, still asks), and moves analyses to the background after 10 s;
- the skills of `.claude/skills/`: `gitlab-sync`, `gitlab-publish` and `gitlab-post-analysis`.

Set in the environment before starting Claude Code:

| Variable | Value |
|---|---|
| `GITLAB_TOKEN` | A GitLab token with the `api` scope on the SquashTM staging project |
| `MEMORY_AGENT_TOKEN` | An agent token of the store `squashtm` (the `memory` MCP server refuses the viewer token) |
| `MEMORY_TOKEN` | A memory server token that reads the store, for `gitlab-publish` (the viewer token is enough) |
| `MEMORY_URL` | Optional, `http://localhost:9501` by default |
| `ANALYST_TOKEN` | The `ANALYST_TOKEN` of `analyst_server/.env` |
| `ANALYST_URL` | Optional, `http://localhost:9502` by default |

Then ask, e.g. "sync /sessions/042/ with GitLab" or "sync /sessions/042/issues/007/issue.md with GitLab". For each issue report, the `gitlab-sync` skill searches GitLab, closed issues included, and proposes in one table:

- a comment on an open issue that describes the same bug, with what the report adds;
- a new issue otherwise, linked to the related issues (a closed issue describing the same bug is a possible regression).

It shows the analyst's investigation of each report when the tester asked for one (whether the code confirms the problem), asks you the priority, team, security and draft flags of each new issue, then creates the issues and posts the comments with their screenshots (`gitlab-publish`), and records the GitLab URL in the metadata of the issue report (`gitlab_issue`, `gitlab_link`). A report that already has a URL is skipped, and `gitlab-publish` refuses to publish it again. If you want, it then posts the investigation on the issue, after you review it (`gitlab-post-analysis`).

To publish a single report without searching, ask e.g. "publish /sessions/042/issues/007/issue.md in GitLab" (`gitlab-publish` skill).

### 6) Analyse a GitLab issue

On the host, ask Claude Code e.g. "analyse #1234": the `gitlab-post-analysis` skill asks the analyst for an investigation of the issue (`analyst_investigate`, a few minutes in the background), stored in `/analyses/work-items/1234/analysis.md`. A recent analysis of the unchanged issue is reused instead (ask for a new one to force it).

Then, or later ("post the analysis of #1234"), it shows you the analysis, points out what looks doubtful, and, with your approval, posts it as a comment on the issue, saying it was written by an AI agent from the issue and the code only. The same skill posts the investigations of the tester's issue reports, from `gitlab-sync`.

The analyst neither builds the code nor runs tests: its verdicts and root causes are leads to check, not proofs.
