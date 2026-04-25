#!/usr/bin/env bats
# BATS test suite for scripts/setup.sh
#
# These tests mock system commands (podman, lsof, df, sysctl, nproc, curl, open,
# xdg-open) via PATH manipulation. Real podman is NOT required.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SETUP="$REPO_ROOT/scripts/setup.sh"

  # Per-test scratch directory
  TMPDIR_TEST="$(mktemp -d)"
  MOCK_BIN="$TMPDIR_TEST/bin"
  WORK="$TMPDIR_TEST/work"
  mkdir -p "$MOCK_BIN" "$WORK"

  # Seed .env.example so scaffold has something to copy
  cp "$REPO_ROOT/.env.example" "$WORK/.env.example"

  # Default happy-path mocks. Individual tests override as needed.
  _mock_happy_path

  # Prepend mock bin so our fakes shadow real tools
  export PATH="$MOCK_BIN:$PATH"

  cd "$WORK"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

# ---------- Mock helpers ----------

_write_mock() {
  # _write_mock <name> <body>
  local name="$1"; shift
  cat > "$MOCK_BIN/$name" <<EOF
#!/usr/bin/env bash
$*
EOF
  chmod +x "$MOCK_BIN/$name"
}

_mock_happy_path() {
  # podman — handles subcommands used by setup.sh
  #   setup.sh calls (happy path):
  #     - podman machine list   (macOS)
  #     - podman machine inspect (macOS)
  #     - podman pull            (image pull)
  #     - podman run             (start container — replaces compose)
  #     - podman compose version (informational detect_compose)
  _write_mock podman '
case "$1" in
  machine)
    case "$2" in
      list)    echo "[{\"Name\":\"podman-machine-default\",\"Running\":true}]" ;;
      inspect) echo "[{\"Resources\":{\"Memory\":8192}},{\"Memory\":8192}]" ;;
      *)       exit 0 ;;
    esac
    ;;
  pull)     exit 0 ;;
  run)      exit 0 ;;
  compose)
    case "$2" in
      version) echo "podman compose 1.0"; exit 0 ;;
      *)       exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
'
  # lsof — port free by default
  _write_mock lsof 'exit 1'
  # curl — default: succeed silently (no-op). Tests that need real file writes
  # override with _write_curl_mock_with_o.
  _write_mock curl 'exit 0'
  # open / xdg-open — no-op
  _write_mock open 'exit 0'
  _write_mock xdg-open 'exit 0'
  # df — plenty of disk (10GB)
  _write_mock df 'echo "Filesystem 1K-blocks Used Available Use% Mounted"; echo "/dev/fake 20000000 5000000 10485760 33% /"'
  # sysctl — macOS memory / cpu
  _write_mock sysctl '
case "$2" in
  hw.memsize) echo 17179869184 ;;   # 16 GB
  hw.ncpu)    echo 8 ;;
  *)          echo 0 ;;
esac
'
  _write_mock nproc 'echo 8'
  _write_mock uname 'echo Darwin'
}

_write_curl_mock_with_o() {
  # curl mock that honors `-o <path>` by writing <content> to that path.
  # All other invocations (e.g. health-check polling) just exit 0.
  # Usage: _write_curl_mock_with_o '<content to write>'
  local content="$1"
  cat > "$MOCK_BIN/curl" <<EOF
#!/usr/bin/env bash
prev=""
dest=""
for a in "\$@"; do
  if [[ "\$prev" == "-o" ]]; then
    dest="\$a"
    break
  fi
  prev="\$a"
done
if [[ -n "\$dest" ]]; then
  printf '%s\n' '${content}' > "\$dest"
fi
exit 0
EOF
  chmod +x "$MOCK_BIN/curl"
}

# ---------- Tests ----------

@test "1. happy path — all prereqs pass, scaffold created, .env copied, podman run invoked" {
  # Track that `podman run` is actually called — replaces the old compose path.
  local sentinel="$TMPDIR_TEST/podman_run_called"
  cat > "$MOCK_BIN/podman" <<EOF
#!/usr/bin/env bash
case "\$1" in
  machine)
    case "\$2" in
      list)    echo '[{"Name":"podman-machine-default","Running":true}]' ;;
      inspect) echo '[{"Resources":{"Memory":8192}},{"Memory":8192}]' ;;
      *)       exit 0 ;;
    esac
    ;;
  pull) exit 0 ;;
  run)  touch "$sentinel"; exit 0 ;;
  compose)
    case "\$2" in
      version) echo "podman compose 1.0"; exit 0 ;;
      *)       exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$MOCK_BIN/podman"

  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  [ -d "$WORK/data/config" ]
  [ -d "$WORK/data/cache" ]
  [ -d "$WORK/data/rh-profile" ]
  [ -f "$WORK/.env" ]
  [ -f "$sentinel" ]
}

@test "2. podman not installed — exit 10 with brew hint" {
  rm -f "$MOCK_BIN/podman"
  # Also block system podman by prepending a stub that replaces command -v lookup:
  # Easiest: create a fake PATH with only our mocks so real podman is hidden.
  export PATH="$MOCK_BIN:/usr/bin:/bin"
  run bash "$SETUP" --yes
  [ "$status" -eq 10 ]
  [[ "$output" == *"brew install podman"* ]]
}

@test "3. podman machine not running (macOS) — exit 11" {
  _write_mock podman '
case "$1" in
  machine)
    case "$2" in
      list)    echo "[{\"Name\":\"podman-machine-default\",\"Running\":false}]" ;;
      inspect) echo "[{\"Memory\":8192}]" ;;
    esac
    ;;
  *) exit 0 ;;
esac
'
  run bash "$SETUP" --yes
  [ "$status" -eq 11 ]
  [[ "$output" == *"podman machine start"* ]]
}

@test "4. podman machine RAM below 4096 — exit 12" {
  _write_mock podman '
case "$1" in
  machine)
    case "$2" in
      list)    echo "[{\"Running\":true}]" ;;
      inspect) echo "[{\"Memory\":2048}]" ;;
    esac
    ;;
  *) exit 0 ;;
esac
'
  run bash "$SETUP" --yes
  [ "$status" -eq 12 ]
  [[ "$output" == *"podman machine stop"* ]]
}

@test "5. disk below threshold — exit 13" {
  _write_mock df 'echo "Filesystem 1K-blocks Used Available Use% Mounted"; echo "/dev/fake 20000000 19000000 1048576 95% /"'
  run bash "$SETUP" --yes
  [ "$status" -eq 13 ]
}

@test "6. port 7777 in use — exit 14" {
  _write_mock lsof 'exit 0'
  run bash "$SETUP" --yes
  [ "$status" -eq 14 ]
  [[ "$output" == *"already in use"* ]]
}

@test "7. existing .env not clobbered" {
  echo "REDHAT_OFFLINE_TOKEN=my_real_token_keep_me" > "$WORK/.env"
  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  grep -q "REDHAT_OFFLINE_TOKEN=my_real_token_keep_me" "$WORK/.env"
}

@test "8. missing .env keys appended" {
  # Override .env.example with multiple uncommented keys so we can verify
  # missing-key append logic independently of the real template's contents.
  cat > "$WORK/.env.example" <<'EOF'
REDHAT_OFFLINE_TOKEN=your_offline_token_here
FOO_KEY=default_foo
BAR_KEY=default_bar
EOF
  # Start with only the first key present
  echo "REDHAT_OFFLINE_TOKEN=existing" > "$WORK/.env"
  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  # Original key + value preserved untouched
  grep -q "REDHAT_OFFLINE_TOKEN=existing" "$WORK/.env"
  # Missing keys appended
  grep -q "FOO_KEY=default_foo" "$WORK/.env"
  grep -q "BAR_KEY=default_bar" "$WORK/.env"
}

@test "9. --doctor flag exits after preflight, no directories created" {
  run bash "$SETUP" --doctor --yes
  [ "$status" -eq 0 ]
  [ ! -d "$WORK/data/config" ]
  [ ! -d "$WORK/data/cache" ]
  [ ! -f "$WORK/.env" ]
}

@test "10. --dry-run narrates but creates nothing" {
  run bash "$SETUP" --dry-run --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"dry-run"* ]]
  [ ! -d "$WORK/data/config" ]
  [ ! -f "$WORK/.env" ]
}

@test "11. --yes flag — no 3-second pause" {
  # A successful run with --yes must complete far faster than the 3s preview would allow.
  local start end elapsed
  start=$(date +%s)
  run bash "$SETUP" --yes --dry-run
  end=$(date +%s)
  elapsed=$((end - start))
  [ "$status" -eq 0 ]
  [ "$elapsed" -lt 3 ]
}

@test "12. schema version printed in --doctor output" {
  run bash "$SETUP" --doctor --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"1.3.1"* ]]
}

@test "13. scaffold_compose downloads docker-compose.yml when missing" {
  # Ensure no docker-compose.yml is present in WORK (default state — not seeded).
  [ ! -f "$WORK/docker-compose.yml" ]

  # curl mock that writes minimal compose content to the `-o` destination.
  _write_curl_mock_with_o 'services: {}'

  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  [ -f "$WORK/docker-compose.yml" ]
  grep -q "services" "$WORK/docker-compose.yml"
}

@test "14. start_container uses podman run, not compose" {
  # Track whether `podman run` (and NOT `podman compose up`) was called.
  local run_sentinel="$TMPDIR_TEST/podman_run_called"
  local compose_up_sentinel="$TMPDIR_TEST/podman_compose_up_called"
  cat > "$MOCK_BIN/podman" <<EOF
#!/usr/bin/env bash
case "\$1" in
  machine)
    case "\$2" in
      list)    echo '[{"Name":"podman-machine-default","Running":true}]' ;;
      inspect) echo '[{"Resources":{"Memory":8192}},{"Memory":8192}]' ;;
      *)       exit 0 ;;
    esac
    ;;
  pull) exit 0 ;;
  run)  touch "$run_sentinel"; exit 0 ;;
  compose)
    case "\$2" in
      version) echo "podman compose 1.0"; exit 0 ;;
      up)      touch "$compose_up_sentinel"; exit 0 ;;
      *)       exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$MOCK_BIN/podman"

  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  [ -f "$run_sentinel" ]
  [ ! -f "$compose_up_sentinel" ]
}

@test "15. .env.example fetched from URL when not present" {
  # Override the setup() seed — remove .env.example so setup.sh has to fetch it.
  rm -f "$WORK/.env.example"
  [ ! -f "$WORK/.env.example" ]

  # curl mock writes a minimal .env.example when setup.sh requests -o .env.example.
  _write_curl_mock_with_o 'REDHAT_OFFLINE_TOKEN=test'

  run bash "$SETUP" --yes
  [ "$status" -eq 0 ]
  # .env created from the fetched template
  [ -f "$WORK/.env" ]
  grep -q "REDHAT_OFFLINE_TOKEN=test" "$WORK/.env"
}
