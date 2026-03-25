# Daily Brief Dashboard — Setup Guide

## What This Is

The Daily Brief Dashboard is an AI-powered customer intelligence tool built specifically for Red Hat Account Executives and Solution Architects. It pulls together everything you need to walk into a customer conversation prepared: upcoming meetings from your Google Calendar, recent emails from your Gmail, open support cases from the Red Hat Customer Portal, pipeline opportunities, and cloud consumption data — all in one place, filtered to your specific accounts.

The dashboard generates AI-written customer briefs on demand. Before a QBR or exec meeting, you can hit a button and get a structured summary of what's happening with that account: active cases, recent communications, upcoming renewals, and any open risks. The AI can use Google Gemini (recommended, Red Hat enterprise standard), Claude Code CLI, Anthropic Claude API, OpenAI GPT-4o, Ollama, or PAI.

Everything runs locally in a Podman container on your laptop. Your data never leaves your machine except to call the APIs you already have access to (Google Workspace, Red Hat Portal). Setup takes about 15-20 minutes the first time using the built-in setup wizard.

---

## Prerequisites

- **macOS** or **RHEL/Fedora Linux**
- **Podman** — container runtime (replaces Docker)
  - Mac: `brew install podman`
  - RHEL/Fedora: `sudo dnf install podman`
- **Bun runtime** — only needed if running without a container, or for running auth scripts from your host
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
- **Red Hat Google Workspace account** — for Gmail, Calendar, and Drive access
- **Red Hat Customer Portal access** — for support case data

---

## Option A: Run with Podman (Recommended)

This is the easiest path. The container packages everything — no need to install Node, Bun, or any dependencies on your machine.

### Step 1: Get the Dashboard Files

Copy the `DailyBriefDashboard` folder from a colleague, or download it from the shared drive. No git required. The folder should contain:

```
DailyBriefDashboard/
  Containerfile
  server.ts
  src/
  scripts/
  config/
  dashboard/
  package.json
```

### Step 2: Build the Container

```bash
cd DailyBriefDashboard
podman build -t pai-dashboard .
```

This takes 2-5 minutes the first time. It installs all dependencies inside the container image.

### Step 3: Set Up Your Config Directory

The container reads all configuration and tokens from `~/.pai-dashboard/` on your machine, so your settings persist across container restarts and rebuilds.

```bash
mkdir -p ~/.pai-dashboard
cp .env ~/.pai-dashboard/.env
cp config/customers.json ~/.pai-dashboard/customers.json
```

### Step 4: Run the Setup Wizard

Open the dashboard in your browser at **http://localhost:7777/dashboard/setup**. The wizard walks you through everything — no manual config file editing required.

The wizard has 5 steps:

---

#### Step 1: Connect Account Data (Google Sheets)

Connect your AE's Google Drive folder(s). This is where the dashboard discovers your customer data, pipeline, CCSP cloud spend, and subscription information.

**Connect AE Folder(s):**
1. Open the AE's Google Drive folder in your browser and copy the URL
2. Paste the URL into the "Add AE Data Folder" field and click **Add**
3. Repeat for each AE you support (SAs supporting multiple AEs can add multiple folders)

Once folders are connected, click **Preview Discovery** to see what the dashboard found: pipeline sheets, CCSP data, and customer-named tabs.

**Import customers from pipeline:**
After connecting folders, click **Preview** to auto-discover the pipeline spreadsheet, review the detected columns, then click **Import**. Your customer list is built automatically from the pipeline data.

##### Google Drive Folder Structure Requirements

The dashboard searches your entire folder tree recursively — you can connect at any level and it finds everything beneath it automatically. Your existing structure works as-is.

**Connect at the highest useful level** — the dashboard will find files at any depth below it:

```
/Sales/                                   ← connect this (or any level below)
  └── Northwest/
        └── 2026/
              └── Jason/                  ← or connect individual AE folder here
                    ├── Pipeline Q1 2026.xlsx   ← found by "pipeline" in filename
                    ├── Territory Data.xlsx     ← found by CCSP tab name
                    ├── Acme Corporation/       ← or: Accounts/Acme Corporation/
                    │     └── Account Plan.docx
                    └── Accounts/               ← subfolder is fine too
                          ├── Contoso Ltd/
                          └── GlobalTech/
```

**Works with any subfolder structure** — whether your accounts are direct children of the AE folder or nested inside an `Accounts/` subfolder (or any other folder), the dashboard finds them.

**Territory data spreadsheet** (CCSP + subscription data) can live anywhere under the connected root. It must contain:
- A tab with **"CCSP"** somewhere in the tab name (e.g., `CCSP Raw Data`, `Q1 CCSP`, `CCSP Report`)
- One tab per customer with the **customer name** somewhere in the tab name (e.g., `Acme Corp`, `ACME CORPORATION Subs`)

**Pipeline spreadsheet** — any Google Sheet with **"pipeline"** in the filename, anywhere under the connected root (e.g., `Pipeline Q1 2026`, `Jason Pipeline`, `West Pipeline Data`).

> **Naming tip:** The dashboard uses flexible matching — it doesn't need exact names. Just make sure "CCSP" appears in the cloud spend tab name, the customer name appears in their subscription tab name, and "pipeline" appears in the pipeline filename.

---

#### Step 2: Connect Google Workspace

Click **Connect Google Workspace** to authorize the dashboard to read your Gmail, Google Calendar, and Google Drive. This opens a Google consent screen in your browser.

The dashboard requests read-only access only — it cannot send emails, create events, or modify any files.

**If you see "This app isn't verified" or you're not a test user:**
- Click "Request Access" in the wizard to send a pre-filled email to jhorn@redhat.com
- Once added, return to Step 2 and click Connect again

**Internal mode (recommended for teams):** If your GCP admin switches the OAuth consent screen to "Internal," any `@redhat.com` user can connect with no test-user approval needed. See the callout in Step 2 for details.

---

#### Step 3: AI Provider (Optional)

Select which AI generates your customer briefs. Options:

| Provider | Requires | Notes |
|----------|----------|-------|
| **Google Gemini** | Nothing — manual | Red Hat enterprise standard. Copy the sample prompt, paste into Gemini at gemini.google.com |
| **Claude Code** | `claude` CLI installed | Uses your existing Claude Code login — no API key needed |
| **Anthropic API** | `ANTHROPIC_API_KEY` in .env | Direct API access |
| **OpenAI** | `OPENAI_API_KEY` in .env | GPT-4o |
| **Ollama** | Ollama running locally | Free, runs on your machine |
| **PAI** | PAI installed | If you're already a PAI user |

For Gemini (recommended for most Red Hat employees): the wizard shows a pre-built sample prompt containing your account context. Copy it, open Gemini, and paste. No API key or CLI needed.

---

#### Step 4: Pipeline (Auto-configured)

If you connected AE folders in Step 1 and they contain a pipeline spreadsheet, this step is already done. The dashboard auto-discovers the pipeline file from your connected folders.

If you need to manually specify a pipeline file, paste the Google Sheets URL into the field provided.

---

#### Step 5: Launch

Click **Go to Dashboard** to start using the dashboard. Your customers are loaded, data sources are connected, and you're ready to generate briefs.

---

### Step 5: Google Authentication (Manual Path)

If you prefer not to use the setup wizard, or if you're setting up on a server without a browser:

Email **jhorn@redhat.com** with subject **"Dashboard Access Request"** and your Red Hat Google email address to be added as a test user on the shared GCP app.

Alternatively, create your own GCP project:

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com) and create a new project.
2. Enable: Calendar API, Gmail API, Drive API, Sheets API
3. Create an **OAuth 2.0 Client ID** with type **Desktop app**
4. Download the JSON, place it at `~/.pai-dashboard/credentials.json`
5. Use the setup wizard's Step 2 to complete the browser OAuth flow

---

### Naming Guidelines for Your Google Drive Data

The dashboard auto-discovers data using fuzzy filename and tab-name matching. Follow these conventions to ensure reliable detection:

#### Pipeline File
- Include **"pipeline"** in the filename
- ✅ `FY26 Q1 Pipeline.xlsx`, `Jason Pipeline`, `West Pipeline Data`
- ❌ `AE Opportunities Q1.xlsx` (no "pipeline" in the name)

#### Territory / Customer Data Spreadsheet (CCSP + Subscriptions)
This is the spreadsheet with CCSP cloud consumption data and subscription details per customer.

**CCSP tab:**
- Tab name must include **"ccsp"** (case-insensitive)
- ✅ `CCSP Raw Data`, `CCSP Report`, `Q1 CCSP`, `ccsp`
- ❌ `Cloud Consumption`, `AWS Spend` (no "ccsp" in the name)

**Customer subscription tabs:**
- Tab name must include the **customer name** (case-insensitive, partial match is fine)
- ✅ `Acme Corp`, `ACME CORPORATION`, `Acme - Q1 Subs`
- ❌ `Account_001`, `CustomerA` (no customer name in the tab)

#### Customer Folders on Drive
- Folder name should include the customer name
- The dashboard searches document titles for the customer name to find relevant account docs

### Step 8: Run the Dashboard

```bash
bash scripts/podman-run.sh
```

Then open your browser to: **http://localhost:7777/dashboard**

If this is your first time, the setup wizard will walk you through any missing configuration: **http://localhost:7777/dashboard/setup**

---

## Option B: Run Without Container (Development)

If you want to run the app directly (useful for development or if you can't use Podman):

```bash
bun install
cd dashboard && bun install && bun run build && cd ..
cp .env.example .env   # then edit .env with your settings
bun run server.ts
```

The server starts on port 7777 by default.

---

## Updating the Dashboard

When a colleague sends you a newer version of the code, update like this:

```bash
# Stop and remove the old container
podman stop pai-dashboard && podman rm pai-dashboard

# Rebuild with the new code
podman build -t pai-dashboard .

# Start again (your config and tokens in ~/.pai-dashboard are untouched)
bash scripts/podman-run.sh
```

Your `~/.pai-dashboard/` directory is mounted into the container, so all your config, tokens, and cached data are preserved across updates.

---

## Troubleshooting

### Starting fresh / resetting setup

In the setup wizard header, click **Reset & Start Over** to clear all cached data and configuration. This removes:
- Connected AE folders
- Imported customer list
- Google OAuth token
- All cached API data

After reset, the wizard returns to Step 1 so you can reconfigure from scratch.

### "No customers found" or blank account list

- Go to Setup Step 1 and confirm your AE folder is connected
- Click **Preview** then **Import** to re-import customers from the pipeline
- Check that `~/.pai-dashboard/customers.json` is valid JSON if you're editing it manually

### Google authentication errors / "Token expired"

- Go to **http://localhost:7777/dashboard/setup** and click through to Step 2
- Click **Connect Google Workspace** to redo the OAuth flow — this refreshes your token
- Tokens live in `~/.pai-dashboard/` — the container reads them from there automatically
- If you see "access denied" or "not a test user," email jhorn@redhat.com to be added

### AI brief says "PAI inference failed" or brief is empty

- Check `LLM_PROVIDER` in `~/.pai-dashboard/.env`
- For Gemini (recommended): no key needed — use the manual prompt from Setup Step 3
- Switch to `anthropic` or `openai` as a fallback and add the corresponding API key
- For `claude-code`: make sure Claude Code is installed and logged in (`claude login`)

### Pipeline data not showing

- In Setup Step 1, confirm an AE folder is connected and the folder contains a pipeline spreadsheet
- The pipeline file must have **"pipeline"** in the filename — see naming guidelines above
- Click **Preview Discovery** in Step 1 to verify the dashboard is finding your pipeline file
- If auto-discovery fails, paste the pipeline spreadsheet URL manually in Setup Step 4

### CCSP cloud consumption data not showing

- The CCSP tab name must include **"ccsp"** (case-insensitive) — e.g., `CCSP Raw Data`, not `Cloud Spend`
- Verify the spreadsheet is inside the connected AE folder(s)
- Click **Preview Discovery** in Step 1 to confirm the CCSP tab was detected

### Customer subscription data not showing

- The customer's tab in the territory spreadsheet must include the customer name somewhere in the tab name
- Example: for "Acme Corporation", the tab could be named `Acme Corp`, `ACME CORPORATION`, or `Acme - Subs`
- Tab names are matched case-insensitively with partial matching

### Podman volume or SELinux errors on RHEL

- Always use `bash scripts/podman-run.sh` — the script includes the `:Z` SELinux volume label automatically
- Never use a bare `-v path:/config` without `:Z` on SELinux-enabled systems
- If you see `permission denied` on volume mounts, check that `~/.pai-dashboard/` exists and your user owns it

### Port 7777 already in use

Set a different port in `~/.pai-dashboard/.env`:
```
PORT=7778
```
Then edit the `-p` flag in `scripts/podman-run.sh` to match:
```
-p 7778:7778
```

### Container starts but dashboard shows no data

- Give it 30-60 seconds on first load — it's fetching from Google APIs and Red Hat Portal
- Check container logs for errors:
  ```bash
  podman logs pai-dashboard
  ```

---

## Environment Variables Reference

These live in `~/.pai-dashboard/.env`. Copy from the project's `.env` file as a starting point.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_PROVIDER` | No | `pai` | AI provider: `pai`, `gemini`, `claude-code`, `anthropic`, `openai`, `ollama` |
| `ANTHROPIC_API_KEY` | If `anthropic` | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | If `openai` | — | OpenAI API key |
| `OLLAMA_MODEL` | No | `llama3` | Ollama model name |
| `OLLAMA_URL` | No | `http://localhost:11434` | Ollama server URL |
| `AE_PARENT_FOLDER_IDS` | No | — | Comma-separated Google Drive folder IDs for AE folders (set via setup wizard) |
| `AE_PARENT_FOLDER_ID` | No | — | Single AE folder ID (legacy, still supported) |
| `PIPELINE_FILE_ID` | No | — | Manual override: Google Sheets file ID for pipeline data |
| `PORT` | No | `7777` | Port the server listens on |
| `CONFIG_DIR` | No | `./config` | Config directory path (set automatically inside container) |
| `CACHE_DIR` | No | `./cache` | Cache directory path (set automatically inside container) |

> **Note:** `AE_PARENT_FOLDER_IDS` and the data sources configuration are managed by the setup wizard and saved to `config/data-sources.json`. You generally don't need to set these manually.

---

## Auth Token Files

These files in `~/.pai-dashboard/` authenticate the dashboard to Google. They are created automatically by the setup wizard. Do not share or commit these files.

| File | Purpose | How created |
|------|---------|-------------|
| `.google-token.json` | Unified token for Gmail, Calendar, Drive, and Sheets | Setup wizard Step 2 → "Connect Google Workspace" button |
| `.gmail-token.json` | Legacy Gmail token (fallback if unified token absent) | Manual auth scripts (old method) |
| `.calendar-token.json` | Legacy Calendar token (fallback) | Manual auth scripts (old method) |
| `.gdrive-server-credentials.json` | Legacy Drive token (fallback) | Manual auth scripts (old method) |

The new setup wizard creates a single `.google-token.json` that covers all four Google APIs. The legacy individual token files still work as a fallback if you set up using the old method.

---

## Questions or Access Requests

For dashboard access to the shared GCP project, or if you run into issues getting set up, email **jhorn@redhat.com**.
