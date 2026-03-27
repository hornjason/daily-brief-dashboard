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
# Pre-push hook: runs smoke test against live data before pushing
# Skip with: git push --no-verify

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo ""
bun run test:smoke
exit $?
EOF

chmod +x "$HOOKS_DIR/pre-push"
echo "  ✅ pre-push hook installed"
echo ""
echo "Done. The smoke test will run before every 'git push'."
echo "To skip: git push --no-verify"
