#!/usr/bin/env bash
# check-env-drift.sh — CI drift gate for env/compose/setup consistency
#
# Verifies that the three sources of environment configuration agree:
#   1. .env.example         — the template users copy from
#   2. docker-compose.yml   — container env + env_file directive
#   3. scripts/setup.sh     — the onboarding scaffolder
#
# Drift rules enforced:
#   - Every REQUIRED (non-commented) key in .env.example must be a key the
#     user can actually set — i.e. setup.sh must reference .env.example as
#     its scaffold source (via scaffold_env reading .env.example).
#   - docker-compose.yml must declare env_file: .env so user-set keys flow
#     into the container.
#   - Every key explicitly listed in compose `environment:` must either
#     appear in .env.example OR be a known container-internal override
#     (CONFIG_DIR, CACHE_DIR, RH_PROFILE_DIR, PORT).
#
# Exit codes:
#   0 — in sync
#   1 — drift detected
#
# Bash 3.2 compatible.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_EXAMPLE="$REPO_ROOT/.env.example"
COMPOSE="$REPO_ROOT/docker-compose.yml"
SETUP="$REPO_ROOT/scripts/setup.sh"

fail() {
  printf '✗ drift: %s\n' "$1" >&2
  exit 1
}

# Container-internal keys — these are set by compose explicitly and do not
# need to appear in .env.example (they're overrides for container paths).
INTERNAL_KEYS="CONFIG_DIR CACHE_DIR RH_PROFILE_DIR PORT"

is_internal() {
  local k="$1" i
  for i in $INTERNAL_KEYS; do
    [[ "$k" == "$i" ]] && return 0
  done
  return 1
}

# --- 1. Extract required (non-commented) keys from .env.example -------------
# A required key is a line matching ^KEY= (no leading # and no leading space).
env_example_keys() {
  # grep returns 1 when there are no matches (e.g. empty .env.example) —
  # that is not an error, it just means no required keys. Tolerate it under set -e.
  grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_EXAMPLE" 2>/dev/null | cut -d= -f1 | sort -u || true
}

# --- 2. Extract compose `environment:` keys ---------------------------------
# Matches lines under `environment:` of the form `  KEY: "value"` or `  KEY: value`.
compose_env_keys() {
  awk '
    /^[[:space:]]+environment:[[:space:]]*$/ { in_env=1; next }
    in_env && /^[[:space:]]+[A-Z_][A-Z0-9_]*:[[:space:]]*/ {
      sub(/^[[:space:]]+/, "")
      sub(/:.*$/, "")
      print
      next
    }
    in_env && /^[[:space:]]*[^[:space:]]/ && !/^[[:space:]]+[A-Z_]/ { in_env=0 }
  ' "$COMPOSE" | sort -u
}

# --- 3. Verify compose declares env_file: .env ------------------------------
if ! grep -qE '^[[:space:]]+-[[:space:]]+\.env[[:space:]]*$' "$COMPOSE" \
  || ! grep -qE '^[[:space:]]+env_file:' "$COMPOSE"; then
  fail "docker-compose.yml must declare 'env_file: [- .env]' so user-set keys reach the container."
fi

# --- 4. Verify setup.sh scaffolds from .env.example -------------------------
if ! grep -qE '\.env\.example' "$SETUP"; then
  fail "scripts/setup.sh must reference .env.example as its scaffold source."
fi

# --- 5. Diff: every compose `environment:` key must be internal OR in .env.example
example_keys="$(env_example_keys)"
compose_keys="$(compose_env_keys)"

missing=""
for k in $compose_keys; do
  if is_internal "$k"; then
    continue
  fi
  if ! printf '%s\n' "$example_keys" | grep -qx "$k"; then
    missing="$missing $k"
  fi
done

if [[ -n "$missing" ]]; then
  fail "compose declares env keys missing from .env.example:${missing}"
fi

# --- 6. Report --------------------------------------------------------------
printf '✓ env drift check passed\n'
printf '  .env.example required keys: %d\n' "$(printf '%s\n' "$example_keys" | grep -c . || true)"
printf '  docker-compose.yml env keys: %d (%s internal)\n' \
  "$(printf '%s\n' "$compose_keys" | grep -c . || true)" \
  "$(printf '%s\n' "$compose_keys" | grep -cE "^($(echo "$INTERNAL_KEYS" | tr ' ' '|'))$" || true)"
exit 0
