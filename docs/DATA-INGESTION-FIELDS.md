---
Classification: Operational
Last validated: 2026-04-23
Trigger: Any change to scraper, parser, or sheet-reading code
---

# Data Ingestion Field Inventory

Complete inventory of every field read during data ingestion, organized by data source. Each field is classified by where it enters the system, whether the application actively consumes it, and what consumes it.

**Definitions:**
- **Scraped** = field exists in the raw source system (Salesforce report, Tableau CSV, SF Bookings GSheet)
- **Kept** = field survives filtering and is written to the intermediate Google Sheet
- **Parsed** = field is read from the Google Sheet by the Stage 2 parser into a typed record
- **Consumed** = field is used by dashboard UI, customer brief XML, or business logic

---

## 1. SF Pipeline (Salesforce Lightning Report → Google Sheet → PipelineRecord)

**Source:** Salesforce Lightning report (CSV export or DOM scrape)
**Scraper:** `src/sf-scraper.ts` — `scrapeSfReport()`
**Intermediate:** Google Sheet `{AE Name} Pipeline`, tab `Pipeline`
**Parser:** `src/pipeline.ts` — `parsePipelineRows()`
**Cache:** `data/cache/pipeline-data.json`
**API:** `GET /api/pipeline`
**Dashboard type:** `PipelineOpp` (dashboard/src/types.ts:90-103)

### Field Matrix

| # | Source Report Column | KEEP_COLS (CSV) | KEEP_COLS (DOM) | Parsed into PipelineRecord | Consumed By |
|---|---|---|---|---|---|
| 1 | `Opportunity ID` | YES | YES | `oppId` (string, optional) | Dashboard: direct SF link; Dedup key (primary) |
| 2 | `Opportunity Number` | YES | YES | `oppNumber` (string) | Dashboard: display; Dedup key (secondary) |
| 3 | `Account Name` | YES | YES | `accountName` (string) | Dashboard: display; Customer brief XML; Dedup key (tertiary) |
| 4 | `Opportunity Name` | YES | YES | `oppName` (string) | Dashboard: display; Customer brief XML line 907; Renewal detection (keyword match) |
| 5 | `ACV Opportunity` | YES | YES | `acv` (number, stripped of $,) | Dashboard: display + all ACV aggregations; Brief XML; Summary: totalAcv, renewalAcv, newAcv, byStage, byOwner, byQuarterStage, topOpps, techWinsNeeded |
| 6 | `Close Date` | YES | YES | `closeDate` (string, ISO date) | Dashboard: display; Brief XML; Summary: byQuarterStage quarter derivation; Dedup key (tertiary) |
| 7 | `Forecast Category` | YES | YES | `forecastCategory` (string) | Dashboard: display + stage grouping; Brief XML; Summary: byStage, open/closed split, byQuarterStage (Commit/Best Case/Pipeline) |
| 8 | `Opportunity Owner` | YES | YES | `owner` (string) | Dashboard: display; Summary: byOwner |
| 9 | `Renewal` | YES | YES | `renewal` (boolean) | Dashboard: display; Summary: renewalAcv vs newAcv split |
| 10 | `Offering Group` | YES | YES | `offeringGroup` (string) | Dashboard: display |
| 11 | `Probability (%)` | NOT in KEEP_COLS* | NOT in KEEP_COLS* | `probability` (number) | Dashboard: display |
| 12 | `Product Description` | YES | YES | `products` (string[], aggregated per opp) | Dashboard: display |
| 13 | `Opportunity Territory Name` | YES | YES | `territory` (string, optional) | AE matching (BKL-SF-01): routes opps to correct AE |
| 14 | `ACV Opportunity Product` | YES (CSV only) | NO | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet |
| 15 | `Close Month` | YES (CSV only) | NO | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet |
| 16 | `Opportunity Pod` | YES | YES | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet |
| 17 | `Product Code` | YES | YES | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet |
| 18 | `Next Steps` | YES (CSV only) | NO | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet |
| 19 | `Industry` | YES (CSV only) | NO | **NOT PARSED** — kept in sheet only | AE reference in Google Sheet (note: `industry` in customer.ts is a separate AI-generated field from Account Intelligence, not this column) |

*`Probability (%)` is not in either KEEP_COLS set but IS parsed by `parsePipelineRows()` at line 108. It passes through when the report has fewer than 3 KEEP_COLS matches (the fallback "pass all columns through" path), or when it's already in the sheet from a previous scrape that included it.

### Pipeline Parser Logic Notes
- **Dedup:** Two passes. First pass aggregates `products[]` and `renewal` per opp (key: oppId → oppNumber → `{accountName}|{oppName}|{closeDate}`). Second pass emits one record per unique key.
- **Renewal detection:** `true` if ANY product row has Renewal = `1`/`true`/`yes`/contains "included" (not "not included"), OR if opp name matches `/\brenewal\b|\brenew\b/`.
- **Sheet range read:** `Pipeline!A1:Z5000` (26 columns, 5000 rows max)

---

## 2. CCSP (Tableau Cloud → Google Sheet → CCSPRecord)

**Source:** Tableau Cloud — Overall Cloud Consumption Dashboard, Raw Data view
**Scraper:** `src/ccsp-scraper.ts` — `runCcspScrape()` → `scrapeOneAe()`
**Intermediate:** Google Sheet `{AE Name} CCSP`, tab `CCSP Data`
**Parser:** `src/sheets.ts` — `fetchCCSPData()`
**Cache:** `data/cache/ccsp-data.json`
**API:** `GET /api/ccsp`
**Dashboard type:** `CCSPSummary` → `CCSPCustomer`, `CCSPQuarter`, `CCSPPartner`, `CCSPByAE` (dashboard/src/types.ts:57-88)

### Tableau Raw Data View — Full Column Set (~32 columns)

The CCSP scraper writes **ALL columns from the Tableau CSV** to the Google Sheet. There is no column filter (unlike Pipeline's KEEP_COLS). The exact columns depend on the Tableau view configuration, but the following are the columns actively used by the application:

| # | Tableau CSV Column | Used in Scraper | Parsed into CCSPRecord | Consumed By |
|---|---|---|---|---|
| 1 | `Account Name` (also: `Account`, `Customer Name`, `Company`) | YES — validation gate (line 1286-1288) | `accountName` (string) | Dashboard: byCustomer display; Brief XML |
| 2 | `Opportunity fiscal Year Quarter` (any header containing "fiscal year quarter") | YES — post-download quarter filter (line 730-737) | `quarter` (string, e.g. "2025-Q1") | Dashboard: byQuarter display; Brief XML |
| 3 | `Opportunity Close Date` (exact match, case-insensitive) | NO scraper logic | `closeDate` (string) | Brief XML |
| 4 | Column containing `Financial Partner` | NO scraper logic | `cloudPartner` (string, normalized to AWS/Google/Microsoft/Other) | Dashboard: byPartner display; Brief XML |
| 5 | `ACV Plus` (also: `ACV+`, `ACVPlus`) | YES — validation gate (line 1290-1293) | `acvPlus` (number, stripped of $,) | Dashboard: all ACV aggregations; Brief XML |
| 6 | Column at index 18 (column S) | NO scraper logic | `productOfferingGroup` (string, optional) | Stored in CCSPRecord but not currently rendered in dashboard |
| 7 | `Account Territory Name` (also: `Account Territory`) | YES — **critical** post-download territory filter (lines 714-727, 417-425, 487-493) | **NOT in CCSPRecord** — consumed by scraper only | Filters full POD data down to each AE's territory. Without this column, all AEs get all POD accounts. |

### Tableau Filter Parameters (applied before CSV download)

These are not data columns — they're URL filter parameters that scope the Tableau viz before data export. They determine what rows appear in the CSV:

| Filter Parameter | Value | Source |
|---|---|---|
| `Super Geo` | `AMERICAS` | Hardcoded |
| `Geo` | `NA_COMM` | Hardcoded |
| `Region` | Derived from `parseTerritoryParts()` | AE's `tableauTerritories` in aes.json |
| `Segment` | `Commercial` or `Enterprise` | Derived from territory string |
| `Subsegment` | Same as Segment | Derived from territory string |
| `Year` | Rolling FY window (e.g. `FY2025,FY2026`) | `getRollingFyWindow()` — last 4 completed calendar quarters |
| `Quarter` | Rolling quarters (e.g. `2025-Q2,2025-Q3,2025-Q4,2026-Q1`) | Same function |
| `Subregion` | Derived from territory | e.g. `WEST_COMM_CORP` |
| `POD` | Derived from territory | e.g. `WEST_COMM_CORP_NORTHWEST_POD` |

**Note:** `Account Territory` filter is NOT applied in the URL (BKL-CCSP-CSV-01: Tableau's .csv endpoint returns empty when territory filter is applied). Territory filtering happens client-side after download.

### Validation Gates
- Sheet write requires BOTH an account name column AND an ACV column, or write is skipped to protect existing data (BKL-M51)
- If either is missing, the scraper likely got the summary view (~4 cols) instead of Raw Data (~32 cols)

### Parser Notes
- **Sheet range read:** `'CCSP Data'!A:AM` (39 columns)
- **Column detection is flexible/case-insensitive** — uses `.findIndex()` with multiple fallback patterns per field
- `productOfferingGroup` is read by **hardcoded column index 18** (not by header name) — fragile if Tableau column order changes
- `ae` field is set from the caller's AE map, not from sheet data

---

## 3. SF Bookings / Subscriptions (Salesforce Bookings GSheet → SupportableResult → Per-Customer Sheet)

**Source:** Pre-exported Salesforce bookings Google Sheet (shared POD-level sheet, not scraped by Playwright)
**Reader:** `src/sf-bookings-reader.ts` — `fetchSfBookingsRaw()` + `mapSfBookingsToCustomers()` / `deriveSfCustomersByTerritory()`
**Intermediate:** Per-AE Google Sheet `{AE Name} Supportable`, per-customer tabs
**Parser:** `src/sheets.ts` — `fetchCustomerSheetData()` → `normalizeElmerFormat()` or `normalizeFlatFormat()`
**Cache:** `data/cache/sheet-cache-*.json`
**API:** `GET /api/customer/:name/subscriptions`
**Dashboard type:** `ProductSubscription` (dashboard/src/types.ts:1-8)

### Stage 1: SF Bookings GSheet Columns Read

These are the columns read from the shared POD-level SF Bookings sheet:

| # | SF Bookings Column | Index Variable | Maps To (Supportable format) | Purpose |
|---|---|---|---|---|
| 1 | `ACCOUNT_NAME` | `acctIdx` | Row matching (tier 1 — most specific billing entity) | Customer identification — preferred match |
| 2 | `ACCOUNT_SALES_GROUP_NAME` | `salesIdx` | Row matching (tier 2 — sales entity) | Customer identification — fallback |
| 3 | `ACCOUNT_GLOBAL_SALES_GROUP_NAME` | `globalIdx` | `Name` field in Supportable row | Display name in output; grouping in deriveSfCustomersByTerritory |
| 4 | `PRODUCT_DESCRIPTION` | `prodDescIdx` | `Product Description` | Core subscription data — rows without this are skipped |
| 5 | `PRODUCT_QUANTITY` | `qtyIdx` | `Quantity` | License count |
| 6 | `OPPORTUNITY_LINE_START_DATE` | `startIdx` | `Start Date` | Subscription period |
| 7 | `OPPORTUNITY_LINE_END_DATE` | `endIdx` | `End Date` | Subscription period + active/expired derivation |
| 8 | `PRODUCT_CODE` | `skuIdx` | `Internal Sku` | SKU identifier |
| 9 | `PRODUCT_FORECAST_OFFERING_GROUP` | `offeringIdx` | `Ordered Item` | Product offering group |
| 10 | `OPPORTUNITY_NAME_H` | `oppNameIdx` | **NOT mapped** — used for CCSP detection only | Rows where this contains "ccsp" are **skipped** (captured by CCSP scraper instead) |
| 11 | `OPPORTUNITY_TERRITORY_NAME` | `territoryIdx` | **NOT mapped** — used for territory filtering only | Filters rows to AE's `tableauTerritories` — eliminates cross-AE false matches |

**Derived field:** `Status` = `endDate > today` → `Active`, else `Expired` (not from a source column)

**Sheet read range:** `A1:AE5000` (31 columns, 5000 rows)

### Stage 2: Per-Customer Supportable Sheet Columns Read

After SF Bookings writes per-customer tabs, the Stage 2 reader (`sheets.ts`) reads them back using two format normalizers:

#### Elmer Format (two-row parent/child per subscription)

| # | Sheet Column | Parsed into ProductSubscription | Notes |
|---|---|---|---|
| 1 | `Subscription#` | *grouping key* (not in output) | Groups parent/child row pairs |
| 2 | `SKU` | `sku` (string, `--` prefix stripped from parent) | Parent row has `--` prefix; child row has real SKU |
| 3 | `Product Description` | `productDescription` (string) | From parent row |
| 4 | `Qty` | `quantity` (number) | From child row |
| 5 | First column starting with `Status` | `status` (string) | From parent row |
| 6 | `Start Date` | `startDate` (string, optional) | From parent row |
| 7 | `End Date` | `endDate` (string, optional) | From parent row |

#### Flat Format (one row per subscription — this is what SF Bookings writes)

| # | Sheet Column | Parsed into ProductSubscription | Notes |
|---|---|---|---|
| 1 | `Internal Sku` (preferred) or `Ordered Item` | `sku` (string) | Tries `Internal Sku` first, falls back to `Ordered Item` |
| 2 | `Product Description` | `productDescription` (string) | Required — rows without this are skipped |
| 3 | `Quantity` (preferred) or `Qty` | `quantity` (number) | Case-insensitive match |
| 4 | First column starting with `Status` | `status` (string) | Case-insensitive prefix match |
| 5 | `Start Date` | `startDate` (string, optional) | |
| 6 | `End Date` | `endDate` (string, optional) | |
| 7 | `Name` | *customer filter* (not in output) | Only used when tab has multiple customers — filters rows by customer name token match |

### Supportable Sheet Full Column Set (CSV_HEADERS)

The SF Bookings reader writes these columns to the per-customer Supportable sheet. Many are empty placeholders carried over from the legacy Supportable format:

| # | Column Header | Has Data from SF Bookings | Notes |
|---|---|---|---|
| 1 | `Name` | YES (globalName or salesName or acctName) | |
| 2 | `Customer Number` | NO (empty string) | Legacy Supportable field |
| 3 | `Account Number` | NO (empty string) | Legacy Supportable field |
| 4 | `Country` | NO (empty string) | Legacy Supportable field |
| 5 | `First Name` | NO (empty string) | Legacy Supportable field |
| 6 | `Last Name` | NO (empty string) | Legacy Supportable field |
| 7 | `Login` | NO (empty string) | Legacy Supportable field |
| 8 | `Email` | NO (empty string) | Legacy Supportable field |
| 9 | `Phone Num` | NO (empty string) | Legacy Supportable field |
| 10 | `Internal Sku` | YES → from `PRODUCT_CODE` | |
| 11 | `Ordered Item` | YES → from `PRODUCT_FORECAST_OFFERING_GROUP` | |
| 12 | `Product Description` | YES → from `PRODUCT_DESCRIPTION` | |
| 13 | `Quantity` | YES → from `PRODUCT_QUANTITY` | |
| 14 | `Status` | YES → derived (Active/Expired from end date) | |
| 15 | `Start Date` | YES → from `OPPORTUNITY_LINE_START_DATE` | |
| 16 | `End Date` | YES → from `OPPORTUNITY_LINE_END_DATE` | |
| 17 | `Contract#` | NO (empty string) | Legacy Supportable field |
| 18 | `Cust PO Number` | NO (empty string) | Legacy Supportable field |
| 19 | `End Customer PO` | NO (empty string) | Legacy Supportable field |

---

## 4. Complete Field Requirements for Report-Based Ingestion

If replacing scrapers with daily 24-hour report pulls, these are ALL fields the application needs:

### SF Pipeline Report — Required Fields

| # | Field Name | Why Required | Parser Reference |
|---|---|---|---|
| 1 | `Opportunity ID` | Dedup key (primary); SF direct link | pipeline.ts:43,93 |
| 2 | `Opportunity Number` | Dedup key (secondary); display | pipeline.ts:44,72 |
| 3 | `Account Name` | Customer matching; display; dedup | pipeline.ts:45,100 |
| 4 | `Opportunity Name` | Display; renewal keyword detection | pipeline.ts:46,74 |
| 5 | `ACV Opportunity` | All financial aggregations | pipeline.ts:86 |
| 6 | `Close Date` | Display; quarter derivation; dedup | pipeline.ts:47,88-91 |
| 7 | `Forecast Category` | Stage grouping; open/closed split | pipeline.ts:85 |
| 8 | `Opportunity Owner` | Owner grouping; display | pipeline.ts:105 |
| 9 | `Renewal` | Renewal vs new business split | pipeline.ts:57-58 |
| 10 | `Offering Group` | Display | pipeline.ts:107 |
| 11 | `Probability (%)` | Display | pipeline.ts:108 |
| 12 | `Product Description` | Product aggregation per opp | pipeline.ts:51 |
| 13 | `Opportunity Territory Name` | AE routing (BKL-SF-01) | pipeline.ts:95 |

**Currently kept but not parsed (include for AE reference):**

| # | Field Name | Why Include |
|---|---|---|
| 14 | `ACV Opportunity Product` | Per-product ACV breakdown |
| 15 | `Close Month` | Convenient grouping |
| 16 | `Opportunity Pod` | POD-level analysis |
| 17 | `Product Code` | SKU-level detail |
| 18 | `Next Steps` | Opportunity context for AE |
| 19 | `Industry` | Account classification |

### SF Bookings (Subscriptions) Report — Required Fields

| # | Field Name | Why Required | Reader Reference |
|---|---|---|---|
| 1 | `ACCOUNT_NAME` | Customer matching (tier 1 — billing entity) | sf-bookings-reader.ts:290 |
| 2 | `ACCOUNT_SALES_GROUP_NAME` | Customer matching (tier 2 — sales entity) | sf-bookings-reader.ts:289 |
| 3 | `ACCOUNT_GLOBAL_SALES_GROUP_NAME` | Display name; grouping | sf-bookings-reader.ts:288 |
| 4 | `PRODUCT_DESCRIPTION` | Core subscription data — rows without are skipped | sf-bookings-reader.ts:291 |
| 5 | `PRODUCT_QUANTITY` | License count | sf-bookings-reader.ts:292 |
| 6 | `OPPORTUNITY_LINE_START_DATE` | Subscription period | sf-bookings-reader.ts:293 |
| 7 | `OPPORTUNITY_LINE_END_DATE` | Subscription period + active/expired derivation | sf-bookings-reader.ts:294 |
| 8 | `PRODUCT_CODE` | SKU identifier → `Internal Sku` | sf-bookings-reader.ts:295 |
| 9 | `PRODUCT_FORECAST_OFFERING_GROUP` | Offering group → `Ordered Item` | sf-bookings-reader.ts:296 |
| 10 | `OPPORTUNITY_NAME_H` | CCSP row detection — rows containing "ccsp" are excluded | sf-bookings-reader.ts:297 |
| 11 | `OPPORTUNITY_TERRITORY_NAME` | Territory filter — routes rows to correct AE | sf-bookings-reader.ts:298 |

### CCSP Report — Required Fields

| # | Field Name | Why Required | Reference |
|---|---|---|---|
| 1 | `Account Name` (or `Account`, `Customer Name`, `Company`) | Customer matching; display; validation gate | sheets.ts:575-578; ccsp-scraper.ts:1286 |
| 2 | Column containing `fiscal year quarter` | Quarter grouping; post-download filter | sheets.ts:579; ccsp-scraper.ts:730-737 |
| 3 | `Opportunity Close Date` | Brief XML | sheets.ts:580 |
| 4 | Column containing `Financial Partner` | Cloud partner grouping (AWS/Google/Microsoft/Other) | sheets.ts:581 |
| 5 | `ACV Plus` (or `ACV+`, `ACVPlus`) | All financial aggregations; validation gate | sheets.ts:582-585; ccsp-scraper.ts:1290 |
| 6 | Column at position 18 (varies by Tableau export) | Product offering group | sheets.ts:600 |
| 7 | `Account Territory Name` (or `Account Territory`) | Territory filter — scopes full POD data to AE's accounts | ccsp-scraper.ts:715-722 |

---

## 5. Report Consolidation Analysis

### Current State: 3 Separate Scraper Sessions

| Source | System | Auth | Cadence | Row Volume |
|---|---|---|---|---|
| SF Pipeline | Salesforce Lightning | Red Hat SSO → Salesforce SAML | Daily 2:00 AM ET | ~100-500 rows per AE |
| CCSP | Tableau Cloud | Red Hat SSO → Tableau SSO | Daily 6:30 AM ET | ~500-2000 rows per POD (pre-territory-filter) |
| SF Bookings | Google Sheets (pre-exported) | Google OAuth | On bootstrap + manual | ~1000-5000 rows per POD sheet |

### Can We Consolidate?

**Pipeline + Bookings → 1 SF Report: YES, with conditions**

Both come from Salesforce CRM. Field overlap:

| Field | Pipeline | Bookings | Shared? |
|---|---|---|---|
| Account Name | `Account Name` | `ACCOUNT_NAME` | YES (different column names) |
| Territory | `Opportunity Territory Name` | `OPPORTUNITY_TERRITORY_NAME` | YES |
| Product Description | `Product Description` | `PRODUCT_DESCRIPTION` | YES |
| Offering Group | `Offering Group` | `PRODUCT_FORECAST_OFFERING_GROUP` | YES (different column names) |
| Opportunity Name | `Opportunity Name` | `OPPORTUNITY_NAME_H` | YES (used for CCSP detection in bookings) |
| Product Code | `Product Code` | `PRODUCT_CODE` | YES |

A combined SF report would need a **discriminator column** (e.g. `Record Type` or `Opportunity Stage Group`) to route rows to the correct parser. The existing CCSP-skip logic (`oppName.includes('ccsp')`) already demonstrates this pattern.

**Benefits of 1 SF report:**
- Single download/parse cycle instead of 2
- Territory filtering applied once
- Customer name matching runs once
- Shared column dedup (Account Name, Territory, Product Description, etc.)

**Risks of 1 SF report:**
- Larger row count (~1500-5500 per parse)
- Parser must correctly route every row — a bug routes pipeline rows to subscriptions or vice versa
- If the report fails, both pipeline AND subscription data are stale (currently independent)
- Different refresh cadences may be needed (pipeline changes daily; subscriptions change weekly)

**CCSP → MUST stay separate**

- Different source system (Tableau vs Salesforce)
- Completely different field schema — no `Opportunity ID`, no `Forecast Category`, has `Financial Partner`/`ACV Plus` that SF doesn't have
- Different auth chain (Tableau SSO vs Salesforce SAML)
- Cannot be consolidated at the source level

### Recommendation: 2 Reports

| Report | Contains | Fields | Estimated Rows |
|---|---|---|---|
| **SF Combined** (Pipeline + Subscriptions) | Open/closed opportunities + subscription line items | Union of Pipeline (19 fields) + Bookings (11 fields) with discriminator column | ~1500-5500 per POD |
| **CCSP** (separate) | Cloud consumption spend | 7+ fields from Tableau Raw Data view | ~500-2000 per POD |

### Ingestion Optimization with Daily Report Dumps

If daily 24-hour pulls are available:

1. **Eliminate Playwright entirely** for Pipeline and Bookings — parse CSV/XLSX directly instead of browser automation
2. **Eliminate Tableau scraping** for CCSP — parse the Tableau export CSV directly
3. **Skip Google Sheets as intermediate store** — go directly from report CSV → JSON cache (sheets become optional AE reference copies)
4. **Single-pass territory filtering** — apply territory filter during parse, not as a post-download step
5. **Incremental cache updates** — diff new report against previous day's cache, only update changed records

**Architecture change:**
```
Current:  Source → Playwright scraper → Google Sheet → Sheet API read → Parser → JSON cache → API → Dashboard
Optimal:  Source → Daily report CSV    → Parser (direct) → JSON cache → API → Dashboard
                                       └→ Google Sheet (optional, for AE reference)
```

This eliminates 3 layers of indirection (Playwright, Sheet write, Sheet read) and the most fragile component (browser automation).
