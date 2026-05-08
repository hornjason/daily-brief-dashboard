#!/bin/bash
# scripts/enable-east-comm-pod01.sh
#
# Enables East Commercial POD01 on the Mac Mini L4 daemon
# Run this ON THE MAC MINI after SSHing in
#
# Usage: cd ~/DailyBriefDashboard && bash scripts/enable-east-comm-pod01.sh

set -e

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Enabling East Commercial POD01 on L4 Daemon"
echo "════════════════════════════════════════════════════════════"
echo ""

# Verify we're in the project directory
if [ ! -f "Makefile" ]; then
  echo "❌ Error: Not in DailyBriefDashboard directory"
  echo "   Run: cd ~/DailyBriefDashboard && bash scripts/enable-east-comm-pod01.sh"
  exit 1
fi

# Step 1: Show current daemon config
echo "Step 1: Current daemon config"
echo "────────────────────────────────────────────────────────────"
if [ -f "data-sync/config/settings.json" ]; then
  echo "Current regions in daemon config:"
  grep -o '"id": "[^"]*"' data-sync/config/settings.json | sed 's/"id": "//g' | sed 's/"//g' | sed 's/^/  • /'
else
  echo "⚠️  No daemon config found at data-sync/config/settings.json"
fi
echo ""

# Step 2: Copy latest settings.json
echo "Step 2: Copying latest settings.json to daemon volume"
echo "────────────────────────────────────────────────────────────"
cp scripts/seed-data/settings.json data-sync/config/settings.json
echo "✅ Copied scripts/seed-data/settings.json → data-sync/config/settings.json"
echo ""

# Verify the copy
echo "New regions in daemon config:"
grep -o '"id": "[^"]*"' data-sync/config/settings.json | sed 's/"id": "//g' | sed 's/"//g' | sed 's/^/  • /'
echo ""

# Step 3: Restart daemon
echo "Step 3: Restarting L4 sync daemon"
echo "────────────────────────────────────────────────────────────"
make sync-down
sleep 2
make sync-up
echo "✅ Daemon restarted"
echo ""

# Step 4: Wait for daemon to initialize
echo "Step 4: Waiting for daemon to initialize (10 seconds)..."
echo "────────────────────────────────────────────────────────────"
sleep 10

# Step 5: Trigger immediate sync
echo "Step 5: Triggering immediate sync"
echo "────────────────────────────────────────────────────────────"
make sync-now
echo "✅ Sync trigger sent (daemon will pick up within 30 seconds)"
echo ""

# Step 6: Watch logs
echo "Step 6: Watching daemon logs..."
echo "────────────────────────────────────────────────────────────"
echo "Look for:"
echo "  • [sync-daemon] loaded 3 regions, 9 total pods"
echo "  • [sync-daemon] trigger file detected"
echo "  • Syncing POD01..."
echo ""
echo "Press Ctrl+C to stop watching logs"
echo ""
sleep 2

make sync-logs
