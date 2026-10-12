#!/bin/bash
# Entry point of the ETiK test container (runs as root).
# Locks egress down to the base allowlist, then starts the ETiK console, which
# opens the firewall to a configuration's domains and host ports while its session runs.
set -euo pipefail

# Refuse to start without a firewall: Claude Code runs in YOLO mode in here.
/usr/local/bin/init-firewall.sh

# Docker creates a missing bind-mounted workspace as root: give it to the agent user.
if [ "$(stat -c %u /workspace)" = 0 ]; then
    chown node:node /workspace
fi

exec node /opt/etik/server/dist/index.js
