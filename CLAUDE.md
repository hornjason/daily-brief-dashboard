# DailyBriefDashboard — Project Instructions

## Read Before Touching Code

Read `ARCHITECTURE.md` and `PRINCIPLES.md` before making changes. They document intentional patterns that look like anti-patterns.

**Architectural truths (do not suggest alternatives):**
- Shared browser context is intentional — isolation breaks Tableau SSO
- No auth middleware is intentional — single-user localhost-only app
- Config files mutated at runtime is intentional — config IS the persistence layer
- In-memory mutex is safe — single-threaded Bun process

## Deploy

- **Always `make rebuild`** — never raw podman/docker commands
- Verify: `curl -s http://localhost:7777/api/aes`
- Container: `pai-dashboard` | Port: `7777` | VNC: `localhost:6080`

## Agent Briefing

- **Rook:** Shared browser context and no-auth are intentional — do not flag as vulnerabilities
- **Quinn:** Test as brand new user from scratch unless Jason says otherwise
- **Marcus:** Read the file before modifying; surgical fixes only
- Include relevant `ARCHITECTURE.md` section in every agent prompt
- After every UI rebuild: spawn Quinn without being asked
- After every item close: spawn Rook on changed files + pattern siblings

## Security Baseline (do not regress)

- `sanitizeCell()` on all Sheets writes before `valueInputOption: 'RAW'`
- `sanitizeErr(e)` on all API error responses — never return raw `e.message`
- `escapeXml()` on all values interpolated into brief XML sources
- Cache/config files written with `mode: 0o600`
- `dumpDom()` gated behind `CCSP_DEBUG=true` — never in production
- `sanitizeText()` rejects HTML tags (returns null -> 400), does not strip

## Scraper Rules (do not regress)

- All scrapers share one `BrowserContext` from RH SSO login
- `PARALLEL_PAGES=1` against Supportable (APEX session contention)
- Keep-alive expiry guard: check all 3 mutex flags before `closeScrapeContext()`
- CCSP two-phase mutex: `ccspScrapeRunning || ccspInFlight` — both required
- Supportable is the ONLY account discovery source — never use RH Portal SOLR
- Chrome needs `--no-sandbox` + `--disable-dev-shm-usage` at all 4 `launchPersistentContext` sites
- `--shm-size=256m` in Makefile — do not remove

## Data Rules (do not regress)

- Never overwrite non-empty cache with empty results (stale-overwrite guard)
- Always pass `knownSheetIds` to bypass Drive BFS (quota protection)
- Tab matching: word-boundary regex for names <= 4 chars (prevents "EBS" matching "Webster")
- Pipeline dedup by `oppNumber` across shared SF reports
- Territory sync: auto-add new customers, flag removals (never auto-delete)
- Customer names come from territory Google Sheet — not manual entry

## Testing

- `make rebuild` after every code change
- API tests: `npx playwright test test/api/`
- Full suite: `npx playwright test` (~260 tests)
- Bootstrap E2E: `npx playwright test test/bootstrap-e2e.spec.ts --timeout=600000`
- State isolation: snapshot/restore per test via `POST /api/__test/snapshot` + `restore`

## Project Map

For module inventory, API endpoints, ADR index, design specs, timer reference, and doc catalog: `docs/PROJECT-MAP.md`
