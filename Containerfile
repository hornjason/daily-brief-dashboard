# ── Stage 1: Builder ──────────────────────────────────────────────────────────
# Installs all dependencies and builds the React/Vite frontend
FROM oven/bun:1 AS builder

WORKDIR /app

# Install root dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Install dashboard dependencies
COPY dashboard/package.json dashboard/bun.lock* ./dashboard/
RUN cd dashboard && bun install --frozen-lockfile

# Copy all source files
COPY . .

# Build the React/Vite frontend
RUN cd dashboard && bun run build


# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Includes Playwright Chromium for RH portal scraping
FROM oven/bun:1 AS runtime

WORKDIR /app

# Install Chromium system dependencies (Debian-based)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy built frontend and server source from builder
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/node_modules ./node_modules

# Install Playwright Chromium browser binary
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN bunx playwright install chromium

# ── Runtime paths ──────────────────────────────────────────────────────────────
# All persistent state lives under /data so a single volume mount covers
# config, cache, and the RH browser profile.
#
#   podman/docker run -v /host/pai-data:/data:Z ...
#   or use the docker-compose.yml in this directory
#
ENV PORT=7777
ENV CONFIG_DIR=/data/config
ENV CACHE_DIR=/data/cache
ENV RH_PROFILE_DIR=/data/rh-profile

EXPOSE 7777

CMD ["bun", "run", "server.ts"]
