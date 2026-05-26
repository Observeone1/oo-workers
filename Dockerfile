# oo-workers — multi-stage build producing three images.
#
#   - `oo-workers`       (default target: `master`)
#                        Full stack: master + UI + scheduler + workers.
#                        Built on Playwright base for QA browser checks.
#
#   - `oo-agent-light`   (target: `agent-light`)
#                        Regional agent without Chromium. Handles every
#                        probe type except QA. ~250-400 MB. Built on
#                        oven/bun:1-debian-slim.
#
#   - `oo-agent-qa`      (target: `agent-qa`)
#                        Regional agent with Playwright. Handles all
#                        probe types including QA. ~1.5 GB. Same base
#                        as master, but agent-only (no UI build, no
#                        migrations, no admin scripts).
#
# Build the default master image with `docker build .` — kept as the
# last FROM so existing source-build flows are unchanged. The two agent
# images need `docker build --target agent-light .` / `--target
# agent-qa .`.

# ---------- Stage 1: deps ----------
FROM oven/bun:1-debian AS deps

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# ---------- Stage 2: agent-light (no Chromium, slim Bun) ----------
# Uses the alpine variant — ~60 MB base, ~250 MB total with node_modules.
# Note: alpine ships musl libc instead of glibc; postgres-js + ioredis +
# udp/tcp probes are pure-JS / TCP and work fine. If a future probe
# depends on a glibc-only native binary, fall back to oven/bun:1-debian.
FROM oven/bun:1-alpine AS agent-light

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./

ENV NODE_ENV=production
ENV OO_WORKER_ROLE=agent

CMD ["bun", "src/index.ts"]

# ---------- Stage 3: agent-qa (Playwright base, agent-only) ----------
FROM mcr.microsoft.com/playwright:v1.57.0-jammy AS agent-qa

WORKDIR /app
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./

ENV NODE_ENV=production
ENV OO_WORKER_ROLE=agent

CMD ["bun", "src/index.ts"]

# ---------- Stage 4 (final, default): master ----------
FROM mcr.microsoft.com/playwright:v1.57.0-jammy AS master

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
