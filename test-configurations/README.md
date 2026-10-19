# Test configurations

Each folder is a configuration of the test container: upload it from the ETiK console (see [`../test_environment/README.md`](../test_environment/README.md), which also describes the format of `config.json`).

## squashtm

Exploratory testing of SquashTM: Claude Code drives SquashTM's UI with Playwright CLI and keeps everything in the memory store `squashtm`:

```
/knowledge/business-rules.md          cross-cutting rules
/knowledge/<entity>.md                one document per business entity
/sessions/NNN/charter.md              one folder per Session (001, 002…)
/sessions/NNN/checklist.md
/sessions/NNN/log/log.md              append-only replay log
/sessions/NNN/log/<screenshot>.png
/sessions/NNN/bugs/MMM/bug.md         one folder per bug (001, 002…)
/sessions/NNN/bugs/MMM/<screenshot>.png
```

Markdown documents are written with the `memory_*` tools. Screenshots are taken into the workspace's `tmp/` folder, then uploaded with the `memory-upload` skill (`squashtm/skills/memory-upload/`), which sends the file to the memory server's REST API with `MEMORY_URL` and `MEMORY_AGENT_TOKEN`: the image never goes through the conversation. The workspace only holds temporary files.

Prerequisites, on the host:
- SquashTM listening on port 8090, e.g. started with Docker Compose as described in the [SquashTM Docker quick start](https://tm-en.doc.squashtest.com/latest/install-guide/installation/install-squash/docker-install.html#quick-start), with its port published on 8090.
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtm` (`MEMORY_AGENT_TOKENS=squashtm=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`.

The store is set in `squashtm/config.json` (the `X-Memory-Store` header of the `memory` MCP server and the `memory agent token` check); the knowledge base instructions copied into the workspace (`squashtm/files/knowledge/INSTRUCTIONS.md`) and the `memory-upload` script name it too.

## squashtmsite

Review of the SquashTM marketing site (spelling, translations, links, forms, claims): Claude Code browses the site with Playwright CLI, writes one report per issue, and keeps its knowledge of the site in the memory store `squashtmsite`.

Prerequisites, on the host:
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtmsite` (`MEMORY_AGENT_TOKENS=squashtmsite=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`. `memory.env` holds a single agent token: to run both configurations without editing it, list the same token for both stores (`MEMORY_AGENT_TOKENS=squashtm=TOKEN,squashtmsite=TOKEN`); otherwise, change `MEMORY_AGENT_TOKEN` and run `docker compose up -d` again when you switch configurations.

The site URL is set in `squashtmsite/config.json` (`domains`) and in `squashtmsite/system-prompt.md`. The store is set in `squashtmsite/config.json` and in `squashtmsite/files/knowledge/INSTRUCTIONS.md`, as for `squashtm`.
