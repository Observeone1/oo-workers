# Single-stage Bun + Playwright image.
# Base: Playwright's official image (includes Chromium + system deps), with Bun layered on top.
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Install Bun
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Install deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

ENV NODE_ENV=production

CMD ["bun", "src/index.ts"]
