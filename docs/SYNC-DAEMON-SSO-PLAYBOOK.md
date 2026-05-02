---
doc-type: runbook | status: active | owner: jason | updated: 2026-04-30
---

# L3 Sync Daemon — SSO Playbook (BKL-SYNC-L3-04)

## Normal startup — no manual auth required

The daemon restores SSO cookies from disk on every start. The persistent Chromium
profile at `/data/rh-profile` (bind-mounted from `data-sync/rh-profile/` on Mac Mini)
carries valid SAML/OAuth cookies for both Tableau and Salesforce. As long as those
cookies are alive, the daemon starts, logs restoration, and begins syncing without any
manual intervention.

On a healthy start you'll see:
```
[rh-scraper] restored 82 session cookies from disk
[ccsp] adopted shared browser context
[sf-scraper] opening persistent context…
[sync-daemon] started — keepalive every 2h, sync at 5:30am ET
```

**You do not need to do anything.** The daemon holds its own sessions alive via the
2-hour SSO keepalive timer (navigates Tableau + SF Lightning home pages).

---

## When you need VNC — session expired

You'll know a session has died because:
- Email arrives: `L3 Sync Daemon - Keepalive Failed {date}` (Tableau or SF redirected to login)
- Email arrives: `L3 Sync FAILED - {date}` with an error mentioning session/auth

### Step 1 — Start daemon with VNC port exposed

```bash
cd ~/DailyBriefDashboard
make sync-down    # stop running daemon
make sync-up-vnc  # restart with VNC on port 6082
```

### Step 2 — Open VNC in browser

Navigate to:
```
http://mac.tail2fe7c7.ts.net:6082/vnc.html   (remote — Tailscale, works anywhere)
http://mini.local:6082/vnc.html              (local LAN only)
```

Click **Connect** (no password required).

### Step 3 — Re-authenticate Tableau

In the VNC browser session, navigate to:
```
https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption
```

If redirected to login: complete the Red Hat SSO flow (your usual SSO credentials).
Tableau will redirect back to the dashboard — you're done.

### Step 4 — Re-authenticate Salesforce

Navigate to:
```
https://redhatcrm.lightning.force.com/lightning/n/Home
```

If redirected to login: complete SSO. SF Lightning home loads — you're done.

### Step 5 — Verify keepalive passes

Watch logs for 2–3 minutes:
```bash
make sync-logs
```

You should see:
```
[sync-daemon] keepalive: navigating Tableau…
[sync-daemon] keepalive: navigating Salesforce…
[sync-daemon] keepalive OK
```

### Step 6 — Switch back to headless (no VNC port)

```bash
make sync-down
make sync-up
```

`make sync-up` removes the VNC port — the daemon is now headless again.

---

## How to trigger an immediate sync after re-auth

```bash
make sync-now
```

Results in logs within 30s. Summary email arrives when sync completes (~5–15 min).

---

## How to check status any time

```bash
make sync-logs    # live log stream
make sync-status  # recent log tail + container state
```

Or open Drive → pod bookings folder → `sync-status.json`.

---

## Cookie lifetime

Red Hat SSO cookies typically live 4–10 hours. The 2-hour keepalive timer fires well
within that window, so sessions survive indefinitely as long as the daemon is running.
If the Mac Mini reboots or the container is stopped for more than ~8 hours, the
keepalive fires immediately on restart — if cookies are still valid (within the TTL),
no manual auth is needed. If they've expired, you'll get a keepalive failure email
within 2 hours of the next start.

---

## Recovery checklist

| Symptom | Action |
|---|---|
| `Keepalive Failed` email | `make sync-up-vnc` → re-auth → `make sync-down && make sync-up` |
| `Sync FAILED` email with auth error | Same as above |
| Container not running | `make sync-up` (cookies still valid if down <8h) |
| Mac Mini rebooted | `make sync-up` — launchd plist auto-runs this at login |
| Daemon watchdog email `L3 Sync Daemon DOWN` | `ssh jasonhorn@100.97.86.25` (Tailscale) or `ssh ssh.jasonhorn.io` → `make sync-up` from project root |
