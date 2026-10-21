# Build stage: compile the server and build the web app (dist/web), fetch the embedding model (models/),
# then keep only production dependencies.
FROM node:24-bookworm-slim AS build
WORKDIR /app
# Embedding model of semantic search, fetched at build time: english, multilingual, a Hugging Face id, or none.
ARG MEMORY_EMBEDDING_MODEL=english
# onnxruntime-node: CPU only, do not fetch the CUDA providers.
ENV ONNXRUNTIME_NODE_INSTALL=skip
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN mkdir -p models && npm run build && MEMORY_MODEL_DIR=/app/models node dist/embedding/prefetch.js && npm prune --omit=dev
# Drop what the CPU inference of this platform does not load: the web runtime (bundled into transformers.js),
# the binaries of other platforms and the GPU providers. This saves about 700 MB.
RUN rm -rf node_modules/onnxruntime-web \
    && find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d ! -path "*/linux/$(node -p process.arch)" -exec rm -rf {} + \
    && rm -f node_modules/onnxruntime-node/bin/*/linux/*/libonnxruntime_providers_cuda.so \
             node_modules/onnxruntime-node/bin/*/linux/*/libonnxruntime_providers_tensorrt.so

# Runtime stage.
FROM node:24-bookworm-slim
ARG MEMORY_EMBEDDING_MODEL=english
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9501 \
    MEMORY_DB_PATH=/data/memory.db \
    MEMORY_EMBEDDING_MODEL=$MEMORY_EMBEDDING_MODEL \
    MEMORY_MODEL_DIR=/app/models \
    MEMORY_MODEL_DOWNLOAD=false
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 9501
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:9501/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
