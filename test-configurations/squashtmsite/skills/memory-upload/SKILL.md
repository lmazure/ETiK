---
name: memory-upload
description: Upload a local screenshot (PNG, JPEG, GIF, WebP) or video (WebM) to the memory server, as a binary document of the store squashtmsite. Use it for every screenshot or video of a Session log or issue report.
allowed-tools: Bash(node .claude/skills/memory-upload/scripts/memory-upload.mjs:*)
---

# Upload a File to the Memory Server

Sends the bytes of a local file straight to the memory server, without passing them through the conversation.

## Quick start

```bash
node .claude/skills/memory-upload/scripts/memory-upload.mjs tmp/pricing-typo.png /sessions/007/issues/002/pricing-typo.png \
  --change-note "session_007: typo on the pricing page"
```

## Options

| Option | Effect |
|--------|--------|
| `<local file>` | The file to send. Its extension must be the same as the memory path's. |
| `<memory path>` | Absolute path of the binary document, ending with `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.webm`. |
| `--overwrite` | Replace an existing document. Without it, the document must not exist yet. |
| `--description <text>` | One line stating what the file shows. |
| `--change-note <text>` | Kept in the history; starts with the Session name. |

## Output

- Success: `OK <memory path> version=N (created)` on stdout, exit code 0.
- Failure: one `Error: ...` line on stderr, exit code 1. Nothing is stored. `already exists` means another file already has this path: choose another name.

## Reading it back

`memory_read` on the memory path returns the image. Reference it from a Markdown document of the same folder by its file name, e.g. `![Typo on the pricing page](pricing-typo.png)`.
