#!/bin/bash
# Entry point of the analyst container (runs as root): locks egress down, keeps the allowlist's addresses fresh,
# then runs the server as `node`, without any capability left.
set -euo pipefail

# Refuse to start without a firewall: the analyses' agent reads untrusted text.
/usr/local/bin/firewall.sh

# CDN addresses rotate: re-resolve the allowed domains every 30 minutes.
(
    while sleep 1800; do
        /usr/local/bin/firewall.sh --refresh >/dev/null 2>&1 || echo "WARNING: firewall refresh failed" >&2
    done
) &

mkdir -p "$ANALYST_REPOS_DIR"
chown node:node "$ANALYST_REPOS_DIR"

exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all -- node /app/dist/index.js
