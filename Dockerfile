# syntax=docker/dockerfile:1

# Node 24 is pinned by major+minor so CI and the image cannot silently diverge.
# `.nvmrc` and package.json "engines" carry the same constraint for local dev.
ARG NODE_VERSION=24.17.0

# Stage 1: Build dependencies (includes devDependencies, needed to compile)
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Builder
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: Production dependencies only.
# The runtime never needs eslint/typescript/tsx/@types, so resolve the tree from
# lockfile metadata alone and keep them out of the shipped image.
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# Stage 4: Runner
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8410
ENV HOSTNAME="0.0.0.0"
# Upper bound for the on-disk media cache (20 GB by default).
ENV MEDIA_CACHE_MAX_BYTES=21474836480
# Cap simultaneous background downloads and per-client preload triggers.
ENV MEDIA_CACHE_MAX_CONCURRENCY=3
ENV PROXY_PRELOAD_MAX_PER_MINUTE=20

# Python3 runs the media scanning / self-healing scripts. tini gives the
# container a real PID 1 so signals and child reaping behave correctly.
RUN apk add --no-cache python3 tini

# Copy application files. node_modules comes from the production-only stage.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/data ./src/data

# The app writes its cache, logs and catalog database under ./data, which is a
# mounted volume. Create it up-front and hand ownership to the unprivileged user
# so the process never needs root.
RUN mkdir -p /app/data/media_cache /app/data/logs \
    && chown -R node:node /app/data /app/.next /app/src/data

EXPOSE 8410

# Run as the built-in unprivileged "node" user instead of root.
USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --spider -q http://localhost:8410/api/courses || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
