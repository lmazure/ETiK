# Test configurations

Each folder is a configuration of the test container: upload it from the ETiK console (see [`../test_environment/README.md`](../test_environment/README.md), which also describes the format of `config.json`).

## squashtm

Exploratory testing of SquashTM: Claude Code tests SquashTM's UI, with Playwright CLI, and its public REST API, and keeps everything in the memory store `squashtm`:

```
/knowledge/business-rules.md          cross-cutting rules
/knowledge/<entity>.md                one document per business entity
/sessions/NNN/charter.md              one folder per Session (001, 002…)
/sessions/NNN/checklist.md
/sessions/NNN/log/log.md              append-only replay log
/sessions/NNN/log/<screenshot>.png
/sessions/NNN/issues/MMM/issue.md     one folder per issue (001, 002…)
/sessions/NNN/issues/MMM/<screenshot>.png
```

Markdown documents are written with the `memory_*` tools, each with a document tag naming its kind: `entity` or `cross-cutting` for the knowledge base, `charter`, `checklist`, `log` or `issue` for a Session; screenshots and videos have none. Screenshots are taken into the workspace's `tmp/` folder, then uploaded with the `memory-upload` skill (`squashtm/skills/memory-upload/`), which sends the file to the memory server's REST API with `MEMORY_URL` and `MEMORY_AGENT_TOKEN`: the image never goes through the conversation. The workspace only holds temporary files.

REST API calls authenticate with a bearer token of `admin`, given by the `squashtm-api-token` skill (`squashtm/skills/squashtm-api-token/`), which creates it through SquashTM's private API and caches it. The `get-logs` skill uses it too.

Prerequisites, on the host:
- SquashTM listening on port 8090, e.g. started with Docker Compose as described in the [SquashTM Docker quick start](https://tm-en.doc.squashtest.com/latest/install-guide/installation/install-squash/docker-install.html#quick-start), with its port published on 8090.
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtm` (`MEMORY_AGENT_TOKENS=squashtm=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`.

The store is set in `squashtm/config.json` (the `X-Memory-Store` header of the `memory` MCP server and the `memory agent token` check); the knowledge base instructions copied into the workspace (`squashtm/files/knowledge/INSTRUCTIONS.md`) and the `memory-upload` script name it too.

## squashtmsite

Review of the SquashTM marketing site (spelling, translations, links, forms, claims): Claude Code browses the site with Playwright CLI, writes one report per issue, and keeps everything in the memory store `squashtmsite`:

```
/knowledge/pages/<page>.md            one document per page or page type
/knowledge/brand-and-voice.md         cross-cutting rules and facts
/knowledge/site-structure.md
/knowledge/tracking-and-tech.md
/sessions/NNN/log/log.md              append-only replay log, with the review scope
/sessions/NNN/log/<screenshot>.png
/sessions/NNN/issues/MMM/issue.md     one folder per issue (001, 002…)
/sessions/NNN/issues/MMM/<screenshot>.png
```

Documents are tagged as for `squashtm`: `page` or `cross-cutting` for the knowledge base, `log` or `issue` for a Session. Screenshots are uploaded as for `squashtm`, with `squashtmsite/skills/memory-upload/`: a copy of squashtm's skill whose script names the store `squashtmsite`.

Prerequisites, on the host:
- The memory server listening on port 9501 (see [`../memory_server/README.md`](../memory_server/README.md)), with an agent token for the store `squashtmsite` (`MEMORY_AGENT_TOKENS=squashtmsite=…` in `../memory_server/.env`).
- That token as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env`. `memory.env` holds a single agent token: to run both configurations without editing it, list the same token for both stores (`MEMORY_AGENT_TOKENS=squashtm=TOKEN,squashtmsite=TOKEN`); otherwise, change `MEMORY_AGENT_TOKEN` and run `docker compose up -d` again when you switch configurations.

The site URL is set in `squashtmsite/config.json` (`domains`) and in `squashtmsite/system-prompt.md`. The store is set in `squashtmsite/config.json`, in `squashtmsite/files/knowledge/INSTRUCTIONS.md` and in the `memory-upload` script, as for `squashtm`.

## gitlab-analysis

Analysis of the SquashTM bugs reported in the GitLab staging project: Claude Code reads an issue and the code of SquashTM, finds why the bug happens and how to fix it, and suggests further tests as Exploratory Test Charters. It **cannot write to GitLab**: it has a read-only token, and writes its results to the memory store `squashtm`, from where Claude Code on the host posts them after your review (the `gitlab-post-analysis` skill, see the root `README.md`).

```
/analyses/<iid>/analysis.md           the comment to post on issue #<iid>
/analyses/<iid>/fix.diff              optional: the proposed fix, a git diff (metadata: project, target_branch, base_sha)
```

It reads `/knowledge/` and `/sessions/` (the issue reports and logs a GitLab issue often comes from), and never writes them. Documents are tagged `analysis` and `fix`; change notes start with `analysis_<iid>`.

Skills:
- `gitlab-read`: reads an issue (description, comments, linked issues) or searches issues, with `GITLAB_READ_TOKEN`;
- `repo-sync`: clones or fetches a code project into `/repos/` (the `repos` volume, which never reaches the workspace on the host) and checks out a branch, a tag or a commit;
- `fix-upload`: stores the changes of a checkout as `/analyses/<iid>/fix.diff`, exactly as `git diff` writes them.

`gitlab-read` and `repo-sync` refuse to run when the token has any scope other than `read_*`.

The code projects to clone are listed in `gitlab-analysis/files/code-projects.md`: fill it in before the first run. The agent cannot build the code or run its tests: it says so in its analysis.

Prerequisites, on the host:
- The memory server listening on port 9501, with an agent token for the store `squashtm`, as `MEMORY_AGENT_TOKEN` in `../test_environment/memory.env` (as for `squashtm`).
- A **read-only** GitLab token (scopes `read_api` and `read_repository` only, e.g. a group access token with the Reporter role) that reads the staging project and the code projects, as `GITLAB_READ_TOKEN` in `../test_environment/gitlab.env`.
- To test and analyse at the same time, a second instance of the test container (see `../test_environment/README.md`).

The firewall opens `gitlab.com` (API and git over HTTPS) while it runs. The private code goes to the Anthropic API like any code Claude Code reads, and only short excerpts go to the memory store.
