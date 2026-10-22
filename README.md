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
│ └───────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

- **SquashTM** is the System Under Test. It runs on the host, on port 8090.
- **The test container** (`test_environment/`) runs Claude Code with `--dangerously-skip-permissions`, so no command needs approval.
  - You chat with Claude Code from your browser, in the web terminal of the ETiK console (`http://localhost:7681`).
  - A configuration (`test-configurations/squashtm/`) defines the system prompt, the allowed Internet domains and host ports, the tools and the skills; you upload it from the console.
  - Claude Code tests SquashTM's UI, with Playwright CLI, and its public REST API, following the Exploratory Testing process in its system prompt (`test-configurations/squashtm/system-prompt.md`).
  - For each Exploratory Test Session, the agent creates a folder `/sessions/NNN/` in the memory server, where it writes the charter, checklist, replay log (append-only), issue reports and screenshots. The workspace only holds temporary files.
  - A firewall only lets the container reach the Anthropic API, and, while Claude Code runs, the domains and host ports of its configuration: the SquashTM documentation, and, on the host, SquashTM and the memory server.
- **The memory server** (`memory_server/`) holds the agent's durable knowledge about the SUT across Sessions (`/knowledge/`: UI pages, private API endpoints, public REST API endpoints, business rules) and the Sessions themselves (`/sessions/`).
  - It is a separate container, so the agent cannot tamper with its files.
  - It keeps every version of every document and the change note of each change; the agent starts each change note with its Session.
  - The agent reaches it through MCP (`memory_*` tools), and uploads screenshots through its REST API (`memory-upload` skill), with a token limited to its own store.
  - You watch it live in a read-only web app.

The bugs found then go to GitLab, and GitLab issues can be analysed against the code:

```
 Host                                                               Internet
┌─────────────────────────────────────────────────────────────┐
│ Claude Code at the root of this repository                  │
│ gitlab-sync, gitlab-post-analysis ──────────────────────────┼──► GitLab: issues, comments,
│   │ memory MCP, REST (read)                                 │    Draft MRs, each approved
│   ▼                                                         │    by you
│ Memory server :9501                                         │
│ /sessions/ (issue reports)    /analyses/ (analyses, fixes)  │
│   ▲ MCP, REST                                               │
│ ┌─┴─────────────────────────────────────┐                   │
│ │ Analysis instance of the test         │ ──────────────────┼──► GitLab, read-only:
│ │ container (gitlab-analysis), YOLO,    │                   │    issues, git clone
│ │ firewalled; code in a Docker volume   │                   │
│ └───────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

- **Claude Code on the host**, started at the root of this repository, does every write to GitLab, and each one waits for your approval: it creates issues from the issue reports of the memory server, or comments on the existing ones (`gitlab-sync`), and posts the analyses and their Draft merge requests (`gitlab-post-analysis`).
- **The analysis instance** is a second instance of the test container, running the configuration `test-configurations/gitlab-analysis/`. With a read-only GitLab token, it reads an issue, clones the private code into a Docker volume, finds the cause of the bug, and writes its analysis, a proposed fix and further tests to the memory server. It cannot write anything to GitLab.

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

### 3) Run Exploratory Tests in the test container

1. Give the agent its token: copy `test_environment/memory.env.example` to `test_environment/memory.env`, and set `MEMORY_AGENT_TOKEN` to the `squashtm` token from step 2.
2. Build and start the container:
   ```bash
   cd test_environment
   docker compose up -d --build
   ```
   Only `test_environment/workspace/` is mounted in the container, which keeps the memory server's admin token out of the agent's reach.
3. Open [`http://localhost:7681`](http://localhost:7681) (the ETiK console), click **Upload configuration folder…** and pick `test-configurations/squashtm`.
4. Select the configuration and click **Start Claude Code**.
   - The console opens the firewall to the configuration's domains and host ports, checks the memory server and the token, then starts Claude Code in the web terminal.
   - The first time, log in with your Claude subscription and accept the prompts; the login is kept in a Docker volume.
5. Give Claude Code an Exploratory Test Charter (or let it ask you for one), and follow the Session in the memory web app: it creates the next `/sessions/NNN/` folder, proposes a charter, builds a checklist, tests, writes issue reports into `/sessions/NNN/issues/`, and records what it learns about SquashTM in `/knowledge/`.

See [`test_environment/README.md`](test_environment/README.md) for more details.

### 4) Sync the issues with GitLab

Claude Code on the host, started from the root of this repository, does every write to GitLab, and each write waits for your approval. It uses:

- the MCP servers of `.mcp.json`: `gitlab` ([`@zereight/mcp-gitlab`](https://www.npmjs.com/package/@zereight/mcp-gitlab), issue tools only) and `memory` (store `squashtm`); Claude Code asks you to approve them the first time. `.claude/settings.json` lets the read-only tools run without a prompt;
- the skills of `.claude/skills/`: `gitlab-sync` and `gitlab-publish`.

Set in the environment before starting Claude Code:

| Variable | Value |
|---|---|
| `GITLAB_TOKEN` | A GitLab token with the `api` scope on the SquashTM staging project |
| `MEMORY_AGENT_TOKEN` | An agent token of the store `squashtm` (the `memory` MCP server refuses the viewer token) |
| `MEMORY_TOKEN` | A memory server token that reads the store, for `gitlab-publish` (the viewer token is enough) |
| `MEMORY_URL` | Optional, `http://localhost:9501` by default |

Then ask, e.g. "sync /sessions/042/ with GitLab" or "sync /sessions/042/issues/007/issue.md with GitLab". For each issue report, the `gitlab-sync` skill searches GitLab, closed issues included, and proposes in one table:

- a comment on an open issue that describes the same bug, with what the report adds;
- a new issue otherwise, linked to the related issues (a closed issue describing the same bug is a possible regression).

It asks you the priority, security and draft flags of each new issue, then creates the issues and posts the comments with their screenshots (`gitlab-publish`), and records the GitLab URL in the metadata of the issue report (`gitlab_issue`, `gitlab_link`). A report that already has a URL is skipped, and `gitlab-publish` refuses to publish it again.

To publish a single report without searching, ask e.g. "publish /sessions/042/issues/007/issue.md in GitLab" (`gitlab-publish` skill).

### 5) Analyse a GitLab issue

1. Fill in `test-configurations/gitlab-analysis/files/code-projects.md` with the GitLab projects holding the code of SquashTM.
2. Give the analysis agent a **read-only** GitLab token: copy `test_environment/gitlab.env.example` to `test_environment/gitlab.env` and set `GITLAB_READ_TOKEN` (scopes `read_api` and `read_repository` only, e.g. a group access token with the Reporter role).
3. Start a second instance of the test container, next to the testing one:
   ```bash
   cd test_environment
   ETIK_CONTAINER=etik-analysis ETIK_PORT=7682 ETIK_WORKSPACE=./workspace-analysis docker compose -p etik-analysis up -d --build
   ```
4. Open `http://localhost:7682`, upload `test-configurations/gitlab-analysis`, start Claude Code (log in the first time), and ask e.g. "analyse #1234". It writes `/analyses/1234/analysis.md` (root cause with permalinks to the code, suggested fix, further tests as Exploratory Test Charters) and, when the fix is small, `/analyses/1234/fix.diff`.
5. On the host, ask Claude Code e.g. "post the analysis of #1234". The `gitlab-post-analysis` skill shows you the analysis and the diff, then, with your approval:
   - opens a Draft merge request from `fix.diff`, on a new branch `etik/1234-…` of the code project (`GITLAB_TOKEN` then needs the Developer role on that project);
   - posts the analysis as a comment on the issue, with the link to the merge request.

The agent cannot build the code or run the tests: review the merge request, build it and run the tests before marking it ready.
