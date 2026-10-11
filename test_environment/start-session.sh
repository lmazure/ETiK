#!/bin/bash
# Starts an Exploratory Test Session: checks that the memory server answers, creates the next
# session_## directory and runs Claude Code with MEMORY_SESSION set to its name.
# .mcp.json sends MEMORY_SESSION to the memory server (X-Memory-Session header), so every
# memory change is recorded with the Session that made it.
# Arguments are passed to claude.

set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f memory.env ]; then
    echo "ERROR: memory.env is missing: copy memory.env.example to memory.env and set MEMORY_AGENT_TOKEN." >&2
    exit 1
fi
set -a
# shellcheck source=memory.env.example
. ./memory.env
set +a
if [ -z "${MEMORY_AGENT_TOKEN:-}" ]; then
    echo "ERROR: MEMORY_AGENT_TOKEN is not set in memory.env." >&2
    exit 1
fi
export MEMORY_URL="${MEMORY_URL:-http://host.docker.internal:9501}"

if ! curl -fsS --max-time 5 -o /dev/null "$MEMORY_URL/health"; then
    echo "ERROR: the memory server does not answer at $MEMORY_URL/health: start it (see memory_server/README.md)." >&2
    exit 1
fi
status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $MEMORY_AGENT_TOKEN" "$MEMORY_URL/api/stores")
if [ "$status" != "200" ]; then
    echo "ERROR: the memory server rejected MEMORY_AGENT_TOKEN (HTTP $status): check memory.env." >&2
    exit 1
fi

last=0
for dir in session_[0-9]*; do
    if [ -d "$dir" ] && [[ "${dir#session_}" =~ ^[0-9]+$ ]]; then
        number=$((10#${dir#session_}))
        if [ "$number" -gt "$last" ]; then
            last=$number
        fi
    fi
done
MEMORY_SESSION=$(printf 'session_%02d' $((last + 1)))
export MEMORY_SESSION
mkdir "$MEMORY_SESSION"
echo "Starting $MEMORY_SESSION (memory server: $MEMORY_URL)"

exec claude --dangerously-skip-permissions "$@"
