#!/usr/bin/env bash
set -euo pipefail

# upgrade.sh — Upgrade DailyBriefDashboard to the latest (or specified) release.
# Usage: bash upgrade.sh [--version=vX.Y.Z] [--latest] [--dry-run] [--help]

CONTAINER="${CONTAINER_NAME:-pai-dashboard}"
IMAGE="ghcr.io/hornjason/daily-brief-dashboard"
PORT="${PORT:-7777}"
VNC_PORT="${VNC_PORT:-6080}"
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
LOCAL_IMAGE=""

for arg in "$@"; do
  case "$arg" in
    --version=*) VERSION="${arg#--version=}" ;;
    --latest)    USE_LATEST=1 ;;
    --image=*)   LOCAL_IMAGE="${arg#--image=}" ;;
    --dry-run)   DRY_RUN=1 ;;
    --help|-h)
      echo "Usage: bash upgrade.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --version=vX.Y.Z   Upgrade to a specific version"
      echo "  --latest            Pull the latest image (most recent push, may be ahead of release)"
      echo "  --image=REF         Use an image already present locally (release testing, rollback); no pull"
      echo "  --dry-run           Print planned actions without executing"
      echo "  --help              Show this help"
      echo ""
      echo "Environment:"
      echo "  HEALTH_TIMEOUT_S    Seconds to wait for the dashboard to answer (default 120)"
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

if [[ -n "$LOCAL_IMAGE" && ( -n "$VERSION" || "$USE_LATEST" -eq 1 ) ]]; then
  die "--image cannot be combined with --version or --latest — pick one target"
fi

# A typo'd timeout must not silently become the default (#1919): refuse it
# before anything is stopped.
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
if ! [[ "$HEALTH_TIMEOUT_S" =~ ^[0-9]+$ ]] || [[ "$HEALTH_TIMEOUT_S" -eq 0 ]]; then
  die "HEALTH_TIMEOUT_S must be a positive whole number of seconds (got '$HEALTH_TIMEOUT_S')"
fi

# ── Platform detection ────────────────────────────────────────────────────────
OS_TYPE="$(uname -s | tr '[:upper:]' '[:lower:]')"
VOL_FLAG=""
if [[ "$OS_TYPE" == "linux" ]]; then
  VOL_FLAG=":z"
fi

# ── Find install directory ────────────────────────────────────────────────────
# Priority: explicit env var > running container inspect > ~/daily-brief > cwd
DETECT_METHOD=""
if [[ -n "${INSTALL_DIR:-}" ]]; then
  DETECT_METHOD="explicit \$INSTALL_DIR"
else
  # Try to read the data volume mount from the running container
  if podman container exists "$CONTAINER" 2>/dev/null; then
    _mount_src=$(podman inspect "$CONTAINER" \
      --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
    if [[ -n "$_mount_src" ]]; then
      INSTALL_DIR="${_mount_src%/data}"
      DETECT_METHOD="container inspect"
    fi
  fi

  # Fall back to ~/daily-brief if the directory exists
  if [[ -z "${INSTALL_DIR:-}" && -d "$HOME/daily-brief" ]]; then
    INSTALL_DIR="$HOME/daily-brief"
    DETECT_METHOD="\~/daily-brief"
  fi

  # Fall back to cwd only if BOTH .env and ./data exist (avoids wrong-dir trap)
  if [[ -z "${INSTALL_DIR:-}" && -f ".env" && -d "./data" ]]; then
    INSTALL_DIR="$(pwd)"
    DETECT_METHOD="current directory"
  fi
fi

if [[ -z "${INSTALL_DIR:-}" ]]; then
  die "Could not find install directory. Set \$INSTALL_DIR, ensure container '$CONTAINER' is running, or run from ~/daily-brief."
fi
ok "install directory: $INSTALL_DIR (from $DETECT_METHOD)"

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
if [[ -n "$LOCAL_IMAGE" ]]; then
  VERSION="$LOCAL_IMAGE"
  # Refuse a missing local ref BEFORE the running container is touched.
  if ! podman image exists "$LOCAL_IMAGE" 2>/dev/null; then
    die "$LOCAL_IMAGE not found locally (check: podman images). Nothing was stopped."
  fi
  ok "using local image $LOCAL_IMAGE (no pull)"
elif [[ -n "$VERSION" ]]; then
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

if [[ -n "$LOCAL_IMAGE" ]]; then
  IMAGE_REF="$LOCAL_IMAGE"
else
  IMAGE_REF="${IMAGE}:${VERSION}"
fi
say "Target image: $IMAGE_REF"

# The image the running container uses — the rollback target if anything fails.
OLD_IMAGE=$(podman inspect "$CONTAINER" --format '{{.ImageName}}' 2>/dev/null || true)
OLD_IMAGE="${OLD_IMAGE:-unknown}"
rollback_hint() {
  say "To roll back to the previous image once the name is free:"
  say "  bash upgrade.sh --image=$OLD_IMAGE"
}

# ── Dry-run exit ─────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  hdr "Dry-run — planned actions (no changes made)"
  say "1. podman stop $CONTAINER"
  say "2. podman rm $CONTAINER"
  if [[ -n "$LOCAL_IMAGE" ]]; then
    say "3. (no pull — local image $IMAGE_REF)"
  else
    say "3. podman pull $IMAGE_REF"
  fi
  say "4. verify the name $CONTAINER is free (podman ps -a --external)"
  say "5. podman run -d --name $CONTAINER ... $IMAGE_REF"
  say "   Install dir: $INSTALL_DIR"
  say "   Volume: ${INSTALL_DIR}/data:/data${VOL_FLAG}"
  say "   Env file: ${INSTALL_DIR}/.env"
  say "6. Health check: $HEALTH_URL (up to ${HEALTH_TIMEOUT_S}s)"
  say "   Rollback image: $OLD_IMAGE"
  say ""
  say "Upgrade from $OLD_VERSION → $VERSION"
  say "Data in ${INSTALL_DIR}/data/ will be preserved."
  exit 0
fi

# ── Execute upgrade ──────────────────────────────────────────────────────────
if [[ -z "$LOCAL_IMAGE" ]]; then
  hdr "Pulling image"
  podman pull "$IMAGE_REF"
  ok "image pulled"
fi

hdr "Stopping container"
podman stop "$CONTAINER" 2>/dev/null || true
# #1919: a failed rm must stop the upgrade. Swallowing it and running anyway
# left prod with no container and a name held by a storage-only leftover.
if ! rm_err=$(podman rm "$CONTAINER" 2>&1); then
  printf '%s\n' "$rm_err" >&2
  say "podman rm failed — the name $CONTAINER may still be held. To recover:"
  say "  podman ps -a --external --filter name=^${CONTAINER}\$"
  say "  podman rm -f <ID>    # a 'replacing mount point' error usually clears on retry or after 'podman system migrate'"
  rollback_hint
  die "Upgrade aborted before starting the new container."
fi

# rm can succeed while a storage-only container still holds the name.
leftover=$(podman ps -a --external --filter "name=^${CONTAINER}\$" --format '{{.ID}} {{.Names}}' 2>/dev/null || true)
if [[ -n "$leftover" ]]; then
  leftover_id="${leftover%% *}"
  say "The name $CONTAINER is still held by: $leftover"
  say "  podman rm -f $leftover_id"
  rollback_hint
  die "Upgrade aborted before starting the new container."
fi
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
  -p "127.0.0.1:${VNC_PORT}:6080" \
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
healthy=0
waited=0
while [[ "$waited" -lt "$HEALTH_TIMEOUT_S" ]]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  printf '.'
  sleep 3
  waited=$((waited + 3))
done
printf '\n'
if [[ "$healthy" -ne 1 ]]; then
  say "Dashboard did not answer $HEALTH_URL within ${HEALTH_TIMEOUT_S}s."
  say "  check: podman logs $CONTAINER"
  rollback_hint
  die "Upgrade FAILED — the new container is not healthy."
fi
ok "dashboard healthy"

# ── Done ─────────────────────────────────────────────────────────────────────
hdr "Upgrade complete"
ok "Upgraded from $OLD_VERSION → $VERSION"
say "Your data in ${INSTALL_DIR}/data/ was preserved."
say "Dashboard: http://localhost:${PORT}"
