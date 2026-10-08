# ETiK - Exploratory Testing is King

Some experiments with using AI for Exploratory Testing.

Experimenting with Claude Code and Playwright CLI impressed me a lot. But there are much too many commands to be approved. So Claude Code needs to be run in YOLO mode. Security is improved (but this is not perfect!) by running Claude Code in a DevContainer.

## Big picture

```
 Host                                                               Internet
┌─────────────────────────────────────────────────────────────┐
│ SquashTM (SUT)        Memory server         Your browser    │
│ :8090                 :9501  ◄───────────── web app (read)  │
│   ▲                     ▲                                   │
│   │ UI (Playwright CLI) │ MCP (memory_* tools)              │
│ ┌─┴─────────────────────┴───────────────┐                   │
│ │ Dev container (test_environment/)     │                   │
│ │ Claude Code in YOLO mode, firewalled  │ ──────────────────┼──► Anthropic API,
│ │ session_##/: charter, checklist, log, │                   │    SquashTM docs
│ │              bug reports, screenshots │                   │
│ └───────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────┘
```

- **SquashTM** is the System Under Test. It runs on the host, on port 8090.
- **The dev container** (`test_environment/`) runs Claude Code with `--dangerously-skip-permissions`, so no command needs approval.
  - Claude Code drives SquashTM's UI with Playwright CLI, following the Exploratory Testing process in `test_environment/CLAUDE.md`.
  - Each Exploratory Test Session writes its charter, checklist, replay log, bug reports and screenshots into a `session_##/` directory.
  - A firewall only lets the container reach the Anthropic API, the SquashTM documentation, and, on the host, SquashTM and the memory server.
- **The memory server** (`memory_server/`) is the agent's durable knowledge about the SUT across Sessions: UI pages, private API endpoints, business rules.
  - It is a separate container, so the agent cannot tamper with its files.
  - It keeps every version of every document and records which Session made each change.
  - The agent reaches it through MCP (`memory_*` tools), with a token limited to its own store.
  - You watch it live in a read-only web app.

## Usage

### 1) Start SquashTM

Start SquashTM with Docker Compose, as described in the [SquashTM Docker quick start](https://tm-en.doc.squashtest.com/latest/install-guide/installation/install-squash/docker-install.html#quick-start).
Publish it on host port 8090: the agent expects it at `http://host.docker.internal:8090/squash`, and the firewall only allows that port.

```bash
docker compose up -d
```

Check that `http://localhost:8090/squash/login` answers, and that you can log in as `admin` / `admin`.

### 2) Start the memory server

```bash
cd memory_server
cp .env.example .env   # then replace the tokens, e.g. with `openssl rand -hex 32`
docker compose up -d --build
curl http://localhost:9501/health
```

`.env` holds three tokens: admin (everything), viewer (the web app, read-only) and the agent token of the store `squashtm` (`MEMORY_AGENT_TOKENS=squashtm=…`).
The memories are kept in the `memory-data` Docker volume.
Open `http://localhost:9501/` and log in with the viewer token to watch the memory.
See `memory_server/README.md` for the tools, the REST API and the web app.

### 3) Run Exploratory Tests in the dev container

1. Give the agent its token: copy `test_environment/memory.env.example` to `test_environment/memory.env`, and set `MEMORY_AGENT_TOKEN` to the `squashtm` token from step 2.
2. Open the `test_environment` folder in VS Code (`code test_environment`), not the repository root. The dev container is defined there, and only that folder is mounted in the container, which keeps the memory server's admin token out of the agent's reach.
3. Run `Dev Containers: Rebuild and Reopen in Container` the first time (needs the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)), or `Dev Containers: Reopen in Container` the next times.
4. In a new terminal (`Terminal: Create New Terminal`), run `./start-session.sh`.
   - It checks the memory server and the token, creates the next `session_##` directory, then starts Claude Code.
   - The first time, accept the workspace trust dialog, so that the memory server registered in `.mcp.json` is enabled.
5. Give Claude Code an Exploratory Test Charter (or let it ask you for one), and follow the Session: it proposes a charter, builds a checklist, tests, writes bug reports into `session_##/`, and records what it learns about SquashTM in the memory server.

See `test_environment/README.md` for more details.
