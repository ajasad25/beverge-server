# syntax=docker/dockerfile:1.7
#
# Target: glibc Linux/amd64 (matches the production VPS).
# Build on an M-series Mac with:
#     docker build --platform=linux/amd64 -f server/Dockerfile -t beverage-api ./server
# Or just `docker compose -f docker-compose.prod.yml build` — the compose
# file pins `platform: linux/amd64`.
#
# Base image is Debian (bookworm) not Alpine — bcrypt and Prisma's query
# engine are native modules and Alpine's musl libc trips them up.

# ─── 1. deps ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ─── 2. build ───────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
 && npm run build

# ─── 3. prod-deps ───────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
 && npx prisma generate \
 && npm cache clean --force

# ─── 4. runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini wget \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist          ./dist
COPY --from=build     /app/prisma        ./prisma
COPY package.json ./

# `node` user (uid 1000) ships with the official node images.
RUN chown -R node:node /app
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

# tini reaps zombies + forwards SIGTERM so Prisma's pool and node-cron
# shut down cleanly on `docker stop`.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Migrations on boot are idempotent — `prisma migrate deploy` no-ops if
# nothing's pending.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
