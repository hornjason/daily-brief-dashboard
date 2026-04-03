# Daily Brief Dashboard

A containerized customer intelligence dashboard for Red Hat Account Executives and Solution Architects. Aggregates support cases, subscriptions, cloud spend, pipeline, and Google Workspace data into a single daily-brief view — so you walk into every customer conversation prepared.

## What It Does

- **Support Cases** — Open cases by severity from the Red Hat Customer Portal per account
- **Subscriptions** — Active subscription data from Supportable 360, organized by customer
- **Cloud Spend (CCSP)** — Tableau CCSP cloud consumption data per account
- **Pipeline** — Salesforce pipeline opportunities per AE
- **AI Briefs** — On-demand customer intelligence briefs (Gemini, Claude, OpenAI, Ollama)
- **Google Workspace** — Gmail and Calendar context for meeting prep
- **Setup Wizard** — Browser-based wizard connects all data sources in ~15 minutes

All data is cached locally. Nothing leaves your machine except API calls to services you already have access to.

## Prerequisites

- **macOS** or **RHEL/Fedora Linux**
- **Podman** (or Docker)
  - Mac: `brew install podman && podman machine init && podman machine start`
  - RHEL/Fedora: `sudo dnf install podman`
- **Red Hat Customer Portal access** (your existing SSO credentials)
- **Red Hat Google Workspace account** (for Gmail, Calendar, and Drive)

## Quick Start

### 1. Pull the container image

```bash
podman login ghcr.io -u YOUR_GITHUB_USERNAME
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

### 2. Create your data directory and environment file

```bash
mkdir -p ./data/config ./data/cache ./data/rh-profile
```

Create a `.env` file with your settings:

```bash
cat > .env << 'EOF'
# Required
REDHAT_OFFLINE_TOKEN=your_offline_token_here
AE_FOLDER_NAME=Your Name

# Optional — AI brief provider (default: gemini, which needs no key)
# LLM_PROVIDER=gemini
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
EOF
```

Get your Red Hat offline token at [access.redhat.com/management/api](https://access.redhat.com/management/api). Set `AE_FOLDER_NAME` to your name as it appears on your Google Drive folder.

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

Go to **http://localhost:7777/dashboard/setup**. The wizard walks you through connecting Google Workspace, Red Hat Portal, and your AI provider.

After setup, your dashboard is at **http://localhost:7777/dashboard**. Data sources refresh on first load — the initial scrape may take 3-5 minutes before data appears.

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

Port 6080 lets you log into the Red Hat Customer Portal from your browser via a window into the container's headless Chromium. You use this once during setup and occasionally when your session expires.

## Environment Variables

Only two variables are required. Everything else is configured through the setup wizard or has sensible defaults.

| Variable | Required | Description |
|---|---|---|
| `REDHAT_OFFLINE_TOKEN` | **Yes** | Red Hat Customer Portal API token |
| `AE_FOLDER_NAME` | **Yes** | Your name as it appears on your Google Drive folder |
| `LLM_PROVIDER` | No | AI provider: `gemini` (default), `anthropic`, `openai`, `ollama`, `claude-code` |
| `ANTHROPIC_API_KEY` | If using Claude | Anthropic API key |
| `OPENAI_API_KEY` | If using OpenAI | OpenAI API key |
| `NTFY_TOPIC` | No | Push notification topic via ntfy.sh |

Google OAuth tokens are configured through the setup wizard — no manual env vars needed.

## Data Persistence

All persistent state lives in `./data/`, mounted at `/data` inside the container. This includes your configuration, cached scrape data, and browser session cookies. Back up this directory to preserve your setup across machines.

## Troubleshooting

**Container fails to start or exits immediately**
Check logs: `podman logs pai-dashboard`

**Dashboard not loading at localhost:7777**
Verify the container is running: `podman ps`

**Red Hat Portal session expired (data stops refreshing)**
Visit `http://localhost:6080` and log in again through the browser window.

**Google auth errors**
Re-run the setup wizard at `http://localhost:7777/dashboard/setup` — Step 2 re-does the OAuth flow.

For detailed troubleshooting, Drive folder naming conventions, and advanced configuration, see **[SETUP.md](SETUP.md)**.

## Building from Source

If you have the source code and `make` installed:

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

## Architecture

For technical details on data flow, scraper design, background timers, and module inventory, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.
