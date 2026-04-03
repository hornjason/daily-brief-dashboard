# Scraper Rules (do not regress)

- All scrapers share one `BrowserContext` from RH SSO login
- Subscription scraping is strictly sequential (one page, one account) — council decision 2026-04-03. Discovery uses up to 3 parallel pages (read-only HTML, no downloads).
- Keep-alive expiry guard: check all 3 mutex flags before `closeScrapeContext()`
- CCSP two-phase mutex: `ccspScrapeRunning || ccspInFlight` — both required
- Supportable is the ONLY account discovery source — never use RH Portal SOLR
- Chrome needs `--no-sandbox` + `--disable-dev-shm-usage` at all 4 `launchPersistentContext` sites
- `--shm-size=2g` + `--memory=4g` in Makefile — do not remove (Chromium stability)
- Circuit breakers reset on auth event (RH or SF SSO) — do not change this behavior
- Manual "Run Now" overrides circuit breakers — intentional design, not a bug
- Auth pre-flight checks RH session before startup scrape — do not remove
- All 4 scrapers re-adopted on auth (rh-auth.ts and sf-auth.ts both adopt RH, SF, Supportable, CCSP)
- SCRAPE_LOG_PATH uses `process.env.CACHE_DIR` — do not hardcode relative paths
