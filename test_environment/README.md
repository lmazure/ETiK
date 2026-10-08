# Test dev container

## Prerequisites

On the host:
- SquashTM listening on port 8090 (see the Docker Compose file in `../notes.md`).
- The memory server listening on port 9501 (see `../memory_server/README.md`), with an agent token for the store `squashtm`.

Copy `memory.env.example` to `memory.env` and set `MEMORY_AGENT_TOKEN` to that agent token (the value after `squashtm=` in `MEMORY_AGENT_TOKENS` of `../memory_server/.env`). `memory.env` is gitignored. The agent can read it, but it only holds the agent's own token; the admin token stays outside the dev container.

## Usage

The first time, in VS Code:
1) Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers).
1) Execute the command `Dev Containers: Rebuild and Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `./start-session.sh`.

Then, the next times:
1) Execute the command `Dev Containers: Reopen in Container`.
1) Execute the command `Terminal: Create New Terminal`.
1) In the new terminal, run `./start-session.sh`.

`start-session.sh` checks that the memory server answers and accepts the token, creates the next `session_##` directory, then runs `claude --dangerously-skip-permissions` (its arguments are passed on) with `MEMORY_SESSION` set to that name.
Claude Code connects to the memory server through `.mcp.json`; every memory change is recorded with the Session that made it.

To watch the memory while the agent works, open `http://localhost:9501/` on the host and log in with the viewer token (`MEMORY_VIEWER_TOKEN` in `../memory_server/.env`).

## Notes

The firewall (`.devcontainer/init-firewall.sh`) only lets the container reach a few Web sites and, on the host, only the ports listed in `HOST_PORTS` (SquashTM and the memory server). If you need to access other Web sites or host ports, modify that script and restart the container.
