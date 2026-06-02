FROM mcr.microsoft.com/devcontainers/javascript-node:24-bullseye

USER root

# Install Claude Code CLI and Playwright CLI globally. @playwright/cli is pinned
# so its bundled playwright stays matched to the browser baked in below.
RUN npm install -g @anthropic-ai/claude-code @playwright/cli@0.1.13

# Install Playwright browser system dependencies (needed to run Chromium in the
# container). Pinned to the same version as the browser install below.
RUN npx -y playwright@1.61.0-alpha-1778188671000 install-deps chromium

USER node

# Bake Chromium into the image so no browser download happens at runtime.
# Pin to the playwright version that @playwright/cli@0.1.13 depends on, so the
# binary matches what playwright-cli uses (keep in sync when bumping the CLI).
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npx -y playwright@1.61.0-alpha-1778188671000 install chromium
