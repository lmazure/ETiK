---
name: gitlab-publish
description: Publish to the SquashTM staging GitLab project what is stored in the memory server, uploading its PNG screenshots and WebM videos - an issue report as a new issue, or a comment (note) on an existing issue. Use only when the user explicitly asks to create a GitLab issue for a bug (e.g. "publish/file/report /sessions/042/issues/007/issue.md in GitLab"), or when the gitlab-sync or gitlab-post-analysis skill has the user's approval to create an issue or post a comment. Its read-only `check` command lists the GitLab references and mentions of a text before it is published.
allowed-tools: Bash(node .claude/skills/gitlab-publish/scripts/gitlab-publish.mjs:*)
---

# Publish to GitLab

Writes to https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging what is stored in the memory server, written in GitLab Flavored Markdown:

- `issue`: creates an issue from an issue report (e.g. `/sessions/042/issues/007/issue.md`);
- `note`: posts a comment on an existing issue from a local Markdown file, whose referenced screenshots and videos are in the memory server;
- `check`: writes nothing; lists what GitLab would turn into links or notifications in a text (see [GitLab references](#gitlab-references)).

Requires the `GITLAB_TOKEN` and `MEMORY_TOKEN` environment variables (`MEMORY_TOKEN`: a memory server token that reads the store; the viewer token is enough). The script only reads the memory server. `check` needs no token for a local file, and only `MEMORY_TOKEN` for a memory document.

## Quick start

```bash
node .claude/skills/gitlab-publish/scripts/gitlab-publish.mjs issue /sessions/042/issues/007/issue.md \
  --memory-url http://localhost:9501 --store squashtm --priority Medium

node .claude/skills/gitlab-publish/scripts/gitlab-publish.mjs note --iid 1234 --body-file tmp/note-1234.md \
  --media-base /sessions/042/issues/007/ --memory-url http://localhost:9501 --store squashtm

node .claude/skills/gitlab-publish/scripts/gitlab-publish.mjs check /sessions/042/issues/007/issue.md \
  --memory-url http://localhost:9501 --store squashtm
node .claude/skills/gitlab-publish/scripts/gitlab-publish.mjs check --body-file tmp/note-1234.md
```

## Options

Common to `issue` and `note`:

| Flag | Required | Effect |
|------|----------|--------|
| `--memory-url <url>` | yes | Base URL of the memory server, e.g. `http://localhost:9501`. No default. |
| `--store <store>` | yes | Memory store holding the documents, e.g. `squashtm`. No default. |
| `--display` | no | Opens the created issue or note in the browser. |

`issue <memory path>`:

| Flag | Required | Effect |
|------|----------|--------|
| `<memory path>` | yes | Absolute path of the issue report in the store, e.g. `/sessions/042/issues/007/issue.md`. |
| `--priority <Highest\|High\|Medium\|Low\|Lowest>` | yes | Sets the `Priority::<P>` label. |
| `--team <AI\|Performance\|TestManagement\|PCI>` | no | Sets the `Team::<T>` label. Without it, no team label. |
| `--security` | no | Adds the `Security` label and makes the issue confidential. |
| `--draft` | no | Sets `Status::Draft` and assigns the issue to the token owner. Without it: `Status::Backlog`, unassigned. |
| `--related <issue>` | no | Links the new issue to that issue (`relates_to`): `1234` or `#1234` in the project, `group/project#1234` or the issue's URL (`…/-/work_items/1234` or `…/-/issues/1234`) in another project, e.g. `henixdevelopment/squash/squash-tm/tm-plugin/api/squash-tm-api-rest#464`. Repeat it for several issues. |

The labels `Type::Bug` and `ProdImpact::ToBeAnalyzed` are always set.

`note`:

| Flag | Required | Effect |
|------|----------|--------|
| `--iid <iid>` | yes | The issue to comment on, e.g. `1234` or `#1234`. |
| `--body-file <file>` | yes | Local Markdown file holding the comment. |
| `--media-base <memory folder>` | no | Folder against which relative media references are resolved, e.g. `/sessions/042/issues/007/`. Without it, media references must be absolute. |

`check`: either a local file, or a memory document:

| Flag | Required | Effect |
|------|----------|--------|
| `--body-file <file>` | one of the two | Local Markdown file to check. |
| `<memory path>` + `--memory-url <url>` + `--store <store>` | one of the two | Memory document to check, e.g. `/sessions/042/issues/007/issue.md` (its title included, with the document's line numbers). |

## Input

- `issue`: the document must have the `.md` extension. The first `# ` heading becomes the issue title and the rest becomes the description.
- `.png` and `.webm` documents referenced as `![alt](file.png)`, `[text](file.webm)`, `<img src="file.png">` or `<video src="file.webm">` are downloaded from the memory server and uploaded to GitLab. A relative reference is resolved against the issue report's folder (`issue`) or `--media-base` (`note`): `shot.png` in `/sessions/042/issues/007/issue.md` is `/sessions/042/issues/007/shot.png`; an absolute one (`/sessions/042/log/shot.png`) is taken as is. GitLab renders `![alt](file.webm)` as an inline video player.
- Everything is read and checked first: a missing document or referenced file, or an unknown issue for `note`, aborts the run before anything is written to GitLab.
- A line that GitLab would run as a quick action (e.g. `/close`, `/assign @someone`), outside a fenced code block, aborts the run: only the script adds quick actions.
- `issue` refuses a report whose metadata already has `gitlab_issue` (it was already published or linked): comment on that issue instead.

## Output

- Success: stdout is the URL only (the issue, or the note: `…/issues/1234#note_5678`), and the exit code is 0.
- `Warning: ...` on stderr means the issue was created but a label, the confidential flag, the assignment or a related link did not take effect. Report the warning to the user.
- `Info: ...` on stderr, after a publication, lists the GitLab references and mentions of the posted text, by kind. Report them to the user when they were not reviewed with `check` before.
- Failure: stderr has one `Error: ...` line and the exit code is 1.
- `check`: stdout is the report, and the exit code is 0 whatever it finds. Each reference is listed once with its line numbers, grouped by what it does once posted (see below). An item URL is shown as `group/project#N (URL)`.

## GitLab references

Outside code (fenced blocks, inline code spans and HTML comments), GitLab turns some text into links or notifications:

| Syntax | Effect once posted |
|---|---|
| `@name`, `@group/sub` | Notifies that user, or every member of that group (`@all`: everyone in the project) |
| `#N`, `!N`, `&N` (epic), `$N` (snippet), `project#N`, `group/project#N`, and the URL of an issue or a merge request | A link, plus a "mentioned in" note on the target |
| `~label`, `~"two words"`, `~N`, `%milestone`, `%"two words"`, `*iteration:…` | A link to that label, milestone or iteration |
| `- [ ]`, `- [x]` starting a list item; `[[_TOC_]]` or `[TOC]` alone on a line | A clickable task box; a table of contents |
| A line starting with `/close`, `/assign` and so on | A quick action: `issue` and `note` refuse it |

Texts written for the memory server (issue reports, logs, analyses) are not written for GitLab: some of these are accidents, e.g. a browser request number `#45`, an approximate time `~20:02`, a Java annotation `@Id` outside code, or `#464` meaning an issue of another project. So, before publishing a text, run `check` on it and, for each reference:

- `@name`: put it in backticks (`` `@name` ``). A report or a log never means to notify someone; keep the mention only if the user asks to notify that person.
- `#N`, `!N`, `&N`, `$N`: keep it only if it means that issue, merge request, epic or snippet of the staging project. An issue of another project must be written with its full path, e.g. `henixdevelopment/squash/squash-tm/tm-plugin/api/squash-tm-api-rest#464`: a bare `#464` points to the staging issue #464, and a path without its group (`squash-tm-api-rest#464`) points to nothing. Anything else goes in backticks.
- `~…`, `%…`, `*iteration:…`, task boxes, tables of contents: in backticks or reworded, unless they mean that GitLab object.
- Tell the user which issues and merge requests will get a "mentioned in" note: unrelated issues cited in the text will get one too.

Fix a local file directly. For an issue report or another memory document, show the user the changes and apply them with `memory_edit` (`str_replace`, `change_note: "gitlab: escape GitLab references"`) once they approve. Then run `check` again.

## Rules

- Run `issue` and `note` only when the user explicitly asked for that publication. `check` can be run at any time.
- Before `issue` or `note`, run `check` on the same text and handle what it finds as described in [GitLab references](#gitlab-references).
- For `issue`, ask the user for the priority, the team (`AI`, `Performance`, `TestManagement`, `PCI`, or none), and whether the bug is a security issue or a draft, when they did not say. Do not guess.
- When you ask whether to link the new issue to another one (`--related`), give the full URL of that issue (`https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging/-/work_items/<iid>`, or the URL in its own project) in the message text, so that the user can click it to open the issue in their browser: a URL inside a question option is not clickable.
- Ask the user for the memory server URL and the store when they did not give them. Do not guess.
- Run the script once per publication. Never rerun it after a success, because that would create a duplicate.
- After a success, record the link on the issue report with `memory_edit`, when the `memory` MCP tools are available; otherwise tell the user the link was not recorded. Operation `set_metadata`, with `change_note: "gitlab: …"`:
  - after `issue`: `metadata: {"gitlab_issue": "<issue URL>", "gitlab_link": "created"}`;
  - after `note`: `metadata: {"gitlab_issue": "<issue URL, without #note_…>", "gitlab_link": "commented", "gitlab_note": "<note URL>"}`.
- Give the user the URL printed by the script.
- After changing the script, run its tests: `node --test .claude/skills/gitlab-publish/scripts/gitlab-publish.test.mjs`.
