# hwanscord-backend multi-stage build. Jenkins runs:
#   docker build --target test -t hwanscord-backend-test:<tag> .     (lint + typecheck at build time)
#   docker run --network <net> -e TEST_MONGODB_URI=mongodb://<mongo>:27017 hwanscord-backend-test:<tag>   (vitest)
#   docker build --target runtime -t akon47/hwanscord-backend:<tag> --build-arg APP_VERSION=<tag> .
# The test stage is the LAST stage on purpose: the legacy (non-BuildKit) builder builds every stage that
# precedes the target, so `--target runtime` must not have the test stage in front of it.

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

# ---------- prod-deps: production dependencies only ----------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production     APP_VERSION=${APP_VERSION}     PORT=8080     UPLOAD_DIR=/data/uploads
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/*   && mkdir -p /data/uploads && chown -R node:node /data
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
VOLUME ["/data/uploads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/src/index.js"]

# ---------- test: quality gates (kept last, see header) ----------
FROM deps AS test
ENV NODE_ENV=test
COPY . .
RUN npm run lint && npm run typecheck
CMD ["npm", "test"]
