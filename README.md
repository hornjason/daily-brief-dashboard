---
Last validated: 2026-04-24
---

# Daily Brief Dashboard

A containerized customer intelligence dashboard for Red Hat Account Executives and Solution Architects. Aggregates support cases, subscriptions, cloud spend, pipeline, and Google Workspace data into a single daily-brief view — so you walk into every customer conversation prepared.

## What It Does

- **Support Cases** — Open cases by severity from the Red Hat Customer Portal per account
- **Subscriptions** — Active subscription data from Supportable 360, organized by customer
- **Cloud Spend (CCSP)** — Tableau CCSP cloud consumption data per account
- **Pipeline** — Salesforce pipeline opportunities per AE
- **AI Briefs** — On-demand customer intelligence briefs powered by Google Gemini via Vertex AI (Google Cloud's AI platform)
- **Google Workspace** — Gmail and Calendar context for meeting prep
- **Setup Wizard** — Browser-based wizard connects all data sources in ~15 minutes

All data is cached locally. Nothing leaves your machine except API calls to services you already have access to.

## Prerequisites

- **macOS** or **RHEL/Fedora Linux**
- **Podman** (or Docker)
  - Mac: `brew install podman && podman machine init && podman machine start`
  - RHEL/Fedora: `sudo dnf install podman`
  - If Podman installation is blocked by corporate IT, contact your IT helpdesk or email jhorn@redhat.com
- **GitHub account** — to pull the container image from GHCR (private registry)
- **Red Hat Google Workspace account** (for Gmail, Calendar, and Drive)
- **Red Hat Customer Portal access** (your existing SSO credentials)
- **Red Hat Offline Token** — required for support case data. Generate yours at [access.redhat.com/management/api](https://access.redhat.com/management/api) → click **Generate Token** (you must be logged in). Copy the token — you'll need it for your `.env` file in the next step.

## Quick Start

### 1. Log in to the container registry and pull the image

The container image is hosted on GitHub Container Registry (private). You need a GitHub Personal Access Token (PAT) with the `read:packages` scope.

Create a PAT at [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)** → check `read:packages`.

```bash
podman login ghcr.io -u YOUR_GITHUB_USERNAME
# paste your PAT when prompted for password
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

### 2. Create your data directory and environment file

```bash
mkdir -p ./data/config ./data/cache ./data/rh-profile
```

Create a `.env` file with your settings (you can also create this in a text editor and save it as `.env`):

```bash
cat > .env << 'EOF'
# Required — Red Hat Customer Portal API token
# Get yours at: https://access.redhat.com/management/api
REDHAT_OFFLINE_TOKEN=your_offline_token_here

# Optional — override any container default (see Environment Variables below)
# PORT=7777
# NTFY_TOPIC=asa-command-center
EOF
```

> **AI briefs work out of the box.** The container ships with a shared GCP project (`jhorn-pai`) and Gemini config baked in — no Gemini/Vertex AI setup required. To use your own GCP project instead, add `GOOGLE_CLOUD_PROJECT` and optionally `GEMINI_SERVICE_ACCOUNT_KEY` to your `.env`. See [Environment Variables](#environment-variables) for the full list.

### 3. Run the container

```bash
podman run -d \
  -p 7777:7777 \
  -p 127.0.0.1:6080:6080 \
  -v ./data:/data:Z \
  --env-file .env \
  -e PORT=7777 \
  -e CONFIG_DIR=/data/config \
  -e CACHE_DIR=/data/cache \
  -e RH_PROFILE_DIR=/data/rh-profile \
  --shm-size=2g \
  --memory=8g \
  --name pai-dashboard \
  ghcr.io/hornjason/daily-brief-dashboard:latest
```

> **Docker users:** Replace `podman` with `docker` and remove the `:Z` volume suffix.
> **Do not reduce** `--shm-size` or `--memory` — Chromium requires these to run stably.

### 4. Open the setup wizard

Go to **http://localhost:7777/dashboard/setup**. The wizard walks you through:

1. **OAuth Keys** — Download the shared `gcp-oauth.keys.json` from the link in the wizard, then paste or upload it
2. **Connect Google Workspace** — Authorizes access to Gmail, Calendar, Drive, and Sheets
3. **Connect Red Hat Portal** — Click "Connect" and log in via the browser window that opens automatically
4. **AEs & Customers** — Connect your Google Drive AE folder(s) to import customer lists
5. **Data Sources & Refresh** — Connect Supportable, Salesforce, and Tableau via one-click buttons, then sync data

After setup, your dashboard is at **http://localhost:7777/dashboard**. Data sources refresh on first load — the initial scrape may take 3-5 minutes before data appears.

> **Google OAuth error?** The shared GCP project (`jhorn-pai`) uses Internal consent mode — any `@redhat.com` Google Workspace account can authorize. If you see errors, email **jhorn@redhat.com**.

For detailed setup instructions, Drive folder naming conventions, advanced configuration, and troubleshooting, see **[SETUP.md](SETUP.md)**.

## Stopping and Restarting

```bash
podman stop pai-dashboard     # stop the container
podman start pai-dashboard    # restart after reboot or stop
podman rm pai-dashboard       # remove (to re-run with new flags)
```

Your data in `./data/` is preserved across stops, starts, and container removal.

## Ports

| Port | Purpose |
|---|---|
| **7777** | Dashboard UI and API |
| **6080** | Browser window for Red Hat Portal login (localhost only) |

Port 6080 opens a browser view into the container's headless Chromium. You use this during setup to log into the Red Hat Customer Portal, and occasionally when your session expires.

## Environment Variables

The container ships with sensible defaults for all variables except `REDHAT_OFFLINE_TOKEN`. To override any default, add the variable to your `.env` file — your values always take precedence.

| Variable | Default | Description |
|---|---|---|
| `REDHAT_OFFLINE_TOKEN` | — | **Required.** Red Hat Customer Portal API token ([get one here](https://access.redhat.com/management/api)) |
| `GOOGLE_CLOUD_PROJECT` | `jhorn-pai` | GCP project ID with Vertex AI API enabled |
| `GEMINI_SERVICE_ACCOUNT_KEY` | *(shared key)* | Base64-encoded GCP service account JSON key (falls back to OAuth token from wizard) |
| `GOOGLE_CLOUD_LOCATION` | `us-east1` | Vertex AI region |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model for brief generation |
| `NTFY_TOPIC` | `asa-command-center` | Push notification topic via ntfy.sh |
| `PORT` | `7777` | Server port |

Google OAuth tokens, AE folder configuration, and data source settings are all managed through the setup wizard — no manual env vars needed for those. For the complete variable reference including path overrides and advanced options, see [SETUP.md — Environment Variables](SETUP.md#environment-variables-reference).

## Data Persistence

All persistent state lives in `./data/`, mounted at `/data` inside the container. This includes your configuration, cached scrape data, Google OAuth tokens, and browser session cookies. Back up this directory to preserve your setup across machines.

## Troubleshooting

**Container fails to start or exits immediately**
Check logs: `podman logs pai-dashboard`

**Dashboard not loading at localhost:7777**
Verify the container is running: `podman ps`

**Red Hat Portal session expired (data stops refreshing)**
Go to the setup wizard and click "Reconnect" on the Red Hat Portal card to re-authenticate.

**Google auth errors**
Re-run the setup wizard at `http://localhost:7777/dashboard/setup` and re-do the Google OAuth step.

**AI briefs failing or empty**
AI briefs should work out of the box with the container's built-in Gemini config. If you're using your own GCP project, verify `GOOGLE_CLOUD_PROJECT` is set in your `.env` and that either `GEMINI_SERVICE_ACCOUNT_KEY` is set or you've completed Google OAuth via the wizard. Check `podman logs pai-dashboard` for errors.

**SELinux permission errors on RHEL/Fedora**
Make sure you're using the `:Z` suffix on volume mounts (included in the run command above). Docker users should remove `:Z`.

**Port 7777 already in use**
Set `PORT=7778` in `.env` and change `-p 7777:7777` to `-p 7778:7778` in the run command.

For detailed troubleshooting, Drive folder naming conventions, and advanced configuration, see **[SETUP.md](SETUP.md)**. Still stuck? Email **jhorn@redhat.com**.

## Building from Source

> This section is for contributors with access to the source code. If you're running the pre-built container, you can skip this.

```bash
cd DailyBriefDashboard
make rebuild    # builds the image, pushes to GHCR, and starts the container
```

| Command | What it does |
|---|---|
| `make build` | Build the container image locally |
| `make up` | Start the container (uses local image) |
| `make down` | Stop and remove the container |
| `make logs` | Tail container logs |
| `make ps` | Show container status |

For developer setup, testing, PR guidelines, and project structure, see **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Architecture

For technical details on data flow, scraper design, background timers, and module inventory, see **[ARCHITECTURE.md](ARCHITECTURE.md)** (for contributors).
