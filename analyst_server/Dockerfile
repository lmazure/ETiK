# Build stage: compile the server, then keep only production dependencies (with the Claude Code binary of the
# Agent SDK, an optional dependency for this platform).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage. The entry point runs as root to apply the firewall, then runs the server as node.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates iptables ipset dnsutils curl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9502 \
    ANALYST_REPOS_DIR=/repos
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=0755 firewall.sh entrypoint.sh /usr/local/bin/
VOLUME /repos
EXPOSE 9502
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:9502/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
