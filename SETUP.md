# Daily Brief Dashboard — Setup Guide

Detailed setup instructions for the Daily Brief Dashboard. See [README.md](README.md) for an overview of what the dashboard does.

Setup takes about 15-20 minutes the first time using the built-in setup wizard.

---

## Prerequisites

See [README.md — Prerequisites](README.md#prerequisites) for the full list. In short: Podman (or Docker), a GitHub account for pulling the container image, and your Red Hat Google Workspace + Customer Portal credentials.

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

Visit **http://localhost:6080** in your browser. This opens a noVNC window into the container's headless Chromium browser. Log into the Red Hat Customer Portal using your SSO credentials.

Your session is saved to `./data/rh-profile/` and persists across container restarts. You only need to re-login when your session expires.

---

#### AEs & Customers

Connect your AE's Google Drive folder(s). This is where the dashboard discovers your customer data, pipeline, CCSP cloud spend, and subscription information.

**Connect AE Folder(s):**
1. Open the AE's Google Drive folder in your browser and copy the URL
2. Paste the URL into the "Add AE Data Folder" field and click **Add**
3. Repeat for each AE you support (SAs supporting multiple AEs can add multiple folders)

Once folders are connected, click **Preview Discovery** to see what the dashboard found: pipeline sheets, CCSP data, and customer-named tabs.

**Import customers from pipeline:**
After connecting folders, click **Preview** to auto-discover the pipeline spreadsheet, review the detected columns, then click **Import**. Your customer list is built automatically from the pipeline data.

---

#### Data Sources & Refresh

Review connected data sources and configure refresh intervals. Default intervals:

| Data Source | Default Refresh |
|---|---|
| Red Hat support cases | Every 4 hours |
| Subscriptions (from Sheets) | Every 4 hours |
| CCSP cloud spend | Every 24 hours |
| Salesforce pipeline | Daily at 2am ET |

Intervals can be changed at any time without restarting the container.

---

After completing all sections, navigate to **http://localhost:7777/dashboard**. Data sources refresh on first load — the initial scrape may take 3-5 minutes before data appears.

---

## Google Drive Folder Structure

The dashboard searches your entire folder tree recursively — you can connect at any level and it finds everything beneath it automatically. Your existing structure works as-is.

**Connect at the highest useful level** — the dashboard will find files at any depth below it:

```
/Sales/                                   <- connect this (or any level below)
  └── Northwest/
        └── 2026/
              └── Jason/                  <- or connect individual AE folder here
                    ├── Pipeline Q1 2026.xlsx   <- found by "pipeline" in filename
                    ├── Territory Data.xlsx     <- found by CCSP tab name
                    ├── Acme Corporation/       <- or: Accounts/Acme Corporation/
                    │     └── Account Plan.docx
                    └── Accounts/               <- subfolder is fine too
                          ├── Contoso Ltd/
                          └── GlobalTech/
```

### Naming Guidelines

The dashboard auto-discovers data using fuzzy filename and tab-name matching:

#### Pipeline File
- Include **"pipeline"** in the filename
- Good: `FY26 Q1 Pipeline.xlsx`, `Jason Pipeline`, `West Pipeline Data`
- Bad: `AE Opportunities Q1.xlsx` (no "pipeline" in the name)

#### Territory / Customer Data Spreadsheet (CCSP + Subscriptions)

**CCSP tab:**
- Tab name must include **"ccsp"** (case-insensitive)
- Good: `CCSP Raw Data`, `CCSP Report`, `Q1 CCSP`, `ccsp`
- Bad: `Cloud Consumption`, `AWS Spend` (no "ccsp" in the name)

**Customer subscription tabs:**
- Tab name must include the **customer name** (case-insensitive, partial match is fine)
- Good: `Acme Corp`, `ACME CORPORATION`, `Acme - Q1 Subs`
- Bad: `Account_001`, `CustomerA` (no customer name in the tab)

#### Customer Folders on Drive
- Folder name should include the customer name
- The dashboard searches document titles for the customer name to find relevant account docs

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
