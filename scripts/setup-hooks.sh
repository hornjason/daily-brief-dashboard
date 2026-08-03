#!/usr/bin/env bash
# scripts/setup-hooks.sh
#
# Installs git hooks for this repo. Run once after cloning:
#   bash scripts/setup-hooks.sh

set -e

HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing git hooks..."

cat > "$HOOKS_DIR/pre-push" << 'EOF'
#!/usr/bin/env bash
# Pre-push hook: verify-gate + Gate 1 (unit tests, type check, hero purity)
# Skip with: git push --no-verify
# Quick mode: QUICK_PUSH=1 git push (skips unit tests, keeps typecheck + hero purity)

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PAI_WORK_DIR="${PAI_WORK_DIR:-$HOME/.pai-work}"

FAILED=0

echo ""
echo "━━━ Verify Gate: Ship Verification Check ━━━"
echo ""

# Find most recent .ship-active marker by mtime
LATEST_MARKER=""
LATEST_MTIME=0

if [ -d "$PAI_WORK_DIR" ]; then
  for marker in "$PAI_WORK_DIR"/*/.ship-active; do
    [ -f "$marker" ] || continue
    if [ "$(uname)" = "Darwin" ]; then
      MTIME=$(stat -f %m "$marker" 2>/dev/null || echo 0)
    else
      MTIME=$(stat -c %Y "$marker" 2>/dev/null || echo 0)
    fi
    if [ "$MTIME" -gt "$LATEST_MTIME" ]; then
      LATEST_MTIME="$MTIME"
      LATEST_MARKER="$marker"
    fi
  done
fi

if [ -n "$LATEST_MARKER" ]; then
  MARKER_DIR="$(dirname "$LATEST_MARKER")"
  VERIFY_FILE="$MARKER_DIR/verify-check.json"

  if [ ! -f "$VERIFY_FILE" ]; then
    echo "  PRE-PUSH BLOCKED: .ship-active found but verify-check.json missing."
    echo ""
    echo "   Ship marker: $LATEST_MARKER"
    echo "   Expected:    $VERIFY_FILE"
    echo ""
    echo "   Run the verify gate before pushing (ship VERIFY creates verify-check.json)."
    echo "   Skip with: git push --no-verify"
    echo ""
    exit 1
  fi

  FAIL_COUNT=$(grep -o '"fail"[[:space:]]*:[[:space:]]*[0-9]*' "$VERIFY_FILE" | grep -o '[0-9]*$' || echo "")
  if [ -z "$FAIL_COUNT" ]; then
    echo "  PRE-PUSH BLOCKED: verify-check.json exists but could not parse fail count."
    echo ""
    echo "   File: $VERIFY_FILE"
    echo "   Skip with: git push --no-verify"
    echo ""
    exit 1
  fi

  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "  PRE-PUSH BLOCKED: verify-check.json has $FAIL_COUNT failure(s)."
    echo ""
    echo "   File: $VERIFY_FILE"
    echo "   Fix verification failures before pushing."
    echo "   Skip with: git push --no-verify"
    echo ""
    exit 1
  fi

  echo "  Verify gate passed (0 failures)"
else
  echo "  No .ship-active marker found — skipping verify gate (non-ship commit)"
fi

echo ""
echo "━━━ Gate 1: Pre-Push Checks ━━━"
echo ""

# Check 1: Unit tests (skippable with QUICK_PUSH=1)
if [ -z "$QUICK_PUSH" ]; then
  echo "▸ Running unit tests..."
  if bun test test/unit/; then
    echo "  ✅ Unit tests passed"
  else
    echo "  ❌ Unit tests failed"
    FAILED=1
  fi
  echo ""
else
  echo "▸ Skipping unit tests (QUICK_PUSH=1)"
  echo ""
fi

# Check 2: TypeScript type check (always runs)
echo "▸ Type checking..."
if bunx tsc --noEmit; then
  echo "  ✅ Type check passed"
else
  echo "  ❌ Type check failed"
  FAILED=1
fi
echo ""

# Check 3: Hero purity check (always runs)
echo "▸ Hero purity check (L3-only, no L4 imports)..."
if bunx tsc --noEmit --project tsconfig.hero.json; then
  echo "  ✅ Hero purity passed"
else
  echo "  ❌ Hero purity failed (L4 dependency imported in L3 code)"
  FAILED=1
fi
echo ""

if [ $FAILED -eq 1 ]; then
  echo "━━━ Gate 1: FAILED ━━━"
  echo ""
  exit 1
fi

echo "━━━ Gate 1: PASSED ━━━"
echo ""
exit 0
EOF

chmod +x "$HOOKS_DIR/pre-push"
echo "  ✅ pre-push hook installed"
echo ""
echo "Done. Gate 1 checks (unit tests, typecheck, hero purity) will run before every 'git push'."
echo "To skip unit tests only: QUICK_PUSH=1 git push"
echo "To skip all checks: git push --no-verify"
