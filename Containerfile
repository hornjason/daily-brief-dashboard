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
# Lean image with only what's needed to run the server
FROM oven/bun:1-slim AS runtime

WORKDIR /app

# Copy built frontend and server source from builder
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src ./src
COPY --from=builder /app/node_modules ./node_modules

# Runtime environment
ENV PORT=7777
# CONFIG_DIR: mount your config volume here (must contain customers.json)
#   podman run -v ~/.pai-dashboard:/config:Z ...
ENV CONFIG_DIR=/config
# CACHE_DIR: mount your cache volume here for persistent brief/sheet caches
#   podman run -v ~/.pai-dashboard-cache:/cache:Z ...
ENV CACHE_DIR=/cache

EXPOSE 7777

CMD ["bun", "run", "server.ts"]
