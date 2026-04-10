# Adding a New AE — Runbook

Complete flow for onboarding a new Account Executive into the DailyBriefDashboard.

---

## Prerequisites

- Google OAuth token with bootstrap scopes (`BOOTSTRAP_SCOPES` — includes Drive write)
- Territory sheet populated with the AE's customer list
- SF Bookings sheet for the AE's POD uploaded to the shared Drive folder (`podBookingsFolderId`)
- RH Portal session active (for case scraping and account discovery)
- Salesforce session active (for pipeline sync)

---

## Bootstrap Wizard (auto-runs all steps)

The setup wizard (`/dashboard/setup`) triggers `bootstrap-orchestrator.ts` which runs 6 steps sequentially:

### Step 0: Create AE Drive folder
- Creates `{AE Name}/` subfolder under the configured parent Drive folder
- If folder already exists (re-bootstrap), reuses it
- Stores `driveFolderId` in `aes.json`

### Step 1: Create per-customer Drive folders
- Creates `{Customer Name}/` subfolder for each customer under the AE folder
- Uses `normalizeCustomerName()` to strip legal suffixes (Inc, LLC, Corp), state codes, parentheticals
- Stores `driveFolderId` on each `Customer` entry in `customers.json`
- Idempotent: existing folder IDs reused on re-runs

### Step 2: Read SF Bookings Sheet
- Reads the POD SF Bookings sheet from the shared Drive folder
- Matches sheet to AE's territory by file name (word-level match against `tableauTerritories`)
- Derives customer list with subscription data and canonical aliases
- Saves customers and aliases to `customers.json`
- Account numbers are NOT discovered here — the RH Cases scraper handles that asynchronously post-bootstrap

### Step 3: Write Subscriptions Sheet
- Subscription rows from SF Bookings written to a Google Sheet per AE
- One tab per customer
- Stores sheet ID in `aes.json`

### Step 4: CCSP Sheet
- Creates a CCSP cloud spend sheet in the AE's Drive folder
- Stores `ccspSheetId` in `aes.json`

### Step 5: SF Pipeline sync
- Creates/updates the Pipeline Google Sheet using the AE's Salesforce report
- Stores `pipelineSheetId` in `aes.json`
- Populates local pipeline cache (`data/cache/pipeline-data.json`)

---

## Post-Bootstrap Auto-Triggers (non-blocking)

These fire automatically after bootstrap completes — no manual action needed:

### Domain inference
- Runs for all new customers immediately after bootstrap
- Infers customer email domains from name + public data
- High-confidence results auto-saved to `customers.json`

### Account Intelligence batch
- Triggered via `POST /api/intelligence/generate-all`
- Runs ~10 minutes per customer (Gemini with Google Search grounding)
- Three steps per customer:
  1. Industry/segment classification
  2. Company brief + industry analysis
  3. Drive docs write (dual-write: Drive document + local JSON cache)
- Monitor progress: `GET /api/intelligence/generate-all/status`

---

## What Does NOT Auto-Run

### RH Cases + Account Discovery
- The RH Cases scraper discovers account numbers post-bootstrap by searching RH Portal sidebar autocomplete using the customer's canonical alias (from SF Bookings)
- Picks up new accounts at the next scheduled run (default: every 4 hours, heartbeat interval)
- For same-day data: Admin page → RH Cases → "Run Now"

### Customer Briefs
- Generated on-demand when a user opens the customer detail page
- 4-hour cache TTL (ADR-009)
- Auto-invalidates when source sheet data is newer than cached brief
- No manual trigger needed — just visit the page

### NotebookLM
- Manual trigger only via Admin page
- Requires `NOTEBOOKLM_ENABLED=true` environment variable
- Not part of any automated pipeline

---

## Validation Checklist

After bootstrap completes, verify:

1. **aes.json** has the new AE entry with:
   - `driveFolderId` (AE's Drive folder)
   - `ccspSheetId` (CCSP sheet)
   - `pipelineSheetId` (Pipeline sheet)

2. **customers.json** has customer entries with:
   - `aliases` array populated (from SF Bookings — canonical SF account names)
   - `driveFolderId` set (per-customer Drive folder)
   - `accountNumbers` may be empty initially — populated asynchronously by the RH Cases scraper

3. **Intelligence pipeline running:**
   ```bash
   curl http://localhost:7777/api/intelligence/generate-all/status
   ```
   Should show `running` or `completed` status.

4. **Customer brief generates on page view:**
   - Open any customer detail page in the dashboard
   - Brief should generate automatically (first load takes ~30 seconds)

5. **RH Cases (if needed same-day):**
   - Admin page → RH Cases section → click "Run Now"
   - Or wait for next scheduled heartbeat tick

---

## Troubleshooting

### Bootstrap fails at SF Bookings step
- Verify the SF Bookings sheet exists in the shared Drive folder (`podBookingsFolderId` in `settings.json`)
- Verify the sheet file name contains the territory word (e.g. "Northwest" for NORTHWEST territory)
- Check required columns exist (see SF Bookings section in `docs/ARCHITECTURE.md`)

### Account numbers not populating after bootstrap
- Account discovery is asynchronous — the RH Cases scraper discovers them via RH Portal sidebar autocomplete
- Verify RH Portal session is active (check VNC at localhost:6080)
- Run Admin page → RH Cases → "Run Now" for immediate discovery
- Check `customers.json` — the `aliases` field must be populated (from SF Bookings) for discovery to work

### Intelligence pipeline shows errors
- Verify `GEMINI_SA_KEY_B64` environment variable is set
- Check `GET /api/intelligence/generate-all/status` for per-customer error messages
- Common: missing imports in `account-intelligence.ts` (fixed 2026-04-06 — `makeAuth` and `google` imports were missing)

### CCSP sheet shows $0 / empty
- The Sheets API service account can only access sheets it created
- Run a full CCSP scrape from Admin panel first (creates service-account-owned sheet)
- Then Setup page "CCSP Sync Now" will work
- See BKL-SCRAPER-02 and BKL-SCRAPER-03 for known issues

### Note on Supportable 360
Supportable 360 is **disabled** and not used anywhere in the current system. Account discovery uses the RH Portal sidebar autocomplete. Subscription data comes from SF Bookings sheets. Do not attempt to enable or call Supportable endpoints.
