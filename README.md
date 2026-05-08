---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Daily Brief Dashboard
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

A containerized customer intelligence dashboard for Red Hat Account Executives and Solution Architects. Aggregates support cases, subscriptions, cloud spend, pipeline, and Google Workspace data into a single daily-brief view — so you walk into every customer conversation prepared.

## Install

### Prerequisites

**Install Podman:**

**macOS:**
```bash
brew install podman
podman machine init
podman machine set --memory 4096  # 4GB minimum required
podman machine start
```

**Ubuntu / Debian:**
```bash
sudo apt update
sudo apt install -y podman
```

**RHEL / Fedora:**
```bash
sudo dnf install -y podman
```

**System Requirements:**
- RAM: 4GB minimum (8GB recommended)
- Disk: 5GB free space
- CPU: 2+ cores recommended

**Red Hat Portal Access:**
Generate an offline token at [access.redhat.com/management/api](https://access.redhat.com/management/api) before setup.

### Run the Installer

```bash
curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh | bash
```

The script checks your system, pulls the container image, and opens the setup wizard at **http://localhost:7777/dashboard/setup**. The wizard handles everything else.

> **Want to inspect the script first?** Download it: `curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh -o setup.sh`, review it, then `bash setup.sh`. The script will pick up where it left off if you need to install prerequisites mid-run.

---

## What It Does

- **Support Cases** — Open cases by severity from the Red Hat Customer Portal per account
- **Subscriptions** — Active subscription data from SF bookings, organized by customer
- **Cloud Spend (CCSP)** — Tableau CCSP cloud consumption data per account
- **Pipeline** — Salesforce pipeline opportunities per AE
- **AI Briefs** — On-demand customer intelligence briefs powered by Google Gemini via Vertex AI
- **Google Workspace** — Gmail and Calendar context for meeting prep
- **Setup Wizard** — Browser-based wizard connects all data sources in ~15 minutes

All data is cached locally. Nothing leaves your machine except API calls to services you already have access to.

---

## Setup Wizard Walkthrough

After running the install script, the wizard guides you through:

1. **OAuth Keys** — Download the shared `gcp-oauth.keys.json` from the link in the wizard, then paste or upload it
2. **Connect Google Workspace** — Authorizes access to Gmail, Calendar, Drive, and Sheets
3. **Connect Red Hat Portal** — Click "Connect" and log in via the browser window that opens automatically
4. **AEs & Customers** — Connect your Google Drive AE folder(s) to import customer lists
5. **Data Sources & Refresh** — Connect Salesforce and Tableau via one-click buttons, then sync data

After setup, your dashboard is at **http://localhost:7777/dashboard**. The first data sync runs automatically — it may take 3-5 minutes before all data appears.

> **Google OAuth error?** The shared GCP project (`jhorn-pai`) uses Internal consent mode — any `@redhat.com` Google Workspace account can authorize. If you see errors, email **jhorn@redhat.com**.

For detailed setup instructions, Drive folder naming conventions, and advanced configuration, see **[SETUP.md](SETUP.md)**.

---

## Ports

| Port | Purpose |
|---|---|
| **7777** | Dashboard UI and API |

The hero install image is a pure HTTP server with no browser components — all data is read from Google Drive and the Red Hat Portal API. No VNC or browser ports needed.

---

## Stopping and Restarting

```bash
podman stop pai-dashboard     # stop the container
podman start pai-dashboard    # restart after reboot or stop
podman rm pai-dashboard       # remove (to re-run with new flags)
```

Your data in `./data/` is preserved across stops, starts, and container removal.

---

## Troubleshooting

**Podman machine not running (macOS)**
```bash
podman machine start
```

If you've never initialized: `podman machine init && podman machine set --memory 4096 && podman machine start`

**Podman machine RAM too low (macOS)**
The container needs 4GB minimum. Increase it:
```bash
podman machine stop
podman machine set --memory 4096
podman machine start
```

**Container fails to start or exits immediately**
Check logs: `podman logs pai-dashboard`

**Dashboard not loading at localhost:7777**
Verify the container is running: `podman ps`

**Red Hat Portal session expired (data stops refreshing)**
Go to the setup wizard and click "Reconnect" on the Red Hat Portal card to re-authenticate.

**Google auth errors**
Re-run the setup wizard at `http://localhost:7777/dashboard/setup` and re-do the Google OAuth step.

**AI briefs failing or empty**
AI briefs work out of the box using your `@redhat.com` Google OAuth token with the shared `jhorn-pai` GCP project. Check `podman logs pai-dashboard` for errors.

**SELinux permission errors on RHEL/Fedora**
Make sure you're using the `:Z` suffix on volume mounts. Docker users should remove `:Z`.

**Port 7777 already in use**
Set `PORT=7778` in `.env` and change `-p 7777:7777` to `-p 7778:7778` in the run command.

For detailed troubleshooting and advanced configuration, see **[SETUP.md](SETUP.md)**. Still stuck? Email **jhorn@redhat.com**.

---

## Advanced / Manual Install

If you prefer to run the container manually or need to customize the setup:

### 1. Pull the image

```bash
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

### 2. Create data directory and environment file

```bash
mkdir -p ./data/config ./data/cache ./data/rh-profile
```

Create a `.env` file:

```bash
cat > .env << 'EOF'
# Required — Red Hat Customer Portal API token
# Get yours at: https://access.redhat.com/management/api
REDHAT_OFFLINE_TOKEN=your_offline_token_here

# Optional overrides (container ships with sensible defaults)
# GOOGLE_CLOUD_PROJECT=jhorn-pai
# PORT=7777
EOF
```

### 3. Run the container

```bash
podman run -d \
  -p 7777:7777 \
  -v ./data:/data:Z \
  --env-file .env \
  -e PORT=7777 \
  -e CONFIG_DIR=/data/config \
  -e CACHE_DIR=/data/cache \
  -e RH_PROFILE_DIR=/data/rh-profile \
  --shm-size=256m \
  --name pai-dashboard \
  ghcr.io/hornjason/daily-brief-dashboard:latest
```

> **Docker users:** Replace `podman` with `docker` and remove the `:Z` volume suffix.
> **Linux (SELinux):** The `:Z` suffix is required on RHEL/Fedora to allow the container to write to the volume.

Then open the setup wizard at **http://localhost:7777/dashboard/setup**.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDHAT_OFFLINE_TOKEN` | — | **Required.** Red Hat Customer Portal API token ([get one here](https://access.redhat.com/management/api)) |
| `GOOGLE_CLOUD_PROJECT` | `jhorn-pai` | GCP project ID with Vertex AI API enabled |
| `GOOGLE_CLOUD_LOCATION` | `us-east1` | Vertex AI region |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model for brief generation |
| `NTFY_TOPIC` | `asa-command-center` | Push notification topic via ntfy.sh |
| `PORT` | `7777` | Server port |

Google OAuth tokens, AE folder configuration, and data source settings are managed through the setup wizard — no manual env vars needed for those. For the complete variable reference, see [SETUP.md — Environment Variables](SETUP.md#environment-variables-reference).

---

## Building from Source

```bash
git clone https://github.com/hornjason/daily-brief-dashboard.git
cd daily-brief-dashboard
make rebuild
```

| Command | What it does |
|---|---|
| `make build` | Build the container image locally |
| `make up` | Start the container (uses local image) |
| `make down` | Stop and remove the container |
| `make logs` | Tail container logs |
| `make ps` | Show container status |

For developer setup, testing, PR guidelines, and project structure, see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## Architecture

For technical details on data flow, scraper design, background timers, and module inventory, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## For Maintainers: Release Artifact Synchronization

**Automated sync on release tags:**

When you create a release tag (e.g., `git tag v1.7.0 && git push origin v1.7.0`), the GitHub Actions workflow (`.github/workflows/release.yml`) automatically:

1. Builds and pushes container images: `latest`, `stable`, `v1.7.0`
2. **Syncs hero install files to main branch**: `setup.sh`, `.env.example`, `docker-compose.yml`, `README.md`
3. Creates a GitHub Release with these files as downloadable assets

Users running `curl https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/setup.sh | bash` always get the latest files from the main branch.

**Manual updates between releases:**

When updating prerequisites or system requirements:

1. Update `scripts/setup.sh` preflight checks (MIN_*_MB constants, check_* functions)
2. Update `.env.example` with any new required/default variables
3. Update `docker-compose.yml` ports, volumes, resource limits
4. Update `README.md` Prerequisites section to match
5. Test locally with `bash scripts/setup.sh --dry-run`
6. Commit to main: `git commit -m "Update hero install prerequisites"`
7. Create a release tag to trigger the automated sync workflow

**Verification:**

After a release, verify the main branch has the latest files:
```bash
curl -I https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/setup.sh
curl -I https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/.env.example
```

Both should return `200 OK` and show recent `Last-Modified` timestamps.
