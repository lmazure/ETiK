# Test configurations

Each folder is a configuration of the test container: upload it from the ETiK console (see [`../test_environment/README.md`](../test_environment/README.md), which also describes the format of `config.json`).

## squashtm

Exploratory testing of SquashTM: Claude Code drives SquashTM's UI with Playwright CLI and keeps its knowledge of the application in the memory store `squashtm`.

Prerequisites, on the host:
- SquashTM listening on port 8090, e.g. started with Docker Compose as described in the [SquashTM Docker quick start](https://tm-en.doc.squashtest.com/latest/install-guide/installation/install-squash/docker-install.html#quick-start), with its port published on 8090.
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtm` (`MEMORY_AGENT_TOKENS=squashtm=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`.

The store is set in `squashtm/config.json` (the `X-Memory-Store` header of the `memory` MCP server and the `memory agent token` check); the knowledge base instructions copied into the workspace (`squashtm/files/knowledge/INSTRUCTIONS.md`) name it too.

## squashtmsite

Review of the SquashTM marketing site (spelling, translations, links, forms, claims): Claude Code browses the site with Playwright CLI, writes one report per issue, and keeps its knowledge of the site in the memory store `squashtmsite`.

Prerequisites, on the host:
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtmsite` (`MEMORY_AGENT_TOKENS=squashtmsite=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`. `memory.env` holds a single agent token: to run both configurations without editing it, list the same token for both stores (`MEMORY_AGENT_TOKENS=squashtm=TOKEN,squashtmsite=TOKEN`); otherwise, change `MEMORY_AGENT_TOKEN` and run `docker compose up -d` again when you switch configurations.

The site URL is set in `squashtmsite/config.json` (`domains`) and in `squashtmsite/system-prompt.md`. The store is set in `squashtmsite/config.json` and in `squashtmsite/files/knowledge/INSTRUCTIONS.md`, as for `squashtm`.
