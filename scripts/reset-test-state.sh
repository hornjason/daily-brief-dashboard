#!/bin/bash
# reset-test-state.sh
# Wipes all runtime data to factory state before E2E testing.
# Run this before every test run — no exceptions.
# Preserves: .google-token.json, gcp-oauth.keys.json, .env, rh-profile/, .rh-session.json

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/data"

echo "[reset] Starting factory reset..."

# 1. Wipe AE config
echo '{"aes":[]}' > "$DATA_DIR/config/aes.json"
echo "[reset] aes.json cleared"

# 2. Wipe customer config
echo '{"customers":[]}' > "$DATA_DIR/config/customers.json"
echo "[reset] customers.json cleared"

# 3. Wipe all cache files
rm -f "$DATA_DIR/cache/"*.json "$DATA_DIR/cache/"*.png 2>/dev/null || true
echo "[reset] data/cache/ cleared"

# 4. Preserve RH browser profile and session marker — cookies survive reset so
#    Quinn can reconnect without a manual VNC login each cycle.
echo "[reset] rh-profile/ preserved (cookies kept for auto-reconnect)"

# 5. Wipe state files (preserve .rh-session.json — session marker stays with profile)
rm -f "$DATA_DIR/config/drive-watcher-state.json" 2>/dev/null || true
rm -f "$DATA_DIR/config/oauth-state.json" 2>/dev/null || true
echo "[reset] state files cleared"

# 6. Restart container
echo "[reset] Restarting container..."
cd "$PROJECT_DIR"
make down
make up

# 7. Wait for server to be healthy
echo "[reset] Waiting for server..."
for i in $(seq 1 15); do
  sleep 2
  HEALTH=$(curl -s http://localhost:7777/health 2>/dev/null || true)
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    AES=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['aes'])" 2>/dev/null || echo "?")
    CUSTOMERS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['customers'])" 2>/dev/null || echo "?")
    echo "[reset] Server healthy — aes:$AES customers:$CUSTOMERS"
    if [ "$AES" = "0" ] && [ "$CUSTOMERS" = "0" ]; then
      echo "[reset] Factory reset complete. Ready for E2E testing."
      exit 0
    else
      echo "[reset] WARNING: Expected aes:0 customers:0 but got aes:$AES customers:$CUSTOMERS"
      exit 1
    fi
  fi
  echo "[reset] Waiting... ($i/15)"
done

echo "[reset] ERROR: Server did not become healthy within 30 seconds"
exit 1
