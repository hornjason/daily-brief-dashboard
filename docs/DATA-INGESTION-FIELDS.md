---
Classification: Operational
Last validated: 2026-04-27
Trigger: Any change to scraper, parser, or sheet-reading code
---

# Data Ingestion Field Requirements

Fields required from each source report to power the DailyBrief Dashboard. Organized for IT configuration of nightly report pulls.

**Two categories per report:**
- **Required** — application breaks or gives wrong data without this field
- **Optional / AE reference** — not parsed by the app; kept in the sheet for AE convenience

---

## 1. SF Pipeline Report

**Source:** Salesforce Lightning report (CSV export)
**Cadence:** Daily — data changes frequently

### Required Fields (13)

| # | Column Name | Why Required |
|---|---|---|
| 1 | `Opportunity ID` | Primary dedup key; powers direct Salesforce links in dashboard |
| 2 | `Opportunity Number` | Secondary dedup key; display |
| 3 | `Account Name` | Customer matching and display |
| 4 | `Opportunity Name` | Display; renewal detection (keyword match on "renewal"/"renew") |
| 5 | `ACV Opportunity` | All financial aggregations — pipeline totals, by-stage, by-owner, by-quarter |
| 6 | `Close Date` | Display; quarter derivation; dedup fallback |
| 7 | `Forecast Category` | Stage grouping (Commit / Best Case / Pipeline / Omitted); open vs. closed split |
| 8 | `Opportunity Owner` | Owner breakdown in pipeline summary |
| 9 | `Renewal` | Splits pipeline into renewal vs. new business ACV |
| 10 | `Offering Group` | Display |
| 11 | `Probability (%)` | Display |
| 12 | `Product Description` | Product aggregation per opportunity (multiple rows per opp) |
| 13 | `Opportunity Territory Name` | Routes opportunities to the correct AE when multiple AEs share a report |

### Optional / AE Reference Fields (6)

These columns are written to the Google Sheet but not parsed by the application. Include them if available — AEs use them for their own analysis.

| # | Column Name | Notes |
|---|---|---|
| 14 | `ACV Opportunity Product` | Per-product ACV breakdown |
| 15 | `Close Month` | Convenient grouping |
| 16 | `Opportunity Pod` | POD-level analysis |
| 17 | `Product Code` | SKU-level detail |
| 18 | `Next Steps` | Opportunity context |
| 19 | `Industry` | Account classification |

---

## 2. SF Bookings / Subscriptions Report

**Source:** Salesforce bookings export (pre-shared Google Sheet or direct CSV)
**Cadence:** Daily or weekly — subscription data changes less frequently than pipeline

### Required Fields (11)

| # | Column Name | Why Required |
|---|---|---|
| 1 | `ACCOUNT_NAME` | Customer matching (tier 1 — billing entity, most specific) |
| 2 | `ACCOUNT_SALES_GROUP_NAME` | Customer matching (tier 2 — sales entity, fallback) |
| 3 | `ACCOUNT_GLOBAL_SALES_GROUP_NAME` | Display name shown in the dashboard |
| 4 | `PRODUCT_DESCRIPTION` | Core subscription data — rows without this are skipped entirely |
| 5 | `PRODUCT_QUANTITY` | License count |
| 6 | `OPPORTUNITY_LINE_START_DATE` | Subscription period |
| 7 | `OPPORTUNITY_LINE_END_DATE` | Subscription period; drives Active/Expired status |
| 8 | `PRODUCT_CODE` | SKU identifier |
| 9 | `PRODUCT_FORECAST_OFFERING_GROUP` | Product offering group |
| 10 | `OPPORTUNITY_NAME_H` | CCSP detection — rows where this contains "ccsp" are excluded (captured separately by cloud spend data) |
| 11 | `OPPORTUNITY_TERRITORY_NAME` | Territory filter — scopes rows to each AE's accounts; without this, all AEs see all POD accounts |

**Note on `OPPORTUNITY_NAME_H`:** The report likely calls this column `Opportunity Name` or similar — confirm the exact column header in the report configuration.

---

## 3. CCSP / Cloud Spend Report (Tableau)

**Source:** Tableau Cloud — Overall Cloud Consumption Dashboard, Raw Data view
**Cadence:** Daily — consumption data updates frequently

### Required Fields (7)

| # | Column Name / Pattern | Why Required |
|---|---|---|
| 1 | `Account Name` (also accepted: `Account`, `Customer Name`, `Company`) | Customer matching; validation gate — export is skipped if missing |
| 2 | Any column containing `fiscal year quarter` | Quarter grouping; data filter |
| 3 | `Opportunity Close Date` | Customer brief output |
| 4 | Any column containing `Financial Partner` | Cloud partner grouping (AWS / Google / Microsoft / Other) |
| 5 | `ACV Plus` (also accepted: `ACV+`, `ACVPlus`) | All financial aggregations; validation gate — export is skipped if missing |
| 6 | Column at position 19 (column S in the Raw Data export) | Product offering group — parsed by hardcoded position, not column name |
| 7 | `Account Territory Name` (also accepted: `Account Territory`) | Territory filter — scopes full POD export down to each AE's accounts |

**Important for column 6:** The app reads the product offering group by column position (column S / index 19 in the raw export), not by column name. If the Tableau Raw Data view column order changes, this field will break. Confirm the column is named `Product Offering Group` or similar and is at position S.

**Export format:** The Raw Data view exports ~32 columns. The app accepts all columns — no column filter is applied on ingest. The 7 fields above are the ones the app actually uses.

---

## Summary: Minimum Fields per Report

| Report | Required Fields | Optional Fields |
|---|---|---|
| SF Pipeline | 13 | 6 |
| SF Bookings / Subscriptions | 11 | 0 |
| CCSP / Cloud Spend (Tableau) | 7 | all remaining columns |
