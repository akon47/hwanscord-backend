# hwanscord-backend — multi-stage build. Jenkins runs:
#   docker build --target test  .            (lint + typecheck + vitest, needs network for mongodb-memory-server)
#   docker build --target runtime -t akon47/hwanscord-backend:<tag> --build-arg APP_VERSION=<tag> .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- deps: all dependencies (dev included) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- build: compile TypeScript ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/migrate-legacy.ts ./scripts/migrate-legacy.ts
RUN npm run build

# ---------- test: quality gates ----------
FROM deps AS test
# mongod (downloaded by mongodb-memory-server) needs libcurl + CA certs on Debian 12
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*
ENV MONGOMS_DOWNLOAD_DIR=/tmp/mongoms \
    MONGOMS_VERSION=7.0.14 \
    MONGOMS_DISTRO=debian-12 \
    NODE_ENV=test
COPY . .
RUN npm run lint && npm run typecheck && npm test

# ---------- prod-deps: production dependencies only ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8080 \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/uploads && chown -R node:node /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
VOLUME ["/data/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]
