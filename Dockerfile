# oo-workers — multi-stage build producing three images.
#
#   - `oo-workers`       (default target: `master`)
#                        Full stack: master + UI + scheduler + workers.
#                        Ships Chromium headless shell only (playwright.config.ts
#                        sets headless: true; Playwright uses the shell binary,
#                        not the full Chrome). Scripts that explicitly target
#                        Firefox/WebKit or headed mode will fail.
#
#   - `oo-agent-light`   (target: `agent-light`)
#                        Regional agent without browser support. Handles every
#                        probe type except QA. Built on oven/bun:1-alpine.
#
#   - `oo-agent-qa`      (target: `agent-qa`)
#                        Regional agent with Playwright (headless shell). Handles
#                        all probe types including QA browser checks.
#
# Build the default master image with `docker build .` — kept as the
# last FROM so existing source-build flows are unchanged. The two agent
# images need `docker build --target agent-light .` / `--target agent-qa .`.

# ---------- Stage 1: prod-deps (production-only, no devDependencies) ----------
FROM oven/bun:1-debian AS prod-deps

WORKDIR /app
COPY package.json bun.lock* ./
# --ignore-scripts skips the prepare hook (husky) which isn't present without devDeps
RUN bun install --frozen-lockfile --production --ignore-scripts

# ---------- Stage 2: agent-light (no browser, slim alpine) ----------
FROM oven/bun:1-alpine AS agent-light

WORKDIR /app

# Create user before COPY so --chown works without a separate chown layer
RUN addgroup -S ooworker && adduser -S ooworker -G ooworker

COPY --from=prod-deps --chown=ooworker:ooworker /app/node_modules ./node_modules
COPY --chown=ooworker:ooworker src ./src
COPY --chown=ooworker:ooworker package.json tsconfig.json ./

ENV NODE_ENV=production
ENV OO_WORKER_ROLE=agent
# This image installs no browser. Declare light-mode so the agent's QA
# capability is stated, not probed — a QA job dispatched here is then
# declined with a clear "redeploy with oo-agent-qa" message instead of
# failing at browser launch.
ENV OO_AGENT_FORCE_LIGHT=1

USER ooworker
CMD ["bun", "src/index.ts"]

# ---------- Stage 2: agent-qa (Chromium headless shell only, agent role) ----------
FROM oven/bun:1-debian AS agent-qa

WORKDIR /app

# Create user before COPY so --chown works without a separate chown layer
RUN groupadd -r ooworker && useradd -r -g ooworker ooworker

COPY --from=prod-deps --chown=ooworker:ooworker /app/node_modules ./node_modules

# Install the Chromium headless shell only (headless: true in playwright.config.ts
# uses the shell, not the full Chrome binary — saves ~357 MB vs full chromium).
# nodejs provides the real `node` binary playwright.service.ts shells out to
# (`node node_modules/.bin/playwright test`); bun:debian's node shim hangs
# Playwright's worker IPC.
#
# Order is load-bearing: playwright install MUST run BEFORE nodejs (see PR #109).
# With real node on PATH, Playwright's downloader uses node's CA store, which
# rejects the CDN cert and the browser download fails; under Bun it succeeds.
# `--with-deps` runs apt-get update, but we add an explicit update before nodejs
# so this won't silently break if a future Playwright cleans the apt lists.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node_modules/.bin/playwright install chromium-headless-shell --with-deps && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    chown -R ooworker:ooworker /ms-playwright && \
    mkdir -p /app/tests && chown ooworker:ooworker /app/tests

COPY --chown=ooworker:ooworker src ./src
COPY --chown=ooworker:ooworker package.json tsconfig.json ./

ENV NODE_ENV=production
ENV OO_WORKER_ROLE=agent

USER ooworker
CMD ["bun", "src/index.ts"]

# ---------- Stage 3 (final, default): master ----------
FROM oven/bun:1-debian AS master

WORKDIR /app

# Create user before COPY so --chown works without a separate chown layer
RUN groupadd -r ooworker && useradd -r -g ooworker ooworker

COPY --from=prod-deps --chown=ooworker:ooworker /app/node_modules ./node_modules

# Install the Chromium headless shell only (headless: true in playwright.config.ts
# uses the shell, not the full Chrome binary — saves ~357 MB vs full chromium).
# nodejs provides the real `node` binary for playwright.service.ts subprocess
# invocation; bun:debian's node shim hangs Playwright's worker IPC.
#
# Order is load-bearing: playwright install MUST run BEFORE nodejs (see PR #109).
# With real node on PATH, Playwright's downloader uses node's CA store, which
# rejects the CDN cert and the browser download fails; under Bun it succeeds.
# `--with-deps` runs apt-get update, but we add an explicit update before nodejs
# so this won't silently break if a future Playwright cleans the apt lists.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node_modules/.bin/playwright install chromium-headless-shell --with-deps && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    chown -R ooworker:ooworker /ms-playwright && \
    mkdir -p /app/tests && chown ooworker:ooworker /app/tests

# Copy app source (.dockerignore excludes node_modules, .git, tests/, docs/, etc.)
COPY --chown=ooworker:ooworker . .

# Bundle the UI into ./public so the server can serve it.
# Uses bun's native bundler — no devDependencies required.
RUN bun run build:ui && chown -R ooworker:ooworker /app/public

ENV NODE_ENV=production
EXPOSE 3001

USER ooworker
CMD ["bun", "src/index.ts"]
