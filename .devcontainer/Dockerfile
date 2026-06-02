FROM mcr.microsoft.com/devcontainers/javascript-node:24-bullseye

USER root

# Install Claude Code CLI and Playwright CLI globally
RUN npm install -g @anthropic-ai/claude-code @playwright/cli

# Install Playwright browser system dependencies (needed to run Chromium in the container)
RUN npx -y playwright@latest install-deps chromium

USER node
