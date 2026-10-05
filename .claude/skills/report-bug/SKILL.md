---
name: report-bug
description: Publish a bug report Markdown file as an issue in the SquashTM staging GitLab project, uploading its PNG screenshots. Use only when the user explicitly asks to create a GitLab issue for a bug (e.g. "publish/file/report bug_003 in GitLab").
allowed-tools: Bash(node .claude/skills/report-bug/scripts/report-bug.mjs:*)
---

# Report a Bug in GitLab

Creates an issue in https://gitlab.com/henixdevelopment/squash/squash-tm/core/squashtest-tm-staging from a bug report written in GitLab Flavored Markdown. Requires the `GITLAB_TOKEN` environment variable.

## Quick start

```bash
node .claude/skills/report-bug/scripts/report-bug.mjs test_environment/session_13/bug_002.md --priority Medium
```

## Options

| Flag | Required | Effect |
|------|----------|--------|
| `--priority <Highest\|High\|Medium\|Low\|Lowest>` | yes | Sets the `Priority::<P>` label. |
| `--security` | no | Adds the `Security` label and makes the issue confidential. |
| `--draft` | no | Sets `Status::Draft` and assigns the issue to the token owner. Without it: `Status::Backlog`, unassigned. |
| `--display` | no | Opens the created issue in the browser. |

The labels `Type::Bug` and `ProdImpact::ToBeAnalyzed` are always set.

## Input file

- Must have the `.md` extension.
- The first `# ` heading becomes the issue title and the rest becomes the description.
- Local `.png` files referenced as `![alt](file.png)` or `<img src="file.png">` are uploaded. A missing file aborts the run before anything is created.

## Output

- Success: stdout is the issue URL only, and the exit code is 0.
- `Warning: ...` on stderr means the issue was created but a label, the confidential flag or the assignment did not take effect. Report the warning to the user.
- Failure: stderr has one `Error: ...` line and the exit code is 1.

## Rules

- Run the script only when the user explicitly asked to publish that bug.
- Ask the user for the priority, and whether the bug is a security issue or a draft, when they did not say. Do not guess.
- Run the script once per bug. Never rerun it after a success, because that would create a duplicate issue.
- Give the user the issue URL printed by the script.
