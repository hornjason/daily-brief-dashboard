---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# Scraper Rules (do not regress)
*Last validated: 2026-04-11 | Owner: DA | Trigger: Any scraper file change, new parallelism design, or BrowserContext change*

- All scrapers share one `BrowserContext` from RH SSO login
- Subscription scraping is strictly sequential (one page, one account) — council decision 2026-04-03. Discovery uses up to 3 parallel pages (read-only HTML, no downloads).
- Keep-alive expiry guard: check all 3 mutex flags before `closeScrapeContext()`
- CCSP two-phase mutex: `ccspScrapeRunning || ccspInFlight` — both required
- `_ctx.newPage()` must always be wrapped in a 30s `Promise.race` timeout — zombie contexts don't throw, they hang forever (BKL-CCSP-06)
- RH Cases scraper is the account discovery source — searches RH portal by quoted customer name when accountNumbers is empty; Supportable is NOT used for discovery
- RH discovery uses `aliases[0]` (canonical SF name from sf-bookings) ONLY — customers without aliases are skipped entirely; no fallback to display name
- SF bookings alias column priority (sf-bookings-reader.ts): `ACCOUNT_SALES_GROUP_NAME` first (parent company legal name, matches RH Portal), then `ACCOUNT_GLOBAL_SALES_GROUP_NAME`, then `ACCOUNT_NAME` (deal-level entity, too specific). Do not change priority — global-first caused abbreviated misses ("INSIGHT" instead of "INSIGHT ENTERPRISES, INC."); account-first caused subsidiary misses ("Big Ten Network Services, LLC" instead of "FOX CORPORATION").
- Territory sheet is AE→territory map ONLY — never a customer data source; customers come exclusively from sf-bookings-sync
- Chrome needs `--no-sandbox` + `--disable-dev-shm-usage` at all 4 `launchPersistentContext` sites
- `--shm-size=2g` + `--memory=4g` in Makefile — do not remove (Chromium stability)
- Circuit breakers reset on auth event (RH or SF SSO) — do not change this behavior
- Manual "Run Now" overrides circuit breakers — intentional design, not a bug
- Auth pre-flight checks RH session before startup scrape — do not remove
- All 4 scrapers re-adopted on auth (rh-auth.ts and sf-auth.ts both adopt RH, SF, Supportable, CCSP)
- SCRAPE_LOG_PATH uses `process.env.CACHE_DIR` — do not hardcode relative paths
- CCSP filter derivation is territory-aware (BKL-CCSP-05): territory segments[1]=COMM → Segment=Commercial, Region=NA_COMM_COMMERCIAL, POD=parts.slice(0,-1) (no suffix); segments[1]=ENT → Segment=Enterprise, Subsegment=Enterprise, Region=parts[0], POD=subregion+_POD. Enterprise Tableau PODs carry a _POD suffix; commercial do not. Do not revert to hardcoded Commercial values.
