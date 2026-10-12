# Instructions for AI agents

These rules apply to any AI agent changing this repository.
The exploratory-testing agent that runs in the test container has its own instructions: the system prompt [`test_environment/configurations/squashtm/system-prompt.md`](test_environment/configurations/squashtm/system-prompt.md). Only `test_environment/workspace/` is mounted there, so it never sees this file.

## Keep the memory server API reference up to date

[`memory_server/API.md`](memory_server/API.md) documents the MCP tools and the REST API of the memory container.
It must always match the code.

**Any change under `memory_server/` that changes what a caller sees must update `memory_server/API.md` in the same commit.** This includes changes to:

- the tools: names, descriptions, parameters, defaults, limits ([`src/schemas.ts`](memory_server/src/schemas.ts));
- MCP registration, annotations, transport or text results ([`src/mcp/`](memory_server/src/mcp/));
- REST routes, query parameters, headers, bodies, status codes, the OpenAPI document ([`src/api/`](memory_server/src/api/));
- error codes and their messages ([`src/core/errors.ts`](memory_server/src/core/errors.ts) and the core);
- tokens, roles and store selection ([`src/auth.ts`](memory_server/src/auth.ts));
- limits and environment variables ([`src/config.ts`](memory_server/src/config.ts));
- rules enforced by the core: paths, versions, sections, edits, search, move, delete, restore, history ([`src/core/`](memory_server/src/core/)).

A pure refactoring, a test or a web app change that leaves both interfaces unchanged needs no update.

Before finishing such a change:

1. Compare the tool sections of `API.md` with `src/schemas.ts` (tool names, parameters, types, defaults, descriptions) and with `src/mcp/format.ts` (sample outputs).
2. Compare the REST sections and the endpoint summary with the routes in `src/api/rest.ts`, and keep `src/api/openapi.ts` consistent with them.
3. Update the error code table when a code, a status or a cause changes.
4. Keep the short tool list in [`memory_server/README.md`](memory_server/README.md) and its links to `API.md` valid.
5. When a tool is added, renamed or removed, also update the tool names used in [`test_environment/configurations/squashtm/files/knowledge/INSTRUCTIONS.md`](test_environment/configurations/squashtm/files/knowledge/INSTRUCTIONS.md) and in `test_environment/configurations/squashtm/system-prompt.md`.
6. Run `npm test` in `memory_server/`.

When in doubt, run the server and check the real outputs against the document.
