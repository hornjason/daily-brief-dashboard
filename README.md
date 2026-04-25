---
Last validated: 2026-04-25
---

# Daily Brief Dashboard

A containerized customer intelligence dashboard for Red Hat Account Executives and Solution Architects. Aggregates support cases, subscriptions, cloud spend, pipeline, and Google Workspace data into a single daily-brief view — so you walk into every customer conversation prepared.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/hornjason/daily-brief-dashboard/main/scripts/setup.sh | bash
```

The script checks your system, pulls the container image, and opens the setup wizard at **http://localhost:7777/dashboard/setup**. The wizard handles everything else.

**Prerequisite:** A Red Hat Google Workspace account (`@redhat.com`) with access to the Red Hat Customer Portal. The setup wizard uses your existing Google OAuth — no separate Gemini or GCP credentials needed.

> **macOS:** Podman must be installed first. `brew install podman && podman machine init && podman machine start`
>
> **RHEL/Fedora:** `sudo dnf install podman`
>
> Run the script again after installing Podman — it will pick up where it left off.

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
| **6080** | Browser window for Red Hat Portal login (localhost only) |

Port 6080 opens a browser view into the container's headless Chromium, used during setup and when re-authenticating the Red Hat Portal session.

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
