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

# ── Virtual display ────────────────────────────────────────────────────────────
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
export DISPLAY=:99

# BKL-M50g: Readiness probe — wait for Xvfb to be ready instead of fixed sleep
XVFB_ATTEMPTS=0
XVFB_MAX=50  # 50 × 0.2s = 10s timeout
while ! xdpyinfo -display :99 >/dev/null 2>&1; do
  sleep 0.2
  XVFB_ATTEMPTS=$((XVFB_ATTEMPTS + 1))
  if [ "$XVFB_ATTEMPTS" -ge "$XVFB_MAX" ]; then
    echo "[entrypoint] WARNING: Xvfb not ready after 10s — proceeding anyway"
    break
  fi
done
echo "[entrypoint] Xvfb ready (${XVFB_ATTEMPTS} probes)"

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

# ── Application server ────────────────────────────────────────────────────────
exec bun run server.ts
