# Test container

A Docker container that runs Claude Code in YOLO mode (`--dangerously-skip-permissions`) behind an egress firewall, with Playwright CLI (Chromium and its skill).
It includes the **ETiK console**, a small web server: from a browser on the host, you upload a configuration, start Claude Code with it, and chat with Claude Code in a web terminal.

## Prerequisites

On the host, what the configuration needs: the application under test and, usually, the memory server listening on port 9501 (see `../memory_server/README.md`) with an agent token for the configuration's memory store. The configurations of this repository and their prerequisites are described in [`../test-configurations/README.md`](../test-configurations/README.md).

Copy `memory.env.example` to `memory.env` and set `MEMORY_AGENT_TOKEN` to that agent token (the value after `<store>=` in `MEMORY_AGENT_TOKENS` of `../memory_server/.env`; a token listed there for several stores reaches all of them). `memory.env` is gitignored. Its variables are passed to Claude Code only when the configuration lists them in `env`; it only holds the agent's own token, the admin token stays outside the container.

## Usage

1. Build and start the container:
   ```bash
   docker compose up -d --build
   ```
   At start, the firewall only lets the container reach the Anthropic API and claude.ai (`docker logs etik` shows it).
2. Open `http://localhost:7681` (another port: set `ETIK_PORT`, e.g. `ETIK_PORT=7700 docker compose up -d`).
3. Click **Upload configuration folder…** and pick a configuration folder, e.g. one in `../test-configurations/`. The configuration is named after the folder; uploading a folder with the same name replaces it. The uploaded configurations are kept in the `etik-state` volume. The details of the selected configuration list its files: click a file name (or the system prompt) to view its content.
4. Select the configuration and click **Start Claude Code**. The console:
   - opens the firewall to the configuration's Internet domains and host ports;
   - runs its checks (e.g. the memory server answers and the token reaches the configuration's store);
   - installs the built-in skills and the configuration's skills in `workspace/.claude/skills/` and copies its `files/` into `workspace/`;
   - starts Claude Code in `workspace/` with the system prompt, the built-in tools, the MCP servers and the environment variables of the configuration.

   Its progress, then Claude Code, appear in the terminal.
5. The first time, log in with your Claude subscription (`/login` or the first-run screens) and accept the prompts. The login and settings are kept in the `claude-config` volume.
6. Work with Claude Code as the configuration's system prompt says (e.g. for `squashtm`, give it an Exploratory Test Charter).
7. **Stop Claude Code** (or `/exit` in Claude Code) ends the run. The processes of Claude Code (including the browser) are killed, and the firewall goes back to the base allowlist.

Reloading the page reattaches to the running Claude Code. Only one Claude Code runs at a time.

What Claude Code writes stays in `workspace/` on the host (gitignored), from one run to the next. How it is organized is up to the configuration's system prompt.

To watch the memory while the agent works, open `http://localhost:9501/` on the host and log in with the viewer token (`MEMORY_VIEWER_TOKEN` in `../memory_server/.env`).

## Configurations

A configuration is a folder:

```
<configuration>/
  config.json         see below
  system-prompt.md    appended to Claude Code's system prompt (--append-system-prompt)
  skills/<name>/      skills, each with its SKILL.md
  files/              copied into the workspace each time Claude Code starts
```

`config.json`:

| Field | Meaning |
|---|---|
| `name` | Shown in the console. |
| `systemPrompt` | Path of the system prompt file in the folder. |
| `domains` | Internet domains Claude Code may reach, on top of `api.anthropic.com` and `claude.ai`. |
| `hostPorts` | Ports Claude Code may reach on the host (`host.docker.internal`). |
| `tools.builtin` | Claude Code built-in tools (`claude --tools`): `"default"` for all of them, or a list of names such as `["Bash", "Read", "Edit"]`. |
| `tools.mcpServers` | MCP servers, in the `mcpServers` format of `.mcp.json` (`${VAR}` and `${VAR:-default}` are expanded by Claude Code). Only these are loaded (`--strict-mcp-config`). |
| `env` | Variables of the container (e.g. from `memory.env`) passed on to Claude Code. |
| `checks` | `{name, url, headers}`: HTTP GETs that must answer 2xx before Claude Code starts (`${VAR}` expanded from the container environment). |

Skills are not listed in `config.json`: every folder `skills/<name>/` of the configuration is installed, and must hold a `SKILL.md`. The skills built into the image (`playwright-cli`) are installed in every run too; a configuration skill of the same name replaces a built-in one. A built-in skill also brings the files its installer wrote: `playwright-cli` comes with `.playwright/cli.config.json` (Chromium), which `files/` can override.

The memory store is a parameter of the configuration: the `X-Memory-Store` header of its memory MCP server, e.g. `"X-Memory-Store": "my-store"`, and a check on `${MEMORY_URL:-http://host.docker.internal:9501}/api/stores/my-store/list?depth=1&limit=1` with the agent token, which fails if the token cannot reach the store.

To allow another Web site or host port, edit `config.json`, upload the folder again and start Claude Code again.

## Security

- The firewall (`init-firewall.sh`) denies all outbound traffic except DNS, the base domains, and the domains and host ports of the configuration of the running Claude Code. Domains are resolved when the firewall is applied (at container start, and each time Claude Code starts and ends).
- Claude Code runs as the user `node`; the console runs as root, because it programs the firewall. The `node` user cannot connect to the console's port, so Claude Code cannot upload a looser configuration or start another Claude Code itself. It cannot read the uploaded configurations either.
- The console's port is published on `127.0.0.1` only, and the console refuses requests whose `Host` or `Origin` is not local.

## Development

The console is in `server/` (Fastify, node-pty, Preact, xterm.js):

```bash
cd server
npm install
npm test
npm run typecheck
npm run build
```
