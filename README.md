---
doc-type: reference
status: active
owner: jason
updated: 2026-05-12
---

# Daily Brief Dashboard
*Last validated: 2026-05-12 | Owner: DA | Trigger: Review and update on any structural change to this doc*

A containerized customer intelligence dashboard for Red Hat Account Executives and Solution Architects. Aggregates support cases, subscriptions, cloud spend, pipeline, and Google Workspace data into a single daily-brief view — so you walk into every customer conversation prepared.

## Install

### Prerequisites

**Supported platforms:** Linux and macOS on both Intel (x86_64) and Apple Silicon (arm64). The container image is multi-arch — `docker pull` / `podman pull` automatically selects the correct architecture.

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

### Before You Start

You'll need a **Google Drive folder** to use as your AE parent folder. This is a folder in your personal Google Drive (or a Drive you own) where the dashboard will organize all your customer data. See [What is the AE Parent Folder?](#what-is-the-ae-parent-folder) below for details.

### Run the Installer

Create a directory for the dashboard, then run the installer from inside it:

```bash
mkdir ~/daily-brief && cd ~/daily-brief
curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh | bash
```

The script will:
1. Check prerequisites (Podman, RAM, disk, port 7777)
2. Create `./data/config`, `./data/cache`, `./data/rh-profile` inside your directory
3. Download `.env` and `docker-compose.yml` templates
4. Pull the container image from GHCR
5. Start the container and open the setup wizard at **http://localhost:7777/dashboard/setup**

> **Want to inspect the script first?** Download it: `curl -fsSL https://github.com/hornjason/daily-brief-dashboard/releases/latest/download/setup.sh -o setup.sh`, review it, then `bash setup.sh`.

---

## Setup Wizard Walkthrough

After the installer finishes, the setup wizard opens in your browser. It has 3 steps (plus one optional section):

### Step 1 of 3 — Google Auth

Click **Connect Google** to authorize access to Gmail, Calendar, Drive, and Sheets. This uses the shared `jhorn-pai` GCP project — any `@redhat.com` Google Workspace account works automatically.

OAuth keys are bundled with the container — no manual download or upload needed.

### Step 2 of 3 — AEs & Customers

This is where you connect your Google Drive AE parent folder and import your customer data.

1. Paste your **AE parent folder URL** (the Google Drive folder you created earlier)
2. Click **Add AE** for each AE you manage
3. The dashboard runs **bootstrap** automatically — this creates the folder structure in your Drive and imports customer data from the shared L3 data source

After bootstrap completes, your customers appear with subscription data, pipeline, and cloud spend already populated.

### Step 3 of 3 — AI & Intelligence Settings (Optional)

Configure AI brief generation preferences. Briefs work out of the box using your Google OAuth token with Vertex AI — no additional API keys needed.

### Done

Click **Open Dashboard** to see your customers at **http://localhost:7777/dashboard**. The first data sync runs automatically — it may take 3-5 minutes before all data appears.

> **Google OAuth error?** The shared GCP project (`jhorn-pai`) uses Internal consent mode — any `@redhat.com` account can authorize. If you see errors, email **jhorn@redhat.com**.

---

## What is the AE Parent Folder?

The **AE parent folder** is a Google Drive folder you create that becomes the root of your dashboard's data structure. During setup, the dashboard scaffolds everything inside it:

```
Your AE Parent Folder/          ← the folder you create and paste into the wizard
  ├── {AE Name}/                ← one subfolder per AE (created by bootstrap)
  │   ├── SF Bookings.gsheet    ← subscription data per customer
  │   ├── CCSP.gsheet           ← cloud spend data
  │   ├── Pipeline.gsheet       ← Salesforce pipeline
  │   └── {Customer Name}/      ← one folder per customer
  │       └── (account docs, notes, intelligence)
  ├── Config/                   ← backup sheets (created by bootstrap)
  └── Products/                 ← product intel folders (created by bootstrap)
      ├── openshift/
      ├── rhel/
      └── ansible/
```

**Why it's needed:** The dashboard reads all customer data from this folder structure. Bootstrap populates it from the shared L3 data source (updated nightly), so your Drive always has fresh data. The folder lives in your personal Drive — nothing is shared or visible to anyone else unless you share it.

**How to create it:** Make a new folder in Google Drive (name it anything — "ASA Dashboard" or "My Customers" works fine), then copy its URL from the browser address bar and paste it into the wizard.

---

## What It Does

- **Support Cases** — Open cases by severity from the Red Hat Customer Portal per account
- **Subscriptions** — Active subscription data from SF bookings, organized by customer
- **Cloud Spend (CCSP)** — Cloud consumption data per account
- **Pipeline** — Salesforce pipeline opportunities per AE
- **AI Briefs** — On-demand customer intelligence briefs powered by Google Gemini via Vertex AI
- **Google Workspace** — Gmail and Calendar context for meeting prep

All data is cached locally. Nothing leaves your machine except API calls to services you already have access to.

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

## Upgrading

Pull the latest image and restart:

```bash
cd ~/daily-brief  # or wherever you installed
podman compose pull
podman compose up -d
```

Your data and configuration are preserved — only the application code updates.

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

**Google auth errors**
Re-run the setup wizard at `http://localhost:7777/dashboard/setup` and re-do the Google OAuth step.

**AI briefs failing or empty**
AI briefs work out of the box using your `@redhat.com` Google OAuth token with the shared `jhorn-pai` GCP project. Check `podman logs pai-dashboard` for errors.

**SELinux permission errors on RHEL/Fedora**
Make sure you're using the `:Z` suffix on volume mounts. Docker users should remove `:Z`.

**Port 7777 already in use**
Set `PORT=7778` in `.env` and change the port mapping in `docker-compose.yml`.

Still stuck? Email **jhorn@redhat.com**.

---

## Advanced / Manual Install

If you prefer to run the container manually instead of using the installer:

### 1. Create a directory and pull the image

```bash
mkdir ~/daily-brief && cd ~/daily-brief
podman pull ghcr.io/hornjason/daily-brief-dashboard:latest
```

### 2. Create data directories and environment file

```bash
mkdir -p ./data/config ./data/cache ./data/rh-profile
```

Create a `.env` file (the only required variable for hero installs is the port):

```bash
cat > .env << 'EOF'
# Server port
PORT=7777

# Optional overrides (container ships with sensible defaults)
# GOOGLE_CLOUD_PROJECT=jhorn-pai
# GEMINI_MODEL=gemini-2.5-flash
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
| `GOOGLE_CLOUD_PROJECT` | `jhorn-pai` | GCP project ID with Vertex AI API enabled |
| `GOOGLE_CLOUD_LOCATION` | `us-east1` | Vertex AI region |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model for brief generation |
| `PORT` | `7777` | Server port |

Google OAuth tokens, AE folder configuration, and data source settings are managed through the setup wizard — no manual env vars needed.

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

---

## Architecture

For technical details on data flow, scraper design, background timers, and module inventory, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.
