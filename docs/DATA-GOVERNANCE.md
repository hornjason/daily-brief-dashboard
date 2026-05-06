---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Daily Brief Dashboard — Data Governance Overview
*Last validated: 2026-05-06 | Owner: DA | Trigger: Review and update on any structural change to this doc*

**Status:** OPERATIONAL | **Owner:** Jason Horn (jhorn@redhat.com) | **Last updated:** 2026-04-13
**Audience:** Red Hat Data Governance, IT Security, and Data Platform teams

---

## Purpose of This Document

This document describes every data source the Daily Brief Dashboard touches, what data is accessed, how it is accessed, where it lands, and how long it is retained. It is intended to support an internal data governance review and to identify where the current browser-automation access model could be replaced with more secure, auditable API or report-based integrations.

---

## 1. What This Tool Is

The Daily Brief Dashboard is a personal productivity tool for Red Hat Account Executives (AEs) and Solution Architects (SAs). It aggregates customer-facing data from multiple Red Hat and Google systems into a single view so that AEs and SAs are prepared for every customer conversation.

**Key architectural facts relevant to governance:**

- Runs entirely on the user's local machine as a container (`podman` / `docker`)
- No SaaS backend, no shared server, no cloud database
- All scraped data is stored locally (`./data/`) or in the user's own Google Sheets (under their `@redhat.com` account)
- The dashboard is only accessible at `localhost:7777` — not exposed to the network by default
- No data is transmitted to third parties outside of the API calls to systems the user already has authorized access to

---

## 2. Data Flow Architecture

Data moves through three stages before reaching the dashboard UI:

```
┌──────────────────────────────────────────────────────────────────┐
│  STAGE 1 — SOURCE SYSTEMS                                        │
│  Red Hat Customer Portal · Salesforce · Tableau (CCSP)          │
│  Gmail · Google Calendar · Territory Sheet · Gemini/Vertex AI   │
└────────────────────────┬─────────────────────────────────────────┘
                         │  Playwright browser automation
                         │  + Google APIs (OAuth)
                         │  + RH Portal REST API (offline token)
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  STAGE 2 — INTERMEDIATE STORAGE (Google Sheets, user-owned)      │
│  "Supportable — {AE Name}"  ·  "{AE Name} CCSP"                 │
│  "{AE Name} Pipeline"                                            │
│  Owned by the user's @redhat.com Google account                  │
└────────────────────────┬─────────────────────────────────────────┘
                         │  Google Sheets API reads
                         │  (background timer, every 4h / 24h)
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  STAGE 3 — LOCAL CACHE (host machine only)                       │
│  rh-cases.json · sheet-cache-*.json · ccsp-data.json            │
│  pipeline-data.json · brief-{customer}.json                      │
│  Stored at: ./data/cache/ (bind-mounted into container)          │
└────────────────────────┬─────────────────────────────────────────┘
                         │  In-process reads, SSE push to browser
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  STAGE 4 — DASHBOARD UI (localhost:7777 only)                    │
│  React app served from the container                             │
│  Accessible only to the user on their local machine              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Sources Inventory

### 3.1 Red Hat Customer Portal (Support Cases)

| Attribute | Detail |
|---|---|
| **What data** | Open support case number, summary/title, severity (1–4), status, last updated date |
| **Data classification** | Customer Confidential |
| **Access method** | RH Portal REST API (`/hydra/rest/search/v2/cases`) using RH Offline Token |
| **Auth mechanism** | Red Hat Offline Token (user-generated at access.redhat.com/management/api) |
| **Frequency** | Every 4 hours (configurable) |
| **Where it lands** | `data/cache/rh-cases.json` — local machine only |
| **Retention** | Overwritten on each refresh; no history retained |
| **What leaves the machine** | Only the API request to access.redhat.com (same call an SA would make manually via the portal) |
| **Current access model** | REST API — already the preferred approach |
| **Account discovery note** | Account numbers are discovered via RH Portal sidebar autocomplete (`POST /api/scrape/rh`) using browser automation. This is a known gap — see §6. |

---

### 3.2 Salesforce (Pipeline Opportunities)

| Attribute | Detail |
|---|---|
| **What data** | Opportunity name, account name, close date, ACV ($), pipeline stage, opportunity number |
| **Data classification** | Red Hat Confidential — Commercial |
| **Access method** | Browser automation (Playwright) — navigates to a Salesforce report URL and scrapes the rendered table |
| **Auth mechanism** | Salesforce SAML SSO via existing browser session (user's @redhat.com SSO) |
| **Frequency** | Daily at 6am ET (hardcoded) + on-demand via Setup page |
| **Where it lands** | User-owned Google Sheet (`{AE Name} Pipeline`) → `data/cache/pipeline-data.json` |
| **Retention** | Sheet is overwritten on each sync; cache is overwritten on each read |
| **What leaves the machine** | Nothing — data flows from Salesforce to a Google Sheet in the user's own Drive |
| **Current access model** | UI scraping via Playwright — **fragile; flagged for replacement** (see §6) |
| **Requested replacement** | Direct Salesforce Connected App API or scheduled report export (CSV/JSON) |

---

### 3.3 Tableau / CCSP (Cloud Consumption Spend)

| Attribute | Detail |
|---|---|
| **What data** | Cloud consumption spend per customer account (Red Hat CCSP program data) |
| **Data classification** | Customer Confidential — Commercial |
| **Access method** | Browser automation (Playwright) — navigates Tableau dashboard, applies territory filter, exports data |
| **Auth mechanism** | Red Hat SSO session (shared browser context from RH Portal login) |
| **Frequency** | On bootstrap + every 24 hours |
| **Where it lands** | User-owned Google Sheet (`{AE Name} CCSP`) → `data/cache/ccsp-data.json` |
| **Retention** | Sheet and cache overwritten on each sync |
| **What leaves the machine** | Nothing — data moves from Tableau to user's own Google Sheet |
| **Current access model** | UI scraping via Playwright — **fragile; flagged for replacement** (see §6) |
| **Requested replacement** | Tableau REST API or scheduled CSV export from the CCSP data source |

---

### 3.4 Gmail (Customer Emails)

| Attribute | Detail |
|---|---|
| **What data** | Email subject, sender address, date, thread ID — only emails where sender/recipient domain matches a known customer. Internal @redhat.com emails are explicitly excluded. |
| **Data classification** | Customer Confidential — may contain PII (contact names, email addresses) |
| **Access method** | Gmail API (`users.messages.list`) via Google OAuth |
| **Auth mechanism** | Google OAuth 2.0 — user authorizes scopes: `gmail.readonly` |
| **Frequency** | On dashboard load and when Customer Detail page is opened |
| **Where it lands** | In-process only — not written to disk. Served directly to the UI. |
| **Retention** | Not persisted. Each request fetches live from Gmail API. |
| **What leaves the machine** | Only the API request to Google (Gmail API). The user's own Google OAuth token is used. |
| **Current access model** | Official Google API — preferred approach, no concerns |

---

### 3.5 Google Calendar (Customer Meetings)

| Attribute | Detail |
|---|---|
| **What data** | Event title, attendee email addresses, start/end time, organizer — only events where at least one attendee domain matches a known customer |
| **Data classification** | Internal / Customer Confidential — attendee list may constitute PII |
| **Access method** | Calendar API (`events.list`) via Google OAuth |
| **Auth mechanism** | Google OAuth 2.0 — user authorizes scope: `calendar.readonly` |
| **Frequency** | On dashboard load and when Customer Detail page is opened |
| **Where it lands** | In-process only — not written to disk |
| **Retention** | Not persisted |
| **What leaves the machine** | Only the API request to Google (Calendar API) |
| **Current access model** | Official Google API — preferred approach, no concerns |

---

### 3.6 Google Drive / Sheets (Intermediate Storage + Config)

| Attribute | Detail |
|---|---|
| **What data** | Three types: (1) Scraped subscription/pipeline/CCSP data written during bootstrap; (2) Territory sheet (read-only, Red Hat-owned); (3) AE folder structure + Drive folder IDs |
| **Data classification** | Varies by sheet content — Commercial/Customer Confidential for scraped data; Red Hat Internal for territory sheet |
| **Access method** | Google Sheets API and Drive API via Google OAuth |
| **Auth mechanism** | Google OAuth 2.0 — user authorizes scopes: `drive`, `sheets` |
| **Frequency** | Sheets written on each scrape; read by background timers (every 4h / 24h) |
| **Where it lands** | User-owned Google Drive (under user's @redhat.com account). No shared drive. |
| **Retention** | Sheets persist until user deletes them. Overwritten on each sync. |
| **What leaves the machine** | Data is written to the user's own Google Drive. No external party has access unless the user shares the sheet manually. |
| **Current access model** | Official Google API — intermediate storage is intentional design for human-readability and auditability |

---

### 3.7 Territory Sheet (AE → Territory Mapping)

| Attribute | Detail |
|---|---|
| **What data** | AE names, territory numbers, POD assignments — read-only; no customer data |
| **Data classification** | Red Hat Internal |
| **Access method** | Google Sheets API (read-only) |
| **Auth mechanism** | Google OAuth 2.0 |
| **Frequency** | On bootstrap / AE setup |
| **Where it lands** | Not cached — used only during bootstrap to resolve AE-to-territory mapping |
| **Retention** | Not persisted locally |
| **What leaves the machine** | Nothing — read-only API call to an existing RH-owned Sheet |
| **Current access model** | Official Google API — no concerns |

---

### 3.8 Gemini / Vertex AI (AI Brief Generation)

| Attribute | Detail |
|---|---|
| **What data** | Customer name, open case summaries, subscription data, cloud spend, pipeline stage — assembled into a prompt for brief generation |
| **Data classification** | Customer Confidential — the prompt contains aggregated customer data |
| **Access method** | Vertex AI REST API (`generateContent`) |
| **Auth mechanism** | GCP service account (shared, managed by jhorn@redhat.com) or user's own GCP project via OAuth |
| **Frequency** | On-demand only — user clicks "Generate Brief" on Customer Detail page |
| **Where it lands** | Generated text cached at `data/cache/brief-{customer}.json` — local machine only |
| **Retention** | Cache file persists until manually cleared or container data directory is removed |
| **What leaves the machine** | The prompt (customer name + aggregated data fields) is sent to Google Cloud Vertex AI. The response is returned and cached locally. **This is the only external transmission of aggregated customer data.** |
| **Data sent to Gemini** | Customer name, case count + severity summary, subscription tier (not raw contract data), pipeline stage — no PII, no contact info, no email content |
| **GCP project** | `jhorn-pai` (default shared project) or user's own project if `GOOGLE_CLOUD_PROJECT` is set in `.env` |
| **Current access model** | Official Vertex AI API. Gemini API is permitted at Red Hat. |

---

## 4. Configuration and Credential Storage

All configuration lives in `./data/config/` on the host machine:

| File | Contents | Sensitivity |
|---|---|---|
| `aes.json` | AE names, territories, Google Sheet IDs, SF report IDs | Red Hat Internal |
| `customers.json` | Customer names, RH Portal account numbers | Red Hat Internal |
| `data-sources.json` | Refresh intervals, feature flags | Internal |
| `rh-profile/Default/` | Chromium cookies for RH Portal SSO session | Sensitive — SSO session tokens |
| `google-oauth-tokens.json` | Google OAuth refresh + access tokens | Sensitive — grants access to Drive, Gmail, Calendar |
| `gcp-oauth.keys.json` | OAuth client ID/secret for GCP | Sensitive — must not be shared |

**These files live only on the user's local machine.** They are not synced to any cloud service by this application.

---

## 5. Data Residency Summary

| Data Type | Resides In | Accessible By |
|---|---|---|
| Support cases | Local machine only | User only (localhost) |
| Pipeline opportunities | User's Google Drive (Sheet) + local cache | User only |
| Cloud spend | User's Google Drive (Sheet) + local cache | User only |
| Email summaries | In-process only (not persisted) | User only |
| Calendar events | In-process only (not persisted) | User only |
| AI briefs | Local machine only | User only |
| Config + credentials | Local machine only | User only |

**No data is transmitted to:**
- Any third-party analytics service
- Any shared database or server
- Any service the user does not already have authorized access to

---

## 6. Current Limitations and Risks

### 6.1 Browser Automation (Playwright Scraping)

Two data sources — **Salesforce** and **Tableau/CCSP** — are accessed via browser automation rather than APIs. The scraper launches a headless Chromium browser, logs in via SSO, navigates to the relevant report or dashboard, and extracts data from the rendered page.

**Governance concerns with this approach:**

| Risk | Description |
|---|---|
| **Session token exposure** | Browser session cookies are stored in `data/rh-profile/` on disk. An SSO session token for Salesforce or Tableau stored on disk is a credential that could be misused if the machine is compromised. |
| **No audit trail** | Browser-based access is indistinguishable from a user manually navigating in a browser. There is no API access log or token-scoped audit record. |
| **Fragility** | UI scraping breaks when Salesforce or Tableau updates their UI. This causes data gaps and requires manual intervention. |
| **Rate limits and detection** | Automated browser sessions can trigger bot detection or account lockouts. |
| **Shared browser context** | All scrapers share a single browser context (a design requirement for Tableau SSO). This means one scraper's authentication state is also visible to all others. |

### 6.2 Account Number Discovery

RH Portal account numbers are currently discovered by automating a search in the RH Portal sidebar. This is also browser automation. The desired replacement is a supported API for account lookup by customer name.

### 6.3 No Access Scoping on Google OAuth

The current OAuth grant requests broad `drive` scope. A narrower scope (`drive.readonly` for reading, specific sheet ID access) would reduce the blast radius of a compromised token.

---

## 7. Requested Data Source Improvements

The following replacements would eliminate browser automation dependencies, improve reliability, and produce a proper audit trail:

| Current (fragile) | Requested replacement | Benefit |
|---|---|---|
| Playwright scrape of Salesforce report UI | Salesforce Connected App with OAuth 2.0, or a scheduled report export (CSV) delivered to a known location | Auditable, stable, token-scoped |
| Playwright scrape of Tableau CCSP dashboard | Tableau REST API or scheduled CSV export from the CCSP data pipeline | No UI dependency, faster, auditable |
| Browser-based RH Portal account number discovery | REST API endpoint: account lookup by customer name (the portal already exposes this via sidebar autocomplete — a supported equivalent would suffice) | Removes SSO cookie dependency for discovery |
| Shared GCP service account for AI briefs | User's own GCP service account or Red Hat-approved Gemini endpoint | Each user's AI calls are independently auditable |

---

## 8. What This Tool Does NOT Do

To be explicit about scope boundaries:

- Does **not** store or transmit customer PII (contact names, phone numbers, addresses)
- Does **not** write to Salesforce, the RH Portal, or Tableau
- Does **not** share data between users — each instance is fully isolated to one user's machine
- Does **not** connect to a central server or phone home
- Does **not** retain email content — only subject lines and sender domains are used
- Does **not** use customer data to train any AI model (Vertex AI/Gemini inference only)
- Does **not** expose the dashboard to the network (bound to `localhost` only)

---

## 9. Questions This Document Is Designed to Answer

| Question | Answer |
|---|---|
| Where does customer data go? | Local machine + user's own Google Drive. Never to a shared server. |
| Does any customer data leave Red Hat's control? | AI brief generation sends aggregated (not raw) customer data to Vertex AI (Google Cloud). All other data stays within Red Hat's Google Workspace or on the user's machine. |
| Who can access the dashboard? | Only the user, on their local machine. No authentication is required because the app is not network-accessible. |
| Is any data retained long-term? | Cached data is overwritten on each refresh. AI briefs persist until manually cleared. Config and credentials persist until the user removes the data directory. |
| What happens if the machine is compromised? | SSO cookies and OAuth tokens stored in `./data/` would be exposed. This is the primary security risk of the current design. Replacing browser automation with scoped API tokens would reduce this surface significantly. |
| Is this compliant with Red Hat's data handling policies? | That is the purpose of this review. The intent is full compliance — the tool only accesses data the user is already authorized to access, and data does not leave the user's control except for Vertex AI inference calls. |

---

*Owner: Jason Horn (jhorn@redhat.com) | Questions or concerns: email directly*
