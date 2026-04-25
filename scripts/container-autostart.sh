#!/usr/bin/env bash
# Auto-start the production container (pai-dashboard) after Mac Mini reboot.
# Runs as a LaunchAgent (user-level) via com.asacommandcenter.container-autostart.plist.
#
# Install (run once on Mac Mini):
#   cp scripts/com.asacommandcenter.container-autostart.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.asacommandcenter.container-autostart.plist
#
# Logs: /tmp/container-autostart.log

set -euo pipefail

LOG=/tmp/container-autostart.log
DASHBOARD_DIR=/Users/jasonhorn/DailyBriefDashboard

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*" | tee -a "$LOG"; }

log "Container autostart triggered"

# Wait for Podman machine to be ready (up to 3 minutes)
COUNT=0
until podman info &>/dev/null 2>&1; do
  sleep 10
  COUNT=$((COUNT+1))
  if [ $COUNT -ge 18 ]; then
    log "ERROR: Podman machine not ready after 3 minutes — giving up"
    exit 1
  fi
  log "Waiting for Podman machine... (${COUNT}/18)"
done
log "Podman machine ready"

# Check if already running
if podman ps --format "{{.Names}}" 2>/dev/null | grep -q "^pai-dashboard$"; then
  log "pai-dashboard already running — no action needed"
  exit 0
fi

# Start stopped container if it exists, otherwise run make up
if podman ps -a --format "{{.Names}}" 2>/dev/null | grep -q "^pai-dashboard$"; then
  log "Starting stopped pai-dashboard container"
  podman start pai-dashboard
  log "pai-dashboard started"
else
  log "Container not found — running make up"
  cd "$DASHBOARD_DIR"
  make up
  log "make up complete"
fi

log "Done"
