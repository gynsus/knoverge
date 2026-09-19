# syntax=docker/dockerfile:1

# ---- base: Node LTS, pnpm via corepack, git for the workspace repositories ----
FROM node:24-alpine AS base
RUN apk add --no-cache git && corepack enable
WORKDIR /app

# ---- build: install every workspace, build apps, prune to production deps ----
FROM base AS build
ENV TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
# Manifests first, then install, then sources. Editing a source file must not
# invalidate the install layer: with the sources copied first, every change to
# any file reinstalls every dependency.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json ./
COPY apps/cli/package.json apps/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/git-store/package.json packages/git-store/
COPY packages/intelligence/package.json packages/intelligence/
COPY packages/policy/package.json packages/policy/
COPY packages/search/package.json packages/search/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm build
RUN pnpm --filter @knoverge/server --prod deploy --legacy /out/server \
 && pnpm --filter @knoverge/cli --prod deploy --legacy /out/cli

# ---- runtime: one image with the server and the CLI ----
FROM base AS runtime
ENV NODE_ENV=production \
    KNOVERGE_PORT=3000 \
    KNOVERGE_HOST=0.0.0.0 \
    KNOVERGE_DATA_DIR=/data \
    KNOVERGE_WEB_DIST=/app/web
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /out/cli /app/cli
COPY --from=build --chown=node:node /app/apps/web/dist /app/web
RUN ln -s /app/cli/dist/index.js /usr/local/bin/knoverge \
 && chmod +x /app/cli/dist/index.js \
 && mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/server
VOLUME ["/data"]
EXPOSE 3000
# Readiness, not liveness: liveness answers as long as the process is up, so a
# container that cannot reach its database would still be reported healthy and
# an orchestrator would send it traffic. The start period covers migrations.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${KNOVERGE_PORT}/health/ready" || exit 1
CMD ["node", "dist/index.js"]
