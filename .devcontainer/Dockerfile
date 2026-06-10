FROM mcr.microsoft.com/devcontainers/javascript-node:24-bullseye

USER root

ARG PW_CLI_VERSION=0.1.13

# Tooling for the egress firewall (see init-firewall.sh). Clean up apt lists to
# keep the layer small.
RUN apt-get update && apt-get install -y --no-install-recommends \
        iptables \
        ipset \
        dnsutils \
        aggregate \
        jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI and the pinned Playwright CLI globally.
RUN npm install -g @anthropic-ai/claude-code @playwright/cli@${PW_CLI_VERSION}

# Resolve the exact playwright version this CLI depends on, once, and record it.
# Every browser-related step below reads from this file -- single source of truth.
RUN npm view @playwright/cli@${PW_CLI_VERSION} dependencies.playwright > /etc/pw_version \
 && echo "Derived playwright version: $(cat /etc/pw_version)"

# Install Playwright browser system dependencies (needed to run Chromium).
RUN npx -y playwright@"$(cat /etc/pw_version)" install-deps chromium

# Install the egress firewall script. Grant the node user passwordless sudo for
# ONLY this script (the script needs root to program iptables; it is re-run on
# every container start via the postStartCommand in devcontainer.json).
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh \
 && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/init-firewall \
 && chmod 0440 /etc/sudoers.d/init-firewall

USER node

# Bake Chromium into the image so no browser download happens at runtime. Uses
# the same derived version as install-deps above, so the binary matches exactly
# what playwright-cli drives -- no manual sync, no second hardcoded version.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npx -y playwright@"$(cat /etc/pw_version)" install chromium