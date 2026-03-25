#!/usr/bin/env bash
set -euo pipefail

CONFIG_HOME="${HOME}/.pai-dashboard"
CACHE_HOME="${HOME}/.pai-dashboard-cache"

# Create config and cache directories if they don't exist
mkdir -p "${CONFIG_HOME}"
mkdir -p "${CACHE_HOME}"

# Verify podman is installed
if ! command -v podman &>/dev/null; then
  echo "Error: podman is not installed or not in PATH."
  echo "Install it from https://podman.io/getting-started/installation"
  exit 1
fi

podman run -d \
  --name pai-dashboard \
  -p 7777:7777 \
  -v "${CONFIG_HOME}:/config:Z" \
  -v "${CACHE_HOME}:/cache:Z" \
  --env-file "${CONFIG_HOME}/.env" \
  pai-dashboard:latest

echo "Dashboard running at http://localhost:7777/dashboard"
