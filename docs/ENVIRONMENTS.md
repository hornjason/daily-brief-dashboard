# Environment Strategy
*Last validated: 2026-04-21 | Owner: DA | Trigger: New container tier, port change, new Makefile target, CI workflow changes*

**DailyBriefDashboard runs four isolated containers.** Each has a specific role and rules about what can be tested/deployed there.

---

## Environment Tiers

| Name | Port | Data | Reset? | Purpose |
|------|------|------|--------|---------|
| `pai-dashboard` | 7777 | Live production data | No | Production — Jason's daily workflow |
| `pai-dashboard-dev` | 7778 | Snapshot of prod data | No | Dev experiments (infrequently used) |
| `pai-dashboard-test` | 7776 | Seed data (synthetic) | Yes (`ALLOW_RESET=true`) | Automated test suite, @destructive tests |
| `pai-dashboard-demo` | 7779 | Frozen prod snapshot | Read-only | Stakeholder demos, tunnel sharing |

---

## The Promotion Rule (HARD RULE — Zero Exceptions)

```
code change → test container (7776) → Quinn passes → make rebuild (prod 7777)
```

1. **Code written** (worktree agent or direct)
2. **Deploy to test container:** use the right command for the situation:
   - `make test-rebuild` — **code changed** → rebuilds image first, then starts 7776 (**use this after any source edit**)
   - `make test-up` — **no code change** → fast restart using the existing image (e.g. data wipe, re-seed only)
3. **Run CI suite against test:** `BASE_URL=http://localhost:7776 bunx playwright test --project=ci`
4. **Quinn visual audit on 7776** (if UI changes)
5. **All pass → `make rebuild`** (promotes to prod 7777)

**Never run `make rebuild` as a first step.** Test first, promote second. Violations waste Jason's time when bugs land in production.

> **⚠️ Stale image trap:** `make test-up` does NOT rebuild the image. If you edited source and used `make test-up`, the test container is running old code and your tests are meaningless. Always use `make test-rebuild` after a code change.
>
> **Syncing test after `make rebuild`:** `make rebuild` already builds a new `:latest` image. To bring the test container in sync afterward, just run `make test-up` — the image is already current, no second build needed.

For a full pre-promote gate (lint + real data + destructive): `make pre-promote && make rebuild`

---

## Quick Reference

```bash
# Start test container — code changed (rebuilds image first)
make test-rebuild

# Start test container — no code change (fast restart, same image)
make test-up

# Stop test container
make test-down

# View test container logs
make test-logs

# Seed test data without starting container
make seed

# Save current data-test/ as versioned tarball (run after successful onboarding-check)
make test-snapshot

# Restore newest snapshot into data-test/ (skips full bootstrap, test container must be stopped)
make test-restore

# Full promotion gate (lint + real data + destructive tests)
make pre-promote && make rebuild

# Freeze current prod data for demo
make demo-snapshot

# Start demo container (port 7779, read-only frozen data)
make demo-up

# Stop demo container
make demo-down

# Share demo via tunnel (Cloudflare, temporary URL)
make demo-tunnel

# Stop tunnel
make demo-tunnel-stop

# Show which containers are running
make env-status

# Start dev snapshot container (port 7778)
make dev-snapshot && make dev-up
```

---

## Test Container Details

- Port 7776, `ALLOW_RESET=true` — enables `/api/__test/snapshot`, `/api/__test/restore`, `/api/setup/reset`
- **Snapshot/restore protocol:** `POST /api/__test/restore` requires a prior `POST /api/__test/snapshot` — calling restore without a snapshot is blocked (production data guard). Always snapshot first in test `beforeAll`.
- Seed data: `data-test/` populated from `scripts/seed-data/` by `make seed`
- Every `make test-up` re-seeds from scratch (idempotent)
- Run `@destructive` tagged tests against port 7776 only — never 7777

**Test-specific env vars:**
```bash
BASE_URL=http://localhost:7776      # point playwright at test container
TEST_URL=http://localhost:7776      # alias used in some specs
TEST_KNOWN_CUSTOMER="Acme Corp"    # seed data fixture customer name
ALLOW_RESET=true                    # already set by make test-up
```

---

## Demo Container Details

- Port 7779, data mounted read-only (`:ro`), write paths on tmpfs
- Frozen at the moment `make demo-snapshot` was run — never stale-syncs to prod
- Image pinned as `localhost/daily-brief-dashboard:demo-latest`
- Re-snapshot any time: `make demo-snapshot` (stops demo container, re-syncs, re-tags image)

**Read-only mount + tmpfs strategy:**
- `/data/config` and `/data/cache` from the snapshot are read-only (`:ro,Z`)
- `/data/cache` tmpfs overlay allows in-session brief generation without touching the snapshot
- On container restart, all session-generated data is discarded — demo always returns to snapshot state

---

## Mac Mini SSH Access

| Context | Command |
|---------|---------|
| Remote (off home LAN) | `ssh ssh.jasonhorn.io` — Cloudflare Zero Trust tunnel |
| Home LAN | `ssh jasonhorn@mini.local` — direct |

**`~/.ssh/config` on laptop (already configured):**
```
Host ssh.jasonhorn.io
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  User jasonhorn
```
First remote connect opens a browser auth tab (24h session). SCP respects this config automatically.
Full setup guide: `docs/MAC-MINI-DEMO-SETUP.md` → SSH Access section.

---

## Demo Tunnel

### Cloudflare Tunnel (Mac Mini — primary, persistent)

Named Cloudflare tunnel keeps the demo URL alive indefinitely — no session drops, no relay timeouts.

- **URL:** `https://demo.jasonhorn.io` → `localhost:7779`
- **Service:** system LaunchDaemon — starts automatically on boot, no manual management
- **Config:** `~/.cloudflared/config.yml` on Mac Mini
- **Logs:** `/Library/Logs/com.cloudflare.cloudflared.err.log`

```bash
# SSH to Mac Mini: use ssh.jasonhorn.io (remote) or jasonhorn@mini.local (home LAN)

# Check tunnel status
ssh ssh.jasonhorn.io "sudo launchctl list com.cloudflare.cloudflared"

# View tunnel log
ssh ssh.jasonhorn.io "tail -50 /Library/Logs/com.cloudflare.cloudflared.err.log"

# Restart tunnel
ssh ssh.jasonhorn.io "sudo launchctl stop com.cloudflare.cloudflared && sudo launchctl start com.cloudflare.cloudflared"

# Verify public URL
curl -s -o /dev/null -w "%{http_code}" https://demo.jasonhorn.io/api/aes
# Expect: 200
```

Full setup guide: `docs/MAC-MINI-DEMO-SETUP.md` → Cloudflare Tunnel Setup section.

### Instatunnel (Mac Mini — deprecated 2026-04-13)

> ⚠️ Replaced by Cloudflare Tunnel. Root cause: relay drops WebSocket sessions every 60-90s of activity, causing "Tunnel not connected" errors on page navigation. `--transport v2` not supported on `connect` subcommand — no fix possible.
>
> Legacy URL: `https://asa-dashboard.instatunnel.my` → `localhost:7779`

To unload if LaunchAgents are still loaded:
```bash
ssh ssh.jasonhorn.io "
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-keepalive.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist
"
```

**Red Hat IT note:** Both instatunnel and Cloudflare Tunnel require only outbound connections — no inbound firewall ports. Compatible with Red Hat IT policy.

---

## CI Integration

### Current
- `make pre-promote` runs locally before every `make rebuild` (lint + real-data CI + destructive gate)
- GitHub Actions runs unit tests, type check, and Playwright `--project=ci` on every PR and push to main
- Container image built and pushed to GHCR on every merge to main (`ci.yml` → `publish` job)

### Mac Mini CI Roadmap
Full setup guide: `docs/MAC-MINI-DEMO-SETUP.md`

| Capability | Backlog | Status |
|---|---|---|
| Self-hosted GH runner (e2e + smoke jobs) | BKL-OPS-03 prereq | 🔴 OPEN |
| Always-on test container (7776) | BKL-OPS-04 | 🔴 OPEN |
| Nightly full test suite | BKL-OPS-05 | 🔴 OPEN |
| Post-deploy smoke from second machine | BKL-OPS-06 | 🔴 OPEN |
| Visual regression baseline (Quinn auto-run) | BKL-OPS-07 | 🔴 OPEN |
| Multi-arch builds (arm64 + amd64) | BKL-OPS-08 | 🔴 OPEN |

---

## Environment Status

```bash
make env-status
```

Shows all running `pai-dashboard-*` containers with port, status, and uptime.

---

## Agent Rules

- **Agents run destructive tests on 7776 only** — use `--project=test` (targets 7776 regardless of BASE_URL).
- **Agents run regression checks on 7777** — use `--project=ci` after `make rebuild` (targets 7777 by default, never pass BASE_URL=7776).
- **Quinn audits UI on 7776** after code changes, then **again on 7777** after `make rebuild` to confirm parity.
- **Rook scans changed files** before `make rebuild` — never after.
- **No agent runs `make rebuild`** — primary DA only.

Full project routing reference: `docs/TESTING-RUNBOOK.md`

---

*Last updated: 2026-04-13 — migrated demo tunnel from instatunnel to Cloudflare (demo.jasonhorn.io)*
