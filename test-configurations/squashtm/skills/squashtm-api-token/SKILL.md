---
name: squashtm-api-token
description: Get a bearer token of the SquashTM administrator for calling the SquashTM REST API.
allowed-tools: Bash(node:*)
---

# Get a SquashTM REST API Token

The script prints a personal API token of `admin` (read and write, valid one year).

## Quick start

```bash
TOKEN=$(node .claude/skills/squashtm-api-token/scripts/squashtm-api-token.mjs)
curl -s -H "Authorization: Bearer $TOKEN" http://host.docker.internal:8090/squash/api/rest/latest/projects | jq
```

If the REST API answers 401 with this token (it was revoked, or SquashTM was reset), get a new one:

```bash
TOKEN=$(node .claude/skills/squashtm-api-token/scripts/squashtm-api-token.mjs --refresh)
```
