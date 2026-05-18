#!/usr/bin/env bash
# entrypoint.sh — Container startup script
#
# Starts the noVNC display stack so the RH Portal login browser can render
# in a browser tab at http://localhost:6080/vnc.html (for headless deployments).
# The dashboard's "Reconnect" button opens this URL automatically.
#
# Stack: Xvfb (virtual display) → x11vnc (VNC server) → websockify (WebSocket bridge)
# Chromium (Playwright headless:false) renders into :99 — noVNC makes it accessible.

set -e

# ── Load default env vars (user's --env-file values take precedence) ──────────
# defaults.env ships inside the image with working Gemini config, etc.
# Any variable already set (via --env-file .env or -e flags) is NOT overwritten.
if [ -f /app/defaults.env ]; then
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" == \#* || "$key" == " "* ]] && continue
    # Only export if not already set
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < /app/defaults.env
fi

# ── OAuth keys (#109) ─────────────────────────────────────────────────────────
# OAuth client credentials are bundled in src/google-oauth-config.ts (council
# decision 2026-05-11). No file provisioning needed — the server reads from
# source code, not gcp-oauth.keys.json. File-based override still works if present.

# ── Load REDHAT_OFFLINE_TOKEN from persistent volume (Issue #87) ──────────────
# Hero install saves token via wizard to /data/config/.rh-token so it survives restarts.
# Only source if not already set (env file takes precedence).
if [ -f /data/config/.rh-token ] && [ -z "${REDHAT_OFFLINE_TOKEN+x}" ]; then
  export REDHAT_OFFLINE_TOKEN="$(cat /data/config/.rh-token)"
  echo "[entrypoint] Loaded REDHAT_OFFLINE_TOKEN from persistent volume"
fi

# ── Seed config templates on first boot ────────────────────────────────────────
# Templates ship at /app/config-templates/. On first boot, copy any missing files
# to the persistent volume at /data/config/. Existing files are never overwritten.
# New features just drop a .json file in config-templates/ — no entrypoint edits needed.
if [ -d /app/config-templates ]; then
  for tmpl in /app/config-templates/*.json; do
    [ -f "$tmpl" ] || continue
    fname=$(basename "$tmpl")
    if [ ! -f "/data/config/$fname" ]; then
      cp "$tmpl" "/data/config/$fname"
      echo "[entrypoint] Seeded config template: $fname"
    fi
  done
fi

# ── Seed value maps on first boot ──────────────────────────────────────────────
if [ -f /app/config-templates/business-value-maps.txt ] && [ ! -f /data/cache/value-maps/business-value-maps.txt ]; then
  mkdir -p /data/cache/value-maps
  cp /app/config-templates/business-value-maps.txt /data/cache/value-maps/business-value-maps.txt
  echo "[entrypoint] Seeded business value maps to cache"
fi

# ── Virtual display ────────────────────────────────────────────────────────────
# Clean up stale X lock files from previous run (left behind by podman restart)
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
export DISPLAY=:99

# BKL-M50g: Readiness probe — wait for Xvfb to be ready instead of fixed sleep
XVFB_FAIL_THRESHOLD=10  # 10 × 0.2s — lower values cause kill-loop during Chromium automation
XVFB_ATTEMPTS=0
while ! test -S /tmp/.X11-unix/X99; do
  sleep 0.2
  XVFB_ATTEMPTS=$((XVFB_ATTEMPTS + 1))
  if [ "$XVFB_ATTEMPTS" -ge "$XVFB_FAIL_THRESHOLD" ]; then
    echo "[entrypoint] WARNING: Xvfb not ready after ${XVFB_FAIL_THRESHOLD} attempts — proceeding anyway"
    break
  fi
done
echo "[entrypoint] Xvfb ready (${XVFB_ATTEMPTS} probes)"
sleep 30

# ── Window manager — gives VNC a visible desktop (not just a black screen) ──
openbox &

# ── VNC server (reads the Xvfb display, streams over VNC protocol) ─────────────
# -nopw       : no VNC password — port is bound to localhost only (see below)
# -localhost  : only accept connections from 127.0.0.1 (websockify proxies in)
# -forever    : keep running after the first client disconnects
# Auto-respawn x11vnc if killed mid-session (BKL-I01)
(while true; do
  x11vnc -display :99 -nopw -localhost -rfbport 5900 -forever -quiet 2>/dev/null
  echo "[entrypoint] x11vnc exited — restarting in 2s..."
  sleep 2
done) &

# ── noVNC / websockify (bridges VNC TCP → WebSocket for browser access) ────────
# Serves the HTML5 noVNC viewer at http://localhost:6080/vnc.html
# --web path serves the noVNC static files; proxies WebSocket → VNC :5900
websockify --web /usr/share/novnc 6080 localhost:5900 &

# ── Application server or sync daemon ────────────────────────────────────────
# SYNC_DAEMON=true → run the L3 sync daemon instead of the app server.
# Both share the same image; the daemon needs Xvfb (above) for Playwright.
if [ "${SYNC_DAEMON}" = "true" ] && [ -f /app/scripts/sync-l3-daemon.ts ]; then
  echo "[entrypoint] SYNC_DAEMON=true — starting L3 sync daemon"
  exec bun run scripts/sync-l3-daemon.ts
fi

bun run scripts/preflight.ts
exec bun run server.ts
