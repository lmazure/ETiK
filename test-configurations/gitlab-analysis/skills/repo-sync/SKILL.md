---
name: repo-sync
description: Clone or update a GitLab code repository (private ones included) into /repos/ with the read-only token, and check out a branch, a tag (e.g. the SquashTM version under test) or a commit. Use it before reading any code.
allowed-tools: Bash(node .claude/skills/repo-sync/scripts/repo-sync.mjs:*)
---

# Clone or Update a Code Repository

Clones `https://gitlab.com/<project>.git` into `/repos/<project>/` the first time, fetches it the next times, then checks out the wanted ref, detached, and removes untracked files. `/repos/` is a Docker volume: the code never goes to the workspace on the host. The token reaches git through a credential helper; it is never written in the clone. The script refuses to run when the token is not read-only.

## Quick start

```bash
node .claude/skills/repo-sync/scripts/repo-sync.mjs henixdevelopment/squash/squash-tm/core/squash-tm            # default branch
node .claude/skills/repo-sync/scripts/repo-sync.mjs henixdevelopment/squash/squash-tm/core/squash-tm 11.0.0     # a tag
```

## Arguments

| Argument | Effect |
|----------|--------|
| `<project path>` | The GitLab project, e.g. one listed in `code-projects.md`. |
| `<ref>` | Optional: a branch, a tag or a commit SHA. Default: the default branch. A branch is taken from the remote, so it is always up to date. |
| `--discard` | Drop the local changes of the checkout. Without it, the script refuses to run while the checkout has local changes. |

## Output

On success, exit code 0 and:

```
Project: henixdevelopment/squash/squash-tm/core/squash-tm
Path: /repos/henixdevelopment/squash/squash-tm/core/squash-tm
Ref: 11.0.0 (tag)
Commit: 3f2c… 2026-09-30T10:12:00+02:00 Release 11.0.0
Permalinks: https://gitlab.com/henixdevelopment/squash/squash-tm/core/squash-tm/-/blob/3f2c…/<path>#L<line>
Default branch: master
Version tags, newest first: 11.0.0, 10.2.1, …
```

Use the `Permalinks` pattern, with the full SHA, for every code reference of the analysis. On failure: one `Error: ...` line on stderr, exit code 1.

## Reading the code

Use the usual tools in the checkout (`Grep`, `Read`, `git -C <path> log`, `git -C <path> blame`, `git -C <path> show`). Do not fetch, push or change the remote yourself. To propose a fix, edit the files of the checkout, then save the diff with the `fix-upload` skill before syncing again.
