---
Last validated: 2026-04-24
---

# Daily Brief Dashboard — Setup Guide

Detailed setup instructions for the Daily Brief Dashboard. See [README.md](README.md) for an overview of what the dashboard does.

Setup takes about 15-20 minutes the first time using the built-in setup wizard.

---

## Prerequisites

See [README.md — Prerequisites](README.md#prerequisites) for the full list. In short:
- Podman (or Docker)
- GitHub account for pulling the container image
- Red Hat Google Workspace account (`@redhat.com`)
- **Red Hat Offline Token** — generate at [access.redhat.com/management/api](https://access.redhat.com/management/api) → click **Generate Token** (must be logged in)

> **Bun runtime** is only needed if running without a container (development mode). Container users do not need Bun installed.

---

## Option A: Run with Podman (Recommended)

This is the easiest path. The container packages everything — no need to install Node, Bun, or any dependencies on your machine.

### Step 1: Pull the Container Image

The image is hosted on GitHub Container Registry (private). You need a GitHub Personal Access Token (PAT) with `read:packages` scope.

Create a PAT at [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)** → check `read:packages`.

```bash
podman login ghcr.io -u YOUR_GITHUB_USERNAME
# paste your PAT when prompted for password
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

### Step 2: Set Up Your Data Directory

The container stores all configuration, tokens, and cached data in a single `./data/` directory on your machine. This directory persists across container restarts and rebuilds.

```bash
mkdir -p ./data/config ./data/cache ./data/rh-profile
```

### Step 3: Create Your Environment File

The container ships with built-in defaults for AI briefs (Gemini config, GCP project). The only required variable is your Red Hat token. To override any default, add it to your `.env` — your values always take precedence.

```bash
cat > .env << 'EOF'
# Required — Red Hat Customer Portal API token
# Get yours at: https://access.redhat.com/management/api
REDHAT_OFFLINE_TOKEN=your_offline_token_here

# Optional — override any container default (see Environment Variables Reference below)
# GOOGLE_CLOUD_PROJECT=your-gcp-project-id
# GEMINI_SERVICE_ACCOUNT_KEY=your-base64-key
# GEMINI_MODEL=gemini-2.5-flash
# GOOGLE_CLOUD_LOCATION=us-east1
# NTFY_TOPIC=asa-command-center
EOF
```

### Step 4: Run the Container

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
> **Do not reduce** `--shm-size` or `--memory` — Chromium requires these for stable operation.

### Step 5: Run the Setup Wizard

Open your browser to **http://localhost:7777/dashboard/setup**. The wizard walks you through everything — no manual config file editing required.

The setup wizard is an accordion-style page with these sections:

---

#### OAuth Keys

Before connecting Google Workspace, the dashboard needs a `gcp-oauth.keys.json` file. This is a standard GCP (Google Cloud Platform) OAuth credential file that identifies the app to Google — it does not contain any personal data and is safe to use. It was created by jhorn@redhat.com and shared read-only.

1. Click the link in the wizard to download the shared `gcp-oauth.keys.json` from Google Drive
2. Either paste the JSON contents or upload the file
3. The wizard confirms the keys are loaded and advances

> **Want to use your own GCP project instead?** See [Creating Your Own GCP Project](#creating-your-own-gcp-project) below.

---

#### Connect Google Workspace

Click **Connect Google Workspace** to authorize the dashboard to access your Gmail, Google Calendar, Google Drive, and Google Sheets. This opens a Google consent screen in your browser.

The dashboard requests these permissions:
- **Gmail** — read-only + send (for email context in briefs and meeting agendas)
- **Calendar** — read-only (for meeting prep)
- **Drive** — read/write (creates Account Intelligence folders and docs, template sheets during bootstrap)
- **Sheets** — read/write (syncs subscription, pipeline, and CCSP data)

The shared GCP project (`jhorn-pai`) uses **Internal** consent mode — any `@redhat.com` Google Workspace user can authorize without test-user approval.

---

#### Connect Red Hat Portal

Click **Connect Red Hat Portal** in the wizard. A browser window opens automatically showing the container's headless Chromium — log into the Red Hat Customer Portal using your SSO credentials and return to the wizard. The session is detected automatically.

Your session is saved to `./data/rh-profile/` and persists across container restarts. You only need to re-login when your session expires.

---

#### AEs & Customers

This section sets up your AE data. There are two paths:

**Option A — Auto Setup (recommended for new installs):**

Click **Auto Setup** to run the full bootstrap wizard. You provide:
- AE name
- Customer names (one per line — copied from your territory list)
- Salesforce Report URL or ID (the pipeline report for this AE — paste the full Lightning URL or bare report ID, both work)
- Tableau territory name(s)
- Optionally, a parent Google Drive folder URL

The wizard then automatically:
1. Creates an AE folder on Google Drive (or uses the parent folder you specified)
2. Creates a customer subfolder for each customer name
3. Runs Supportable discovery and scrape for all customers
4. Runs CCSP (Tableau) scrape and sheet creation
5. Syncs Salesforce pipeline data to a new sheet
6. Kicks off domain inference + AI account intelligence batch for all customers

This takes 5-10 minutes and requires Red Hat VPN for Supportable. When complete, your dashboard will be fully populated.

**Option B — Connect existing folders:**

If you already have an AE folder structure on Drive, open the AE's Google Drive folder in your browser, copy the URL, paste it into the "Add AE Data Folder" field, and click **Add**. The dashboard searches recursively — connect at any level and it finds everything beneath it. Then click **Preview Discovery** to see what was found, and **Import** to build the customer list from the pipeline data.

---

#### Data Sources & Refresh

This section has two parts:

**Connections** — One-click connect buttons for each data source. Click each to authenticate:

| Source | What Happens |
|---|---|
| **Red Hat Portal** | Scrolls to the RH Portal section above |
| **Supportable 360** | Checks VPN reachability (requires Red Hat VPN) |
| **Salesforce** | Opens a browser window for SSO login, auto-detects when done |
| **Tableau** | Opens a browser window for SSO login, auto-detects when done |

**Sync** — Manual sync buttons and last-sync timestamps for each data source. Default refresh intervals:

| Data Source | Default Refresh |
|---|---|
| Red Hat support cases | Every 4 hours |
| Supportable subscriptions | Every 4 hours |
| CCSP cloud spend | Every 24 hours |
| Salesforce pipeline | Daily at 2am ET |

You can trigger a manual sync any time without restarting the container.

---

After completing all sections, navigate to **http://localhost:7777/dashboard**. Data sources refresh on first load — the initial scrape may take 3-5 minutes before data appears.

---

## Google Drive Folder Structure

### What Bootstrap Creates

When you run the setup wizard's bootstrap step, it automatically creates this folder structure on Google Drive:

```
Your Parent Folder/                          <- you choose where (or let it create at root)
  └── Jason Horn/                            <- AE folder (one per AE)
        ├── Supportable — Jason Horn         <- Google Sheet: subscription data per customer tab
        ├── Jason Horn CCSP                  <- Google Sheet: cloud consumption data
        ├── Jason Horn Pipeline              <- Google Sheet: Salesforce pipeline opportunities
        ├── Acme Corporation/                <- customer folder (one per customer)
        │     └── Account Intelligence/      <- auto-created subfolder
        │           ├── Account Brief.gdoc   <- AI-generated customer brief
        │           └── SWOT Analysis.gdoc   <- AI-generated SWOT
        ├── Contoso Ltd/
        │     └── Account Intelligence/
        │           └── ...
        └── GlobalTech Inc/
              └── Account Intelligence/
                    └── ...
```

| Resource | Created By | Purpose |
|---|---|---|
| **AE folder** | Bootstrap Step 1 | Top-level folder for all AE data |
| **Customer folders** | Bootstrap Step 2 | One subfolder per customer from your territory list |
| **Supportable — {AE}** sheet | Bootstrap Step 4 | Subscription data scraped from Supportable 360 (one tab per customer) |
| **{AE} CCSP** sheet | Bootstrap Step 5 | Cloud consumption data scraped from Tableau CCSP |
| **{AE} Pipeline** sheet | Bootstrap Step 6 | Salesforce pipeline opportunities synced from your SF report |
| **Account Intelligence/** | On-demand | Created inside each customer folder when you generate AI briefs |

### Connecting an Existing Folder

If you already have an AE folder structure on Drive, you can connect it instead of creating a new one. The dashboard searches recursively — connect at any level and it finds everything beneath it.

Auto-discovery uses fuzzy matching on filenames and tab names:

- **Pipeline:** filename must include **"pipeline"** (e.g., `FY26 Q1 Pipeline.xlsx`)
- **CCSP:** tab name must include **"ccsp"** (e.g., `CCSP Raw Data`)
- **Subscriptions:** tab name must include the **customer name** (case-insensitive, partial match OK)
- **Customer folders:** folder name should include the customer name

---

## Option B: Run Without Container (Development)

If you want to run the app directly (useful for development or if you can't use Podman):

```bash
# Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Install dependencies
bun install
cd dashboard && bun install && bun run build && cd ..

# Create your env file
cp .env.example .env   # then edit with your settings

# Start the server
bun run server.ts
```

The server starts on port 7777 by default.

---

## Building from Source

See [README.md — Building from Source](README.md#building-from-source) for `make` commands.

---

## Updating the Dashboard

When a new version is available:

```bash
# Pull the latest image
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest

# Restart with the new image
podman stop pai-dashboard && podman rm pai-dashboard
# Re-run the podman run command from Step 4 above
```

Your `./data/` directory is preserved — all config, tokens, and cached data carry over.

---

## Creating Your Own GCP Project

If you want to use your own GCP project instead of the shared one:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project
2. Enable these APIs: **Gmail API**, **Google Calendar API**, **Google Drive API**, **Google Sheets API**
3. For AI briefs, also enable: **Vertex AI API**
4. Create an **OAuth 2.0 Client ID** with type **Desktop app**
5. Download the JSON, rename to `gcp-oauth.keys.json`, and upload it in the setup wizard's OAuth Keys step
6. For AI briefs with a service account:
   - Create a Service Account with the **Vertex AI User** role
   - Download the JSON key
   - Base64-encode it: `base64 -i your-key.json` (macOS) or `base64 -w0 your-key.json` (Linux)
   - Set `GEMINI_SERVICE_ACCOUNT_KEY` in your `.env`

---

## Environment Variables Reference

These live in your `.env` file in the same directory as the `podman run` command.

### Required

| Variable | Description |
|---|---|
| `REDHAT_OFFLINE_TOKEN` | Red Hat Customer Portal API token ([get one](https://access.redhat.com/management/api)) |

### AI Briefs (defaults ship in container)

The container includes a shared GCP project and Gemini service account key so AI briefs work out of the box. Override these only if you want to use your own GCP project.

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | `jhorn-pai` | GCP project ID with Vertex AI API enabled |
| `GEMINI_SERVICE_ACCOUNT_KEY` | *(shared key)* | Base64-encoded GCP service account JSON key. To create your own: `base64 -i key.json` (macOS) or `base64 -w0 key.json` (Linux). If omitted entirely, falls back to the Google OAuth token from the setup wizard. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_CLOUD_LOCATION` | `us-east1` | Vertex AI region |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model for brief generation |
| `PORT` | `7777` | Server listen port |
| `NTFY_TOPIC` | `asa-command-center` | ntfy.sh push notification topic |
| `PIPELINE_FILE_ID` | — | Manual override: Google Sheets file ID for pipeline data |
| `TABLEAU_BASE_URL` | — | Tableau Cloud base URL for CCSP session pre-flight |
| `NODE_ENV` | — | Set to `production` to disable debug endpoints |

### Path Overrides (set automatically in container)

These are set by the `podman run` command and generally do not need manual configuration:

| Variable | Container Default | Description |
|---|---|---|
| `CONFIG_DIR` | `/data/config` | Config and token file directory |
| `CACHE_DIR` | `/data/cache` | Scraper cache directory |
| `RH_PROFILE_DIR` | `/data/rh-profile` | Chromium browser profile directory |
| `GOOGLE_OAUTH_KEYS` | `{CONFIG_DIR}/gcp-oauth.keys.json` | Path to GCP OAuth keys file |

> **Note:** AE folder configuration, data source settings, and Google OAuth tokens are managed by the setup wizard and saved to `./data/config/`. You generally don't need to set these manually.

---

## Auth Token Files

These files in `./data/config/` authenticate the dashboard to Google. They are created automatically by the setup wizard. Do not share or commit these files.

| File | Purpose | How Created |
|---|---|---|
| `.google-token.json` | Unified token for Gmail, Calendar, Drive, and Sheets | Setup wizard → "Connect Google Workspace" |
| `gcp-oauth.keys.json` | GCP OAuth client credentials (identifies the app) | Setup wizard → OAuth Keys step (uploaded by you) |
| `oauth-state.json` | Tracks permission downgrade state after bootstrap | Created automatically during bootstrap |

The unified `.google-token.json` covers all four Google APIs in a single token. Legacy per-service token files (`.gmail-token.json`, `.gdrive-server-credentials.json`, `.calendar-token.json`) are still supported as fallbacks but are no longer created by the wizard.

---

## Troubleshooting

### Starting fresh / resetting setup

In the setup wizard, click **Reset & Start Over** to clear all cached data and configuration. This removes:
- Connected AE folders
- Imported customer list
- Google OAuth token
- All cached API data

After reset, the wizard returns to the first step so you can reconfigure from scratch.

### "No customers found" or blank account list

- Go to the setup wizard and confirm your AE folder is connected
- Click **Preview** then **Import** to re-import customers from the pipeline
- Check that `./data/config/customers.json` is valid JSON if you're editing it manually

### Google authentication errors / "Token expired"

- Go to **http://localhost:7777/dashboard/setup** and re-do the Google OAuth step
- Click **Connect Google Workspace** to redo the OAuth flow — this refreshes your token
- Tokens live in `./data/config/` — the container reads them from there automatically
- If you see "access denied" or "not a test user," email jhorn@redhat.com to be added

### AI briefs failing or empty

- AI briefs should work out of the box with the container's built-in Gemini config
- If using your own GCP project: verify `GOOGLE_CLOUD_PROJECT` is set in your `.env`
- If using your own service account: verify `GEMINI_SERVICE_ACCOUNT_KEY` is set, or complete Google OAuth via the setup wizard
- Check `podman logs pai-dashboard` for Gemini-related errors
- The Vertex AI API must be enabled in your GCP project (already enabled in the shared `jhorn-pai` project)

### Pipeline data not showing

- In the setup wizard, confirm an AE folder is connected and the folder contains a pipeline spreadsheet
- The pipeline file must have **"pipeline"** in the filename — see naming guidelines above
- Click **Preview Discovery** to verify the dashboard is finding your pipeline file
- If auto-discovery fails, paste the pipeline spreadsheet URL manually

### CCSP cloud consumption data not showing

- The CCSP tab name must include **"ccsp"** (case-insensitive) — e.g., `CCSP Raw Data`, not `Cloud Spend`
- Verify the spreadsheet is inside the connected AE folder(s)
- Click **Preview Discovery** to confirm the CCSP tab was detected

### Customer subscription data not showing

- The customer's tab in the territory spreadsheet must include the customer name somewhere in the tab name
- Example: for "Acme Corporation", the tab could be named `Acme Corp`, `ACME CORPORATION`, or `Acme - Subs`
- Tab names are matched case-insensitively with partial matching

### Podman volume or SELinux errors on RHEL

- Always use the `:Z` suffix on volume mounts (included in the run command in Step 4)
- Docker users should remove `:Z`
- If you see `permission denied` on volume mounts, check that `./data/` exists and your user owns it

### Port 7777 already in use

Set a different port in `.env`:
```
PORT=7778
```
Then change `-p 7777:7777` to `-p 7778:7778` in the run command.

### Container starts but dashboard shows no data

- Give it 3-5 minutes on first load — it's fetching from Google APIs and Red Hat Portal
- Check container logs for errors:
  ```bash
  podman logs pai-dashboard
  ```

---

## Questions or Access Requests

For dashboard access to the shared GCP project, or if you run into issues getting set up, email **jhorn@redhat.com**.
