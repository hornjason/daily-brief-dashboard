#!/usr/bin/env bash
# Fails build if any empty catch blocks exist in dashboard/src/.
# Part of BKL-TEST-13: CI gate to prevent silent error swallowing.
set -e

PATTERN='\.catch\s*(\s*(\(\s*\)|\(\s*_\s*\))\s*=>\s*\{\s*\})'
FOUND=$(grep -rEn "$PATTERN" dashboard/src/ 2>/dev/null || true)

if [ -n "$FOUND" ]; then
  echo "❌  Empty catch blocks found in dashboard/src/ — fix before committing:"
  echo "$FOUND"
  echo ""
  echo "Replace .catch(() => {}) with .catch(e => console.error('[context]', e))"
  echo "or migrate to useAction hook (see dashboard/src/hooks/useAction.ts)"
  exit 1
fi

echo "✅  No empty catch blocks found in dashboard/src/"
