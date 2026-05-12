#!/usr/bin/env bats
# BATS test suite for scripts/nightly-assertions.ts
#
# Tests the nightly data assertion script against known-good seed data
# and validates failure modes (missing fields, empty arrays, etc).

setup() {
  REAL_REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"

  # Per-test scratch directory for config files
  TMPDIR_TEST="$(mktemp -d)"
  FAKE_CONFIG_DIR="$TMPDIR_TEST/config"
  mkdir -p "$FAKE_CONFIG_DIR"

  # Test server port — use a unique port to avoid conflicts
  TEST_PORT=7799
  TEST_SERVER_PID=""
}

teardown() {
  # Kill test server if still running
  if [ -n "$TEST_SERVER_PID" ]; then
    kill "$TEST_SERVER_PID" 2>/dev/null || true
    wait "$TEST_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR_TEST"
}

# ---------- Fixture helpers ----------

_write_seed_aes() {
  cp "$REAL_REPO_ROOT/scripts/seed-data/aes.json" "$FAKE_CONFIG_DIR/aes.json"
}

_write_seed_customers() {
  cp "$REAL_REPO_ROOT/scripts/seed-data/customers.json" "$FAKE_CONFIG_DIR/customers.json"
}

_write_empty_aes() {
  cat > "$FAKE_CONFIG_DIR/aes.json" <<'EOF'
{
  "aes": []
}
EOF
}

_write_empty_customers() {
  cat > "$FAKE_CONFIG_DIR/customers.json" <<'EOF'
{
  "customers": []
}
EOF
}

_write_invalid_customer_missing_name() {
  cat > "$FAKE_CONFIG_DIR/customers.json" <<'EOF'
{
  "customers": [
    { "domain": "example.com", "accountNumbers": ["12345"], "ae": "Test AE One" }
  ]
}
EOF
}

_write_invalid_customer_missing_ae() {
  cat > "$FAKE_CONFIG_DIR/customers.json" <<'EOF'
{
  "customers": [
    { "name": "Test Customer", "domain": "example.com", "accountNumbers": ["12345"] }
  ]
}
EOF
}

_start_test_server() {
  # Minimal test server that serves static JSON from config dir
  # This is a lightweight alternative to starting the full dashboard server
  cat > "$TMPDIR_TEST/server.ts" <<EOF
import { serve } from 'bun'
import { readFileSync } from 'fs'

serve({
  port: $TEST_PORT,
  fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/aes') {
      const data = readFileSync('$FAKE_CONFIG_DIR/aes.json', 'utf-8')
      return new Response(data, { headers: { 'Content-Type': 'application/json' } })
    }

    if (url.pathname === '/api/accounts') {
      // /api/accounts returns {customers: [...]} not {accounts: [...]}
      const data = readFileSync('$FAKE_CONFIG_DIR/customers.json', 'utf-8')
      return new Response(data, { headers: { 'Content-Type': 'application/json' } })
    }

    return new Response('Not Found', { status: 404 })
  }
})
EOF

  bun "$TMPDIR_TEST/server.ts" &
  TEST_SERVER_PID=$!

  # Wait for server to be ready (up to 5 seconds)
  for i in {1..10}; do
    if curl -sf "http://localhost:$TEST_PORT/api/aes" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  echo "ERROR: Test server failed to start" >&2
  return 1
}

# ---------- Tests ----------

@test "1. happy path — seed data exits 0" {
  _write_seed_aes
  _write_seed_customers
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 0 ]
  [[ "$output" == *"All assertions passed"* ]]
}

@test "2. zero AEs configured — exit 1 with clear message" {
  _write_empty_aes
  _write_seed_customers
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Zero AEs configured"* ]]
}

@test "3. zero customers configured — exit 1 with clear message" {
  _write_seed_aes
  _write_empty_customers
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Zero customers configured"* ]]
}

@test "4. customer missing required field: name — exit 1" {
  _write_seed_aes
  _write_invalid_customer_missing_name
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing required field: name"* ]]
}

@test "5. customer missing required field: ae — exit 1" {
  _write_seed_aes
  _write_invalid_customer_missing_ae
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing required field: ae"* ]]
}

@test "6. API unavailable — exit 1 with fetch error" {
  # Don't start server — assertions should fail gracefully
  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"fetch failed"* ]] || [[ "$output" == *"ECONNREFUSED"* ]]
}

@test "7. AE with zero customers — exit 1" {
  # Write seed AEs but customers that don't reference them
  _write_seed_aes
  cat > "$FAKE_CONFIG_DIR/customers.json" <<'EOF'
{
  "customers": [
    { "name": "Orphan Customer", "ae": "Nonexistent AE", "accountNumbers": ["99999"] }
  ]
}
EOF
  _start_test_server

  run env BASE_URL="http://localhost:$TEST_PORT" bun "$REAL_REPO_ROOT/scripts/nightly-assertions.ts"
  [ "$status" -eq 1 ]
  [[ "$output" == *"has zero customers"* ]]
}
