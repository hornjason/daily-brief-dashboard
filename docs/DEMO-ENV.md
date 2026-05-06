---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Environment Strategy
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

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
2. **Deploy to test container first:** `make test-up` (spins up 7776 with seed data)
3. **Run CI suite against test:** `BASE_URL=http://localhost:7776 npx playwright test test/api/`
4. **Quinn visual audit on 7776** (if UI changes)
5. **All pass → `make rebuild`** (promotes to prod 7777)

**Never run `make rebuild` as a first step.** Test first, promote second. Violations waste Jason's time when bugs land in production.

For a full pre-promote gate (lint + real data + destructive): `make pre-promote && make rebuild`

---

## Quick Reference

```bash
# Start test container (port 7776, synthetic data, destructive-safe)
make test-up

# Stop test container
make test-down

# View test container logs
make test-logs

# Seed test data without starting container
make seed

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

## Demo Tunnel (Cloudflare)

`make demo-tunnel` runs `cloudflared tunnel --url http://localhost:7779` which outputs a temporary `*.trycloudflare.com` URL. Share that URL with stakeholders. The tunnel dies when you run `make demo-tunnel-stop` or close the session.

For a permanent/stable subdomain: set up a named Cloudflare tunnel with `cloudflared tunnel create daily-brief` and configure DNS. See [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

**Red Hat IT note:** Cloudflare Tunnel does not require inbound firewall ports — traffic flows outbound only. Should be compatible with Red Hat IT policy. Tailscale (`tailscale serve`) is an alternative for Red Hat-internal sharing without public internet exposure.

---

## CI Integration

### Current (manual)
- `make pre-promote` runs locally before every `make rebuild`
- GitHub Actions runs Playwright `test/api/` on every PR (configured in `.github/workflows/ci.yml`)

### Planned (BKL-OPS-02)
- Self-hosted GH runner: not yet implemented (research pending — Mac mini as runner feasible but requires GH runner agent setup)
- Automatic `make rebuild` on merge to main: blocked on self-hosted runner

---

## Environment Status

```bash
make env-status
```

Shows all running `pai-dashboard-*` containers with port, status, and uptime.

---

## Agent Rules

- **Agents test on 7776** — never 7777. Use `BASE_URL=http://localhost:7776` in playwright commands.
- **Quinn audits UI on 7776** (test container) after code changes, then **again on 7777** after `make rebuild` to confirm parity.
- **Rook scans changed files** before `make rebuild` — never after.
- **No agent runs `make rebuild`** — primary DA only.

---

*Last updated: 2026-04-11 — BKL-OPS-02*
