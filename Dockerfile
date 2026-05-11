# oo-workers — multi-stage build.
# Stage 1: oven/bun (Docker Hub) installs deps with a real Bun.
# Stage 2: mcr playwright (has Chromium + system deps), gets Bun binary + node_modules copied in.

# ---------- Stage 1: deps ----------
FROM oven/bun:1-debian AS deps

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ---------- Stage 2: runtime ----------
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Copy Bun binary from stage 1 — no install needed on this layer
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun

# Copy node_modules from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy app source
COPY . .

# Bundle the UI into ./public so the server can serve it
RUN bun run build:ui

ENV NODE_ENV=production
EXPOSE 3001

CMD ["bun", "src/index.ts"]
