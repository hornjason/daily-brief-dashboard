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
# Pre-push hook: Gate 1 — unit tests, type check, hero purity
# Skip with: git push --no-verify
# Quick mode: QUICK_PUSH=1 git push (skips unit tests, keeps typecheck + hero purity)

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

FAILED=0

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
