#!/usr/bin/env bats
# BATS test suite for scripts/check-env-drift.sh
#
# check-env-drift.sh derives REPO_ROOT from its own script location (one level
# up from the script). So to isolate each test, we copy the script + the three
# config files it reads (.env.example, docker-compose.yml, scripts/setup.sh)
# into a temp repo and run the copy.

setup() {
  REAL_REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"

  # Per-test scratch repo
  TMPDIR_TEST="$(mktemp -d)"
  FAKE_REPO="$TMPDIR_TEST/repo"
  mkdir -p "$FAKE_REPO/scripts"

  # Copy the script under test
  cp "$REAL_REPO_ROOT/scripts/check-env-drift.sh" "$FAKE_REPO/scripts/check-env-drift.sh"
  chmod +x "$FAKE_REPO/scripts/check-env-drift.sh"

  DRIFT="$FAKE_REPO/scripts/check-env-drift.sh"

  # Default happy-path fixtures — individual tests override as needed.
  _write_happy_env_example
  _write_happy_compose
  _write_happy_setup
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ---------- Fixture helpers ----------

_write_happy_env_example() {
  cat > "$FAKE_REPO/.env.example" <<'EOF'
# Required token
REDHAT_OFFLINE_TOKEN=your_offline_token_here

# Commented optional key — should NOT be a required key
# GOOGLE_CLOUD_PROJECT=your-project
EOF
}

_write_happy_compose() {
  cat > "$FAKE_REPO/docker-compose.yml" <<'EOF'
services:
  dashboard:
    image: ghcr.io/hornjason/daily-brief-dashboard:latest
    ports:
      - "7777:7777"
    volumes:
      - ./data:/data
    environment:
      PORT: "7777"
      CONFIG_DIR: /data/config
      CACHE_DIR: /data/cache
      RH_PROFILE_DIR: /data/rh-profile
      REDHAT_OFFLINE_TOKEN: "${REDHAT_OFFLINE_TOKEN}"
    env_file:
      - .env
EOF
}

_write_happy_setup() {
  cat > "$FAKE_REPO/scripts/setup.sh" <<'EOF'
#!/usr/bin/env bash
# Setup scaffolder — copies .env.example into .env
cp .env.example .env
EOF
  chmod +x "$FAKE_REPO/scripts/setup.sh"
}

# ---------- Tests ----------

@test "1. happy path — consistent fixtures exit 0" {
  run bash "$DRIFT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"env drift check passed"* ]]
}

@test "2. env_file directive missing from compose — exit 1 with clear message" {
  # Rewrite compose without the env_file block
  cat > "$FAKE_REPO/docker-compose.yml" <<'EOF'
services:
  dashboard:
    image: ghcr.io/hornjason/daily-brief-dashboard:latest
    environment:
      PORT: "7777"
      REDHAT_OFFLINE_TOKEN: "${REDHAT_OFFLINE_TOKEN}"
EOF
  run bash "$DRIFT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"env_file"* ]]
}

@test "3. compose environment key missing from .env.example — exit 1" {
  # Compose declares NEW_USER_KEY but .env.example does not
  cat > "$FAKE_REPO/docker-compose.yml" <<'EOF'
services:
  dashboard:
    image: ghcr.io/hornjason/daily-brief-dashboard:latest
    environment:
      PORT: "7777"
      CONFIG_DIR: /data/config
      NEW_USER_KEY: "${NEW_USER_KEY}"
    env_file:
      - .env
EOF
  run bash "$DRIFT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"NEW_USER_KEY"* ]]
  [[ "$output" == *"missing from .env.example"* ]]
}

@test "4. internal key allowlist — PORT CONFIG_DIR CACHE_DIR RH_PROFILE_DIR exempt" {
  # .env.example has ONLY REDHAT_OFFLINE_TOKEN. Compose declares all four
  # internal keys plus REDHAT_OFFLINE_TOKEN — should still pass.
  cat > "$FAKE_REPO/.env.example" <<'EOF'
REDHAT_OFFLINE_TOKEN=your_offline_token_here
EOF
  cat > "$FAKE_REPO/docker-compose.yml" <<'EOF'
services:
  dashboard:
    image: ghcr.io/hornjason/daily-brief-dashboard:latest
    environment:
      PORT: "7777"
      CONFIG_DIR: /data/config
      CACHE_DIR: /data/cache
      RH_PROFILE_DIR: /data/rh-profile
      REDHAT_OFFLINE_TOKEN: "${REDHAT_OFFLINE_TOKEN}"
    env_file:
      - .env
EOF
  run bash "$DRIFT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"env drift check passed"* ]]
}

@test "5. empty .env.example — exit 0 (no required keys = no drift possible)" {
  # Empty .env.example. Compose only declares internal keys.
  : > "$FAKE_REPO/.env.example"
  cat > "$FAKE_REPO/docker-compose.yml" <<'EOF'
services:
  dashboard:
    image: ghcr.io/hornjason/daily-brief-dashboard:latest
    environment:
      PORT: "7777"
      CONFIG_DIR: /data/config
      CACHE_DIR: /data/cache
      RH_PROFILE_DIR: /data/rh-profile
    env_file:
      - .env
EOF
  run bash "$DRIFT"
  [ "$status" -eq 0 ]
}

@test "6. setup.sh does not reference .env.example — exit 1" {
  cat > "$FAKE_REPO/scripts/setup.sh" <<'EOF'
#!/usr/bin/env bash
# Broken scaffolder that doesn't reference the template
echo "setup"
EOF
  run bash "$DRIFT"
  [ "$status" -eq 1 ]
  [[ "$output" == *"setup.sh"* ]]
  [[ "$output" == *".env.example"* ]]
}
