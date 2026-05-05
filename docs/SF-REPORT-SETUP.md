---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-05
---

# Salesforce Pipeline Report Setup

This guide covers how to create the Salesforce Opportunities report used by the dashboard, what columns it requires, and how to schedule a daily automatic refresh.

---

## 1. Create the Report in Salesforce

1. Go to **Reports** in your Salesforce navigation bar.
2. Click **New Report**.
3. Select **Opportunities** as the report type and click **Continue**.
4. In the report editor, add the following columns (exact names matter):

### Required Columns

| Column Name | Notes |
|---|---|
| **Opportunity Name** | Required |
| **Account Name** | Required |
| **Amount** | Annual Contract Value (ACV) |
| **Stage** | Pipeline stage (Prospecting, Proposal, Closed Won, etc.) |
| **Forecast Category** | Pipeline / Best Case / Commit / Closed |
| **Close Date** | Expected close date |
| **Opportunity Owner** | Full name of the AE (must match the AE name in the dashboard) |

5. Add filters as needed — recommended:
   - **Stage** does not equal *Closed Lost*
   - **Opportunity Owner** equals your AE(s) or territory

6. Save the report with a descriptive name (e.g., *ASA West Pipeline - Q2 2026*).

---

## 2. Find the Report ID or URL

After saving, copy the URL from your browser address bar. It looks like:

```
https://yourorg.lightning.force.com/lightning/r/Report/00OPe000001abcDEF/view
```

You can paste either:
- The **full Lightning URL** (the dashboard strips the ID automatically), or
- The **bare Report ID** (`00OPe000001abcDEF`)

---

## 3. Schedule Daily Automatic Refresh

Salesforce caches report data. To ensure the dashboard always has fresh pipeline data each morning:

1. Open the report in Salesforce.
2. Click **Subscribe** (top-right, next to Run Report).
3. Set the schedule:
   - **Frequency**: Daily
   - **Time**: 6:00 AM (or 1–2 hours before your morning brief)
   - **Recipients**: Add your own email (the run itself refreshes the cache)
4. Click **Save**.

The subscription causes Salesforce to run the report on schedule, refreshing the cached data that the dashboard scraper reads.

---

## 4. Dashboard Sync

Once the report ID is configured:
- Go to **Setup → Salesforce** and click **Connect**.
- After a successful connection, click **Sync Now** or wait for the automatic overnight sync.
- Pipeline data appears in the **Pipeline** section of each customer detail page.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Report not found" error | Verify the report ID starts with `00O` and is 15–18 characters |
| Pipeline shows 0 opportunities | Check that Stage filter isn't excluding all records; verify AE name matches exactly |
| Data is stale | Confirm Salesforce subscription is active and ran this morning |
| "Opportunity Owner" column missing | Add the field in the Salesforce report builder under **Columns** |
