# ETiK test container: Claude Code + Playwright CLI (Chromium and skill) + the ETiK console,
# a web server to upload configurations and chat with Claude Code from a browser on the host.
# Build and run with `docker compose up -d --build` (see README.md).

# Build stage: compile the console and build its web page, then keep only production dependencies.
# The full node image has the toolchain node-pty needs.
FROM node:24-bookworm AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json server/tsconfig.build.json server/tsconfig.web.json server/vite.config.ts ./
COPY server/src ./src
COPY server/web ./web
RUN npm run build && npm prune --omit=dev

# Runtime stage.
FROM node:24-bookworm

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

# Bake Chromium and its system dependencies into the image so no browser download
# happens at runtime. Same derived version as the CLI, so the binary matches exactly
# what playwright-cli drives. Outside /home/node, which holds a volume.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@"$(cat /etc/pw_version)" install --with-deps chromium

# The playwright-cli skill, matching the pinned CLI version: a built-in skill that
# configurations can select (CI=1 keeps the installer non-interactive).
WORKDIR /opt/etik/builtin
RUN CI=1 playwright-cli install --skills && test -f .claude/skills/playwright-cli/SKILL.md

# The console.
COPY --from=build /app/package.json /opt/etik/server/
COPY --from=build /app/node_modules /opt/etik/server/node_modules
COPY --from=build /app/dist /opt/etik/server/dist
COPY --chmod=0755 init-firewall.sh entrypoint.sh /usr/local/bin/

# Claude Code runs as node in /workspace; its login and settings live in the
# claude-config volume. The uploaded configurations stay root-only.
RUN mkdir -p /workspace /home/node/.claude /var/lib/etik \
 && chown node:node /workspace /home/node/.claude \
 && chmod 0700 /var/lib/etik

ENV ETIK_PORT=7681 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
WORKDIR /workspace
EXPOSE 7681
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:7681/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# The console runs as root: it programs the firewall, and runs Claude Code as node.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
