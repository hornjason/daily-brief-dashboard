#!/usr/bin/env bash
# DailyBriefDashboard — new user onboarding script
# Usage: ./setup.sh [--doctor] [--dry-run] [--yes]
#
# --doctor    Run preflight checks only; print results and exit. No mutations.
# --dry-run   Narrate every step but make no changes.
# --yes       Skip the 3-second preview (useful for CI / returning users).
#
# Bash 3.2 compatible (macOS ships bash 3.2).

set -euo pipefail

# ---------- Constants ----------

SETUP_SCHEMA_VERSION="1.3.1"
IMAGE_REF="ghcr.io/hornjason/daily-brief-dashboard:latest"
DASHBOARD_URL="http://localhost:7777/dashboard/setup"
HEALTH_URL="http://localhost:7777/api/aes"
ENV_EXAMPLE_URL="https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/.env.example"
COMPOSE_URL="https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/docker-compose.yml"
MIN_MACHINE_RAM_MB=4096
MIN_HOST_RAM_MB=4096
MIN_DISK_MB=5120
MIN_CPU_CORES=2
PORT=7777

# Named exit codes (referenced by BATS tests)
E_OK=0
E_UNSUPPORTED_OS=1
E_NO_PODMAN=10
E_MACHINE_STOPPED=11
E_LOW_RAM=12
E_LOW_DISK=13
E_PORT_IN_USE=14
E_GHCR_AUTH=15
# shellcheck disable=SC2034  # reserved for future schema-version drift check
E_SCHEMA_MISMATCH=16
E_NO_HOST_RAM=17

# Flags
DOCTOR=0
DRY_RUN=0
ASSUME_YES=0

# Runtime state
OS_TYPE=""
COMPOSE_CMD=()

# ---------- UI helpers ----------

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

die() {
  # die <exit-code> <multi-line message>
  local code="$1"
  shift
  printf '\n' >&2
  # Print each subsequent arg as its own line
  while [[ $# -gt 0 ]]; do
    printf '%s\n' "$1" >&2
    shift
  done
  printf '\n' >&2
  exit "$code"
}

# ---------- Flag parsing ----------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --doctor)  DOCTOR=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      bad "Unknown flag: $1"
      exit 2
      ;;
  esac
  shift
done

# ---------- Preview (interactive) ----------

preview() {
  if [[ "$ASSUME_YES" -eq 1 || "$DOCTOR" -eq 1 || ! -t 0 ]]; then
    return 0
  fi
  hdr "DailyBriefDashboard setup v${SETUP_SCHEMA_VERSION}"
  say "This will:"
  say "  1. Check prerequisites (Podman, RAM, disk, port 7777)"
  say "  2. Create ./data/config, ./data/cache, ./data/rh-profile"
  say "  3. Copy .env.example to .env (or append new keys if .env exists)"
  say "  4. Pull the container image from GHCR"
  say "  5. Start the container via compose"
  say "  6. Open the setup wizard in your browser"
  say ""
  say "Starting in 3 seconds — Ctrl-C to cancel."
  sleep 3
}

# ---------- Preflight ----------

detect_os() {
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  case "$(printf '%s' "$uname_s" | tr '[:upper:]' '[:lower:]')" in
    darwin) OS_TYPE="darwin" ;;
    linux)  OS_TYPE="linux"  ;;
    *)
      die "$E_UNSUPPORTED_OS" \
        "✗ Unsupported OS: $uname_s" \
        "  This script supports macOS and Linux only."
      ;;
  esac
  ok "OS: $OS_TYPE"
}

check_podman() {
  if ! command -v podman >/dev/null 2>&1; then
    die "$E_NO_PODMAN" \
      "✗ Podman not found." \
      "  macOS:  brew install podman" \
      "          OR download Podman Desktop: https://podman-desktop.io" \
      "  Linux:  sudo apt install podman   (Ubuntu/Debian)" \
      "          sudo dnf install podman   (RHEL/Fedora)" \
      "Re-run this script after installing Podman."
  fi
  ok "podman found"
}

check_podman_machine() {
  # macOS only — Linux runs podman natively
  if [[ "$OS_TYPE" != "darwin" ]]; then
    return 0
  fi

  local list_json
  list_json="$(podman machine list --format json 2>/dev/null || echo '[]')"

  if [[ "$list_json" == "[]" || -z "$list_json" ]]; then
    die "$E_MACHINE_STOPPED" \
      "✗ No Podman machine found." \
      "  Fix: podman machine init && podman machine start" \
      "Re-run this script after creating the machine."
  fi

  # Extract "Running": true from any entry (bash 3.2 — no jq dependency assumed)
  if ! printf '%s' "$list_json" | grep -q '"Running":[[:space:]]*true'; then
    die "$E_MACHINE_STOPPED" \
      "✗ Podman machine is not running." \
      "  Fix: podman machine start" \
      "Re-run this script after starting the machine."
  fi

  ok "podman machine is running"
}

check_podman_machine_ram() {
  if [[ "$OS_TYPE" != "darwin" ]]; then
    return 0
  fi

  local inspect_json mem_mb
  inspect_json="$(podman machine inspect --format json 2>/dev/null || echo '')"

  # Memory field is reported in MiB by podman (e.g. "Memory": 2048)
  mem_mb="$(printf '%s' "$inspect_json" \
    | tr -d '\n' \
    | grep -oE '"Memory"[[:space:]]*:[[:space:]]*[0-9]+' \
    | head -n1 \
    | grep -oE '[0-9]+$' || echo "0")"

  if [[ -z "$mem_mb" || "$mem_mb" -eq 0 ]]; then
    warn "Could not read podman machine memory — skipping check."
    return 0
  fi

  if [[ "$mem_mb" -lt "$MIN_MACHINE_RAM_MB" ]]; then
    die "$E_LOW_RAM" \
      "✗ Podman machine RAM: ${mem_mb}MB — minimum required is ${MIN_MACHINE_RAM_MB}MB (4GB)." \
      "  The container uses 2GB for shared memory alone and may crash below this." \
      "" \
      "  Fix (stop machine first):" \
      "    podman machine stop" \
      "    podman machine set --memory ${MIN_MACHINE_RAM_MB}" \
      "    podman machine start" \
      "" \
      "  Or via Podman Desktop:" \
      "    Settings → Resources → Podman Machine → Memory → set to ${MIN_MACHINE_RAM_MB}MB → Apply & Restart" \
      "" \
      "  Docs: https://docs.podman.io/en/latest/markdown/podman-machine-set.1.html" \
      "Re-run this script after increasing memory."
  fi

  ok "podman machine RAM: ${mem_mb}MB"
}

check_disk() {
  # df -k returns 1K blocks. Column 4 is "available" on both macOS and Linux.
  local avail_kb avail_mb
  avail_kb="$(df -k . 2>/dev/null | awk 'NR==2 {print $4}')"
  if [[ -z "$avail_kb" ]]; then
    warn "Could not read disk free space — skipping check."
    return 0
  fi
  avail_mb=$((avail_kb / 1024))
  if [[ "$avail_mb" -lt "$MIN_DISK_MB" ]]; then
    local avail_gb
    avail_gb=$((avail_mb / 1024))
    die "$E_LOW_DISK" \
      "✗ Insufficient disk space: ${avail_gb}GB available, 5GB required." \
      "  Free up space and re-run."
  fi
  ok "disk free: $((avail_mb / 1024))GB"
}

check_host_ram() {
  local ram_mb=0
  if [[ "$OS_TYPE" == "darwin" ]]; then
    local bytes
    bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
    ram_mb=$((bytes / 1048576))
  elif [[ "$OS_TYPE" == "linux" ]]; then
    local kb
    kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
    ram_mb=$((kb / 1024))
  fi

  if [[ "$ram_mb" -eq 0 ]]; then
    warn "Could not read host RAM — skipping check."
    return 0
  fi

  if [[ "$ram_mb" -lt "$MIN_HOST_RAM_MB" ]]; then
    local ram_gb=$((ram_mb / 1024))
    die "$E_NO_HOST_RAM" \
      "✗ Host RAM: ${ram_gb}GB — minimum 4GB required."
  fi
  ok "host RAM: $((ram_mb / 1024))GB"
}

check_cpu() {
  local cores=0
  if [[ "$OS_TYPE" == "darwin" ]]; then
    cores="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"
  else
    cores="$(nproc 2>/dev/null || echo 0)"
  fi
  if [[ "$cores" -gt 0 && "$cores" -lt "$MIN_CPU_CORES" ]]; then
    warn "CPU cores: ${cores} — ${MIN_CPU_CORES}+ recommended (continuing)."
  else
    ok "CPU cores: ${cores}"
  fi
}

check_port() {
  local in_use=0
  if command -v lsof >/dev/null 2>&1; then
    if lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
      in_use=1
    fi
  elif command -v ss >/dev/null 2>&1; then
    if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
      in_use=1
    fi
  else
    warn "Neither lsof nor ss found — skipping port check."
    return 0
  fi

  if [[ "$in_use" -eq 1 ]]; then
    die "$E_PORT_IN_USE" \
      "✗ Port ${PORT} is already in use." \
      "  Check what's running: lsof -i :${PORT}" \
      "  If it's a previous dashboard container: podman stop pai-dashboard"
  fi
  ok "port ${PORT} is free"
}

check_ghcr() {
  # ghcr.io/v2/ returns 401 for unauthenticated requests — that's expected and means reachable.
  # HTTP 000 means a network-level failure (DNS, timeout, no route).
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://ghcr.io/v2/" 2>/dev/null)
  if [[ "$status" == "000" ]] || [[ -z "$status" ]]; then
    die "$E_GHCR_AUTH" \
      "✗ Cannot reach GHCR. Check your network connection and try again."
  fi
  ok "GHCR reachable"
}

detect_compose() {
  # Informational only — startup uses podman run directly.
  # Detected command is reported so users know what to use for manual management.
  if podman compose version >/dev/null 2>&1; then
    ok "compose available: podman compose (for manual management)"
  elif command -v podman-compose >/dev/null 2>&1; then
    ok "compose available: podman-compose (for manual management)"
  elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    ok "compose available: docker compose (for manual management)"
  else
    say "No compose tool found — that's fine, setup uses podman run directly"
  fi
}

run_preflight() {
  hdr "Preflight checks"
  detect_os
  check_podman
  check_podman_machine
  check_podman_machine_ram
  check_disk
  check_host_ram
  check_cpu
  check_port
  check_ghcr
  detect_compose
}

# ---------- Scaffold ----------

scaffold_dirs() {
  hdr "Scaffolding data directories"
  local d
  for d in ./data/config ./data/cache ./data/rh-profile; do
    if [[ -d "$d" ]]; then
      ok "exists: $d"
    else
      if [[ "$DRY_RUN" -eq 1 ]]; then
        say "(dry-run) would create: $d"
      else
        mkdir -p "$d"
        chmod 700 "$d"
        ok "created: $d"
      fi
    fi
  done
}

scaffold_env() {
  hdr "Environment file"
  if [[ ! -f .env.example ]]; then
    # When invoked via curl pipe the file won't be present locally.
    # Fetch it from raw GitHub so the script is self-contained.
    say "Fetching .env.example from GitHub..."
    if command -v curl >/dev/null 2>&1 && \
       curl -fsSL "$ENV_EXAMPLE_URL" -o .env.example 2>/dev/null; then
      ok "Downloaded .env.example"
    else
      warn ".env.example not found and could not be downloaded — skipping env scaffold."
      return 0
    fi
  fi

  if [[ ! -f .env ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      say "(dry-run) would copy .env.example → .env"
    else
      cp .env.example .env
      chmod 600 .env
      ok "Created .env from template"
    fi
    return 0
  fi

  # .env exists — append any missing keys from .env.example (preserve existing values)
  local line key appended=0
  while IFS= read -r line; do
    # Skip blanks and comments
    case "$line" in
      ''|\#*) continue ;;
    esac
    # Extract KEY from KEY=value
    key="${line%%=*}"
    # Skip if KEY already present in .env (allow surrounding whitespace)
    if grep -qE "^[[:space:]]*${key}=" .env 2>/dev/null; then
      continue
    fi
    if [[ "$DRY_RUN" -eq 1 ]]; then
      say "(dry-run) would append missing key: $key"
    else
      printf '\n%s\n' "$line" >> .env
      chmod 600 .env
      say "appended missing key: $key"
      appended=1
    fi
  done < .env.example

  if [[ "$appended" -eq 0 && "$DRY_RUN" -eq 0 ]]; then
    ok ".env already has all keys from .env.example"
  fi
}

# ---------- Container start ----------

pull_image() {
  hdr "Pulling container image"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    say "(dry-run) would run: podman pull $IMAGE_REF"
    return 0
  fi
  say "Pulling $IMAGE_REF (this may take a few minutes)..."
  if podman pull "$IMAGE_REF"; then
    ok "image pulled"
  else
    die "$E_GHCR_AUTH" \
      "✗ Image pull failed. Check your network connection and try again."
  fi
}

scaffold_compose() {
  # Download docker-compose.yml for post-install management (podman compose up/down).
  # Not used for initial startup — setup always uses podman run directly.
  if [[ -f docker-compose.yml ]]; then
    ok "docker-compose.yml present"
    return 0
  fi
  say "Fetching docker-compose.yml from GitHub..."
  if curl -fsSL "$COMPOSE_URL" -o docker-compose.yml 2>/dev/null; then
    ok "Downloaded docker-compose.yml"
  else
    warn "Could not download docker-compose.yml — you can fetch it later from $COMPOSE_URL"
  fi
}

start_container() {
  hdr "Starting container"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    say "(dry-run) would run: podman run -d --name pai-dashboard ..."
    return 0
  fi

  # Always use podman run directly — reliable on every platform regardless of
  # compose tool availability. docker-compose.yml is provided for manual
  # management after setup (podman compose up/down/logs).
  local vol_flag
  if [[ "$OS_TYPE" == "linux" ]]; then
    vol_flag="$(pwd)/data:/data:z"
  else
    vol_flag="$(pwd)/data:/data"
  fi

  podman run -d \
    --name pai-dashboard \
    --restart unless-stopped \
    -p 7777:7777 \
    -p 127.0.0.1:6080:6080 \
    -v "$vol_flag" \
    -e PORT=7777 \
    -e CONFIG_DIR=/data/config \
    -e CACHE_DIR=/data/cache \
    -e RH_PROFILE_DIR=/data/rh-profile \
    --env-file .env \
    --shm-size 2g \
    "$IMAGE_REF"
  ok "container started"
}

wait_healthy() {
  hdr "Waiting for dashboard to be healthy"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    say "(dry-run) would poll $HEALTH_URL for up to 30s"
    return 0
  fi
  local i
  for i in $(seq 1 30); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      ok "dashboard healthy after ${i}s"
      return 0
    fi
    printf '.'
    sleep 1
  done
  printf '\n'
  warn "Dashboard did not respond within 30s — check 'podman logs pai-dashboard'."
  return 1
}

open_browser() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    say "(dry-run) would open $DASHBOARD_URL"
    return 0
  fi
  case "$OS_TYPE" in
    darwin) open "$DASHBOARD_URL" 2>/dev/null || say "Open: $DASHBOARD_URL" ;;
    linux)  xdg-open "$DASHBOARD_URL" 2>/dev/null || say "Open: $DASHBOARD_URL" ;;
  esac
}

print_success() {
  hdr "Setup complete"
  printf '  ✓ DailyBriefDashboard is running at http://localhost:%s\n' "$PORT"
  printf '  ✓ Setup wizard opened at %s\n' "$DASHBOARD_URL"
  printf '\n'
  printf '  Next: Complete the wizard to configure OAuth, Google Drive, and your customers.\n'
  printf '  SETUP.md has the full reference if you get stuck.\n'
}

# ---------- Main ----------

main() {
  preview
  run_preflight

  if [[ "$DOCTOR" -eq 1 ]]; then
    hdr "Doctor summary"
    ok "All checks passed — schema v${SETUP_SCHEMA_VERSION}"
    exit "$E_OK"
  fi

  scaffold_dirs
  scaffold_env
  scaffold_compose

  if [[ "$DRY_RUN" -eq 1 ]]; then
    hdr "Dry-run complete"
    say "No changes were made. Re-run without --dry-run to start the container."
    exit "$E_OK"
  fi

  pull_image
  start_container
  wait_healthy || true
  open_browser
  print_success
}

main "$@"
