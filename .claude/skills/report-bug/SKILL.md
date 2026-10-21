---
name: report-bug
description: Publish an issue report stored in the memory server as an issue in the SquashTM staging GitLab project, uploading its PNG screenshots and WebM videos. Use only when the user explicitly asks to create a GitLab issue for a bug (e.g. "publish/file/report /sessions/042/issues/007/issue.md in GitLab").
allowed-tools: Bash(node .claude/skills/report-bug/scripts/report-bug.mjs:*)
---

# Report a Bug in GitLab

Creates an issue in https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging from an issue report written in GitLab Flavored Markdown and stored in the memory server. Requires the `GITLAB_TOKEN` and `MEMORY_TOKEN` environment variables (`MEMORY_TOKEN`: a memory server token that reads the store; the viewer token is enough).

## Quick start

```bash
node .claude/skills/report-bug/scripts/report-bug.mjs /sessions/042/issues/007/issue.md \
  --memory-url http://localhost:9501 --store squashtm --priority Medium
```

## Options

| Flag | Required | Effect |
|------|----------|--------|
| `<memory path>` | yes | Absolute path of the issue report in the store, e.g. `/sessions/042/issues/007/issue.md`. |
| `--memory-url <url>` | yes | Base URL of the memory server, e.g. `http://localhost:9501`. No default. |
| `--store <store>` | yes | Memory store holding the bug, e.g. `squashtm`. No default. |
| `--priority <Highest\|High\|Medium\|Low\|Lowest>` | yes | Sets the `Priority::<P>` label. |
| `--security` | no | Adds the `Security` label and makes the issue confidential. |
| `--draft` | no | Sets `Status::Draft` and assigns the issue to the token owner. Without it: `Status::Backlog`, unassigned. |
| `--display` | no | Opens the created issue in the browser. |

The labels `Type::Bug` and `ProdImpact::ToBeAnalyzed` are always set.

## Input document

- Must have the `.md` extension.
- The first `# ` heading becomes the issue title and the rest becomes the description.
- `.png` and `.webm` documents referenced as `![alt](file.png)`, `[text](file.webm)`, `<img src="file.png">` or `<video src="file.webm">` are downloaded from the memory server and uploaded to GitLab. A relative reference is resolved against the issue report's folder (`shot.png` in `/sessions/042/issues/007/issue.md` is `/sessions/042/issues/007/shot.png`); an absolute one (`/sessions/042/log/shot.png`) is taken as is. GitLab renders `![alt](file.webm)` as an inline video player.
- Everything is read from the memory server first: a missing issue report or referenced file aborts the run before anything is created in GitLab.

## Output

- Success: stdout is the issue URL only, and the exit code is 0.
- `Warning: ...` on stderr means the issue was created but a label, the confidential flag or the assignment did not take effect. Report the warning to the user.
- Failure: stderr has one `Error: ...` line and the exit code is 1.

## Rules

- Run the script only when the user explicitly asked to publish that bug.
- Ask the user for the priority, and whether the bug is a security issue or a draft, when they did not say. Do not guess.
- Ask the user for the memory server URL and the store when they did not give them. Do not guess.
- Run the script once per bug. Never rerun it after a success, because that would create a duplicate issue.
- Give the user the issue URL printed by the script.
