---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-13
---

# Mac Mini Demo Environment — Setup Guide
*Status: Operational | Last validated: 2026-04-22 | Trigger: Mac Mini OS changes, CI runner config changes, tunnel URL changes*

> **See also:** [NEW-MACHINE-SETUP.md](NEW-MACHINE-SETUP.md) for the complete portable setup runbook (prerequisites, config backup/restore, environment validation).

## SSH Access — Local vs Remote

Two ways to reach the Mac Mini depending on where you are:

| Situation | Command | Notes |
|-----------|---------|-------|
| On home LAN | `ssh jasonhorn@mini.local` | Direct — no proxy needed |
| Remote (off home LAN) | `ssh ssh.jasonhorn.io` | Cloudflare Zero Trust SSH tunnel |

**Remote access — `~/.ssh/config` (already configured on laptop):**
```
Host ssh.jasonhorn.io
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  User jasonhorn
```

First remote connect opens a browser tab for Cloudflare authentication — approve once. Subsequent connects within 24h are seamless. SCP also respects this config automatically:
```bash
scp file.txt jasonhorn@ssh.jasonhorn.io:~/       # remote
scp file.txt jasonhorn@mini.local:~/              # local LAN
```

**When writing scripts or docs:** if the script runs from an unknown network context (e.g. PAI agents, CI), use `ssh.jasonhorn.io` as the safe default — it works both on and off the home LAN (cloudflared routes through even on LAN).

---

This doc covers how to set up a Mac Mini as a dedicated demo machine and CI runner for
DailyBriefDashboard, with remote control from your main development machine and PAI memory sync.

---

## Reliability: Container Auto-Start + Remote Access

### Why Nightly Jobs Fail After Reboots
When the Mac Mini reboots, the GitHub Actions runner restarts automatically (LaunchAgent),
but the `pai-dashboard` container (port 7777) does NOT auto-start. Both nightly workflows
immediately fail: Connection Health gets "connection refused", L3 pre-flight fails.

### Fix: Container Auto-Start LaunchAgent

The repo ships a LaunchAgent plist that starts `pai-dashboard` on every login.

**Install once on the Mac Mini (run after `git pull`):**
```bash
# Pull the new scripts first
cd ~/DailyBriefDashboard && git pull origin main

# Install the LaunchAgent
cp scripts/com.asacommandcenter.container-autostart.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.asacommandcenter.container-autostart.plist

# Verify it ran
cat /tmp/container-autostart.log
```

After install, `pai-dashboard` starts automatically on every reboot via auto-login → LaunchAgent.

**Check status anytime:**
```bash
launchctl list | grep container-autostart    # should show a PID
cat /tmp/container-autostart.log             # startup log
podman ps | grep pai-dashboard               # confirm container running
```

---

### L3 Sync Daemon (`pai-sync-l3`) — Manual Start Required

The L3 sync daemon is a **separate container** from `pai-dashboard`. It has no LaunchAgent — it must be started manually after each reboot or reinstall.

```bash
# Check if running
podman ps -a --filter name=pai-sync-l3
# Nothing → not started; Exited → crashed

# Start it (requires data-sync/config/settings.json to exist)
make sync-up

# Verify it initialized correctly
make sync-logs    # watch for: "[sync-daemon] started — keepalive every 2h, sync at 5:30am ET"
```

**What it does:** Holds a warm Chromium browser context for RH SSO + Tableau + SF. Runs a daily sync at 5:30am ET that writes CCSP CSVs and SF Pipeline CSVs to Drive (shared `podBookingsFolderId`). Hero installs on other machines read from these files.

**Prerequisite:** `data-sync/config/settings.json` must exist and have `podBookingsFolderId` configured. The Makefile exits with an error if this file is missing.

**Full runbook:** `ARCHITECTURE.md §3a` — container contents, all failure modes, troubleshooting, re-auth procedure.
**SSO re-auth:** `docs/SYNC-DAEMON-SSO-PLAYBOOK.md`

---

### Remote Access When Traveling: Tailscale (Recommended)

The Cloudflare SSH tunnel (`ssh.jasonhorn.io`) requires a browser auth click every 24 hours.
On corporate networks or VPNs, this browser redirect may be blocked.

**Tailscale gives always-on SSH from any network with no browser interaction:**

**Install on Mac Mini (one-time, when you have SSH access):**
```bash
# Install the CLI formula (not the GUI cask)
brew install tailscale

# Start as a system daemon (LaunchDaemon — survives reboots, runs before login)
sudo brew services start tailscale

# Authenticate with a reusable tagged key (generate at tailscale.com/admin/settings/keys)
# Key settings: Reusable=yes, Ephemeral=no, Tag=tag:servers (disables key expiry on node)
sudo tailscale up --auth-key=tskey-auth-XXXXXXXXXXXX --advertise-tags=tag:servers

# Verify
sudo tailscale status
launchctl list | grep tailscale
```

**Install Tailscale on your laptop/phone:** Download from tailscale.com — log in with same account.

**SSH via Tailscale (no browser popup, works from any network):**
```bash
ssh jasonhorn@mac-mini          # MagicDNS hostname (if enabled)
ssh jasonhorn@100.x.x.x         # Tailscale IP from: tailscale status
```

Add to `~/.ssh/config` on laptop for convenience:
```
Host mac-mini-ts
  HostName 100.x.x.x            # replace with actual Tailscale IP
  User jasonhorn
```

**Both tunnels available:**
| Method | Works when | Auth required |
|--------|-----------|---------------|
| `ssh ssh.jasonhorn.io` | Cloudflare not blocked | Browser click every 24h |
| `ssh jasonhorn@mac-mini` (Tailscale) | Always | None after initial setup |

---

## Architecture

```
Main Dev Machine (MacBook)          Mac Mini
─────────────────────────           ────────────────────────────────────
PAI ~/.claude  ──git push──►  ──git pull──►  PAI ~/.claude
DailyBriefDashboard/ ──make demo-export──►  ~/DailyBriefDashboard/
   data/config                                 data/ (read-only demo data)
   data/cache                                  podman pai-dashboard-demo:7779
                                               ~/DailyBriefDashboard/ (CI + demo)
                                               GitHub Actions runner (optional)
SSH control  ──────────ssh ssh.jasonhorn.io (Cloudflare tunnel)──────────►
GitHub  ─────────────────── Actions jobs (self-hosted) ────►
```

The Mac Mini serves two roles:
- **Demo:** frozen container on port 7779, safe for stakeholder access (rw volume, pre-populated cache)
- **CI:** runs the Playwright + unit test suite, optionally as a self-hosted GH Actions runner

---

## GitHub Actions Runner Setup

This section covers the **nightly L3 E2E workflow** (`nightly.yml`) which runs the full onboarding
suite (`make onboarding-check`) against the Mac Mini's live OAuth sessions every night at 02:00 PT.
This is distinct from the cloud-runner CI (`ci.yml`) which runs on PRs with seed data only.

### Why a Self-Hosted Runner for L3

The L3 onboarding suite requires real OAuth sessions: Google Drive, RH Portal, Salesforce, and
Tableau. These sessions live in the Mac Mini's browser profile and macOS Keychain. They cannot be
put in GitHub Secrets or replicated in a cloud runner — the only way to run the full suite is on
a machine that already holds live credentials.

### One-Time: Register the Runner

Run the following on the Mac Mini (SSH in first: `ssh jasonhorn@mini.local` on LAN, or `ssh ssh.jasonhorn.io` remotely).

```bash
# 1. Download the runner
#    Check https://github.com/settings/actions/runners for the current release URL.
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-osx-arm64.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.323.0/actions-runner-osx-arm64-2.323.0.tar.gz
tar xzf ./actions-runner-osx-arm64.tar.gz

# 2. Get the registration token from GitHub:
#    github.com/hornjason/asaCommandCenter → Settings → Actions → Runners → New self-hosted runner
#    Copy the token shown on that page (valid for ~1 hour).

# 3. Configure the runner with the required label
./config.sh \
  --url https://github.com/hornjason/asaCommandCenter \
  --token RUNNER_TOKEN_FROM_GITHUB \
  --labels mac-mini-live \
  --name mac-mini \
  --unattended

# 4. Install as a macOS LaunchDaemon (starts automatically on reboot, runs as root)
sudo ./svc.sh install
sudo ./svc.sh start

# 5. Verify the runner is online
./svc.sh status
# Expect: "active (running)" or similar
```

The runner will appear in GitHub → Settings → Actions → Runners as "mac-mini" with label
`mac-mini-live`. The `nightly.yml` workflow targets this label.

**PATH note:** The runner service may not inherit your shell's PATH. If `bun` or `make` are not
found during jobs, add them to the runner's environment file:

```bash
# ~/actions-runner/.env  (create if it doesn't exist)
PATH=/opt/homebrew/bin:/Users/jasonhorn/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

### Initial Session Population (one-time, after first runner setup)

Before the nightly suite can run, the Mac Mini's test data directory needs live OAuth tokens.
Run these once from your main machine after runner registration:

```bash
# SSH_MINI: use jasonhorn@mini.local on LAN, or ssh.jasonhorn.io remotely
SSH_MINI="ssh.jasonhorn.io"   # or jasonhorn@mini.local on home LAN

# 1. Google token — refresh token is machine-agnostic; copy from laptop prod to Mac Mini test
scp ~/.claude/PAI/Projects/DailyBriefDashboard/data/config/.google-token.json \
    jasonhorn@${SSH_MINI}:~/DailyBriefDashboard/data-test/config/.google-token.json

# 2. RH Portal session — browser session cookies; copy from laptop rh-profile
scp ~/.claude/PAI/Projects/DailyBriefDashboard/data/rh-profile/content-rh-session.json \
    jasonhorn@${SSH_MINI}:~/DailyBriefDashboard/data-test/rh-profile/content-rh-session.json

# 3. Restart the test container to pick up the new tokens
ssh ${SSH_MINI} "cd ~/DailyBriefDashboard && make test-up-live"

# 4. Verify both sessions are valid
ssh ${SSH_MINI} "curl -s http://localhost:7776/api/setup/check-auth | python3 -c \
  'import sys,json; d=json.load(sys.stdin); print(\"Google valid:\", d[\"valid\"])'"
ssh ${SSH_MINI} "curl -s http://localhost:7776/health"
# Expect: Google valid: True | {"status":"ok","session":true,...}
```

**Token lifetimes:**
- `.google-token.json` — Google refresh token is long-lived (months/years). Only needs re-copying if you revoke access in GCP or rotate the OAuth client.
- `content-rh-session.json` — RH Portal browser session, expires ~8 hours. Needs re-copying (or in-browser refresh on Mac Mini) after each expiry. See Session Refresh Runbook below.

**Note:** Salesforce and Tableau sessions are stored inside the Chromium profile at `data-test/rh-profile/Default/`. To populate them, log in via the Setup page on `http://localhost:7776` while Screen Sharing into the Mac Mini. This is a one-time step per session cycle.

### Session Refresh Runbook

OAuth sessions expire. When `nightly.yml` posts a "Mac Mini not ready" summary, use this runbook.

```bash
# 1. Check current session state
curl -s http://localhost:7776/api/status/scrapes | jq '.sessions'

# 2. Refresh each expired session via the dashboard UI at http://localhost:7776
#    → Setup → RH Portal → Connect        (expires ~8h after last use)
#    → Setup → Salesforce → Connect       (expires ~24h)
#    → Setup → Tableau → Connect          (varies by org policy)
#    → Setup → Google Auth → Authenticate (refresh token is long-lived; rarely expires)

# 3. After refreshing, restart the test container to pick up new session state
cd ~/DailyBriefDashboard && make test-up-live

# 4. Verify the container is healthy before re-triggering the workflow
curl -s http://localhost:7776/health
# Expect: {"status":"ok"}

# 5. Re-trigger the nightly workflow manually from GitHub Actions if needed
```

### What Runs Automatically

| What | When | Container | Notes |
|------|------|-----------|-------|
| `nightly.yml` health pre-flight | 02:00 PT nightly | 7776 (test) | Skips L3 gracefully if sessions expired |
| `nightly.yml` L3 onboarding suite | 02:00 PT nightly (if healthy) | 7776 (test) | Full 33-min 6-phase suite |
| Voice alert | On L3 failure | — | `http://localhost:8888/notify` on Mac Mini |

**The production container (7779) is never touched by CI.** All L3 tests run against the test
container on port 7776.

### Required Runner Label

The `nightly.yml` workflow uses `runs-on: [self-hosted, mac-mini-live]`. The runner MUST have
the label `mac-mini-live` — this is set during `./config.sh` above. Without it, the workflow
will queue indefinitely with no runner to pick it up.

### Runner Service Verification

The runner is installed as a LaunchAgent via `svc.sh install`. To verify it auto-starts:
```bash
ssh ssh.jasonhorn.io   # or via Tailscale
ls ~/Library/LaunchAgents/actions.runner.*.plist   # should exist
launchctl list | grep actions.runner               # should show a PID
./actions-runner/svc.sh status                     # shows service state
```

If the runner is NOT configured as a service (no plist found):
```bash
cd ~/actions-runner
./svc.sh install
./svc.sh start
```

### Session Expiry Recovery (Remote)


> **Proactive warning:** The nightly Connection Health workflow now shows the RH Portal
> session expiry time and hours remaining. Check the workflow summary at
> https://github.com/hornjason/asaCommandCenter/actions/workflows/nightly-health.yml
> before the session expires to re-auth proactively.

RH Portal sessions expire after ~8 hours and Tableau sessions expire based on org policy.
Neither service supports PATs or API tokens — re-auth requires completing an OAuth browser
flow on the Mac Mini itself. The VNC tunnel makes this possible from any browser, no SSH needed.

If the container itself is down, restart it first via GitHub Actions (Option A below) — no
SSH required. VNC only works when the container is running.

#### Option A: Restart via GitHub Actions (No SSH Required)

Use this first whenever the dashboard is unreachable or a nightly workflow reports the
container is down. It is the fastest recovery path and works from any network.

1. Go to: https://github.com/hornjason/asaCommandCenter/actions/workflows/restart-container.yml
2. Click **Run workflow** → **Run workflow**
3. Wait ~30 seconds for the container to come up
4. Check: https://demo.jasonhorn.io — if the dashboard loads, container is up

If sessions are expired after restart, continue with the VNC re-auth flow below.

#### Option B: Remote re-auth via VNC over Tailscale (recommended for session expiry)

VNC is **Tailscale-only** — there is no public exposure. You must be connected to the
Tailscale network to reach it. The old `vnc.jasonhorn.io` Cloudflare hostname has been
deleted.

1. Make sure Tailscale is connected on your client machine
2. Open **`http://mac.tail2fe7c7.ts.net:6080/vnc.html`** in your browser
   *(When you click Reconnect in the dashboard at mac.tail2fe7c7.ts.net:7777,
   the VNC link auto-resolves to the correct Tailscale hostname -- no manual URL copy needed)*

> **Why this URL is stable:** Tailscale MagicDNS assigns a permanent hostname (`mac.tail2fe7c7.ts.net`) to the Mac Mini. This hostname resolves to the current Tailscale IP automatically — even if the IP changes, the hostname stays the same. Run `make vnc-url` on the Mac Mini to confirm the current URL anytime.

3. You are now looking at the Chromium browser running inside the Mac Mini's container
4. In that browser, navigate to **`http://localhost:7777/dashboard/setup`**
5. Click **Reconnect** for the expired service (RH Portal, Tableau, or Salesforce)
6. Complete the OAuth/SSO flow — callbacks land on `localhost` on the Mac Mini ✓
7. Re-trigger the Nightly Connection Health workflow to confirm recovery

> **Security note:** The VNC session has no password — Tailscale network membership is
> the only auth layer. Do not expose port 6080 publicly or add it back to a Cloudflare tunnel.

#### If the container is down (VNC will be a blank/dead screen)

The VNC viewer only shows something if the container is running. If it's blank or won't connect,
restart the container first — use Option A above (GitHub Actions) as the primary path.

**Primary — GitHub Actions (no SSH needed):**

Run the [Restart Production Container](https://github.com/hornjason/asaCommandCenter/actions/workflows/restart-container.yml)
workflow (Option A above), wait ~30 seconds, then re-open `http://mac.tail2fe7c7.ts.net:6080/vnc.html`
(requires Tailscale connected).

**Fallback — SSH (only if the GitHub Actions runner is unavailable):**

```bash
ssh ssh.jasonhorn.io        # Cloudflare SSH (needs browser auth every 24h)
# or
ssh jasonhorn@mac-mini      # Tailscale (no browser auth — preferred when traveling)

cd ~/DailyBriefDashboard && make up
```

Then re-open `http://mac.tail2fe7c7.ts.net:6080/vnc.html` (requires Tailscale connected) — it should show the desktop.

#### VNC access (Tailscale-only)

VNC access is gated by Tailscale network membership. There is no Cloudflare tunnel for VNC
any longer — the `vnc.jasonhorn.io` hostname and its Access policy have been deleted.

- **Reach the VNC UI:** `http://mac.tail2fe7c7.ts.net:6080/vnc.html` from any device connected to your Tailnet
- **Confirm the URL anytime:** run `make vnc-url` on the Mac Mini (falls back to raw Tailscale IP if MagicDNS is unavailable)
- **Port:** `6080` is bound to the Mac Mini's Tailscale interface only — it must not be exposed to the public internet

---

## What Requires You vs What PAI Handles

Once SSH key auth is set up from your main machine to the Mac Mini, PAI can handle the majority of the setup remotely via SSH. Here's the exact split:

### What You Do (4 things)

**1. SSH key auth — one time**
```bash
# On home LAN:
ssh-copy-id jasonhorn@mini.local

# Or remotely via Cloudflare tunnel:
ssh-copy-id jasonhorn@ssh.jasonhorn.io
```
This is the handoff point. Everything after this PAI can run remotely.

**2. Homebrew install — one command, needs your sudo password**
The Homebrew installer prompts for your Mac Mini password interactively. PAI can't type that.
```bash
ssh jasonhorn@mini.local
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Alternative: add your user to passwordless sudo first (`sudo visudo`) and PAI handles this too.

**3. API keys — values only you know**
`ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are gitignored and never in the repo. Give PAI the values once and it writes the `.env` files, or paste them yourself.

**4. GitHub runner token + SSH key — two browser clicks**
- **Runner token:** GitHub.com → repo Settings → Actions → Runners → New runner → copy the token. Give it to PAI, PAI runs the registration.
- **GitHub SSH key:** PAI generates the keypair on Mac Mini and shows you the public key. You paste it into GitHub.com → Settings → SSH keys. The paste is the only part you do.

### What PAI Handles (everything else)

Once the 4 items above are done:
- All Homebrew package installs (Podman, Bun, Node, Claude Code)
- Project source clone + dependencies + Playwright browsers
- Demo export, transfer, container load, `make demo-up`
- Always-on test container setup
- Nightly cron schedule
- Self-hosted GitHub Actions runner install + service registration
- All verification and health checks at each phase
- Reporting back with pass/fail at each step

**Shortest path to fully operational:** run `ssh-copy-id`, run the Homebrew line, give PAI the hostname + API keys. PAI handles the other ~20 steps.

---

## Prerequisites Check — Do These First

### 1. Architecture — Critical First Step

Run on both machines before anything else:
```bash
uname -m
```
- `arm64` = Apple Silicon (M1/M2/M3/M4)
- `x86_64` = Intel

**If both machines match:** proceed normally.

**If they don't match (e.g. MacBook is Intel, Mac Mini is Apple Silicon):**
The container image won't run. You'll need to build a multi-arch image first — see the
"Architecture Mismatch" section at the bottom.

---

## Phase 1 — Mac Mini Prerequisites

### Enable SSH
```
System Settings → General → Sharing → Remote Login → ON
```
Note the Mac Mini's local address shown there (e.g. `Mac-Minis-name.local` or `192.168.x.x`).

### Set Up Key-Based SSH Auth (from main machine)
```bash
# On home LAN:
ssh-copy-id jasonhorn@mini.local
ssh jasonhorn@mini.local echo "connected"

# Or remotely via Cloudflare tunnel:
ssh-copy-id jasonhorn@ssh.jasonhorn.io
ssh ssh.jasonhorn.io echo "connected"
```

### Install Homebrew on Mac Mini
```bash
ssh jasonhorn@mini.local
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
Apple Silicon Mac Minis: add Homebrew to PATH after install:
```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
source ~/.zprofile
```

### Install Podman
```bash
brew install podman
podman machine init
podman machine start
# Verify
podman info | grep -A2 "host:"
```

### Install Claude Code (for PAI to work on Mac Mini)
Download and install from [claude.ai/download](https://claude.ai/download) (macOS app).
Claude Code creates `~/.claude` on first launch — this must exist before Phase 2.

---

## Phase 2 — PAI Directory Sync (~/.claude)

The `~/.claude` directory is a git repo with nightly backup commits. Sensitive files
(`.env`, `.google-token.json`, OAuth tokens) are excluded by `.gitignore` — safe to push.

### First-Time: Check for Existing Remote
```bash
git -C ~/.claude remote -v
```

**If a remote exists (e.g. GitHub):** skip to "Clone on Mac Mini" below.

**If no remote yet — create one:**
1. Create a **private** GitHub repo (e.g. `pai-config`)
2. On main machine:
```bash
git -C ~/.claude remote add origin git@github.com:hornjason/pai-config.git
git -C ~/.claude push -u origin main
```

### Sync PAI to Mac Mini

Claude Code creates `~/.claude` on first install — it already exists on the Mac Mini as a plain directory, not a git repo. Do NOT `git clone` into it (that requires an empty directory). Instead, initialize git inside the existing directory:

```bash
ssh ssh.jasonhorn.io       # or: ssh jasonhorn@mini.local (home LAN)
cd ~/.claude
git init
git remote add origin git@github.com:hornjason/pai-config.git
git fetch origin
git reset --hard origin/main
```

This pulls everything from GitHub into the existing `~/.claude` without wiping Claude Code's local session state.

**GitHub SSH key required on Mac Mini.** Generate one and add it to GitHub:
```bash
ssh ssh.jasonhorn.io       # or: ssh jasonhorn@mini.local (home LAN)
ssh-keygen -t ed25519 -C "jasonhorn@mini.local" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```
Copy the output and add it at: GitHub.com → Settings → SSH and GPG keys → New SSH key.
Then verify: `ssh -T git@github.com` should say "Hi hornjason!"

### Set API Keys on Mac Mini

The `.env` is gitignored — you must create it manually on Mac Mini:
```bash
ssh ssh.jasonhorn.io       # or: ssh jasonhorn@mini.local (home LAN)
cat > ~/.claude/.env << 'EOF'
ANTHROPIC_API_KEY=your_key_here
EOF
```

Gemini key lives in the project `.env` — handled in Phase 3 below.

### Ongoing PAI Sync

After nightly backup commits on main machine push to GitHub, sync to Mac Mini:
```bash
ssh ssh.jasonhorn.io "git -C ~/.claude pull"
# On home LAN: ssh jasonhorn@mini.local "git -C ~/.claude pull"
```

For scripted automation, see BKL-OPS-03.

---

## Phase 3 — Demo Pipeline Setup

### Step 1: Export from Main Machine
```bash
cd ~/.claude/PAI/Projects/DailyBriefDashboard

# Freeze current prod state
make demo-snapshot

# Package safe data only (strips OAuth tokens, RH profile, Google creds)
make demo-export
# Creates: demo-export.tar.gz + demo-image.tar in project root
```

`demo-export.tar.gz` contains:
- `data/config/aes.json` — encryption key
- `data/config/customers.json` — customer list
- `data/config/settings.json` — AE/territory config
- `data/config/product-intel-config.json`
- `data/config/product-alerts.json`
- `data/cache/` — full cache: CCSP, pipeline, cases, sheets, intelligence, product-intel, scraper-status

Does NOT contain: `.google-token.json`, `.rh-session.json`, `data/rh-profile/`

### Step 2: Transfer to Mac Mini
```bash
# Remote (Cloudflare tunnel):
scp demo-export.tar.gz demo-image.tar jasonhorn@ssh.jasonhorn.io:~/
scp ~/.claude/PAI/Projects/DailyBriefDashboard/Makefile jasonhorn@ssh.jasonhorn.io:~/DailyBriefDashboard/
# On home LAN:
# scp demo-export.tar.gz demo-image.tar jasonhorn@mini.local:~/
# scp ~/.claude/PAI/Projects/DailyBriefDashboard/Makefile jasonhorn@mini.local:~/DailyBriefDashboard/
```

### Step 3: Set Up on Mac Mini
```bash
ssh ssh.jasonhorn.io
# On LAN: ssh jasonhorn@mini.local

# Load container image into podman
podman load -i demo-image.tar

# Create project structure
mkdir -p ~/DailyBriefDashboard/data

# Extract demo data (tarball contains ./data/ prefix — extract to project root, not data/)
cd ~/DailyBriefDashboard && tar xzf ~/demo-export.tar.gz

# Create minimal .env (Gemini key needed for brief generation display)
cat > ~/DailyBriefDashboard/.env << 'EOF'
GEMINI_API_KEY=your_gemini_key_here
EOF
```

### Step 4: Start the Demo Container
```bash
cd ~/DailyBriefDashboard
make demo-up
```

### Step 5: Verify
```bash
curl -s http://localhost:7779/api/aes
# Should return AE list JSON

curl -s http://localhost:7779/health
# Should return {"status":"ok"}
```

Open browser: `https://demo.jasonhorn.io` (remote) or `http://mini.local:7779` (home LAN only)

---

## Remote Control — Day-to-Day Commands

> Use `jasonhorn@mini.local` on home LAN, `ssh.jasonhorn.io` remotely.

### Check demo status
```bash
ssh ssh.jasonhorn.io "curl -s http://localhost:7779/health"
# On LAN: ssh jasonhorn@mini.local "curl -s http://localhost:7779/health"
```

### Restart demo container
```bash
ssh ssh.jasonhorn.io "cd ~/DailyBriefDashboard && make demo-down && make demo-up"
```

### Refresh demo with latest prod data (full cycle)
```bash
# On main machine:
cd ~/.claude/PAI/Projects/DailyBriefDashboard
make demo-export
scp demo-export.tar.gz demo-image.tar jasonhorn@ssh.jasonhorn.io:~/
# On LAN: scp demo-export.tar.gz demo-image.tar jasonhorn@mini.local:~/
ssh ssh.jasonhorn.io "
  cd ~/DailyBriefDashboard && \
  make demo-down && \
  podman load -i ~/demo-image.tar && \
  rm -rf data && \
  tar xzf ~/demo-export.tar.gz && \
  make demo-up
"
```

### Sync PAI memory to Mac Mini
```bash
git -C ~/.claude push && ssh ssh.jasonhorn.io "git -C ~/.claude pull"
```
### Re-authenticate to GHCR (when make rebuild push fails)

The GHCR push token lives in `.env` as `GITHUB_TOKEN`. Requires a GitHub PAT with
`write:packages` scope. If `make rebuild` fails at the push step with
permission_denied or token scope error, create a new PAT and re-auth:

1. Create PAT at https://github.com/settings/tokens -- Classic, enable write:packages
2. On the Mac Mini, update GITHUB_TOKEN in `.env`, then:
```bash
cd ~/DailyBriefDashboard
make login-ghcr   # re-authenticates podman to ghcr.io using GITHUB_TOKEN from .env
make rebuild      # push will now succeed
```

---


### Start tunnel for stakeholder access

**Cloudflare Tunnel (primary — persistent, no session drops):**

- **URL:** `https://demo.jasonhorn.io` → `localhost:7779` ✅ LIVE (confirmed 2026-04-13)
- Indefinitely persistent as long as `cloudflared` is running — no session timeouts, no relay drops
- Managed by a system LaunchDaemon installed via `sudo cloudflared service install`
- Full setup guide: see [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup) section below

```bash
# Check tunnel status
ssh ssh.jasonhorn.io "sudo launchctl list com.cloudflare.cloudflared"
# On home LAN: ssh jasonhorn@mini.local "sudo launchctl list com.cloudflare.cloudflared"

# View tunnel log
ssh ssh.jasonhorn.io "tail -50 /Library/Logs/com.cloudflare.cloudflared.err.log"

# Restart tunnel
ssh ssh.jasonhorn.io "sudo launchctl stop com.cloudflare.cloudflared && sudo launchctl start com.cloudflare.cloudflared"

# Verify public URL
curl -s -o /dev/null -w "%{http_code}" https://demo.jasonhorn.io/api/aes
# Expect: 200
```

---

**Instatunnel (legacy — deprecated 2026-04-13):**

> ⚠️ Replaced by Cloudflare Tunnel. Instatunnel had a session-drop bug: the relay server disconnected every 60-90 seconds of activity, causing "Tunnel not connected" errors on page navigation. Kept here for rollback reference only.

Three LaunchAgents on the Mac Mini managed the instatunnel:

| LaunchAgent | Purpose |
|---|---|
| `com.pai.instatunnel-asa-dashboard` | Main tunnel process |
| `com.pai.instatunnel-keepalive` | PID check every 30s |
| `com.pai.instatunnel-watchdog` | HTTP health check every 5 min |

- **Legacy URL:** `https://asa-dashboard.instatunnel.my` → `localhost:7779`

To unload (after Cloudflare Tunnel is confirmed working):
```bash
ssh ssh.jasonhorn.io "
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-keepalive.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist
"
```

Recovery runbook (if needed while still active): see Tunnel Recovery Runbook at the bottom of this doc.

---

## Synthetic Monitor (BKL-TEST-P0-05)

Read-only production health check running every 15 minutes on the Mac Mini. Checks health endpoint, customer count, brief quality (from cache), and intelligence status. Sends voice alert via PAI notification service on failure. Writes status to `/Users/jasonhorn/DailyBriefDashboard/data/synthetic-monitor-status.json`.

**Setup (run once on Mac Mini):**
```bash
# Copy the plist to LaunchAgents
cp ~/DailyBriefDashboard/scripts/com.pai.synthetic-monitor.plist ~/Library/LaunchAgents/

# Load it (starts immediately and every 15 min)
launchctl load ~/Library/LaunchAgents/com.pai.synthetic-monitor.plist

# Check it's running
launchctl list | grep synthetic-monitor
cat /tmp/synthetic-monitor.log
```

**Run manually:**
```bash
cd ~/DailyBriefDashboard && make monitor-once
# or from main machine:
ssh ssh.jasonhorn.io "cd ~/DailyBriefDashboard && make monitor-once"
# On home LAN: ssh jasonhorn@mini.local "cd ~/DailyBriefDashboard && make monitor-once"
```

**Check logs:**
```bash
cat /tmp/synthetic-monitor.log
cat /tmp/synthetic-monitor.err
cat ~/DailyBriefDashboard/data/synthetic-monitor-status.json
```

---

## Cloudflare Tunnel Setup

Replaces instatunnel. Free, indefinitely persistent named tunnel using your own domain (`jasonhorn.io`). No session drops, no data cap, no relay rate-limiting.

> **Current state (2026-04-21):** Tunnel is running in **token mode** — configured via Cloudflare dashboard, not a local config file. No `~/.cloudflared/config.yml` exists on the Mac Mini. Ingress rules are managed at dash.cloudflare.com → Zero Trust → Networks → Tunnels → asa-dashboard → **Published application routes**. Protocol fixed to `http2` on 2026-04-21. SSH tunnel confirmed working 2026-04-21.

### SSH Access (WORKING — 2026-04-21)

`ssh.jasonhorn.io` → Mac Mini port 22, protected by Cloudflare Access.

**Current ingress (Published application routes):**
| # | Hostname | Service |
|---|---|---|
| 1 | demo.jasonhorn.io | http://localhost:7779 |
| 2 | ssh.jasonhorn.io | ssh://localhost:22 |

**Adding a new hostname (token mode):**
1. Zero Trust → Networks → Tunnels → asa-dashboard → **Published application routes** → Add
2. Fill in subdomain, domain, service type, URL — do NOT set a Path
3. Do NOT manually create the DNS record — Cloudflare auto-creates it. If a record already exists, delete it first or you'll get a conflict error
4. Change takes effect within seconds — no tunnel restart needed

**Laptop SSH config** (`~/.ssh/config` — already configured):
```
Host ssh.jasonhorn.io
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
  User jasonhorn
```

**Cloudflare Access application:** `ssh` app at ssh.jasonhorn.io, policy "Allow Jason SSH" (jason.horn@gmail.com), 24h session.

**First connect:** opens browser tab for Cloudflare auth → approve → SSH proceeds. Subsequent connects within 24h are seamless.

**If DNS lookup fails after changes:** `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`

**Remote tunnel restart (when away from home):**
```bash
gh workflow run restart-tunnel.yml --repo hornjason/asaCommandCenter
```
Runner `mac-mini` is online and picks it up immediately.

---

### Phase 1 — Add jasonhorn.io to Cloudflare (~5-30 min, mostly DNS propagation)

1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site** → enter `jasonhorn.io` → select **Free plan**
2. Cloudflare scans your existing DNS records — review and confirm they look correct (especially MX/SPF/DKIM if you have email on this domain)
3. Cloudflare shows you two nameserver addresses (e.g. `ada.ns.cloudflare.com`, `clark.ns.cloudflare.com`) — copy both
4. Go to your domain registrar → replace the existing nameservers with Cloudflare's two
5. Back in Cloudflare, click **Done, check nameservers** — propagation takes 5 min to 24 hours

> ⚠️ If `jasonhorn.io` has active email: make sure Cloudflare picked up your MX, SPF, and DKIM records in step 2 before saving nameservers. Cloudflare usually auto-imports them — verify before switching.

### Phase 2 — Install and configure cloudflared on Mac Mini

All commands run on the Mac Mini (via SSH: `ssh ssh.jasonhorn.io` remotely, or `ssh jasonhorn@mini.local` on home LAN).

**Install cloudflared:**
```bash
brew install cloudflared
```

**Authenticate** (opens a browser on the Mac Mini — must be done directly on the Mini or use the token method below):
```bash
cloudflared tunnel login
# Opens https://dash.cloudflare.com/... — click Authorize in browser
# Downloads cert to ~/.cloudflared/cert.pem
```

> **Headless alternative** (if Mini has no display): In the Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel → copy the token. Then on the Mini:
> ```bash
> cloudflared service install <TOKEN>
> # This installs AND authenticates in one step — skip the remaining steps below
> ```

**Create a named tunnel:**
```bash
cloudflared tunnel create asa-dashboard
# Outputs a Tunnel ID like: c1744f8b-faa1-48a4-9e5c-02ac921467fa
# Credentials saved to: ~/.cloudflared/<TUNNEL-ID>.json
```

**Create the config file:**
```bash
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: asa-dashboard
credentials-file: /Users/jasonhorn/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: demo.jasonhorn.io
    service: http://localhost:7779
  - service: http_status:404
EOF
```
> Replace `<TUNNEL-ID>` with the ID printed by `cloudflared tunnel create`. Change `demo.jasonhorn.io` if you want a different subdomain.

**Wire up the DNS record** (auto-creates a CNAME in Cloudflare DNS):
```bash
cloudflared tunnel route dns asa-dashboard demo.jasonhorn.io
# Cloudflare creates: demo.jasonhorn.io CNAME → <TUNNEL-ID>.cfargotunnel.com
```

**Test manually before installing as a service:**
```bash
cloudflared tunnel --protocol http2 run asa-dashboard
# Visit https://demo.jasonhorn.io — should load the dashboard
# Ctrl+C when confirmed working
```

> ⚠️ **Always use `--protocol http2` — never `--protocol quic`.** QUIC uses UDP, which home routers NAT-expire after 30-120s of no traffic. This drops all 4 tunnel connections simultaneously, causing outages. HTTP/2 uses TCP which survives idle periods indefinitely.

**Disable Mac Mini sleep (required for always-on tunnel):**
```bash
sudo pmset -a sleep 0
# Verify:
pmset -g | grep ' sleep'
# Expect: sleep 0
```

**Install as a persistent system service** (survives reboots, starts automatically):
```bash
sudo cloudflared service install
# Installs to /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
# Starts immediately
```

**Verify:**
```bash
# Check service is running
sudo launchctl list com.cloudflare.cloudflared

# Check logs
tail -20 /Library/Logs/com.cloudflare.cloudflared.err.log

# Hit the public URL
curl -s -o /dev/null -w "%{http_code}" https://demo.jasonhorn.io/api/aes
# Expect: 200
```

### Phase 3 — Decommission instatunnel (after Cloudflare confirmed working)

```bash
ssh ssh.jasonhorn.io "
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-asa-dashboard.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-keepalive.plist
  launchctl unload ~/Library/LaunchAgents/com.pai.instatunnel-watchdog.plist
"
```

### Why Cloudflare Tunnel vs instatunnel

| | Cloudflare Tunnel | instatunnel (old) |
|---|---|---|
| Persistence | Indefinite — no session concept | Drops every 60-90s of activity |
| Custom domain | Yes — your own domain, free | Yes — `*.instatunnel.my` subdomain |
| Data cap | None | Varies by plan |
| Price | Free | Free tier |
| Root cause of old issue | N/A | Relay drops idle WebSocket sessions; `--transport v2` not supported on `connect` subcommand |

---

## Architecture Mismatch (Apple Silicon vs Intel)

If your Mac Mini is Apple Silicon (arm64) and your main dev machine is Intel (x86_64) —
or vice versa — the built image won't run on the Mac Mini.

**Option A: Build on the Mac Mini directly**
```bash
ssh ssh.jasonhorn.io    # or: ssh jasonhorn@mini.local (home LAN)
git clone git@github.com:hornjason/asaCommandCenter.git ~/DailyBriefDashboard
cd ~/DailyBriefDashboard
podman build -t localhost/daily-brief-dashboard:latest .
# Then continue with Phase 3, Step 3 (image is already loaded)
```

**Option B: Multi-arch build on main machine (advanced)**
Requires buildx or podman manifest — more complex, deferred until needed.

---

## Phase 4 — CI Testing on Mac Mini

### Why Use the Mac Mini for CI

**Architecture match.** GitHub-hosted runners are `ubuntu-latest` (x86_64 Linux). Your production container runs on macOS — potentially Apple Silicon (arm64). Tests that pass on GH runners can fail on the actual machine because the OS and CPU differ. The Mac Mini runs the same environment that actually matters.

**Real container in the test loop.** The GH Actions `e2e` job runs Playwright against a process started inline — no container, no podman, just seed data served directly. The Mac Mini can run tests against a real running container (`make test-up` → Playwright against port 7776), which is exactly what ships. That's a different and stronger signal.

**No cold start, no minute budget.** Every GH-hosted job spins up a fresh VM: installs Bun, installs Playwright browsers (~2-3 min overhead before a single test runs). The Mac Mini already has everything installed — jobs start immediately. Self-hosted runners don't consume GitHub Actions minutes regardless of how often CI runs.

**Pre-deploy gate you can trust.** Right now `make pre-promote` runs manually on your main machine before a rebuild. With the Mac Mini as a runner, the full gate — unit tests, type check, E2E against a real container — runs automatically on every push to main. You get confirmation from a second machine, not just your dev environment.

**The gap it closes most meaningfully:** the current CI proves the code compiles and seed data tests pass. It doesn't prove the container starts correctly on your hardware with your architecture. The Mac Mini closes that gap.

---

Two modes: **manual** (run tests yourself via SSH) or **self-hosted runner** (Mac Mini runs GitHub Actions jobs automatically).

---

### Option A: Manual CI Runs

Good for pre-demo validation or running the full suite before a deploy without touching your main machine.

**Prerequisites (one-time setup on Mac Mini):**
```bash
ssh ssh.jasonhorn.io    # or: ssh jasonhorn@mini.local (home LAN)

# Clone the project (same path as main machine convention)
git clone git@github.com:hornjason/asaCommandCenter.git ~/DailyBriefDashboard
cd ~/DailyBriefDashboard

# Install git hooks
make install-hooks

# Copy .env from main machine (contains API keys — gitignored)
# Run this on your main machine:
# scp ~/.claude/PAI/Projects/DailyBriefDashboard/.env jasonhorn@mini.local:~/DailyBriefDashboard/.env

# Install Bun (not available via Homebrew — use official installer)
curl -fsSL https://bun.sh/install | bash
source ~/.zshrc  # or open a new shell

# Install dependencies
bun install

# Install Playwright Chromium
bunx playwright install --with-deps chromium
```

**Running the CI suite (same as GitHub Actions e2e job):**
```bash
ssh ssh.jasonhorn.io "cd ~/DailyBriefDashboard && git pull && \
  make seed && \
  CI=true TEST_KNOWN_CUSTOMER='Acme Corp' bunx playwright test --project=ci --workers=2 --reporter=list"
# On home LAN: ssh jasonhorn@mini.local "..."
```

**Running unit tests + type check (same as GitHub Actions test job):**
```bash
ssh ssh.jasonhorn.io "cd ~/DailyBriefDashboard && \
  bun test src/ test/unit/ && \
  cd dashboard && bunx tsc --noEmit"
```

**Running the full pre-promote gate (uses the test container):**
```bash
ssh ssh.jasonhorn.io "cd ~/DailyBriefDashboard && make pre-promote"
# Requires: .env with REDHAT_OFFLINE_TOKEN (for real-data gate)
# Or run destructive-only: make test-up && bunx playwright test --project=test --workers=1
```

**Keep the source up to date:**
```bash
ssh ssh.jasonhorn.io "git -C ~/DailyBriefDashboard pull"
```

---

### Option B: Self-Hosted GitHub Actions Runner

**→ Full setup guide moved to [GitHub Actions Runner Setup](#github-actions-runner-setup) at the top of this doc.** That section covers `nightly.yml` registration, PATH config, and session refresh in detail.

**CI jobs and which runner handles them:**

---

### CI Jobs Reference

| Job | Runs on | What it does | Mac Mini candidate? |
|-----|---------|-------------|---------------------|
| `test` | ubuntu-latest | Unit tests, type check, dashboard build | Optional — fast on GH |
| `publish` | ubuntu-latest | Builds + pushes image to GHCR | No — keep on GH (needs Docker Buildx) |
| `smoke` | ubuntu-latest | Pulls image, starts container, health checks | Yes — native podman |
| `e2e` | ubuntu-latest | Playwright suite against seed data | Yes — best candidate |

---

## What Lives Where

| Item | Main Machine | Mac Mini |
|------|-------------|----------|
| Production container (7777) | Yes | No |
| Test container (7776) | Yes | No |
| Demo container (7779) | Optional | Yes |
| Live credentials (.env, OAuth) | Yes | No |
| PAI ~/.claude (git) | Yes (source) | Yes (clone) |
| DailyBriefDashboard source | Yes | Yes (for CI) |
| Scrapers / live data pipelines | Yes | No |
| GitHub Actions runner | No | Optional |

---

## What Agents Need to Use This System

PAI agents (Marcus, Quinn, Rook) operate from CLAUDE.md rules. They currently have no awareness of the Mac Mini. Three layers must be in place before agents can use it:

### Layer 1 — Hostname in CLAUDE.md (blocks everything)
Agents need one value to know where to SSH. Use the tunnel hostname — it works on and off the home LAN:
```
MAC_MINI_HOST=ssh.jasonhorn.io
```
**Confirmed working:** `ssh ssh.jasonhorn.io` via Cloudflare Zero Trust (2026-04-22). For local LAN use `jasonhorn@mini.local`. Add to CLAUDE.md when OPS targets are ready to activate.

### Layer 2 — Makefile targets must exist
Agents have nothing to call until the OPS backlog items ship. Adding CLAUDE.md rules that reference `make smoke-remote` before that target exists causes agent errors. The dependency chain is strict:
```
Mac Mini set up → Makefile targets built (OPS-03 to OPS-06) → CLAUDE.md rules added → agents use them
```

### Layer 3 — CLAUDE.md rules added as each OPS item ships
Rules get added one at a time as the implementation lands — not all upfront. Phantom rules for unbuilt features are worse than no rules.

| OPS Item | CLAUDE.md rule it unlocks |
|----------|--------------------------|
| OPS-03 (demo refresh) | "Run `make demo-refresh-remote` to push updated demo to Mac Mini" |
| OPS-04 (always-on test container) | "Test container on Mac Mini is always warm — use `MAC_MINI_HOST:7776` for validation" |
| OPS-05 (nightly suite) | "Check `~/test-results.log` on Mac Mini for overnight failures before starting any session" |
| OPS-06 (post-deploy smoke) | "After every `make rebuild`, run `make smoke-remote` to verify prod from Mac Mini" |
| OPS-07 (visual regression) | "Quinn: run visual baseline diff on Mac Mini after every deploy" |
| OPS-08 (multi-arch) | "GH Actions publishes arm64+amd64 manifest — no arch-specific pull flags needed" |
| Runner registered | "GH Actions `e2e` and `smoke` jobs run on Mac Mini self-hosted runner" |

### Is Adding This to Agent Context Now Overkill?

Yes — adding it all to CLAUDE.md now would be overkill. Rules that reference non-existent targets generate errors and erode agent trust in the rules file. The pointer in CLAUDE.md (`# Mac Mini CI: see docs/MAC-MINI-DEMO-SETUP.md`) is enough for now. Each rule gets added the moment its implementation ships.

**The one exception:** `MAC_MINI_HOST` gets added to CLAUDE.md the moment Jason confirms the hostname — even before any OPS items ship. It costs nothing and unblocks everything.

---

## Mac Mini as a Stability Asset

Beyond demo and CI, the Mac Mini compounds stability across the entire development workflow. Each layer moves bug detection one step earlier — earlier detection means cheaper fixes.

### Always-On Test Container *(BKL-OPS-04)*
Keep `make test-up` running permanently on the Mac Mini. The test container (7776) currently spins up and down per session. An always-warm environment means zero friction for validation — agents and manual checks alike hit a ready container without setup time.

### Nightly Full Test Suite *(BKL-OPS-05)*
Schedule `npx playwright test --project=test` nightly against the test container. Regressions that accumulate silently between sessions surface the next morning before you touch any code. Currently there is no automated recurring test run — regressions only get found when someone manually runs tests.

### Post-Deploy Smoke Test from Second Machine *(BKL-OPS-06)*
After every `make rebuild` on the main machine, the Mac Mini automatically runs a health + API check against production (7777) from an independent machine. A misconfigured container or failed env var that appears healthy locally gets caught. Two machines confirming health is a stronger signal than the deploy machine checking itself.

### Visual Regression Baseline *(BKL-OPS-07)*
After every deploy, Quinn runs automatically on the Mac Mini and compares screenshots to the previous deploy. Silent visual regressions — broken layouts, missing components, color changes — get caught without manual review.

### Multi-Arch Container Builds *(BKL-OPS-08)*
If the Mac Mini is Apple Silicon (arm64), build the `linux/arm64` image there while GH Actions builds `linux/amd64`. Push both as a multi-arch manifest to GHCR. Anyone pulling the image on any architecture gets the native build — no silent performance penalties from emulated layers.

### Agent Offload
With PAI cloned and Claude Code installed, long-running agent tasks (Marcus doing a deep audit, Quinn running a full regression pass) run on the Mac Mini while you continue working on the main machine. Agents push results via git — you review and merge, never blocked.

### The Compound Effect

```
Today:        code → make rebuild → find bug in prod → fix → make rebuild
With Mac Mini: code → push → Mac Mini catches it → fix before it ships
```

Every layer added to the Mac Mini moves bug detection one step earlier. The always-on test container + nightly run + self-hosted runner + post-deploy smoke together create a system that surfaces problems automatically rather than waiting for manual discovery.

---

## Automation Backlog

| Item | Description | Status |
|------|-------------|--------|
| BKL-OPS-03 | PAI sync + demo full refresh (`make pai-sync-remote`, `make demo-full-refresh`) | ✅ DONE 2026-04-13 |
| BKL-OPS-04 | Always-on test container on Mac Mini | 🟡 REOPENED — self-hosted runner wired up 2026-04-17; Mac Mini now actively used for L3 nightly tests |
| BKL-OPS-05 | Nightly full test suite (cron on Mac Mini) | ✅ DONE 2026-04-17 — `.github/workflows/nightly.yml` runs at 02:00 PT via self-hosted runner |
| BKL-OPS-06 | Post-deploy smoke test from Mac Mini | 🚫 WONTFIX — smoke gate runs on main machine post-rebuild (`make smoke`); redundant second-machine check not needed |
| BKL-OPS-07 | Visual regression baseline + Quinn auto-run post-deploy | 🚫 WONTFIX — Quinn audits run manually on main machine as part of promotion gate |
| BKL-OPS-08 | Multi-arch container builds (arm64 + amd64) | 🟡 IN PROGRESS — arm64 confirmed; `platforms` added to ci.yml |

See BACKLOG.md for full specs.

---

*Created: 2026-04-11 | Last validated: 2026-04-20 | Owner: DA | Trigger: demo-export or demo-up Makefile changes, tunnel config changes, nightly.yml changes*

### Tunnel Change Log
- **2026-04-12:** Added `com.pai.instatunnel-keepalive` (3rd LaunchAgent). Root cause: relay drops idle connections after ~45-90s. Keep-alive must hit public URL to traverse relay — localhost hits bypass it entirely. Watchdog endpoint fixed from `/health` (always 404, never fires) to `/api/aes` (returns 200 when healthy).
- **2026-04-13:** Tunnel went down with `"tunnel with subdomain asa-dashboard not found"` — `instatunnel status` showed tunnel as `expired`. Fix: run `instatunnel --kill asa-dashboard` on the Mac Mini.
- **2026-04-13:** Migrated from instatunnel to Cloudflare Tunnel. Root cause: instatunnel relay drops WebSocket sessions every 60-90s of activity, causing "Tunnel not connected" errors on page navigation. `--transport v2` flag not supported on `connect` subcommand — no workaround. Cloudflare named tunnels have no session concept and are indefinitely persistent. New URL: `https://demo.jasonhorn.io` — confirmed live HTTP 200 at 2026-04-13. DNS: jasonhorn.io nameservers moved to Cloudflare (casey + keyla). Tunnel ID: `39496b85-a976-4811-ac94-462ddf4faa8b`. Service: `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist`.
- **2026-04-13 (fix):** Tunnel kept dropping every 30-120s. Root cause: plist had `--protocol quic` (UDP). Home router NAT tables expire UDP sessions after ~30-120s of no traffic, killing all 4 QUIC connections simultaneously. Fix: changed plist to `--protocol http2` (TCP-based, survives NAT/idle). Also fixed: Mac Mini had `sleep 1` (slept after 1 minute) — disabled with `sudo pmset -a sleep 0`. Both changes verified: 4 http2 connections registered, HTTP 200 from public URL.
- **2026-04-21:** Discovered plist had reverted to `--protocol quic` (possibly from a `cloudflared service install` call that regenerated the plist). Fixed again: `sed` replaced quic→http2, full unload/load applied. All 4 connections confirmed `protocol=http2`. Note: tunnel runs in token mode — no local `~/.cloudflared/config.yml`; ingress managed via Cloudflare dashboard.
- **2026-04-21:** Added SSH tunnel setup docs. To add `ssh.jasonhorn.io`: Cloudflare dashboard → Zero Trust → Networks → Tunnels → asa-dashboard → Edit → Public Hostnames → Add (SSH / localhost:22). Laptop: add ProxyCommand to `~/.ssh/config`.

### Tunnel Recovery Runbook

If `https://asa-dashboard.instatunnel.my` returns 404 and the tunnel log shows "tunnel with subdomain asa-dashboard not found":

```bash
# Step 1: Check status
ssh jasonhorn@mini.local "/opt/homebrew/bin/instatunnel status"
# If shows "expired" → proceed to step 2

# Step 2: Kill the expired tunnel record
ssh jasonhorn@mini.local "/opt/homebrew/bin/instatunnel --kill asa-dashboard"

# Step 3: Restart the LaunchAgent (it uses 'connect' which now works)
ssh jasonhorn@mini.local "launchctl stop com.pai.instatunnel-asa-dashboard && launchctl start com.pai.instatunnel-asa-dashboard"

# Step 4: Verify
curl -s -o /dev/null -w "%{http_code}" https://asa-dashboard.instatunnel.my/dashboard
# Expect: 200
```
