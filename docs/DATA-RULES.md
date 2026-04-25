# Data Rules (do not regress)
*Last validated: 2026-04-20 | Owner: DA | Trigger: Any cache write, Drive BFS change, or new sheet tab matching logic*

## Data Ingestion Tiers (L1–L4)

Every data read in the pipeline resolves at the highest available tier. Bootstrap and scrapers fall through to the next tier only when the current tier is absent or stale.

| Tier | Source | What it is | When used |
|---|---|---|---|
| **L1** | Local file cache (`data/cache/`) | JSON files written by previous scraper runs (ccsp-data.json, pipeline-data.json, cases.json) | Fastest path — used when files exist and are within TTL |
| **L2** | AE-specific Google Sheets | Supportable sheet, CCSP sheet, Pipeline sheet stored under each AE's Drive folder | Bootstrap reuses existing AE sheets when found; avoids re-scraping external sources |
| **L3** | POD/territory Google Drive sheets | SF Bookings sheet (territory-level source of truth for customers) — the canonical list for customer names and subscription data | Bootstrap always reads here for customer list; territory sheet is the authority |
| **L4** | Live external scrape | Real-time API or browser scrape: Salesforce pipeline API, RH Portal cases, Tableau/CCSP cloud spend | Used when L1–L3 are absent, stale, or for new AE bootstrap with no existing sheets |

**How bootstrap resolves each step:**

| Bootstrap step | Normal path | Fallback |
|---|---|---|
| Customer list | L3 — reads territory SF Bookings Drive sheet | No fallback — territory sheet is required |
| Supportable sheet | L2 — reuse existing AE sheet if found | L4 — create new sheet via live Supportable scrape |
| CCSP sheet | L2 — reuse existing AE CCSP sheet if found | L4 — live Tableau scrape creates new sheet |
| Pipeline sheet | L2 — reuse existing AE pipeline sheet if found | L4 — live Salesforce sync creates new sheet |
| RH cases | L1 — local cases.json if fresh | L4 — live RH Portal scrape (post-bootstrap hook) |

**Key rule:** Customer names come from L3 (territory sheet), never from L1 local cache or manual entry. L2 AE sheets are data stores, not the source of truth for who the customers are.

---

- Never overwrite non-empty cache with empty results (stale-overwrite guard)
- Always pass `knownSheetIds` to bypass Drive BFS (quota protection)
- Tab matching: word-boundary regex for names <= 4 chars (prevents "EBS" matching "Webster")
- Pipeline dedup by `oppNumber` across shared SF reports
- Territory sync: auto-add new customers, flag removals (never auto-delete)
- Customer names come from territory Google Sheet — not manual entry
