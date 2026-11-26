# syntax=docker/dockerfile:1

# --- build stage: official Vite+ toolchain image ---
FROM ghcr.io/voidzero-dev/vite-plus:1.6.0 AS build
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp . .
# The version shown in the app comes from .git (build stage only); these args override it when .git is missing.
ARG GIT_SHA
ARG GIT_DATE
RUN vp build
# Export the exact Node.js from .node-version for the runtime stage.
RUN cp "$(vp env which node | head -1)" /tmp/node

# --- production dependencies only ---
FROM ghcr.io/voidzero-dev/vite-plus:1.6.0 AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .node-version ./
RUN vp install --frozen-lockfile --prod

# --- runtime: Node + built SPA + server source (run via Node type stripping) ---
FROM debian:bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1
COPY --from=build /tmp/node /usr/local/bin/node
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN rm -f server/*.test.ts && mkdir -p /data && chown 65534:65534 /data
# The entrypoint starts as root, fixes /data ownership, then drops to PUID:PGID (default 65534) before Node starts.
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "server/main.ts"]
