#!/usr/bin/env bash
set -euo pipefail

# upgrade.sh — Upgrade DailyBriefDashboard to the latest (or specified) release.
# Usage: bash upgrade.sh [--version=vX.Y.Z] [--latest] [--dry-run] [--help]

CONTAINER="${CONTAINER_NAME:-pai-dashboard}"
IMAGE="ghcr.io/hornjason/daily-brief-dashboard"
PORT="${PORT:-7777}"
REPO_API="https://api.github.com/repos/hornjason/daily-brief-dashboard/releases/latest"
HEALTH_URL="http://localhost:${PORT}/api/admin/health"

# ── UI helpers (match setup.sh style) ─────────────────────────────────────────
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }
hdr()  { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# ── Argument parsing ──────────────────────────────────────────────────────────
VERSION=""
DRY_RUN=0
USE_LATEST=0

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#--version=}" ;;
    --latest)    USE_LATEST=1 ;;
    --dry-run)   DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: bash upgrade.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --version=vX.Y.Z   Upgrade to a specific version"
      echo "  --latest            Pull the latest image (most recent push, may be ahead of release)"
      echo "  --dry-run           Print planned actions without executing"
      echo "  --help              Show this help"
      echo ""
      echo "Default (no flags): upgrades to the latest GitHub release."
      echo ""
      echo "Examples:"
      echo "  bash upgrade.sh                    # upgrade to latest release"
      echo "  bash upgrade.sh --latest           # upgrade to latest image (bleeding edge)"
      echo "  bash upgrade.sh --version=v1.7.3   # upgrade to specific version"
      echo "  bash upgrade.sh --dry-run           # preview without changes"
      exit 0
      ;;
    *) die "Unknown argument: $arg (try --help)" ;;
  esac
done

# ── Platform detection ────────────────────────────────────────────────────────
OS_TYPE="$(uname -s | tr '[:upper:]' '[:lower:]')"
VOL_FLAG=""
if [[ "$OS_TYPE" == "linux" ]]; then
  VOL_FLAG=":z"
fi

# ── Find install directory ────────────────────────────────────────────────────
if [[ -n "${INSTALL_DIR:-}" && -f "${INSTALL_DIR}/.env" ]]; then
  : # explicit override via env var
elif [[ -f "$HOME/daily-brief/.env" ]]; then
  INSTALL_DIR="$HOME/daily-brief"
elif [[ -f ".env" ]]; then
  INSTALL_DIR="$(pwd)"
else
  die "Could not find install directory. Expected ~/daily-brief/.env or ./.env"
fi

# ── Pre-flight checks ────────────────────────────────────────────────────────
hdr "Pre-flight checks"

if ! command -v podman >/dev/null 2>&1; then
  die "podman not found. Install podman first: https://podman.io"
fi
ok "podman found"

if ! podman container exists "$CONTAINER" 2>/dev/null; then
  die "Container $CONTAINER not found. Run setup.sh first."
fi
ok "container $CONTAINER exists"

# ── Get current version ──────────────────────────────────────────────────────
OLD_VERSION=$(podman exec "$CONTAINER" cat /app/package.json 2>/dev/null \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  || echo "unknown")
say "Current version: $OLD_VERSION"

# ── Resolve target version ───────────────────────────────────────────────────
if [[ -n "$VERSION" ]]; then
  : # explicit version provided via --version=
elif [[ "$USE_LATEST" -eq 1 ]]; then
  VERSION="latest"
  ok "using :latest image (bleeding edge)"
else
  hdr "Checking for latest release"
  VERSION=$(curl -sf "$REPO_API" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if [[ -z "$VERSION" ]]; then
    die "Could not determine latest version from GitHub API"
  fi
  ok "latest release: $VERSION"
fi

IMAGE_REF="${IMAGE}:${VERSION}"
say "Target image: $IMAGE_REF"

# ── Dry-run exit ─────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  hdr "Dry-run — planned actions (no changes made)"
  say "1. podman stop $CONTAINER"
  say "2. podman rm $CONTAINER"
  say "3. podman pull $IMAGE_REF"
  say "4. podman run -d --name $CONTAINER ... $IMAGE_REF"
  say "   Install dir: $INSTALL_DIR"
  say "   Volume: ${INSTALL_DIR}/data:/data${VOL_FLAG}"
  say "   Env file: ${INSTALL_DIR}/.env"
  say "5. Health check: $HEALTH_URL"
  say ""
  say "Upgrade from $OLD_VERSION → $VERSION"
  say "Data in ${INSTALL_DIR}/data/ will be preserved."
  exit 0
fi

# ── Execute upgrade ──────────────────────────────────────────────────────────
hdr "Pulling image"
podman pull "$IMAGE_REF"
ok "image pulled"

hdr "Stopping container"
podman stop "$CONTAINER" 2>/dev/null || true
podman rm "$CONTAINER" 2>/dev/null || true
ok "old container removed"

hdr "Starting upgraded container"
env_file_arg=()
if [[ -f "${INSTALL_DIR}/.env" ]]; then
  env_file_arg=(--env-file "${INSTALL_DIR}/.env")
fi

# Read memory limit from .env (large installs set MEM_LIMIT=16g)
MEM_LIMIT="8g"
if grep -qE "^MEM_LIMIT=" "${INSTALL_DIR}/.env" 2>/dev/null; then
  MEM_LIMIT="$(grep -E '^MEM_LIMIT=' "${INSTALL_DIR}/.env" | cut -d= -f2)"
  say "Large install detected: memory=$MEM_LIMIT"
fi

podman run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${PORT}:7777" \
  -p "127.0.0.1:${VNC_PORT:-6080}:6080" \
  -v "${INSTALL_DIR}/data:/data${VOL_FLAG}" \
  -e PORT=7777 \
  -e CONFIG_DIR=/data/config \
  -e CACHE_DIR=/data/cache \
  -e RH_PROFILE_DIR=/data/rh-profile \
  -e UNIFIED_INTELLIGENCE=true \
  ${env_file_arg[@]+"${env_file_arg[@]}"} \
  --shm-size 2g \
  --memory "$MEM_LIMIT" \
  "$IMAGE_REF"
ok "container started"

# ── Health check ─────────────────────────────────────────────────────────────
hdr "Waiting for dashboard"
for i in $(seq 1 5); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    ok "dashboard healthy"
    break
  fi
  if [[ "$i" -eq 5 ]]; then
    warn "Dashboard not responding after 15s — check: podman logs $CONTAINER"
  fi
  printf '.'
  sleep 3
done

# ── Done ─────────────────────────────────────────────────────────────────────
printf '\n'
hdr "Upgrade complete"
ok "Upgraded from $OLD_VERSION → $VERSION"
say "Your data in ${INSTALL_DIR}/data/ was preserved."
say "Dashboard: http://localhost:${PORT}"
