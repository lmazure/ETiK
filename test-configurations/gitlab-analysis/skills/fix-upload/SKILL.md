---
name: fix-upload
description: Save the changes made in a checkout of /repos/ as the fix proposed for a GitLab issue, /analyses/<iid>/fix.diff in the memory server, exactly as git produces it. Use it once the fix is written in the checkout, instead of writing the diff with memory_write.
allowed-tools: Bash(node .claude/skills/fix-upload/scripts/fix-upload.mjs:*)
---

# Save a Proposed Fix

Runs `git diff HEAD` in `/repos/<project>/` (new files included) and stores the result as `/analyses/<iid>/fix.diff` in the store `squashtm`, with the tag `fix` and the metadata `project`, `target_branch` and `base_sha` (the commit of the checkout). The diff goes straight from git to the memory server, so it applies exactly as it was written. On the host, the user turns it into a Draft merge request after reviewing it.

## Quick start

```bash
node .claude/skills/fix-upload/scripts/fix-upload.mjs henixdevelopment/squash/squash-tm/core/squash-tm 1234 --target-branch master
```

## Options

| Option | Effect |
|--------|--------|
| `<project path>` | The project whose checkout holds the changes (synced with `repo-sync`). |
| `<issue iid>` | The analysed issue. |
| `--target-branch <branch>` | The branch the merge request would target: usually the default branch, or the maintenance branch of the analysed version. |
| `--overwrite` | Replace an existing `fix.diff`. Without it, the document must not exist yet. |

## Output

- Success: `OK /analyses/<iid>/fix.diff version=N (created)`, the base commit and `git diff --stat` on stdout, exit code 0.
- Failure: one `Error: ...` line on stderr, exit code 1. Nothing is stored.

## Rules

- Only text changes: a diff touching a binary file is refused.
- Keep the fix minimal: only the change that fixes the issue, in the style of the surrounding code, with a test when the project has tests for that code.
- The checkout keeps the changes: after the upload, `repo-sync` needs `--discard` to check out another ref.
