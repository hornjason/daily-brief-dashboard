---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-13
---

# New Machine Setup

Complete runbook for deploying DailyBriefDashboard on a fresh machine. Covers hero install (L3, any Mac/Linux) and primary node (L4, Mac Mini with browser scrapers).

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Podman | 4.x+ | `brew install podman` (macOS) / `sudo dnf install podman` (RHEL/Fedora) |
| Bun | 1.x+ | `curl -fsSL https://bun.sh/install \| bash` |
| Git | 2.x+ | Pre-installed on macOS |
| GH CLI | 2.x+ | `brew install gh` (for GitHub Actions runner + issue management) |

**macOS only:** Initialize Podman machine with at least 4GB RAM:
```bash
podman machine init --memory 4096
podman machine start
```

## 1. Clone and Setup

```bash
git clone https://github.com/hornjason/asaCommandCenter.git ~/DailyBriefDashboard
cd ~/DailyBriefDashboard
make setup
```

This creates `data/config/`, `data/cache/`, `data/rh-profile/` and copies `.env.example` to `.env`.

Edit `.env` with your credentials:
```bash
# Required
REDHAT_OFFLINE_TOKEN=<your_token>
GOOGLE_CLOUD_PROJECT=<your_gcp_project>

# Optional
TABLEAU_USER_EMAIL=<you@redhat.com>
NODE_ROLE=primary    # Only for Mac Mini (L4-capable nodes)
```

## 2. Restore Config (existing deployment) or Fresh Start

### Option A: Restore from backup
If migrating from another machine, copy the backup tarball and restore:
```bash
make restore-config FILE=config-backup-YYYYMMDD-HHMMSS.tar.gz
```

### Option B: Fresh start via Setup Wizard
Build and start with empty config — the web UI wizard will walk you through initial setup:
```bash
make build && make up
open http://localhost:7777/dashboard/setup
```

## 3. Build and Start

```bash
make build    # Build container image locally
make up       # Start production container on port 7777
```

Verify:
```bash
make doctor   # Checks podman, config files, image, container, API
```

## 4. Environment Health Check

Run `make doctor` at any time to validate the environment:
```
$ make doctor
Running environment health check...

  ✓ podman found
  ✓ aes.json present
  ✓ customers.json present
  ✓ settings.json present
  ✓ .env present
  ✓ REDHAT_OFFLINE_TOKEN set
  ✓ container image exists
  ✓ container: Up 2 minutes
  ✓ API healthy on :7777

Doctor complete.
```

## 5. Config Backup (for future migration)

Create a portable config snapshot at any time:
```bash
make backup-config
# Creates backups/config-backup-YYYYMMDD-HHMMSS.tar.gz
```

This captures `aes.json`, `customers.json`, `settings.json`, `product-intel-config.json`, and other config files. Does NOT include credentials, OAuth tokens, or cache data.

Store backups somewhere safe — they're your fastest path to recovery.

## 6. GitHub Actions Runner (optional — for CI/Gate 3)

Register a self-hosted runner for nightly data assertions:

```bash
# Download runner (check GitHub for latest version)
mkdir ~/actions-runner && cd ~/actions-runner
curl -o actions-runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.XXX.X/actions-runner-osx-arm64-2.XXX.X.tar.gz
tar xzf actions-runner.tar.gz

# Configure
./config.sh --url https://github.com/hornjason/asaCommandCenter --token <RUNNER_TOKEN> --name mac-mini-live --labels self-hosted,mac-mini-live

# Install as service (survives reboots)
sudo ./svc.sh install
sudo ./svc.sh start
```

Get your runner token: GitHub repo → Settings → Actions → Runners → New self-hosted runner.

## 7. Container Auto-Start (optional — for always-on machines)

Install the LaunchAgent so the container starts automatically after reboot:

```bash
cp scripts/com.asacommandcenter.container-autostart.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.asacommandcenter.container-autostart.plist
```

Logs: `/tmp/container-autostart.log`

## 8. Verify Gate 3

If you have a GitHub Actions runner configured, trigger the nightly assertions manually:

```bash
gh workflow run "Gate 3 — Nightly Data Assertions" --repo hornjason/asaCommandCenter
gh run list --repo hornjason/asaCommandCenter --workflow nightly.yml --limit 1
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `make up` fails with "aes.json missing" | Config not initialized | `make setup` for fresh start, or `make restore-config FILE=...` |
| Gate 3 fails with "Zero AEs configured" | Container started without config | Restore config + `make up` |
| API returns empty `{"aes":[]}` | Config volume not mounted or empty | Check `data/config/aes.json` exists on host |
| Container won't start after reboot | LaunchAgent not installed | Install per §7 above |
| `ENOENT: data-sources.json` in logs | Optional file missing | Copy from `scripts/seed-data/data-sources.json` to `data/config/` |

## Architecture Notes

- **Config is the persistence layer** — `aes.json` and `customers.json` are mutated at runtime by the setup wizard and scrapers. There is no database.
- **Single volume mount** — `./data/` maps to `/data/` in the container. Subdirs: `config/`, `cache/`, `rh-profile/`.
- **L3 vs L4** — Hero installs are L3 (Drive-read-only). Mac Mini with `NODE_ROLE=primary` is L4 (browser scrapers for RH Portal, Tableau, Salesforce). The L4 sync daemon is a separate container — see `ARCHITECTURE.md §3a`.
- **No auth middleware** — single-user, localhost-only by design.
