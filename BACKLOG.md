---
doc-type: backlog
status: active
owner: jason
updated: 2026-05-01
---

# DailyBriefDashboard — Canonical Backlog

**This is the single source of truth for all open, completed, and deferred work.**

Rules:
- Items are NEVER deleted — status moves to DONE / DEFERRED / WONTFIX with date + reason
- Decision field is mandatory on close — captures what was decided and why
- Read this file first at every session — do not rely on memory summaries
- Security scan (Rook) is mandatory on every item close, not just security items

Last full review: 2026-03-31 (Rook + Marcus + Quinn + ScraperExplorer, deep scraper analysis)
Last update: 2026-04-11 (BKL-INTEL-04 added + closed DONE; identifyIndustry now runs for no-data customers in early-exit path)

---

## Status Key
- 🔴 OPEN — not started
- 🟡 IN PROGRESS — actively being worked
- ✅ DONE — completed, verified
- ⏸ DEFERRED — intentionally postponed (reason documented)
- 🚫 WONTFIX — not worth fixing (reason documented)
- ⚪ SUPERSEDED — replaced by a newer item (successor documented)

---

## Security

### BKL-S01 | sanitizeCell() missing from Supportable sheet writes
Status: ✅ DONE 2026-03-31
Severity: Critical
Source: Rook audit 2026-03-31
Files: src/supportable-scraper.ts lines 914, 929
Description: Supportable wrote raw CSV data to Google Sheets without formula injection protection. Customer names and subscription data could contain =, +, -, @ prefix formulas.
Decision: DONE — sanitizeCell() added to accountRows and dataRows writes. Matches ccsp-scraper.ts pattern exactly.

### BKL-S02 | SF pipeline sheet written with USER_ENTERED + no sanitization
Status: ✅ DONE 2026-03-31
Severity: High
Source: Rook audit 2026-03-31
Files: src/sf-scraper.ts line 430
Description: Pipeline data written to Sheets with valueInputOption: 'USER_ENTERED' and no sanitization. Opportunity names and account names from Salesforce could trigger formula execution.
Decision: DONE — changed to valueInputOption: 'RAW', sanitizeCell() applied to all data rows.

### BKL-S03 | driveFolderId validation missing in SF createPipelineSheet
Status: ✅ DONE 2026-03-31
Severity: High
Source: Rook audit 2026-03-31
Files: src/sf-scraper.ts line 442
Description: createPipelineSheet() passed driveFolderId to Drive API without format validation. Pattern already fixed in ccsp-scraper.ts and supportable-scraper.ts but missed in sf-scraper.ts.
Decision: DONE — /^[a-zA-Z0-9_-]{10,}$/ validation added before Drive API call.

### BKL-S04 | mode 0o600 missing from brief, sheet, pipeline cache writes
Status: ✅ DONE 2026-03-31
Severity: High
Source: Rook audit 2026-03-31
Files: server.ts lines 172, 193, 2442
Description: CCSP cache had mode 0o600 (correct) but brief cache, sheet data cache, and pipeline cache did not. These files contain customer intelligence data.
Decision: DONE — mode: 0o600 added to all three writeFileSync calls.

### BKL-S05 | Raw e.message leaked to client at 5 API routes
Status: ✅ DONE 2026-03-31
Severity: High
Source: Rook audit 2026-03-31
Files: server.ts lines 501, 788, 1428, 1635, 1679
Description: Internal error messages (e.message) returned directly to frontend at RH login, SF login, Tableau login, file check, and folder connection routes. Exposes internal paths and stack details.
Decision: DONE — generic messages at all 5 routes. Rook re-scan verified clean. Scope extended to also fix bootstrap status, sfSyncError, OAuth upload, SSO refresh (see BKL-S10).

### BKL-S06 | Empty driveFolderId reaches bootstrap step 5
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Rook audit 2026-03-31
Files: server.ts bootstrap orchestration (~line 1339)
Description: If driveFolderId lookup returns empty string in auto-bootstrap, it passes to createPipelineSheet() causing a cryptic Drive API error rather than a clean step failure.
Decision: DONE — changed step status from 'skipped' to 'error' with descriptive message when driveFolderId missing. Rook re-scan verified clean.

### BKL-S07 | SF column filter silently drops custom report columns
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Gap review 2026-03-30 (S5), confirmed in code scan
Files: src/sf-scraper.ts KEEP_COLS logic (~lines 356-363)
Description: If SF report has ≥3 matched KEEP_COLS, remaining custom columns are dropped silently. No log entry, no warning returned in scrape result. Custom report fields vanish without trace.
Decision: DONE — `droppedColumns` field added to `SfReportRow` interface; warn-level log emitted when columns are dropped; field included in scrape result.

### BKL-S10 | Bootstrap status, sfSyncError, OAuth upload, SSO refresh leak raw errors
Status: ✅ DONE 2026-03-31
Severity: Medium (bootstrap/sfSyncError), Low (OAuth/SSO)
Source: Rook extended scan 2026-03-31 (follow-on to BKL-S05)
Files: server.ts lines 1027, 752, 961, 2097; src/redhat.ts line 29
Description: Four additional info-leak paths found during Batch 1 security scan:
  1. `GET /api/bootstrap/auto/status` returned raw `autoBootstrapState` with `e.message` in 10 step detail fields
  2. `sfSyncError` returned unsanitized in SF auth status and scrapes status endpoints
  3. OAuth keys upload catch returned raw `e.message` (could expose filesystem paths)
  4. SSO token refresh threw error including full SSO response body
Decision: DONE — All 4 fixed 2026-03-31:
  1. Sanitize-on-output helper strips file paths + caps at 200 chars for bootstrap state (steps + error)
  2. sfSyncError: `.slice(0,200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')` at both output points
  3. OAuth upload: generic "Failed to save OAuth keys — check file permissions"
  4. SSO refresh: throws `RH SSO token refresh failed (${res.status})` — status code only

### BKL-S11 | ~10 additional e.message leaks in territory, wizard, pipeline, calendar endpoints
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Rook extended re-scan 2026-03-31 (pre-existing — not introduced by BKL-S10 fixes)
Files: server.ts lines ~740, 1519-1520, 1822, 1924, 1976, 1998, 2020, 2173, 2199, 2241, 2269, 2481, 2501
Description: Remaining endpoints that return `e.message` directly to clients: territory discovery, territory-names, territory-lookup, AE wizard setup, Drive folder resolve, AI brief test, infer-domains, update-domains, import-customers, cases fetch, pipeline fetch, calendar fetch. Low practical risk (single-user localhost app, no auth). Could expose Playwright internals, Google API error strings, or file system paths.
Decision: DONE — `sanitizeErr(e)` helper added to server.ts (strips file paths, caps at 200 chars). Applied to all 10+ locations: territory discovery, territory-names, territory-lookup, AE wizard setup, Drive folder validation, AI brief test, infer-domains (per-customer + top-level), save-domains, save-customers, cases fetch, pipeline fetch, calendar fetch.

### BKL-S08 | Google Sheets quota errors = silent failure
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Gap review 2026-03-30 (S7)
Files: src/google.ts, src/supportable-scraper.ts, src/ccsp-scraper.ts, src/sf-scraper.ts
Description: 429 quota errors from Sheets API bubble up and are logged but no retry, no backoff, and no user notification. Scrape appears to complete but data is never written.
Decision: DONE — `withQuotaRetry<T>(fn, label?)` helper added to `google.ts` and exported. All sheet `values.update` and `values.clear` calls in the 3 scrapers wrapped. On 429/RESOURCE_EXHAUSTED, logs warning and retries once after 61s. Non-429 errors rethrown immediately. Failed retries surface via existing `lastSupportableError`/`lastCcspError`/`sfSyncError` in `/api/status/scrapes`.

### BKL-S09 | RH SSO cascade failure not documented in ARCHITECTURE.md
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Gap review 2026-03-30 (S6), final pass 2026-03-31
Files: ARCHITECTURE.md, server.ts (keep-alive guard already added 2026-03-30)
Decision: DONE — ARCHITECTURE.md §11 added with full cascade pattern. UI notification was already implemented: `setSessionExpiredCallback` calls `recordScrapeExpired()` before the guard check → sets `rhSessionExpired = true` → `GET /api/auth/redhat/status` exposes it → App.tsx shows "⚠ Red Hat session expired" banner. BKL-S09b was already working through this mechanism.

### BKL-M14 | tabMatchesCustomer substring match — short names absorb wrong accounts
Status: ✅ DONE 2026-03-31
Severity: High (data corruption)
Source: Jason observed 343 cases on EBS 2026-03-31; Marcus diagnosed root cause
Files: src/sheets.ts, server.ts
Description: BKL-M12 added `knownSheetIds` fast path to `fetchCustomerAccountNumbers`. When called with ALL AE supportable sheet IDs (not scoped to customer's AE), `tabMatchesCustomer`'s bidirectional substring match caused "EBS" (3 chars) to mid-word match tabs like "Webster". First matching tab was an AE-wide summary with 173 account numbers — all persisted to customers.json for EBS, causing 343 of 377 cached cases to appear on that customer.
Decision: DONE — Three fixes applied 2026-03-31:
  1. `tabMatchesCustomer` now requires whole-word boundary match for names ≤ 4 chars (regex `(^|\s)shorter(\s|$)`)
  2. SSE endpoint scopes `knownSheetIds` to the customer's own AE sheet (not all AEs)
  3. `runPortalAccountDiscovery` similarly scoped per-customer to their AE sheet
  4. EBS `accountNumbers` cleared from customers.json (was 173 wrong entries)
  Post-fix: 77 API tests pass, Rook scan clean (no new vulnerabilities), data corruption resolved.

---

## Bugs

### BKL-SFCACHE-02 — SF L3 write-back fires after fix; add regression log assertion
- Status: ✅ DONE 2026-04-27
- Priority: P2
- Detail: After BKL-SFCACHE-01 fix, verify `[pod-bootstrap] SF Drive cache written` log appears after L4 scrape. No automated test yet — proxy is checking for CSV file in pod Drive folder post-bootstrap.

### BKL-UX94-TEST — Add automated test for SF auth VNC auto-close
- Status: ✅ DONE 2026-04-27
- Priority: P2
- Detail: SF happy-path blank-tab clear (sf-auth.ts) can't be tested via Playwright CI — requires live headed browser with authenticated RH session. Proxy test: stub `onComplete` + mock `ctx.newPage()`, verify `about:blank` navigation fires on happy path. Add to regression.spec.ts with REG tag.

### BKL-SF-PAGE-CLOSE — sfPage not closed after SF login completion
- Status: ✅ DONE 2026-04-27
- Priority: P2
- Detail: sfPage not closed after SF login completion; VNC showed lingering SF tab. Fix: close sfPage in both login completion paths after blank-tab sequence.
- Resolution: Added `await sfPage.close().catch(() => {})` immediately after the `blankPage.goto('about:blank')` block in both completion paths in `src/sf-auth.ts` (happy path post-RH-portal confirmation, and fallback path when RH portal didn't load). Context (`ctx`) remains alive for scraper adoption — only the SF login tab is closed. Regression: `REG-SF-PAGE-CLOSE-01`.

### BKL-IAP-RACE — acquireIap concurrent call leaks orphan page
- Status: ✅ DONE 2026-04-27
- Priority: P3
- Detail: If `acquireIap` is called twice concurrently (double-click on Connect button), the second call clobbers `_iap` and the first page is orphaned — never reached by `releaseIap`. Mitigate with an `_acquiring: Promise<Page> | null` mutex. Source: Rook scan 2026-04-27.
- Resolution: Added module-scope `_acquiring: Promise<Page> | null` mutex in `src/interactive-auth-page.ts`. Concurrent callers now share the in-flight creation promise; `_acquiring` is cleared in a `finally` block so the next call gets a fresh slot. Regression: `REG-IAP-RACE-01`.

### BKL-IAP-LISTENER-ATTACH — crash/close listeners attached after newPage await
- Status: ✅ DONE 2026-04-27
- Priority: P3
- Detail: `page.on('crash')` and `page.on('close')` are attached after `await ctx.newPage()` resolves. Renderer crash in that gap leaves `_iap` pointing at a dead page. Move listener attach to immediately after newPage() call. Source: Rook scan 2026-04-27.
- Resolution: Verified — listeners are attached synchronously immediately after `ctx.newPage()` resolves and BEFORE `_iap = page` assignment. Within the new mutex closure ordering is: `newPage()` → `page.on('crash')` → `page.on('close')` → `_iap = page` → `goto()`. No intervening await between `newPage` and the listener calls. No code change required beyond the mutex wrap.

### BKL-TABLEAU-ENV-VALIDATION — parseInt on TABLEAU_COOKIE_AGE_MS accepts negatives/partial numerics
- Status: OPEN
- Priority: P3
- Detail: `parseInt(process.env.TABLEAU_COOKIE_AGE_MS ?? '')` parses `"1abc"` as `1` and accepts negatives (negative age → all sessions appear stale → forced re-auth loop). Fix: use `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT` with a console.warn when the env value is rejected. Operator trust boundary — not externally exploitable. Source: Rook Wave 3 scan 2026-04-27.

### BKL-INTEL-DRIVE-TIMEOUT — Account intelligence pipeline fails with DOMException TimeoutError on Drive write
- Status: ✅ DONE 2026-04-27
- Priority: P1
- Detail: Intelligence generation completes successfully (all 3 steps, full synthesis) but the final Drive write step throws `DOMException: TimeoutError` (code 23). Observed on A10 Networks in test env 2026-04-27. CCSP context was lost (`No browser context`) just before the pipeline ran — possible shared browser context degradation. The generated data is lost (cache not written) so the page re-triggers on next load. Source: Jason reported 2026-04-27.
- Resolution: Root cause was the 120s `AbortSignal.timeout` in `fetchGeminiWithRetry` firing on the slow `generateIndustryAnalysis` grounded call — propagated as `DOMException: TimeoutError`, then re-thrown as fatal by `Promise.allSettled` industry-rejection branch in `runIntelligencePipeline`, killing the pipeline AFTER the company brief had already generated. Two surgical fixes: (1) `src/account-intelligence.ts` — industry rejection now `console.warn`s and continues with `industryAnalysis = null` (matches existing company-side handling); (2) `src/gemini-fetch.ts` — `fetchGeminiWithRetry` now retries up to 2 times on `TimeoutError`/`AbortError` with a fresh per-attempt `AbortSignal.timeout`. 429 retry path unchanged. Regression tests REG-INTEL-TIMEOUT-01/02 added in `test/regression.spec.ts` source-inspection block.

### BKL-TABLEAU-LOCK-PATH — SingletonLock unlink has no path-containment assertion
- Status: OPEN
- Priority: P3
- Detail: `unlinkSync(join(TABLEAU_AUTH_PROFILE_DIR, 'SingletonLock'))` in tableau-auth.ts doesn't verify the resolved path stays inside the profile dir (symlink escape possible if env var is crafted). Fix: `resolve` both paths and assert containment before unlinking. Operator trust boundary only. Source: Rook Wave 3 scan 2026-04-27.

### BKL-CANCEL-STEP3-OVERLAP — tid3 watchdog can false-cancel Step 3 after Step 2 completes
- Status: OPEN
- Priority: P2
- Detail: In the combined SF-bookings try/catch (bootstrap-orchestrator.ts), `tid3` starts before the try block alongside `tid2`. If `tid3` fires in the window between `setStep(2,'done')` and `setStep(3,'running')` (e.g., slow `findExistingSheet` call), it marks Step 3 as error and sets `autoBootstrapCancelRequested = true`, then the success path overwrites with done but `checkCancelled()` still aborts the run. Fix: move `tid3 = makeStepTimeout(3, ...)` to just before the Step 3 sheet-write block (line ~2032) rather than the top of the combined try. Source: Serena Wave 2 audit 2026-04-27.

### BKL-HEALTH-TIMER-LEAK — setTimeout not cleared in isLivePageHealthy happy path
- Status: ✅ DONE 2026-04-27
- Priority: P3
- Detail: `Promise.race` in `isLivePageHealthy` (rh-scraper.ts) leaves a dangling 2s timer when evaluate wins — causes unhandledRejection log noise in Bun. Fix: clear timer in finally block. Source: Rook scan 2026-04-27.

---

## Data Freshness

### BKL-D12 | Subscription refresh BFS burns quota — most customers show 0 products
Status: ✅ DONE 2026-03-31
Severity: High
Source: Jason observed 2026-03-31 (most accounts showing 0 Products / 0 Licenses)
Files: src/sheets.ts, server.ts
Description: `fetchCustomerSheetData` used Drive BFS + `sheets.spreadsheets.get` for every spreadsheet under the parent folder, burning all Sheets API read quota before reaching most customers. CROWDSTRIKE, DROPBOX, ILLUMIO, SHUTTERFLY, A10 all had tabs in the Supportable sheet but returned empty caches. Also: stale-overwrite risk — when quota failure returns `[]`, `writeSheetCache` was overwriting valid cached data.
Decision: DONE —
  1. `fetchCustomerSheetData` now accepts `knownSheetIds?: string[]` fast-path param (same pattern as `fetchCCSPData`).
  2. `refreshSubscriptions`, `refreshAll`, and `GET /customer/:name/sheetdata?force=true` all pass `aes.map(a => a.supportableSheetId).filter(Boolean)` — bypasses BFS entirely.
  3. Stale-overwrite guard added to `refreshSubscriptions`, `refreshAll`, `refreshCCSP`, and `refreshPipeline` — if fetch returns 0 records and cache has data, keep existing cache.
  4. Pre-existing stale `-inc` slug cache files for Lynden Logistics and REI copied to correct slug.
After fix: `POST /api/refresh` → 22/22 sheets, 0 errors. CROWDSTRIKE 20/155, DROPBOX 6/19, ILLUMIO 7/69, SHUTTERFLY 4/84, A10 6/123.

---

## Code Quality & Architecture

### BKL-M01 | server.ts monolith — Phase 1 (cache + settings)
Status: ✅ DONE 2026-03-31
Severity: High
Source: Marcus code review 2026-03-31
Files: server.ts → src/cache-layer.ts, src/settings-api.ts
Description: server.ts is ~4,000 lines / 87 routes. Phase 1 extracts pure utility functions with no HTTP surface change (~235 lines).
  - src/cache-layer.ts: brief cache, sheet cache, CCSP cache, pipeline cache helpers
  - src/settings-api.ts: refresh interval + weather settings routes
Fix: Surgical extraction; imports updated in server.ts. Lowest risk phase — no route changes.
Decision: 4-phase split approved by Jason 2026-03-31.
Done: All ISC criteria met. API tests pass (80/80). Rook scan: PASS.

### BKL-M02 | server.ts monolith — Phase 2 (background systems + timer tests)
Status: ✅ DONE 2026-03-31
Severity: High
Source: Marcus code review 2026-03-31
Files: server.ts → src/background-scheduler.ts, src/refresh-engine.ts, src/scraper-manager.ts
Description: Extracts ~530 lines of internal machinery with no user-facing routes. Timer unit tests written alongside this phase.
  - src/background-scheduler.ts: setInterval/setTimeout logic, 2am pipeline sync, drive watcher, brief pre-gen
  - src/refresh-engine.ts: refreshAll/Subscriptions/CCSP/Pipeline functions
  - src/scraper-manager.ts: RH scrape mutex, session expiry guard, status endpoint
Fix: Extraction + test/background-scheduler.spec.ts with nextEt2amUtc() DST edge cases.
Dependency: Phase 1 complete.
Done: All ISC criteria met (ISC-24–45). API tests pass. DST unit tests (9/9) pass. Rook scan: PASS.

### BKL-M03 | server.ts monolith — Phase 3 (core feature domains)
Status: ✅ DONE 2026-03-31
Severity: High
Source: Marcus code review 2026-03-31
Files: server.ts → src/bootstrap-orchestrator.ts, src/account-discovery.ts
Description: Extracts ~655 lines. Bootstrap becomes independently testable.
  - src/bootstrap-orchestrator.ts: /api/bootstrap/auto handler + 6-step state machine
  - src/account-discovery.ts: territory lookup, name normalization, Drive folder traversal
Dependency: Phase 2 complete.
Done: All ISC criteria met (ISC-46–58). API tests pass. Rook scan: PASS. runPortalAccountDiscovery placed in bootstrap-orchestrator per server.ts comment.

### BKL-M04 | server.ts monolith — Phase 4 (data sources — largest, last)
Status: ✅ DONE 2026-03-31
Severity: High
Source: Marcus code review 2026-03-31
Files: server.ts → src/sheet-import.ts, src/drive-sources.ts
Description: Extracts ~1,650 lines. server.ts at 1865 lines after M04 (territory, AE config, cases, CCSP, pipeline, OAuth remain — M05+ required to reach ≤500 target).
  - src/sheet-import.ts: customer import from Google Sheets, header mapping
  - src/drive-sources.ts: AE folder discovery, Drive file monitoring, data source registration
Dependency: Phase 3 complete.
Done: All ISC criteria met (ISC-59–72). API tests pass (80/80). Playwright 4 pre-existing failures confirmed (2 strict-mode, 1 perf/VPN, 1 accessibility). Rook scan: PASS (7 e.message leaks fixed, 2 medium gaps addressed). ISC-69 (≤500 lines) deferred to M05+.

### BKL-M12 | fetchCustomerAccountNumbers missing knownSheetIds fast path
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Rook scan 2026-03-31 (Finding 4 — quota pattern sibling)
Files: src/sheets.ts, server.ts
Decision: DONE — `fetchCustomerAccountNumbers` now accepts `knownSheetIds?: string[]` with same priority logic as `fetchCustomerSheetData` (per-customer override > AE fast path > BFS). Both call sites in server.ts (SSE endpoint, account discovery loop) now pass `aes.map(a => a.supportableSheetId).filter(Boolean)`.

### BKL-M13 | Pipeline refresh lacks Sheets quota fast path
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Rook scan 2026-03-31 (Finding 3 — operational)
Files: src/pipeline.ts, server.ts
Decision: DONE — `fetchPipelineData` now accepts `knownSheetIds?: string[]`. When provided, skips `discoverPipelineFileIds` Drive scan and uses those IDs directly (plus `PIPELINE_FILE_ID` env fallback). `refreshPipeline` passes `aes.map(a => a.pipelineSheetId).filter(Boolean)` as fast path.

### BKL-M05 | Customer name normalization — 4 functions, inconsistent rules
Status: DONE (2026-03-31)
Severity: High
Source: Gap review 2026-03-30 (H4), confirmed: 4 functions at lines 217, 1714, 2394, 2655
Files: server.ts, src/sheets.ts
Description: Four separate normalization functions with different rules cause duplicate customers and failed Supportable matches. normalizeCustomerName() for folders, normalizeForDedup() for dedup, plus 2 others.
Decision: Removed `normalizeForDedup` from server.ts — it was identical to `normalizeForMatch` in src/sheets.ts. All dedup call sites now import `normalizeForMatch` (single source of truth). Kept `normalizeCustomerName` (display/title-case for Drive folders) and `normalizeForQuery` (substring overlap with business-line phrase stripping) as separate functions with purpose comments — they serve genuinely different roles.

### BKL-M06 | No scrape cancellation for RH sync and SF sync
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Gap review 2026-03-30 (M3)
Files: server.ts, src/rh-scraper.ts
Description: CCSP and Supportable have status + cancel endpoints. RH sync and SF sync do not. No way to stop a stuck RH or SF scrape from the dashboard without container restart.
Decision: Added 4 endpoints: GET /api/auth/redhat/sync/status, DELETE /api/auth/redhat/sync/cancel, GET /api/salesforce/sync/status, DELETE /api/salesforce/sync/cancel. RH cancel uses a shouldCancel callback passed into runRhScrape (checked between account iterations). SF cancel uses a server-level flag checked between AE iterations. Added _sfSyncRunning flag to track SF sync state (was previously hardcoded false). Also updated /api/status/scrapes to report real SF isRunning state.

### BKL-M07 | GOOGLE_UNIFIED_TOKEN_PATH deleted unconditionally in reset
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Final pass 2026-03-31, code line 2119
Files: server.ts POST /api/setup/reset
Description: Reset endpoint deletes GOOGLE_UNIFIED_TOKEN_PATH unconditionally — does not respect the full=true flag. CLAUDE.md rule says never delete OAuth tokens. GOOGLE_OAUTH_KEYS_PATH correctly respects the flag; unified token does not.
Decision: DONE — `tryDelete(GOOGLE_UNIFIED_TOKEN_PATH)` moved inside the `if (full)` block, matching the OAUTH_KEYS_PATH guard.

### BKL-M08 | SSE error shape inconsistent across Promise.all fetchers
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Marcus code review 2026-03-31
Files: server.ts /customer/:name/events and /events SSE routes
Description: meetings/emails return {error: string} on failure; cases/subscriptions return []. Client receives a union type with no consistent shape.
Decision: DONE — `fetchCustomerMeetings` and `fetchCustomerEmails` `.catch(() => [])` now return `[]` consistently. All 4 fetchers return empty arrays on failure.

### BKL-M09 | adoptScrapeContext() exported but never called
Status: 🚫 WONTFIX 2026-03-31
Severity: Low
Source: Marcus code review 2026-03-31
Files: src/rh-scraper.ts ~line 100
Decision: WONTFIX — Verified: adoptScrapeContext() IS called in rh-auth.ts:137 and sf-auth.ts:142. Also has 3 dedicated tests in rh-scraper.test.ts. Marcus's finding was based on server.ts not calling it — but that's correct by design, rh-auth.ts owns the context lifecycle. Not dead code.

### BKL-M18 | Pipeline cache not populated after bootstrap — dashboard shows empty pipeline
Status: ✅ DONE 2026-03-31
Severity: High
Source: Discovered 2026-03-31 during GATE01 verification
Files: src/bootstrap-orchestrator.ts, src/refresh-engine.ts, src/scraper-manager.ts, src/pipeline.ts
Decision: Fixed 2026-03-31. Three bugs in pipeline.ts fixed: (1) `manualId` ReferenceError — block-scoped var used outside block, all fileId reads silently failed; (2) wrong Sheets range — bootstrap-created sheets use 'Pipeline' tab but code fell back to 'A1:Z5000' (default sheet); (3) env var `PIPELINE_FILE_ID` was merged into aes-sourced IDs causing duplicate records. Also added `refreshPipeline()` call after SF sync in scraper-manager.ts `.finally()` and after bootstrap step 6 in bootstrap-orchestrator.ts. Added `/api/refresh/pipeline` endpoint for manual cache population. Result: 116 clean pipeline records, 28 open opps, $3.5M ACV confirmed via API.

### BKL-M16 | Supportable scrape has no automatic re-scrape timer after bootstrap
Status: ✅ SUPERSEDED by BKL-M33 (DATA-FRESHNESS Phase 3) — 2026-04-01
See DATA-FRESHNESS.md Phase 3 and BKL-M33 for full spec including scale decision (BKL-M36).

### BKL-M17 | CCSP scrape has no automatic re-scrape timer after bootstrap
Status: ✅ SUPERSEDED by BKL-M33 (DATA-FRESHNESS Phase 2) — 2026-04-01
See DATA-FRESHNESS.md Phase 2 and BKL-M33 for full spec.

### BKL-M32 | Territory sheet drift — customers.json never re-syncs after bootstrap
Status: ✅ DONE 2026-04-02 (addressed by Wave 6 Timer 33 — daily 1:45am territory sync via syncTerritorySheet())
Severity: High
Source: Jason observation 2026-04-01
Files: src/bootstrap-orchestrator.ts, data/config/customers.json, data/config/aes.json, server.ts
Description: The POD → AE → customer mapping is read from the Red Hat territory Google Sheet once at bootstrap/setup time, then persisted locally to `customers.json` and `aes.json`. No mechanism exists to detect or apply changes to the territory sheet after bootstrap. Silent drift scenarios: (1) new customer added to territory — never appears in dashboard; (2) customer removed or reassigned — still shows in dashboard with stale data; (3) AE renamed — old name stays in aes.json indefinitely. User must manually edit config files or re-run full bootstrap (destructive) to pick up changes.
Fix: Under analysis — see team recommendations.

### BKL-M15 | Territory lookup hits Sheets API on every wizard open — no caching
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Jason review 2026-03-31 (E2E gate quota failure)
Files: server.ts or bootstrap-orchestrator.ts (territory lookup endpoint), potentially a new src/territory-cache.ts
Description: Every time the wizard opens and a POD+territory is selected, the territory sheet is read live from the Sheets API (`spreadsheets.values.get`). Territory data (AE name + customer list) changes infrequently — at most weekly. Under heavy test runs or repeated wizard use, this burns Sheets read quota and can fail with "Read requests per minute per user" (confirmed during E2E gate run 2026-03-31).
Fix: Cache territory sheet data server-side with a TTL (suggested: 1 hour or configurable). On territory selection: serve from cache if fresh, re-fetch and repopulate cache if stale. Cache should be per-territory-sheet-ID. Must still allow force-refresh if Jason explicitly re-fetches. Document in ARCHITECTURE.md.

### BKL-M10 | ADR-004 needs update for sequential test execution decision
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Final pass 2026-03-31
Files: docs/adr/ADR-004.md
Description: ADR-004 exists (dated 2026-03-29) but does not reflect the sequential test execution mode decision or DST edge case findings from the timer unit test work.
Fix: Update ADR-004 after BKL-M02 (Phase 2) is complete and timer tests are written.
Done: ADR-004.md updated with sequential execution rationale (quota, shared browser context, single-threaded mutex), DST handling via Intl.DateTimeFormat dynamic offset, and short-tick scheduler rationale.

### BKL-M11 | lastError returns generic "check server logs" — users have no log access
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Gap review 2026-03-30 (L5), confirmed lines 866, 925, 943, 949
Files: server.ts Supportable and CCSP status endpoints
Description: Supportable and CCSP status endpoints return "Supportable scrape failed — check server logs" as the error. Users in a container have no log access. Should return sanitized last error (first 200 chars of actual error message).
Decision: DONE — Supportable (line 866) and CCSP (line 925) status endpoints now return `lastError.slice(0,200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')`. Scrapes endpoint (lines 943, 949) also updated.

### BKL-M30 | Remove RH Portal account discovery path
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Architecture cleanup — Supportable APEX is sole discovery source
Files: server.ts, src/bootstrap-orchestrator.ts
Description: Deleted `runPortalAccountDiscovery()`, `POST /api/auth/redhat/discover` endpoint, and `discoverAccountNumbers` import. All account discovery now routes through Supportable APEX only. Eliminates dead code path and prevents accidental regression to the slower, less reliable RH Portal SOLR lookup.
Decision: DONE — Three deletions confirmed. No remaining references to Portal-based account discovery. CLAUDE.md updated to document removal.

### BKL-M31 | Supportable sync live progress display
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: UX improvement — sync button gave no feedback during long scrapes
Files: src/supportable-scraper.ts, src/scrape-api.ts, dashboard/src/pages/SetupPage.tsx
Description: Added `supportableStatusMessage` export to the scraper, polled via the existing status endpoint. Setup page Data Sources section shows an amber spinner with per-customer progress message while a Supportable sync is running. Previously the sync button gave no indication of progress — users had no way to know if it was working or stuck.
Decision: DONE — Status message updates per-customer during discovery. Frontend polls status endpoint and renders amber spinner + message text. Clears automatically when scrape completes.

### BKL-M32 | Supportable name-search fallback candidates
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Elmer Alvarez bootstrap — "Bespin Global U.S." returned 0 results in Supportable
Files: src/supportable-scraper.ts
Description: When `discoverAccountNumbersByName` initial search returns 0 results, it now automatically retries with abbreviation-normalized name (`U.S.` → `US`) and first-two-words prefix. Fixes "Bespin Global U.S." finding "Bespin Global US" in Supportable without needing a manual `supportableName` override in customers.json.
Decision: DONE — Three-candidate search chain: (1) `stripLegalSuffix(name)`, (2) abbreviation-normalized (`U.S.` → `US`), (3) first two words only. First match wins. Logged which candidate succeeded for debugging.

---

## UI / UX

### BKL-Q01 | Customer detail cases count stuck on "--" with permanent loading spinner
Status: ✅ DONE 2026-03-31
Severity: High
Source: Quinn UI review 2026-03-31
Files: src/redhat.ts, dashboard/src/pages/CustomerDetailPage.tsx
Description: Cases count shows "--" and a "Loading..." spinner that never resolves on ALL customer detail pages — both customers with cases and customers with zero cases. Undermines trust in the entire page.
Decision: DONE — Root cause: `rhGet`/`rhPost` had no fetch timeout; hung forever on unreachable RH API. Fixed with 15s `AbortController` timeout. Quinn validated: cases resolved to "0" correctly, spinner clears.

### BKL-Q02 | Escape key does not close modals
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/CustomerDetailPage.tsx (CaseDetailModal), dashboard/src/components/PipelineSection.tsx (OppDetail)
Description: Pressing Escape has no effect on open modals (tested on Open Cases and Sev 1 Cases modals). Only backdrop click closes. WCAG 2.1 failure.
Decision: DONE — `keydown` Escape handler added to CaseDetailModal and OppDetail with proper `useEffect` cleanup. Quinn code-verified (no case data in env to browser-test interactively).

### BKL-Q03 | Modal close button not in accessibility tree
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/CustomerDetailPage.tsx (CaseDetailModal), dashboard/src/components/PipelineSection.tsx (OppDetail)
Description: Visual X close button has no accessible name or role — invisible to screen readers and keyboard navigation.
Decision: DONE — `role="button"` and `aria-label="Close"` added to close buttons in CaseDetailModal and OppDetail. Quinn code-verified.

### BKL-Q04 | Non-existent customer shows misleading green status + stats
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: /dashboard/customer/NonExistentCompany renders with green "Healthy" dot and "0 cases / 0 products / 0 licenses" — looks like a real customer. 3 console 404 errors fire. "Customer not found" only appears in the brief area, not the header.
Decision: DONE — Health dot and stats wrapped in `sectionLoading || sse.meta !== null` conditional; "Customer not found" + AlertTriangle shown when `!sectionLoading && sse.meta === null`. Quinn PASS: no green dot, no misleading stats.

### BKL-Q05 | Tableau card shows "Connected" and "scrape failed" simultaneously
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/SetupPage.tsx (Tableau card, DataSourcesSection)
Description: Tableau card shows green dot "Connected" and red "CCSP scrape failed — check server logs" at the same time. Auth connection ≠ data sync health. Contradictory status confuses users.
Decision: DONE — CCSP `lastError` display removed from Tableau card (was duplicated from Sync section). Auth status and sync health now cleanly separated. Quinn PASS: Tableau card shows only "Connected"; CCSP sync info in Sync section below.

### BKL-Q06 | No sidebar or breadcrumb on customer detail pages
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Quinn UI review 2026-03-31 (also Gap review L3)
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: Customer detail pages show only a back arrow with no label. No sidebar, no breadcrumb. No way to navigate directly to another customer or to Setup without going back first.
Decision: DONE — Back arrow replaced with breadcrumb nav (`Dashboard / {customerName}`); "Dashboard" is a clickable `<button>` inside a `<nav>` element. Quinn PASS: breadcrumb navigates back correctly.

### BKL-Q07 | Cloud Spend empty state gives no cause context
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/CustomerDetailPage.tsx (CloudSpendCard)
Description: When CCSP scrape fails or has no data, shows "$0 / 0 accounts / No data" with only a faint "stale data" tag. Cannot distinguish: not configured, scrape failed, or genuine zero spend.
Decision: DONE — CloudSpendCard now shows "No cloud spend data found for this customer." when data loaded but `totalAcv === 0` (previously returned null/empty). Quinn PASS: empty state message visible on both test customers.

### BKL-Q08 | Data Sources accordion badge says "Status" — not informative
Status: ✅ DONE 2026-03-31
Severity: Low
Source: Quinn UI review 2026-03-31
Files: dashboard/src/pages/SetupPage.tsx (DataSourcesSection)
Description: Data Sources section header badge shows plain "Status" text on the right. Other sections show meaningful badges like "Configured", "Connected". Gives no at-a-glance health info.
Decision: DONE — `onHealthChange` prop added to DataSourcesSection; `useEffect` computes 'loading'/'healthy'/'issues' from connection states; SetupPage renders dynamic badge ("Checking..." / "All connected" green / "Issues" amber). Quinn PASS: badge shows "All connected" after expansion.

### BKL-UX02 | Customer detail page header redesign — two-row layout with hero name, collapsible account pill, stat badges
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design spec 2026-04-01
Files: dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/components/AccountCountPill.tsx (new), dashboard/src/components/StatBadge.tsx (new)
Description: Replace crowded single-row header strip with two-row layout: (1) nav bar with breadcrumb + sync status, (2) identity block with hero customer name (`text-xl`), collapsible account numbers pill (popover with copy-per-row), semantic stat badge cards (cases/products/licenses), AE name tertiary right-aligned. Extract `AccountCountPill.tsx` and `StatBadge.tsx` components.
Fix: Implement two-row header per design spec. Row 1: breadcrumb nav + sync status indicator. Row 2: hero customer name at `text-xl`, `AccountCountPill` component (click to expand popover showing account numbers with per-row copy button), `StatBadge` cards for cases/products/licenses counts, AE name right-aligned in tertiary style. Extract `AccountCountPill.tsx` and `StatBadge.tsx` as standalone reusable components.

### BKL-UX03 | Tabular number font features on all numeric displays
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css, dashboard/tailwind.config.js
Description: Numeric values in KPI cards, ACV figures, pipeline amounts, case counts, license counts use proportional figures. Numbers don't vertically align in columns — "1.23M" next to "4.56M" looks ragged.
Fix: Add to index.css: `.font-mono, [class*="font-mono"] { font-feature-settings: 'tnum' 1, 'zero' 1; }` and `.tabular-nums { font-variant-numeric: tabular-nums; }`. Apply `.tabular-nums` to all KPI value divs, pipeline currency spans, and case/license number displays.

### BKL-UX04 | SetupPage uses raw Tailwind colors instead of design system tokens
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/pages/SetupPage.tsx, dashboard/src/components/RefreshTimerSettings.tsx, dashboard/src/components/WeatherSettings.tsx
Description: These files use raw Tailwind colors (slate-800, slate-700, indigo-600, emerald-400, red-400) while every other page uses semantic tokens (bg-surface, border-border, text-accent, text-success, text-critical). Navigating to Setup feels like entering a different app.
Fix: Replace all raw slate/indigo/emerald/red classes with semantic tokens: bg-slate-800→bg-surface, border-slate-700→border-border, text-slate-300→text-text-primary, text-slate-400→text-text-secondary, bg-slate-900→bg-bg, bg-indigo-600→bg-accent, hover:bg-indigo-700→hover:bg-accent/80, text-emerald-400→text-success, text-red-400→text-critical, etc.

### BKL-UX05 | SUPERSEDED — see BKL-UX44
Status: ⚪ SUPERSEDED
Source: Aditi Sharma design audit 2026-04-01
Decision: Original recommendation to reduce KPIs from 7 to 4 withdrawn. Replaced by BKL-UX44 (extensible KPI container with flex-wrap layout). The flex-wrap approach handles any count gracefully without layout surgery.

### BKL-UX06 | Wrap Pipeline and Cloud Spend sections in container cards
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/PipelineSection.tsx, dashboard/src/components/CloudSpendSection.tsx
Description: These sections have a floating header above a grid of cards. Calendar and Account Portfolio are wrapped in a single container with a header bar. The inconsistency breaks visual rhythm.
Fix: Wrap each section in `<div className="bg-surface border border-border rounded-xl overflow-hidden">` with header inside `<div className="px-5 py-3.5 border-b border-border">`. Replace inner card bg-surface with bg-bg/50 rounded-lg to make them inset sub-cards.

### BKL-UX07 | Add modal enter/exit animations
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css, all modal components
Description: Modals appear/disappear instantly. No entrance animation. Feels abrupt compared to every modern tool.
Fix: Add to index.css: `@keyframes modal-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }` and `.modal-enter { animation: modal-in 200ms ease-out; }`. Add `backdrop-enter` for overlay fade. Apply to all modals.

### BKL-UX08 | Standardize card padding to primary (p-5) and compact (p-4) tiers
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: All card components
Description: Card padding varies: p-4, p-5, px-5 py-4, px-4 pt-4 pb-3. Inconsistency creates visual noise.
Fix: Primary cards use p-5. Compact cards (KPI, account grid, opp rows) use p-4. Cards with header bar: px-5 py-3.5 header, p-5 body. Remove all variant padding patterns.

### BKL-UX09 | Bump section header titles from text-sm to text-base
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: All section header components
Description: Every section header is text-sm font-semibold (14px). No typographic hierarchy between section title and sub-labels. Page feels flat.
Fix: Top-level section headers become text-base font-semibold (16px). Sub-labels stay text-xs font-medium text-text-secondary.

### BKL-UX10 | Shared EmptyState component replacing all plain-text empty states
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: CalendarStrip.tsx, AccountPortfolioGrid.tsx, PipelineSection.tsx, CloudSpendSection.tsx, ActivityTimeline (CustomerDetailPage.tsx), CasesSection, SubscriptionsSection
Description: Empty states are plain italic text with no visual interest and no actionable guidance ("No meetings today", "No recent activity found").
Fix: Create `components/EmptyState.tsx` with props: `icon: LucideIcon, title: string, description?: string, action?: { label: string; onClick: () => void }`. Renders centered block with 32px muted icon, title at text-sm, description at text-xs text-text-secondary, optional ghost button. Replace all plain-text empty states.

### BKL-UX11 | Add surface-hover, surface-active, border-strong tokens to Tailwind config
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/tailwind.config.js
Description: Interactive hover states built ad hoc: hover:bg-border/30, hover:bg-accent/10, hover:border-accent/50. No consistent token for "hovered surface".
Fix: Add to tailwind.config.js colors: 'surface-hover': '#1C2128', 'surface-active': '#21262D', 'border-strong': '#484F58', 'accent-muted': 'rgba(0,188,212,0.12)'. Search-replace ad-hoc patterns to use tokens.

### BKL-UX12 | Add focus-visible rings for keyboard accessibility
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css
Description: No visible focus indicators on any interactive element. Fails WCAG 2.1 AA 2.4.7.
Fix: Add to index.css: `*:focus-visible { outline: 2px solid #00BCD4; outline-offset: 2px; border-radius: 4px; }` and `*:focus:not(:focus-visible) { outline: none; }`.

### BKL-UX13 | Add aria-label to all icon-only buttons
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma design audit 2026-04-01
Files: Sidebar.tsx, TopBar.tsx, KPICards.tsx, PipelineSection.tsx, CloudSpendSection.tsx
Description: Multiple buttons contain only an icon with no text and no aria-label. Sidebar collapse toggle, TopBar refresh, Pipeline filter clears, modal close buttons.
Fix: Audit all icon-only buttons and add descriptive aria-label to each.

### BKL-UX14 | Add hover shadow elevation to clickable cards
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: AccountCard, KPICard, CustomerPrepCard
Description: Clickable cards have hover border color change but no shadow elevation. Feels flat on hover.
Fix: Add `hover:shadow-[0_2px_12px_rgba(0,188,212,0.08)]` and `transition-all duration-150` to clickable cards.

### BKL-UX15 | Deduplicate CopyButton component
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: CustomerDetailPage.tsx, SetupPage.tsx, AccountCountPill.tsx
Description: CopyButton defined three times across three files with slight style variations.
Fix: Move to components/CopyButton.tsx. Accept optional variant prop: 'inline' (icon only) and 'button' (icon + text). Import from shared location.

### BKL-UX16 | Add scroll-to-top on customer detail page navigation
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: Navigating from Account Portfolio grid to a customer detail page may preserve scroll position from previous page.
Fix: Add `useEffect(() => { window.scrollTo(0, 0) }, [customerName])` at top of CustomerDetailPage component.

### BKL-UX17 | Add staggered fade-in animation for Account Portfolio grid cards
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: All account cards render simultaneously on load. 15+ cards pop in at once, visually jarring.
Fix: Add CSS keyframe `card-in` (opacity 0→1, translateY 4px→0). Apply with inline `style={{ animationDelay: '${i * 30}ms' }}` per card. Cap at 15 cards (450ms total).

### BKL-UX18 | Add transition-colors to all missing interactive elements
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: Multiple
Description: Some buttons have transition-colors, some transition-all, some nothing. Inconsistent.
Fix: Global rule in index.css: `button, a, [role="button"] { transition-property: color, background-color, border-color, opacity; transition-duration: 150ms; transition-timing-function: ease-in-out; }`.

### BKL-UX19 | Create shared Modal shell component
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: KPICards.tsx, CalendarStrip.tsx, PipelineSection.tsx, AccountPortfolioGrid.tsx, CustomerDetailPage.tsx
Description: Modal overlay/wrapper code duplicated across 8+ locations with slight style variations.
Fix: Create components/Modal.tsx with props: open, onClose, title, icon, subtitle, maxWidth, children. Apply BKL-UX07 animations here. All existing modals become wrappers around unique content only.

### BKL-UX20 | Add subtle radial gradient to app background
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css
Description: #0D1117 background is flat solid color. Lacks depth compared to Linear, Vercel, GitHub.
Fix: Change body background in index.css to: `background: radial-gradient(ellipse at top, #161B22 0%, #0D1117 60%);`

### BKL-UX21 | Fix CalendarStrip full-week grid event positioning alignment
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/CalendarStrip.tsx (FullCalendarGrid)
Description: Event blocks use percentage-based left/width calculations while column headers use CSS Grid. Can misalign on non-standard screen widths.
Fix: Switch events to grid-column-based positioning. Create 7 column containers using CSS Grid, position events absolutely within their column container.

### BKL-UX22 | Add "Refreshing..." text and pointer-events-none to TopBar refresh button
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/TopBar.tsx
Description: When Refresh clicked, icon spins but button text stays "Refresh". User can spam-click.
Fix: Change button text to "Refreshing..." when loading=true. Add pointer-events-none when disabled.

### BKL-UX23 | Add "Back to top" floating button on long dashboard scroll
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/App.tsx
Description: Dashboard has 5 stacked sections with no quick way to return to top on long portfolios.
Fix: Floating button at bottom-right, appears after scrolling past first viewport height. Fade in with opacity/translate transition.

### BKL-UX24 | Add customer search/filter to Account Portfolio Grid
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: With 15+ customers, finding a specific account requires visual scanning. No search input.
Fix: Add compact text search input to section header right side. Filter by customer name, case-insensitive includes match. Clear on x click.

### BKL-UX25 | Standardize section header icon sizes (4x4 top-level, 3.5x3.5 sub-labels)
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: All section headers
Description: Section header icons inconsistently sized: w-4 h-4, w-3.5 h-3.5, w-5 h-5 mixed without a system.
Fix: Rule: top-level section headers use w-4 h-4. Sub-section labels use w-3.5 h-3.5. KPI card icons remain w-5 h-5.

### BKL-UX26 | Add Escape key handler to all modals missing it
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: KPICards.tsx, CalendarStrip.tsx, AccountPortfolioGrid.tsx
Description: KPI modals, AgendaModal, ProductsModal only close on overlay click — no Escape key support. OppDetail and CaseDetailModal have it but others don't.
Fix: Add Escape handler to shared Modal component (BKL-UX19), or individually: `useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])`.

### BKL-UX27 | Add relative timestamp tooltip with absolute date
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: All components using formatRelTime
Description: Relative timestamps like "2h ago" have no tooltip showing the exact datetime.
Fix: Create `<RelTime iso={string} />` component that renders `<time dateTime={iso} title={absoluteFormatted}>{relative}</time>`. Replace all formatRelTime(x) calls in JSX.

### BKL-UX28 | Fix "Last synced: just now" showing wrong timestamp
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Decision: DONE — `lastSynced` now derived from max `cachedAt` across accountsApi, ccspApi, and pipelineApi responses. Returns null when loading or no timestamps available. No longer always shows "just now".

### BKL-UX29 | Add "Last Updated" indicator per dashboard section
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: PipelineSection.tsx, CloudSpendSection.tsx, AccountPortfolioGrid.tsx, CalendarStrip.tsx
Description: Only Pipeline and Cloud Spend show sync timestamps. Calendar shows nothing. Users can't tell which sections have stale data.
Fix: Add `<RelTime />` (BKL-UX27) to header of every section that loads from cache.

### BKL-UX30 | Add SSE progress bar to customer detail page load
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/hooks/useCustomerSSE.ts
Description: No overall progress indicator while SSE streams data. User sees sections populate one by one with no indication of how many remain.
Fix: Add 2px progress bar below header, fills as SSE sections complete. Expose progress (0-1) from useCustomerSSE hook based on which data types have arrived.

### BKL-UX31 | Define named border-radius tokens in Tailwind config
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/tailwind.config.js
Description: Border radius inconsistently applied using generic utilities. No documented design intent.
Fix: Add to tailwind.config.js borderRadius: { card: '0.75rem', modal: '1rem', badge: '0.375rem', pill: '9999px' }. Use rounded-card, rounded-modal, rounded-badge, rounded-pill.

### BKL-UX32 | Add prefers-reduced-motion media query
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css
Description: All animations play regardless of user OS accessibility preferences. Fails users with vestibular disorders who have reduce-motion enabled.
Fix: Add to index.css: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }`.

### BKL-UX33 | Consolidate currency formatting to single fmtCurrency function
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: PipelineSection.tsx, CloudSpendSection.tsx, CustomerDetailPage.tsx, dashboard/src/lib/format.ts
Description: Four separate currency formatting functions defined across files with slightly different thresholds and decimal places.
Fix: Remove all local fmt/fmtAcv/fmtFull functions. Use fmtCurrency from lib/format.ts as single source. Add fmtCurrencyFull variant for exact dollar display. Import everywhere.

### BKL-UX34 | Make pipeline opp list rows keyboard accessible
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/PipelineSection.tsx
Description: Opp list items are div elements with onClick — not keyboard-accessible. Cannot Tab to or Enter to open.
Fix: Change opp rows from div to button (w-full text-left) or add role="button" tabIndex={0} onKeyDown handler.

### BKL-UX35 | Increase donut chart size in Cloud Spend section
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/components/CloudSpendSection.tsx
Description: Donut chart is 160x160px. With 10+ accounts in legend, chart feels visually unbalanced vs the scrollable legend.
Fix: Increase chart to width=180 height=180. Set max-h-48 on legend.

### BKL-UX36 | Fix Bootstrap Save AE button hooks violation and error handling
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Decision: DONE — Extracted proper `SaveAeButton` component with useState at top level. Catch handler now shows error message via setError() instead of calling setSaved(true) on failure.

### BKL-UX37 | Add scrape status indicator tooltips with last sync time
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/App.tsx (scrape staleness indicators)
Description: Scrape status dots show colored dots and labels but no hover detail. Can't tell when last successful sync was.
Fix: Add title attributes: `title={isRunning ? 'Currently running' : lastError ? 'Last error: ...' : 'Last sync: ...'}`

### BKL-UX38 | Increase minimum touch target sizes for interactive elements
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma design audit 2026-04-01
Files: dashboard/src/index.css, Sidebar.tsx, CopyButton uses
Description: Many interactive elements smaller than 44x44px WCAG minimum (sidebar toggle ~24px, CopyButton ~24px).
Fix: Global CSS: `button, a, [role="button"] { min-height: 32px; min-width: 32px; }`. For small icon buttons add invisible padding: p-2 -m-1 pattern.

### BKL-Q09 | Customer detail page fires 14 console 404s on `/api/products/*/intel/*` endpoints
Status: ✅ DONE 2026-04-10
Severity: Medium
Source: Quinn QA 2026-04-10
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: Every customer detail page load makes product intelligence API calls for all products before checking if intel has been generated. This produces 14 console 404 errors per page load (one per product). Fix options: (a) suppress the calls until user explicitly triggers "Generate", or (b) return 200 with empty data from the endpoint instead of 404.

### BKL-Q10 | Data Sources badge flashes "All connected" briefly before health checks resolve
Status: ✅ DONE 2026-04-10 (verified already implemented — loading state prevents flash)
Severity: Low
Source: Quinn QA 2026-04-10
Files: dashboard/src/pages/SetupPage.tsx
Description: During the ~3 second health check resolution on the Setup page, the Data Sources badge can show "All connected" before it updates to the correct connected count once checks complete. Users who scan quickly during load get a false impression. Fix: initialize badge to a neutral loading state rather than optimistic "all connected".

---

## UX / Scale & Future-Proofing

### BKL-UX39 | Account Portfolio Grid — pagination, virtualization, collapsible AE groups
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: Grid renders all AccountCards simultaneously. At 200 accounts: 200 cards with O(accounts*cases) health calc per card, 10,600px vertical scroll. No search or filter. "By AE" toggle with 20 groups produces extreme scroll.
Fix: (1) Add search/filter bar: text search by name, dropdown by AE, dropdown by health status. (2) Default to "By AE" with collapsible accordion sections — each AE group shows name, count, aggregate health, chevron. (3) Virtualize with react-window or @tanstack/react-virtual. (4) Pre-compute Map<accountNumber, SupportCase[]> once at grid level, pass slices to each card.

### BKL-UX40 | Convert sidebar from scrollIntoView to route-based navigation
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/Sidebar.tsx, dashboard/src/App.tsx
Description: Sidebar uses scrollIntoView to navigate between sections on a single long page. At 20 AEs with 200 accounts, Accounts section alone exceeds viewport. No sub-navigation, no scroll-spy, no way to jump to a specific AE. Every new section added makes future migration harder.
Fix: Convert to route-based views: /dashboard (Command Center), /dashboard/pipeline, /dashboard/cloud, /dashboard/calendar, /dashboard/accounts. Sidebar items become links. If too large a refactor immediately, add scroll-spy via IntersectionObserver as interim step.

### BKL-UX41 | Add Triage grouping mode to Account Portfolio (By Health Status)
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: Current toggle: All / By AE. At 200 accounts, neither serves primary use case (triage). "By AE" forces scanning 20 groups looking for red dots.
Fix: Add third mode "Triage" to segmented control: All | By AE | Triage. Triage groups into Critical (Sev 1, expanded), Attention (open cases, expanded), Healthy (no cases, collapsed). Sort within groups by most cases first, then next meeting soonest. Make Triage default at >20 accounts.

### BKL-UX42 | Add per-AE breakdown to KPI drill-down modals
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/KPICards.tsx (modal components)
Description: KPI totals like "Open Cases: 312" are meaningless at scale without per-AE breakdown. Cases modal has customerName, accounts have ae — data exists, just not grouped.
Fix: Add AE grouping column/section to each KPI drill-down modal. No API change required — group existing modal data by ae field client-side. Long term: API returns per-AE KPI breakdowns.

### BKL-UX43 | Add compact list view to Account Portfolio (table row format)
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: Each account card ~160px tall. 200 accounts = 10,600px of scroll in 3-col grid. No sortable columns.
Fix: Add List view mode alongside Grid. List renders single-row table: [health dot] Customer Name | AE | Cases | Products | Licenses | Next Meeting. Each row ~40px. Add Grid|List toggle. Default Grid at <50 accounts, List at 50+.

### BKL-UX44 | Extensible KPI container system — replaces BKL-UX05
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/KPICards.tsx (full refactor), new: dashboard/src/types/kpi.ts, dashboard/src/components/KPISection.tsx
Description: Seven hardcoded KPICard components in grid-cols-2/4/7. Adding an 8th KPI breaks the grid. No data model, no ordering, no configurability. 434-line monolith with 5 inline modals.
Fix: (1) Define KPIDefinition interface: id, label, lane (critical/actionable/informational), type (count/currency/percent/sparkline/alert), icon, getValue, getDynamicAccent, detailComponent, order, defaultVisible. (2) Create KPISection with `flex flex-wrap gap-4` container — handles any count gracefully. Cards get min-w-[180px] max-w-[240px] flex-1. (3) Priority lanes: Critical gets border-l-2 border-l-critical, Actionable gets border-l-2 border-l-warning, Informational no accent. (4) Adding a new KPI = adding one object to array, zero layout changes.

### BKL-UX45 | KPI configuration persistence layer (localStorage now, API later)
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma scale audit 2026-04-01
Files: New: dashboard/src/hooks/useKPIPreferences.ts
Description: No mechanism to choose which KPIs are visible or their order. In 6 months with 12 available KPIs, every change requires a code edit.
Fix: Create useKPIPreferences hook with localStorage persistence: { visible: string[], hidden: string[] }. Expose getVisibleDefinitions, moveKPI, toggleKPI, resetDefaults. KPISection reads from it. Configuration UI (gear icon → popover with checklist + drag handles) deferred — build the data layer now.

### BKL-UX46 | Extract KPI detail modals into standalone components
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/KPICards.tsx → new: dashboard/src/components/kpi-details/
Description: Five modal components defined inline in KPICards.tsx with separate useState booleans per modal. Adding a new KPI modal adds more inline state + JSX.
Fix: Extract each to components/kpi-details/: CasesDetail.tsx, Sev1Detail.tsx, RenewalsRedDetail.tsx, RenewalsAmberDetail.tsx, TechWinsDetail.tsx. Each implements `{ data: KPIDatasources; onClose: () => void }`. KPISection manages single openDetailId: string | null state.

### BKL-UX47 | Sparkline KPI type for trend visualization
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma scale audit 2026-04-01
Files: New KPI type in extensible system (BKL-UX44), server.ts (/api/kpis), data/cache/kpi-history.json
Description: All KPIs are point-in-time counts. No trend visibility — can't see if cases trending up or down. At scale, directional changes matter more than absolutes.
Fix: Add sparkline KPI type rendering 64x24px inline SVG (no chart library). Server appends daily snapshots to data/cache/kpi-history.json. /api/kpis grows optional history field. Build the KPI type now, add history tracking when ready.

### BKL-UX48 | Add AE sub-navigation to sidebar
Status: ✅ DONE 2026-04-02
Severity: High
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/Sidebar.tsx
Description: Sidebar has 5 nav items with no AE-level navigation. At 20 AEs, the "By AE" toggle buried in Account Portfolio is insufficient.
Fix: Add expandable "Accounts (N)" section in sidebar listing AEs. Each AE links to filtered Account Portfolio view showing only that AE's accounts. When sidebar collapsed, hover reveals flyout panel with AE list. Depends on BKL-UX40 (route-based nav) for full implementation.

### BKL-UX49 | TopBar shows active AE context when filtered
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Aditi Sharma scale audit 2026-04-01
Files: dashboard/src/components/TopBar.tsx
Description: TopBar always shows "ASA Command Center" regardless of active filter. At scale, when viewing a single AE's accounts, no visual indication of the filtered context.
Fix: Add breadcrumb-style indicator when AE filter active: "ASA Command Center > Carolanne Farrell (12 accounts)". When no filter: show just "ASA Command Center". Driven by active filter state.

---

## Features

### BKL-F01 | SF Report Browser — browse reports instead of pasting ID
Status: ✅ DONE 2026-03-31
Severity: High
Source: Jason explicit request (memory: project_sf_report_browser.md)
Files: dashboard/src/pages/SetupPage.tsx
Description: SF Report ID is currently a bare paste field. Should be a dropdown populated from /api/sf/reports showing available pipeline reports. One shared report covers full territory.
Decision: Applied 2026-03-31 — `SfReport` type added; both `AutoBootstrapForm` wizard field and `AEsCustomersSection` edit field now fetch `/api/sf/reports` on mount and render a `<select>` dropdown when reports are available, falling back to the original text input when SF is not connected. Quinn + Rook verifying.

### BKL-F05 | Domain inference must run automatically during AE onboarding, not manually after
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason 2026-04-01 (discovered during Elmer + Carolanne onboarding)
Files: dashboard/src/pages/SetupPage.tsx (AutoBootstrapForm), src/domains.ts, server.ts (/api/setup/infer-domains)
Description: Customer email domains are critical for accurate calendar meeting matching and account detail page filtering. Currently domains must be manually triggered from the Setup page after bootstrap — there is no domain inference step during AE onboarding. Result: all customers start with no domain, calendar matching falls back to title-only which produces false positives (wrong meetings, wrong customer pills). Additionally: `workday.com` was in the blocklist (tool domain) but Workday Inc. is itself a customer — the blocklist needs a customer-override mechanism.
Fix:
  1. After Step 3 (Supportable discovery) completes in bootstrap, auto-run domain inference for all discovered customers (POST /api/setup/infer-domains internally, no separate user action needed).
  2. After inference, present top candidates in the bootstrap completion screen — one row per customer with inferred domain + confidence sources (web/calendar/gmail). Let user confirm or override before saving.
  3. Auto-save high-confidence candidates (sources include 'web' + at least one of 'calendar'/'gmail') without requiring explicit confirmation. Flag low-confidence (web-only) ones for user review.
  4. Add a customer-level domain override field in customers.json to allow specific domains that are on the global blocklist (e.g. workday.com for Workday Inc. customer).
  5. Add rebuild script (`scripts/rebuild-customers.ts`) as a documented recovery path when customers.json is corrupted.
Blocked by: None
Note: `scripts/rebuild-customers.ts` now exists — reads Accounts tab from each AE's Supportable sheet as source of truth.

### BKL-F06 | Bootstrap imports junk customer names from territory sheet — no validation
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason 2026-04-01 (Elmer bootstrap imported 105 customers including deal names, CCSP billing rows, other AEs' accounts)
Files: dashboard/src/pages/SetupPage.tsx (AutoBootstrapForm submit), src/bootstrap-orchestrator.ts (customerNames validation)
Description: When bootstrapping an AE, the territory Google Sheet is read and all tab names are sent as customerNames to the bootstrap. The territory sheet often contains the entire territory — deal-tracking entries (DSOR Renewal, Global Royalty-CCSP billing periods), other AEs' accounts, opportunity names — not just the AE's customers. The bootstrap accepts all names literally, creating 100+ junk customer entries in customers.json that corrupt the Account Portfolio, pollute calendar meeting matching, and add fake customer pills to meeting cards.
Fix:
  1. Use the Supportable sheet "Accounts" tab as the source of truth for customer names (it's authoritative — one row per real account). On bootstrap, read the AE's existing Supportable sheet first if it exists.
  2. For new AEs: validate customerNames against Supportable 360 name search before committing to customers.json. Any name that returns 0 Supportable matches and has no manual accountNumbers override gets flagged, not auto-saved.
  3. After bootstrap, auto-run `scripts/rebuild-customers.ts` logic to sync customers.json from the Accounts tab.
  4. Add customer name filter in bootstrap: reject names matching junk patterns (DSOR Renewal, Global Royalty-CCSP, dates in name, "~" separator, opportunity keywords).
Note: `scripts/rebuild-customers.ts` is the emergency recovery path — run it anytime customers.json is corrupted.

### BKL-F03 | Settings UI: expose Type 1 scrape intervals as configurable fields
Status: ✅ SUPERSEDED by BKL-M38 (Configurable intervals + Advanced UI) — 2026-04-01
See DATA-FRESHNESS.md Phase 6 and BKL-M38 for full spec including server-side floors.

### BKL-F04 | Tableau VNC window doesn't auto-close after successful login
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Jason observation 2026-03-31
Decision: DONE — `tableauVncRef.current?.close()` now called on both the success branch AND the else branch (sessionValid: false) AND the catch handler. VNC window closes whenever the connect flow completes regardless of outcome. Matches SF login pattern.

### BKL-F02 | Opportunity ID links in pipeline detail
Status: ⏸ DEFERRED — waiting on external change
Severity: Medium
Source: Memory: reference_salesforce.md
Files: src/pipeline.ts, dashboard/src/components/PipelineSection.tsx
Description: Pipeline sheet doesn't include Opportunity ID column yet. When SF report is updated to include it, wire up direct opp links in the UI.
Decision: DEFERRED until SF report includes Opportunity ID column. When ready: (1) add oppId to PipelineRecord type, (2) capture col(row, 'Opportunity ID') in parsePipelineRows, (3) wrap oppName in <a href> when oppId present.

### BKL-M56 | SF Pipeline scraper — try CSV export instead of DOM scroll+parse
Status: ✅ DONE 2026-04-03
Priority: P1
Size: S (half day)
Source: Jason 2026-04-02 — "report shows all 341 rows in one continuous page, just do CSV"
Files: src/sf-scraper.ts
Description: SF Pipeline scraper takes 11+ minutes because it clicks "Show More", scrolls the treegrid, and parses 341+ DOM rows via allTextContents(). The SF report already exists pre-built and shows all rows on one page.
  Optimization: Try clicking the SF report's Export/Download button → CSV file download → parse CSV. Same pattern as Supportable scraper's CSV download. Should take 5-10 seconds instead of 11 minutes.
  Approach: Add CSV export as primary path, keep current DOM parsing as fallback if export fails. Don't remove anything that works.
  Baseline: 11+ min (timed out in baseline test at 660s)
Related: BKL-F11 (SF dedup — also implemented)

---

### BKL-F11 | Shared SF report dedup — scrape once, fan out to multiple AE sheets + UI toggle
Status: ✅ DONE 2026-04-04 — backend dedup + per-AE row filter implemented. Rook MEDIUM: first-name substring match (e.g. "Chris" matches "Christine") — see BKL-F11b for exact-token fix. UI "share report" toggle deferred.
### BKL-F11b | SF report filter: exact token match for Opportunity Owner (Rook MEDIUM follow-up)
Status: ✅ DONE 2026-04-06 — verified already applied: scrape-api.ts lines 573+814 use .split(/\s+/).includes(aeFirstName)
Priority: P3
Size: XS (15 min)
Source: Rook scan 2026-04-04 — MEDIUM finding on F11
Files: src/scrape-api.ts
Description: BKL-F11 uses `row[ownerIdx].toLowerCase().includes(aeFirstName)` — substring match can cause false positives (AE "Chris" matches "Christine"). Change to exact-token match: `row[ownerIdx].toLowerCase().split(' ').includes(aeFirstName)` to match on whole words only.
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — observed same report 00OPe00000isU2zMAE scraped twice for two AEs
Files: src/sf-scraper.ts, src/scraper-manager.ts (runSfSyncForAes), dashboard/src/pages/SetupPage.tsx (AE config)
Description: When multiple AEs share the same sfReportId, the SF sync scrapes the report once per AE — identical Playwright navigation, DOM parsing, and wait times repeated unnecessarily. Three changes needed:
  (1) Backend dedup: Group AEs by sfReportId before syncing. Scrape each unique report once to get the full result set.
  (2) Backend filter: After scraping, filter rows by AE name (match on Opportunity Owner or equivalent column) so each AE's Google Sheet only contains their own opportunities — not the full shared report.
  (3) UI: During AE setup, add a "Share pipeline report from [dropdown of existing AEs]" toggle. When selected, auto-populate sfReportId from the selected AE instead of requiring a new report ID. Show a visual indicator (e.g., link icon) on AEs using a shared report.
Fix:
  1. In runSfSyncForAes(), group aes by sfReportId before the loop
  2. For each unique reportId: scrape once, get full parsed rows
  3. For each AE sharing that reportId: filter rows where Opportunity Owner matches AE name, write filtered rows to that AE's sheet
  4. Identify the owner column dynamically (check for "Opportunity Owner", "Owner Full Name", or similar headers)
  5. In AE setup UI: add "Share report from" dropdown that appears when other AEs already have a report configured
  6. When shared, sfReportId is copied from source AE; show "(shared with {AE name})" label
  7. If source AE's report changes, prompt whether to update linked AEs

### BKL-F10 | Research: improve morning brief effectiveness — actionable next steps per signal
Status: ✅ DONE 2026-04-04 (design) — Aditi completed. Variant C selected (CustomerSignalBanner for top signal + inline SignalActionChips for remaining signals). TopActionsPanel for morning summary. Five components spec'd: SignalActionChip, SignalPriorityBadge, CustomerSignalBanner, TopActionsPanel, SignalRow. Tailwind tokens + props documented. Implementation tracked in BKL-F10a.
Original Status: 🔴 OPEN
Priority: P2
Size: M (research + design)
Source: Jason 2026-04-02 — briefs need next steps next to each opportunity/signal to drive action
Files: src/customer.ts (brief generation prompts), dashboard/src/components/MorningSummary.tsx, docs/GEMINI-BRIEF-ARCHITECTURE.md
Description: Research ways to make the morning brief and morning summary more actionable. Current briefs surface signals (renewals, cases, pipeline) but don't tell the SA what to DO about each one. Wants next steps alongside each flagged opportunity or signal — e.g., "Renewal expiring in 30d → Schedule renewal review with AE" or "New Sev1 case → Check case status, prep customer call." Research should cover: (1) How best-in-class sales intelligence tools present actionable next steps alongside signals, (2) AI-generated vs rule-based next steps, (3) Scannable in <30 seconds while including actions, (4) Clickable actions (open calendar, draft email, link to case), (5) Other effectiveness improvements — priority ordering, severity badges, time-sensitivity, "if you do one thing today" highlight.
Fix:
  1. Research: extensive research on actionable intelligence brief patterns
  2. Design: Aditi designs next-step UI patterns for morning summary + per-customer brief
  3. Update Gemini brief prompt to generate specific next-step recommendations per signal
  4. Update morning summary to include recommended action per signal row
  5. Consider: rule-based for common patterns (renewal → schedule review) + AI-generated for novel situations
  6. SF pipeline data: investigate adding Next Steps, Stage, Activity Notes columns to SF report. If available, pipeline-stuck signals can show the actual next step from Salesforce instead of generic "review pipeline"
  7. Jason confirmed "Meeting Notes" column added to SF report (2026-04-02). This is free-text from AE meeting recaps — rich signal but needs summarization.
  8. UX design needed (Aditi): how to surface meeting notes without overwhelming the UI. Options: truncated preview with expand, Gemini-summarized to 1-2 sentences, tooltip on hover, dedicated "Recent Activity" tab on customer detail. Meeting notes + next steps together = the SA prep workflow.
  9. Scraper change needed: add "Meeting Notes" and "Industry" columns to SF scraper column extraction in src/sf-scraper.ts. Parse and store alongside existing pipeline fields.
  10. Jason confirmed "Industry" column added to SF report (2026-04-02). This enables automatic industry-per-customer detection from live SF data — supplements or replaces AI01's web search approach. Industry from SF is authoritative (CRM-maintained) vs AI-inferred.

### BKL-F10b | Wire real signal data to F10a components — replace mock data
Status: ✅ DONE 2026-04-05 — TopActionsPanel now uses morningSummaryApi signals (case signals first, then meeting-prep, then alpha). Case URL chip + Google Calendar create-event chip per action. Commit 9a1a5c1.
Priority: P2
Size: S (half day)
Source: Quinn QA validation 2026-04-05 — components pass, data pipeline not connected
Files: dashboard/src/App.tsx (TopActionsPanel mock→real), dashboard/src/pages/CustomerDetailPage.tsx (CustomerSignalBanner priorityAction gate)
Description: F10a components are built and correct. Two wiring gaps remain:
  1. TopActionsPanel (App.tsx:272) uses hardcoded mock data (Acme Corp, Globex, Initech). Replace with real signal aggregation from /api/accounts — sort by: (1) days to hard deadline, (2) case severity, (3) pipeline ARR.
  2. CustomerSignalBanner (CustomerDetailPage.tsx:1310) is gated by `{priorityAction && ...}`. The brief API generates a Priority Action section in the brief text, but `priorityAction` as a structured field on the customer object is not populated. Extract/parse priorityAction from brief response or add as a derived field in the brief cache. Currently no customers show the banner.

---

### BKL-F10a | Implement F10 signal-action UI — Variant C + TopActionsPanel
Status: ✅ DONE 2026-04-05 — All 5 components built and in production. Quinn validated: code correct, build clean, API 200. See BKL-F10b for data wiring.
Priority: P2
Size: M (half day)
Source: Aditi design output 2026-04-04
Files: dashboard/src/components/ (5 new), dashboard/src/components/MorningSummary.tsx, dashboard/src/pages/CustomerDetailPage.tsx
Description: Implement Aditi's Variant C design from BKL-F10 research. Components to build:
  1. SignalActionChip — inline action button (Calendar | Case | Salesforce | Email), props: label/href/variant
  2. SignalPriorityBadge — colored dot + text (urgent=red / this-week=amber / fyi=muted), no icon
  3. CustomerSignalBanner — "do this today" highlighted banner, amber/cyan left border, star icon, up to 3 action chips. Appears ONLY for highest-priority signal (no banner inflation).
  4. TopActionsPanel — cross-customer top 3 ranked by: (1) days to hard deadline, (2) case severity, (3) pipeline ARR. Inserts above customer grid in MorningSummary.
  5. SignalRow — single signal row wrapping PriorityBadge + text + optional ActionChip.
  Tailwind tokens: bg-[#161b22], text-[#00BCD4] for accent, text-red-400/amber-400 for urgency. Dark theme only.
  Action URLs: Calendar → Google Calendar create-event, Case → RH portal case URL, Opp → Salesforce opp URL. All open in new tab with rel=noopener.

---

### BKL-F09 | Setup page Sync status may not reflect API/scheduler-triggered scrapes
Status: ✅ DONE 2026-04-03 (fully solved by BKL-G22 — SetupPage polls /api/scraper-status every 3s, covers all 4 scrapers + all trigger sources)
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — observed CCSP sync possibly not showing as running on Setup page
Files: dashboard/src/pages/SetupPage.tsx (CCSP status polling), src/scrape-api.ts (status endpoints)
Description: When a scrape is triggered from the Admin page or background scheduler (POST /api/scrape/ccsp), the Setup Data Sources page should show it as running. The Setup page polls GET /api/scrape/ccsp/status which returns server-side ccspScrapeRunning || ccspInFlight. However, the Setup page "Sync Now" button calls /api/refresh/ccsp (cache-only, no server flag) — so there may be confusion between the two endpoints. Additionally, the polling interval may be too slow to catch short scrapes. Investigate: (1) confirm Setup page polling picks up Admin-triggered scrapes, (2) ensure all 4 sync types (RH Cases, Supportable, CCSP, SF Pipeline) show running state regardless of trigger source, (3) consider adding SSE or faster polling for sync status.
Fix:
  1. Verify Setup page polls /api/scrape/ccsp/status (not just local state)
  2. Test: trigger scrape from Admin, observe Setup page — does it show running?
  3. If not: ensure Setup page uses server-side running flag, not just local ccspScraping state
  4. Consider unifying "Sync Now" on Setup page to call the full scrape endpoint (with confirmation) instead of cache-only refresh
  5. Check polling interval — may need to be shorter during active scrapes

### BKL-F08 | VNC window flash-closes on Connect — BKL-F04 close() too aggressive
Status: ✅ DONE 2026-04-02
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-02 — VNC flashes and goes away on Tableau/any connect; Quinn + Marcus confirmed root cause
Files: dashboard/src/pages/SetupPage.tsx (handleTableauConnect, lines 2116-2162)
Regression from: BKL-F04 (added .close() on all branches — success, failure, and catch)
Description: BKL-F04 added tableauVncRef.current?.close() on every response from wait-for-login — not just on successful login. The wait-for-login endpoint returns in ~8 seconds (or instantly if no live page exists), then .then() fires .close() before the user can interact with the VNC window. The VNC window opens and closes within seconds regardless of outcome. Same issue likely affects SF and RH Portal VNC flows if they share the pattern.
Fix:
  1. Only call .close() when sessionValid is true (line 2154) — successful login confirmed
  2. Remove .close() from the else branch (sessionValid: false) — leave window open for user to retry
  3. Remove .close() from .catch() handler (line 2159) — leave window open on network error
  4. Verify SF login pattern (lines 2087-2101) doesn't have the same issue — SF uses polling loop, may be fine
  5. Test: click Connect, confirm VNC stays open until login completes or user closes manually

### BKL-F07 | Accept full Salesforce report URL instead of requiring bare report ID
Status: ✅ DONE 2026-04-02
Priority: P1
Size: S (half day)
Source: Jason 2026-04-02 — cumbersome for new users, doesn't present as quality product
Files: dashboard/src/pages/SetupPage.tsx (SF report field), server.ts (SF report endpoints), src/sf-scraper.ts
Description: Currently users must find a Salesforce report, copy the URL, then manually extract the report ID from the URL before pasting it. This is a bad UX — users should be able to paste the full SF report URL (e.g., https://redhat.lightning.force.com/lightning/r/Report/00OPQ000001abc/view) and the system extracts the report ID automatically. The SF Report Browser (BKL-F01) helps when SF is connected, but for initial setup or when pasting a shared link, accepting a full URL is the natural flow.
Fix:
  1. Research: identify all SF report URL formats (Lightning, Classic, embedded, with/without /view suffix)
  2. Add URL parser that extracts report ID from any valid SF report URL format
  3. Accept BOTH full URLs and bare report IDs in the input field
  4. Update placeholder text: "Paste Salesforce report URL or ID"
  5. Show parsed report ID as confirmation after paste (e.g., "Report ID: 00OPQ000001abc ✓")
  6. Validate format before saving — reject obviously invalid strings

## Account Intelligence Pipeline (from 2026-04-02 research synthesis)

### BKL-AI01 | Web search to identify industry/segment per customer + cache
Status: ✅ DONE 2026-04-02
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — account intelligence prompt pipeline; 3-agent extensive research
Files: src/account-intelligence.ts (new), data/config/customers.json
Description: For each customer, use Gemini with Google Search grounding to determine industry and segment. Cache the result in customers.json so we don't re-search every run. This is the foundation for templating both intelligence prompts.
Fix:
  1. Create src/account-intelligence.ts with determineIndustry(customerName) function
  2. Use Gemini with tools: [{ googleSearch: {} }] to identify industry + segment
  3. Cache industry/segment in customers.json per customer
  4. Skip search if customer already has industry cached
  5. Expose via GET /api/customer/:name/industry for frontend use

### BKL-AI02 | Gemini generation — Company Intelligence brief with grounding
Status: ✅ DONE 2026-04-02
Priority: P2
Size: M (1-2 days)
Source: Jason 2026-04-02 — improved Prompt 1 from 3-agent research synthesis
Files: src/account-intelligence.ts
Depends on: BKL-AI01 (needs industry/segment)
Description: Run improved Company Intelligence prompt through Gemini with Google Search grounding (40% hallucination reduction). Uses PTCF structure, thinkingLevel HIGH, atomic claim citations, anti-pattern guardrails, "earned recommendation" pattern for Red Hat product fit, and PESTLE→SWOT ordering. Multi-pass: generate → verify → finalize.
Research: Prompt template at ~/.claude/MEMORY/RESEARCH/2026-04/improved-account-intelligence-prompts.md
Fix:
  1. Template Prompt 1 with customer name, industry, AE name, relationship notes
  2. Call Gemini with tools: [{ googleSearch: {} }], thinkingLevel: "HIGH"
  3. Post-generation verification pass (financial claims, leadership names, source freshness)
  4. Return structured markdown ready for Google Docs

### BKL-AI03 | Gemini generation — Industry Technology Analysis with grounding
Status: ✅ DONE 2026-04-02
Priority: P2
Size: M (1-2 days)
Source: Jason 2026-04-02 — improved Prompt 2 from 3-agent research synthesis
Files: src/account-intelligence.ts
Depends on: BKL-AI01 (needs industry/segment)
Description: Run improved Industry Technology Analysis prompt through Gemini with grounding. Auto-selects all subsegments. Includes regional parity rules, emerging tech deep-dive (6 categories), technology adoption chain, vendor ecosystem mapping. Per-customer doc even if customers share industry. Geographic balance enforced with gap disclosure.
Research: Prompt template at ~/.claude/MEMORY/RESEARCH/2026-04/improved-account-intelligence-prompts.md
Fix:
  1. Template Prompt 2 with customer name, industry, date
  2. Single-pass generation (subsegment identification + full report in one call)
  3. Call Gemini with tools: [{ googleSearch: {} }], thinkingLevel: "HIGH"
  4. Post-generation verification pass for geographic balance and citation quality
  5. Return structured markdown ready for Google Docs

### BKL-AI04 | Create Account Intelligence subfolder + Google Docs via Drive API
Status: ✅ DONE 2026-04-02
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — docs in {customer_folder}/Account Intelligence/
Files: src/account-intelligence.ts, src/google.ts (Drive API)
Depends on: BKL-AI02, BKL-AI03 (needs generated content)
Description: For each customer, create "Account Intelligence" subfolder in their Drive folder. Write two Google Docs: "{Customer} - Company Intelligence" and "{Customer} - Industry Analysis". **Always regenerate content regardless of whether folder/docs already exist** — this is a "refresh" operation, not "create once". The same files get updated with fresh intelligence on every run.
Fix:
  1. Find customer's Drive folder from customers.json or aes.json driveFolderId
  2. Check for existing "Account Intelligence" subfolder; create via Drive API if missing
  3. Check for existing docs by name; **update content in place if found** (clear + rewrite), create if not
  4. Use Docs API batchUpdate with markdown-to-Docs formatting (## headings, tables, [text](url) citations)
  5. Return Google Doc URLs for dashboard linking
  6. Never skip generation because files exist — always run the Gemini prompts and overwrite with fresh content

### BKL-AI05 | Dashboard UI — per-customer Generate Intelligence button + doc links
Status: ✅ DONE 2026-04-02
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — button placement decided by Aditi + Quinn
Files: dashboard/src/pages/CustomerDetailPage.tsx, server.ts (new endpoints)
Depends on: BKL-AI04 (needs Drive write capability)
Description: Add UI to Customer Detail Page for generating and viewing account intelligence docs. Aditi (design) and Quinn (QA) decide placement. Show doc status (exists/generating/missing), last generated date, and direct Google Doc links.
Fix:
  1. POST /api/customer/:name/generate-intelligence — triggers async generation pipeline
  2. GET /api/customer/:name/intelligence-status — returns doc URLs, dates, generation status
  3. Frontend: button to trigger, loading state, links to Google Docs when ready
  4. Show progress (industry lookup → company brief → industry analysis → Drive write)

### BKL-AI06 | Batch "Generate All" from Admin/Settings page
Status: ✅ DONE
Priority: P3
Size: S (half day)
Source: Jason 2026-04-02 — batch generation for full portfolio
Files: dashboard/src/pages/SetupPage.tsx or Admin page, server.ts
Depends on: BKL-AI05 (needs per-customer generation working)
Description: "Generate All Account Intelligence" button on Admin or Settings page. Sequential execution with rate-limit delays. Progress indicator. Skip customers with recent docs (< 30 days) unless force=true.
Fix:
  1. POST /api/intelligence/generate-all — triggers batch generation
  2. GET /api/intelligence/batch-status — returns progress (completed/total/current/errors)
  3. Sequential execution with 2-second delay between customers (Gemini rate limits)
  4. Frontend: progress bar, current customer name, error count, cancel button

### BKL-AI07 | Auto-generate intelligence docs during bootstrap
Status: ✅ DONE 2026-04-04
Priority: P3
Size: XS (30 min)
Source: Jason 2026-04-02 — new users should get this automatically during setup
Files: src/bootstrap-orchestrator.ts
Depends on: BKL-AI06 (needs batch generation)
Description: After bootstrap customer discovery (Step 3), auto-trigger account intelligence generation for all discovered customers as a background non-blocking task. New users get intelligence docs without manual steps.
Decision: DONE — non-blocking fetch POST to /api/intelligence/generate-all fired at end of bootstrap (after autoBootstrapState.running = false). Logs status code on success, warns on failure without blocking bootstrap.

### BKL-AI08 | Wire Account Intelligence docs into brief generation pipeline
Status: ✅ DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: Jason 2026-04-02 — current code should leverage the intelligence data
Files: src/doc-extraction.ts, src/customer.ts
Description: The existing Drive doc fetcher already crawls subfolders (customer.ts:246-277, depth=5) and feeds docs into classifyDocs(). Update classifyDocs() to recognize Account Intelligence docs as high-value strategic context and score them highly. This ensures SWOT findings, competitive positioning, trigger events, and product-fit insights flow into daily briefs automatically.
Decision: DONE — added COMPANY_INTELLIGENCE and INDUSTRY_ANALYSIS to DocClassification type union; added strategic_signals field (swot/trigger_event/product_fit); updated prompt and schema; emitted strategic_signals XML with priority="high" in buildXmlSources for these doc types. TSC clean.

### BKL-E01 | Add gmail.send scope to OAuth + reauth flow
Status: ✅ DONE 2026-04-03 (Marcus: gmail.send in NORMAL_SCOPES + BOOTSTRAP_SCOPES)
Priority: P2
Size: XS (30 min)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: src/google.ts (OAuth scope list), config/.google-token.json
Description: Current OAuth token only has gmail.readonly scope. Email sending requires gmail.send. Add the scope to the OAuth scope list so next reauth picks it up. User re-consents once.
Fix:
  1. Add `https://www.googleapis.com/auth/gmail.send` to SCOPES array in src/google.ts
  2. On next OAuth flow, user consents to new scope
  3. Verify token includes gmail.send after reauth

### BKL-E02 | sendBriefEmail() function — MIME build + Gmail API POST
Status: ✅ DONE 2026-04-03 (Marcus: sendBriefEmail() with MIME + Gmail POST in email-sender.ts)
Priority: P2
Size: S (half day)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: src/email-sender.ts (new)
Depends on: BKL-E01 (needs gmail.send scope)
Description: Port the ~20-line send_email() from MorningBrief Python skill to TypeScript. Build MIME multipart message (From, To, Subject, HTML body), base64url encode, POST to Gmail API. Use existing OAuth token from src/google.ts. No external libraries needed — raw fetch().
Fix:
  1. Create src/email-sender.ts with sendBriefEmail(to, subject, htmlBody) function
  2. MIME multipart construction with Content-Type: text/html
  3. Base64url encode and POST to https://gmail.googleapis.com/gmail/v1/users/me/messages/send
  4. Error handling with sanitizeErr() — never leak raw Gmail errors to client

### BKL-E03 | Port HTML email template from Python to TypeScript
Status: ✅ DONE 2026-04-03 (Marcus: email-template.ts + BriefEmailData interface exists)
Priority: P2
Size: M (1 day)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: src/email-template.ts (new)
Depends on: BKL-E02 (needs sendBriefEmail to deliver)
Description: Port email_templates_v3.py dark theme template to TypeScript template literals. 4-section layout (meetings, emails, cases, pipeline). Table-based for Gmail compatibility, inline CSS only. Reference existing design at ~/.claude/skills/MorningBrief/Tools/email_templates_v3.py.
Fix:
  1. Create src/email-template.ts exporting renderBriefHtml(briefData)
  2. Dark theme (#0d0d0d, #111, #161616), blue/teal accents, no red
  3. Table-based layout, inline CSS only (Gmail compatibility)
  4. Meeting cards, email rows with urgency indicators, case/pipeline sections
  5. Graceful empty states per section

### BKL-E04 | Email settings UI on Settings page
Status: ✅ DONE 2026-04-03 (Marcus: imported EmailSettingsSection into settings accordion in SetupPage.tsx)
Priority: P2
Size: S (half day)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: dashboard/src/pages/SetupPage.tsx or dashboard/src/components/EmailSettingsSection.tsx (new)
Depends on: BKL-E05 (needs settings API to read/write)
Description: Add Morning Brief Delivery section to dashboard settings. Delivery time picker, email address field, section toggles (meetings/emails/cases/pipeline), master on/off toggle. Reads/writes via /api/settings/email endpoint.
Fix:
  1. Create EmailSettingsSection component with toggle, time picker, email input, section checkboxes
  2. Fetch current settings from GET /api/settings/email on mount
  3. Save via PUT /api/settings/email on change
  4. Match existing settings page design patterns (design tokens, spacing)

### BKL-E05 | Email settings API — GET/PUT /api/settings/email
Status: ✅ DONE 2026-04-03 (Marcus: GET + PUT /api/settings/email handlers in server.ts)
Priority: P2
Size: XS (30 min)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: server.ts, data/config/email-settings.json (new)
Description: REST endpoints to read/write email delivery config. Config stored in data/config/email-settings.json alongside existing data-sources.json. Schema matches MorningBrief Config/schema.json delivery + sections shape.
Fix:
  1. GET /api/settings/email — read and return email-settings.json (default: disabled, 7am ET weekdays)
  2. PUT /api/settings/email — validate and write email-settings.json with mode 0o600
  3. Validate email format, cron expression, timezone string
  4. sanitizeErr() on all error responses

### BKL-E06 | Wire background-scheduler to trigger email delivery
Status: ✅ DONE 2026-04-03 (scheduleEmailDelivery() added to background-scheduler.ts; reads email-settings.json per cycle, renders HTML, sends via sendBriefEmail())
Priority: P2
Size: S (half day)
Source: Daily brief email integration — Serena architecture review 2026-04-02
Files: src/background-scheduler.ts, src/email-sender.ts
Depends on: BKL-E02, BKL-E03, BKL-E05
Description: Add email delivery trigger to existing background-scheduler.ts. Reads email-settings.json for schedule/enabled state. Uses same self-rescheduling setTimeout pattern as brief generation and SF sync. Assembles brief data from cached briefs, renders HTML template, sends via sendBriefEmail().
Fix:
  1. Add scheduleEmailDelivery() to background-scheduler.ts
  2. Read email-settings.json for enabled, schedule, timezone, email address, section toggles
  3. At scheduled time: aggregate cached briefs → renderBriefHtml() → sendBriefEmail()
  4. Log success/failure, surface last-send status via /api/settings/email response
  5. Re-read config on each cycle (supports live changes from settings UI without restart)

## UI Spec Compliance Gaps (from 2026-04-02 Quinn visual audit)

### BKL-G01 | Morning Summary signals not clickable — no navigation to customer detail
Status: ✅ DONE 2026-04-03 (Quinn: signal clicks navigate to customer detail)
Priority: P1
Size: S (half day)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: dashboard/src/components/MorningSummary.tsx
Description: Morning Summary signal rows display but are not clickable. Spec requires each signal to navigate to the relevant customer detail page. This is the core morning review workflow — scan signals, click to investigate. Currently a dead end.
Fix:
  1. Wrap each signal row in a clickable link/button that navigates to /customer/:name
  2. Add hover state and cursor-pointer
  3. Pass customer name from signal data to navigation

### BKL-G02 | Morning Summary only generates renewal signals — 8 of 9 signal types missing
Status: ✅ DONE 2026-04-04 — All 9 signal types now live: Sev1/Sev2 cases, renewal, gone-silent, engagement, pipeline-stuck, competitor, cloud-anomaly, meeting-prep. Signal #8 (meeting-prep) added 2026-04-04: fetchCalendar() called in morning-summary route, filters today's events with needsPrep=true, generates medium-severity signal.
Priority: P1
Size: M (2-3 days)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: server.ts (/api/morning-summary), src/morning-summary.ts or equivalent
Related: BKL-R06 (initial morning summary — DONE, but only renewal signals implemented)
Description: The morning summary endpoint only generates renewal-type signals. Missing: Sev1/Sev2 new cases, gone-silent contacts, competitor mentions, pipeline deal stuck >30d, engagement drops, cloud spend anomalies, meeting prep needed, subscription expiring <60d with no renewal opp. The spec and research (BKL-R06) defined 9 signal types; only 1 is live.
Fix:
  1. Add Sev1/Sev2 case signals from cached case data
  2. Add gone-silent signals from detectGoneSilent() (already exists in email-extraction.ts)
  3. Add competitor mention signals from brief competitive signals parsing
  4. Add pipeline stuck signals from pipeline cache (closeDate >30d past)
  5. Add meeting-today-with-prep-needed signals from calendar data
  6. Add subscription expiring signals from subscription cache
  7. Rank all signals by priority per BKL-R06 spec

### BKL-G03 | PriorityActionBanner has no action buttons (Schedule/View/Dismiss)
Status: ✅ DONE 2026-04-03 (Quinn: Schedule/View/Dismiss buttons present on banner)
Priority: P2
Size: S (half day)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md, DESIGN-SPEC-AccountDetailPage.md
Files: dashboard/src/components/PriorityActionBanner.tsx
Description: Banner shows the priority action text and source but provides no way to act on it. Spec requires Schedule, View, and Dismiss buttons. Without them the banner is informational only — the user must manually find the relevant email, case, or meeting.
Fix:
  1. Add action buttons row: Schedule (opens calendar), View (navigates to source), Dismiss (hides until next brief)
  2. Dismiss state persisted in localStorage or via API
  3. View button links to source (email, case URL, meeting) when available

### BKL-G04 | StakeholderEngagementPanel missing frequency bar visualization
Status: ✅ DONE 2026-04-04 (Marcus audit: FrequencyBar fully implemented in StakeholderEngagementPanel.tsx)
Priority: P2
Size: S (half day)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md, VISUAL-DESIGN-SPEC.md
Files: dashboard/src/components/StakeholderEngagementPanel.tsx
Description: Panel shows contacts with tiny color dots and "Silent Xd" badges, but no frequency bar visualization showing engagement trend over time. The spec calls for horizontal bars showing email/meeting frequency per contact. Without them, "gone silent" is a binary badge instead of a visible trend.
Fix:
  1. Add horizontal frequency bars per contact (last 30/60/90d email + meeting count)
  2. Color gradient from healthy (green) to silent (red/gray)
  3. Data already available from buildContactHistory() — just needs visualization

### BKL-G05 | Customer detail header stat row missing Cloud$ and Pipeline ACV + sparklines
Status: ✅ DONE 2026-04-04 (Marcus audit: Cloud$ and Pipeline ACV stats confirmed at CustomerDetailPage.tsx lines 1740-1767)
Priority: P2
Size: S (half day)
Source: Quinn visual audit 2026-04-02 — compared against DESIGN-SPEC-AccountDetailPage.md
Files: dashboard/src/pages/CustomerDetailPage.tsx (header section)
Description: Header stat row shows Cases, Products, Licenses but omits Cloud$ and Pipeline ACV per spec. Also no sparklines in stat badges. Spec calls for 5 stat badges with inline trend sparklines for at-a-glance directional context.
Fix:
  1. Add Cloud$ stat from CCSP cache data
  2. Add Pipeline ACV stat from pipeline cache data
  3. Add 32x12px inline SVG sparklines per stat badge using historical data
  4. Header height to h-16 per spec (currently h-12)

### BKL-G06 | Sidebar missing Morning Summary nav item + wrong order
Status: ✅ DONE 2026-04-03 (Quinn: Morning Summary is first sidebar nav item)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against INFORMATION-ARCHITECTURE-V2.md
Files: dashboard/src/components/Sidebar.tsx
Description: Sidebar has no "Morning Summary" nav item. Spec requires it as first item for scroll-anchor navigation. Current order (Command Center → Pipeline → Cloud → Calendar → Accounts) differs from spec which puts Morning Summary first.
Fix:
  1. Add Morning Summary nav item at top of sidebar
  2. Wire click to scroll to MorningSummary section on dashboard home
  3. Reorder nav items to match spec hierarchy

### BKL-G07 | TemporalDeltaSection shows section names only, not content-level diffs
Status: ✅ DONE 2026-04-04
Priority: P2
Size: M (1-2 days)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: server.ts (/api/customer/:name/temporal-delta), dashboard/src/components/TemporalDeltaSection.tsx
Related: BKL-R07 (delta detection — DONE, but section-level only)
Description: Current implementation compares section headers between briefs and reports "Priority Action — New section added." Spec wants content-level deltas: "▲ New Sev2 case opened for Satellite," "▲ Pipeline ACV increased $50K." The section-level granularity provides low signal value.
Fix:
  1. Enhance temporal-delta endpoint to diff within sections, not just detect section presence
  2. Extract key facts (case count changes, dollar amounts, new names) from section text
  3. Add ▲ triangle markers on changed items per spec
  4. Return structured change objects with type (new/changed/removed) and summary text

### BKL-G08 | Brief generation HTTP 500 on some customers
Status: ✅ DONE 2026-04-04 — callLLMStructured now checks for empty text before JSON.parse; throws descriptive error with finishReason, callType, customerName
Priority: P1
Size: S (1 day)
Source: Quinn visual audit 2026-04-02 — observed during customer detail page testing
Files: src/customer.ts (generateBrief), server.ts (/api/customer/:name/brief)
Description: Brief generation fails with HTTP 500 for some customers, blocking source citations and competitive signals from rendering. Root cause unknown — may be Gemini API errors, missing data, or edge cases in sub-pipeline processing.
Fix:
  1. Add structured error logging to identify which customers fail and why
  2. Check if failures are Gemini quota/rate-limit, missing data fields, or sub-pipeline errors
  3. Ensure graceful degradation — partial brief with available data instead of full 500

### BKL-G09 | KPI sparklines use static color instead of trend-direction coloring
Status: ✅ DONE 2026-04-03 (SparklineKPI.tsx: computeTrend() + SPARK_UP/SPARK_DOWN/SPARK_NEUTRAL on polyline stroke; color prop ignored in favor of trendColor; invertTrend prop used on openCases/sev1Cases cards; tsc clean)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against VISUAL-DESIGN-SPEC.md
Files: dashboard/src/components/KPICards.tsx
Related: BKL-UX47 (sparkline type — DONE, but color is static)
Description: Sparkline polylines use the card's static accent color. Spec calls for dynamic trend-direction coloring: green (spark-up) for improving metrics, red (spark-down) for worsening. Currently no visual distinction between a metric trending better vs worse.
Fix:
  1. Compute trend direction from sparkline data (last N points slope)
  2. Apply spark-up (green) or spark-down (red) color to polyline stroke
  3. Neutral color for flat trends

### BKL-G10 | Bootstrap CompletionCard lacks clickable resource links
Status: ✅ DONE 2026-04-03 (SetupPage.tsx lines 618-628: <a href> links with target="_blank" rel="noopener noreferrer" for driveFolder, supportableSheet, ccspSheet, pipelineSheet; fallback extracts IDs from step details; tsc clean)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against auto-bootstrap-ui-spec.md
Files: dashboard/src/pages/SetupPage.tsx (CompletionCard section)
Description: CompletionCard shows step detail text (e.g., "Google Sheet created: [sheet name]") as plain text spans. Spec requires clickable `<a href>` links to the created Google Sheets, Drive folders, and other resources so the user can verify what was set up.
Fix:
  1. Wrap resource references in CompletionCard with `<a href>` to actual Google Sheet/Drive URLs
  2. URLs already available from bootstrap response data — just need rendering as links
  3. Add target="_blank" rel="noopener" for external links

### BKL-G11 | KPI sparklines missing on Meetings Today and Meetings This Week cards
Status: ✅ DONE 2026-04-03 (kpi-history.ts: meetingsToday/meetingsThisWeek in DailySnapshot; captureSnapshot() accepts both params; background-scheduler.ts fetches calendar counts; App.tsx sparklineHistory maps both fields; KPICards passes sparklineHistory?.meetingsToday/meetingsThisWeek; tsc clean)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: dashboard/src/components/KPICards.tsx, server.ts (/api/kpis/history)
Description: Sparklines render on 5 KPI cards (Open Cases, Sev1, Expiring, Renewals, Tech Wins) but not on Meetings Today and Meetings This Week. These meeting counts also benefit from trend visibility (is meeting load increasing?).
Fix:
  1. Add meetingsToday and meetingsThisWeek to KPI history snapshots
  2. Pass sparklineData to meeting KPI cards
  3. Render sparkline polyline same as other cards

### BKL-G12 | HealthDot hover tooltip does not show score breakdown
Status: ✅ DONE 2026-04-03 (hover tooltip implemented via showTooltip state; always-visible panel removed)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: dashboard/src/components/AccountPortfolioGrid.tsx (HealthDot)
Description: HealthDot shows a color-coded dot on account cards but hovering does not reveal the composite score breakdown (which of the 6 signals contributed, individual scores). Spec requires a tooltip showing score/100 and signal breakdown on hover.
Fix:
  1. Add hover tooltip (or popover) to HealthDot
  2. Show composite score (e.g., "78/100") and per-signal scores
  3. Data already available from /api/health-scores — pass breakdown to tooltip

### BKL-G13 | Customer detail header missing numeric health score
Status: ✅ DONE 2026-04-03 (Quinn: numeric health score 55/100 confirmed)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against DESIGN-SPEC-AccountDetailPage.md
Files: dashboard/src/pages/CustomerDetailPage.tsx (header)
Description: Customer detail header shows health color dot but no numeric score (e.g., "78/100"). Spec calls for the score displayed alongside the dot in the header for quick reference.
Fix:
  1. Display health score number next to HealthDot in customer detail header
  2. Score already fetched via HealthScoreHero — reuse data in header

### BKL-G14 | StakeholderEngagementPanel in wrong column — LEFT instead of spec RIGHT
Status: ✅ DONE 2026-04-03 (Quinn: StakeholderPanel in right column confirmed)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against DESIGN-SPEC-AccountDetailPage.md
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: Two-column layout is 65%/35%. StakeholderEngagementPanel is in the left (main content) column. Spec places it in the right (sticky sidebar) column alongside HealthScoreHero for persistent visibility during scroll.
Fix:
  1. Move StakeholderEngagementPanel from left column to right column
  2. Ensure it scrolls naturally within the sticky right column below HealthScoreHero

### BKL-G15 | Setup page missing accessibility: elapsed timer, aria-labels, role="alert"
Status: ✅ DONE 2026-04-03 (Marcus: elapsed timer at lines 517-554, aria-labels on step icons at 537-543, role="alert" on all 4 Sync error messages in DataSourcesSection)
Priority: P3
Size: XS (30 min)
Source: Quinn visual audit 2026-04-02 — compared against auto-bootstrap-ui-spec.md
Files: dashboard/src/pages/SetupPage.tsx
Description: Three accessibility gaps: (1) No elapsed time timer during bootstrap running state, (2) No aria-label on step status icons, (3) No role="alert" on error messages. Spec requires all three for accessibility compliance.
Fix:
  1. Add elapsed time counter (mm:ss) visible during bootstrap execution
  2. Add aria-label to each step icon (e.g., "Step 3: Complete")
  3. Add role="alert" to error message containers

### BKL-G16 | Brief section order follows AI output, not spec-mandated hierarchy
Status: ✅ DONE 2026-04-03 (Quinn: fixed section order confirmed)
Priority: P3
Size: S (half day)
Source: Quinn visual audit 2026-04-02 — compared against UNIFIED-REDESIGN-SPEC.md
Files: dashboard/src/pages/CustomerDetailPage.tsx (BriefSection rendering)
Description: Brief sections render in whatever order Gemini outputs them. Spec defines a fixed hierarchy: Priority Action → What Changed → Key Risks → Competitive Signals → Meetings → Pipeline → Cases → Subscriptions. Consistent order builds muscle memory for scanning.
Fix:
  1. Parse brief sections by heading (## markers)
  2. Reorder parsed sections to match spec hierarchy
  3. Unknown sections appended at end

---

### BKL-BOOT-CCSP-SHEET-SKIP-01 — L3 short-circuit skipped CCSP sheet write for second AE
- **Status:** DONE 2026-04-29
- **Priority:** P0
- **Symptom:** Second AE (Elmer) bootstrapped with L3 hit but never appeared in CCSP dashboard. No `ccspSheetId` saved.
- **Root cause:** `checkCcspL3Exists` pre-check in bootstrap set step 4 done and returned early, skipping `runCcspScrape` and `writeCcspSheet`. Drive CSV exists = skip everything, including sheet write.
- **Fix:** Removed `checkCcspL3Exists` pre-check entirely. `runCcspScrape` already handles L3 via `_podCsvCache` (no Tableau scrape when in-memory cache warm) and Drive CSV check internally. Sheet write now always happens.

### BKL-CONN-TABLEAU-CCSP-HANG-01 — CCSP L4 bootstrap hang after Tableau SSO login
- **Status:** DONE 2026-04-29
- **Priority:** P0
- **Symptom:** Bootstrap step 4 (Create CCSP Sheet) timed out at 300s. Zero `[ccsp]` logs after the L3 marker.
- **Root cause:** `waitForTableauLogin` closes `activePage` but leaves the SSO new tab (Tableau dashboard) open in the shared context. `runCcspScrape` → `restoreTableauSession` → `ctx.cookies()` hangs with this live Tableau tab present.
- **Fix:** (1) `_closeContext` now closes SSO Tableau tabs after cookie harvest; (2) `restoreTableauSession` wraps `ctx.cookies()` in 10s timeout as defense-in-depth; (3) mutex (`loginInProgress`/`setLivePageBusy`) release moved to AFTER tab cleanup so no concurrent scrape slips through.
- **Regression test:** Manual CCSP scrape immediately after Tableau login should produce `[ccsp] runCcspScrape: processing AE` within 15s (no 300s hang).

### BKL-CONN-TABLEAU-SSO-PREDICATE-01 — `_closeContext` SSO tab predicate too broad (council P2)
- **Status:** OPEN
- **Priority:** P2
- **Symptom:** `_closeContext` closes any page matching `10ay.online.tableau.com/site/.*/views/` — this would also close an active CCSP scrape page if a Tableau login completes concurrently.
- **Recommendation (Serena):** Track pages opened during login explicitly in a Set; close only those pages, not URL-matched pages.
- **When to fix:** Before enabling concurrent logins or multi-AE parallel scrapes.

### BKL-CONN-TABLEAU-STORAGE-STATE-TIMEOUT-01 — `ctx.storageState()` undefended in `_closeContext` (council P2)
- **Status:** OPEN
- **Priority:** P2
- **Symptom:** `_closeContext` calls `ctx.storageState()` without a timeout. If context is wedged at harvest time, `waitForTableauLogin` hangs indefinitely.
- **Recommendation (Serena):** Apply same `Promise.race` timeout pattern used for `ctx.cookies()` in `restoreTableauSession`.
- **When to fix:** If `ctx.storageState()` hang is observed in production logs.

---

### BKL-CONN-TABLEAU-CDP-AUDIT-01 — Structural fix: `safeCookieOp` utility + full CDP call audit (council P0/P1 sweep)
- **Status:** OPEN
- **Priority:** P0**
- **Source:** Serena council audit 2026-04-29 — scraper-wide CDP hang vulnerability sweep
- **Symptom:** 13 unguarded CDP Network-domain calls across 5 files can each hang indefinitely when a Tableau tab is open in the shared context. The band-aid pattern (guarding individual call sites) is unsustainable — each patch reveals the next hanging call.
- **Root cause:** CDP serializes Network-domain calls against pending network activity on any page in the context. Tableau tabs hold live WebSockets permanently. Every `ctx.cookies()`, `ctx.addCookies()`, `ctx.storageState()`, `ctx.clearCookies()` is a potential hang site.
- **Durable fix:** Build `safeCookieOp<T>(ctx, label, op, fallback, timeoutMs)` + `closeTableauTabs(ctx, label)` in `browser-utils.ts`. Mechanically replace every raw CDP call across all scraper files. Make raw CDP calls a lint failure (ESLint `no-restricted-syntax`).
- **P0 instances (will hang bootstrap now):**
  - `tableau-auth.ts:112` — `ctx.storageState()` in `_closeContext` harvest fires while SSO tab is still open
  - `tableau-auth.ts:179,183,184` — `ctx.cookies()` / `clearCookies()` / `addCookies()` in `startTableauLoginBrowser` unguarded
  - `ccsp-scraper.ts:658,985` — `saveTableauSession` calls `ctx.storageState()` with no timeout (line 658 fires mid-scrape with live Tableau page)
  - `tableau-auth.ts:296` — `waitForTableauLogin` timeout exit returns `false` without calling `_closeContext` — leaks SSO Tableau tab permanently into shared context
- **P1 instances (conditional hangs):**
  - `rh-scraper.ts:382,951` — `persistSessionState` during scrape and context recycle
  - `sf-scraper.ts:405` — SF session persistence after scrape
  - `scrape-api.ts:735` — HTTP endpoint blocks entire request
  - `tableau-auth.ts:202-208` — `startTableauLoginBrowser` catch path leaks page without closing it
- **Files:** `tableau-auth.ts`, `ccsp-scraper.ts`, `rh-scraper.ts`, `sf-scraper.ts`, `scrape-api.ts`, `browser-utils.ts`

---

### BKL-CONN-TABLEAU-LOGIN-TIMEOUT-LEAK-01 — `waitForTableauLogin` timeout exit leaks SSO Tableau tab (council P0)
- **Status:** OPEN
- **Priority:** P0
- **Source:** Serena council audit 2026-04-29
- **Symptom:** When the 5-minute Tableau login poll times out, `waitForTableauLogin` returns `false` at line 296 without calling `_closeContext`. The SSO Tableau dashboard tab remains open in the shared context indefinitely. Any subsequent CCSP bootstrap inherits this leaked tab and hangs on CDP calls.
- **Fix:** Replace `return false` at timeout exit (`tableau-auth.ts:296`) with `await _closeContext({ harvest: false }); return false`.
- **File:** `tableau-auth.ts:296`

---

### BKL-ARCH-SCRAPER-01 — Full scraper architectural consistency audit (all scrapers)
- **Status:** DONE (audit complete 2026-04-29 — implementation tracked in child items below)
- **Priority:** P1
- **Source:** Jason request 2026-04-29 — eliminate scraper snowflakes, standardize patterns
- **Audit findings:** Serena council audit 2026-04-29. 8 cross-cutting gaps found across all scrapers. See child items BKL-ARCH-SCRAPER-02 through BKL-ARCH-SCRAPER-09 for each wave.

---

### BKL-ARCH-SCRAPER-02 — Wave 1: Standardize scraper service naming (P0)
- **Status:** OPEN
- **Priority:** P0
- **Source:** Serena audit 2026-04-29 (CC-1)
- **Symptom:** Same scraper referred to by different identifiers at every layer — `rh-cases` in status store, `rh` in circuit breaker and API, `sf-pipeline` in status store, `salesforce` in circuit breaker and API. Every debug grep and dashboard query requires mental translation. Status routes do triple-fallback chains because names don't align.
- **Fix:** Pick one canonical name per scraper (`rh-cases`, `ccsp`, `sf-pipeline`). Update: `circuitBreakers` map keys in `scraper-manager.ts:231-235`, telemetry `service` fields, `/api/status/scrapes` and `/api/scraper-status` keys. Mechanical rename, zero behavior delta.
- **Files:** `scraper-manager.ts`, `scraper-status-store.ts`, `scrape-api.ts`, `background-scheduler.ts`

---

### BKL-ARCH-SCRAPER-03 — Wave 2: Single source of truth for scraper status (P1)
- **Status:** OPEN
- **Priority:** P1
- **Source:** Serena audit 2026-04-29 (CC-3)
- **Symptom:** Three sources of truth per scraper: (1) module-level `export let last*Scrape` in scraper file, (2) `_*ScrapeLastError` in `scraper-manager.ts`, (3) `ScraperStatusEntry` in `scraper-status-store.ts` (persisted). Only (3) survives container restart. Status route uses `??` chains across all three. Behavior changes invisibly post-restart.
- **Fix:** Delete module-level status exports from scraper files. Read everything from `scraper-status-store.ts` via `getScraperStatus(name)`. Requires Wave 1 (naming) to land first.
- **Files:** `rh-scraper.ts`, `ccsp-scraper.ts`, `sf-scraper.ts`, `scraper-manager.ts`, `scrape-api.ts`

---

### BKL-ARCH-SCRAPER-04 — Wave 3: Move mutex ownership into scraper modules (P1)
- **Status:** OPEN
- **Priority:** P1
- **Source:** Serena audit 2026-04-29 (CC-2)
- **Symptom:** CCSP has its mutex inside the scraper (correct). RH and SF have their mutex only in `scraper-manager.ts`. Direct calls to `runRhScrape()` or `scrapeSfReport()` bypass the running guard entirely — no protection against concurrent execution.
- **Fix:** Add `_rhScrapeRunning` + stale-mutex check to `rh-scraper.ts:runRhScrape`. Add `_sfSyncRunning` to `sf-scraper.ts:scrapeSfReport`. Mirror the CCSP pattern (mutex + `startedAt` + `STALE_MUTEX_MS` + finally release). Requires Wave 2 to land first.
- **Files:** `rh-scraper.ts`, `sf-scraper.ts`, `scraper-manager.ts`

---

### BKL-ARCH-SCRAPER-05 — Wave 4: CCSP typed error class for Tableau session expiry (P0)
- **Status:** OPEN
- **Priority:** P0
- **Source:** Serena audit 2026-04-29 (CC-4)
- **Symptom:** CCSP has no typed `TableauSessionExpiredError` class. Session expiry uses a string flag `_tableauSessionExpired` set/consumed via `consumeTableauSessionExpired()`. `recordConnectionFailure('ccsp', e)` cannot branch on `instanceof` — uses string parsing instead. Grace-period semantics are inconsistent with RH and SF.
- **Fix:** Add `class TableauSessionExpiredError extends Error` to `ccsp-scraper.ts`. Replace `_tableauSessionExpired` boolean setter sites with `throw new TableauSessionExpiredError()`. Keep the boolean as a derived signal in the catch block.
- **Files:** `ccsp-scraper.ts`, `scraper-manager.ts` (update `recordConnectionFailure` branch)

---

### BKL-ARCH-SCRAPER-06 — Wave 5: Extract shared scraper helpers (P2)
- **Status:** OPEN
- **Priority:** P2
- **Source:** Serena audit 2026-04-29 (CC-5, CC-6)
- **Symptom:** (a) Stale-overwrite guard (`keepIfNonEmpty`) duplicated 5 times across all scrapers. (b) Live-scrape leader/test guard (`DISALLOW_LIVE_SCRAPE` + `IS_LEADER`) duplicated 6 times with inconsistent behavior (SF throws, CCSP returns empty silently).
- **Fix:** Extract `keepIfNonEmpty(cachePath, newRows)` helper. Extract `assertLiveScrapeAllowed(serviceName)` helper. Both go in a new `scraper-utils.ts` or appended to `browser-utils.ts`.
- **Files:** `rh-scraper.ts`, `ccsp-scraper.ts`, `sf-scraper.ts`, new `scraper-utils.ts`

---

### BKL-ARCH-SCRAPER-07 — Wave 6: Wire login-handoff to sister context re-adoption (P1)
- **Status:** OPEN
- **Priority:** P1
- **Source:** Serena audit 2026-04-29 (CC-7)
- **Symptom:** `setContextRecoveryCallback` fires on disconnect and 50-scrape recycle, but NOT on fresh login handoff via `adoptScrapeContext`. After a fresh RH login, SF and CCSP hold the old context reference until their next scrape self-heals via lazy `getScrapeContext() !== _ctx` check.
- **Fix:** In `rh-scraper.ts:adoptScrapeContext`, call `_onContextRecovered?.(context, profileDir)` after assignments. One line.
- **Files:** `rh-scraper.ts`

---

### BKL-ARCH-SCRAPER-08 — Wave 7: Session persistence symmetry (P1)
- **Status:** OPEN
- **Priority:** P1
- **Source:** Serena audit 2026-04-29
- **Symptom:** (a) SF writes `sf-session-state.json` via `persistSessionState` but never reads it — `restoreSfSession` does not exist. File is a write-only audit trail. (b) CCSP persists cookie-subset format `{ cookies, savedAt }` vs RH full `storageState()` format — not standardized.
- **Fix:** (a) Add `restoreSfSession()` to `sf-scraper.ts` and call it from `initSfContext`. (b) Document CCSP subset format as intentional (Tableau-domain cookies only) or align with RH format.
- **Files:** `sf-scraper.ts`

---

### BKL-ARCH-SCRAPER-10 — Rename IS_LEADER → NODE_ROLE=primary; non-leader as default (P1)
- **Status:** ✅ DONE 2026-04-29
- **Priority:** P1
- **Source:** Jason 2026-04-29
- **Symptom:** `IS_LEADER=true` sits in `.env` by default, making every copy of this repo a leader instance. The variable name is self-documenting, revealing the leader/non-leader scrape architecture to anyone reading the config.
- **Fix:** (1) Rename env var `IS_LEADER` → `NODE_ROLE` with value `primary`. (2) Guard check becomes `process.env.NODE_ROLE === 'primary'`. (3) Remove `IS_LEADER=true` from `.env` so default is non-leader. (4) Update `.env.example` to have it commented out with a vague description. (5) Update all 5 guard sites in `ccsp-scraper.ts` and `sf-scraper.ts`.
- **Files:** `src/ccsp-scraper.ts`, `src/sf-scraper.ts`, `.env`, `.env.example`
- **Decision:** Renamed IS_LEADER → NODE_ROLE=primary. All 5 guard sites updated. Removed from .env default. Test containers always non-leader via -e NODE_ROLE= Makefile override.
- **Closed:** 2026-04-29 ✅ DONE

### BKL-ARCH-SCRAPER-09 — Wave 8: Remove Supportable from live execution path (P1)
- **Status:** OPEN
- **Priority:** P1
- **Source:** Serena audit 2026-04-29
- **Symptom:** Supportable is permanently disabled per CLAUDE.md, but `adoptSupportableContext(ctx)` is still called in `background-scheduler.ts:1270` and `scheduleSupportableSync()` is still registered at line 1190. ~1300 lines of dead code on the live runtime path. Supportable bugs can still surface at startup even though the feature is disabled.
- **Fix:** Remove `adoptSupportableContext` call and `scheduleSupportableSync()` registration from `background-scheduler.ts`. Keep the file in tree as historical reference.
- **Files:** `background-scheduler.ts`

---

## Previously Verified Done

### BKL-D01 | Tableau connect card in Data Sources
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: SetupPage.tsx:2144-2193 — full card with status badge, Connect/Reconnect button, 2s polling.
Note: Final pass agent flagged "lacks Connect call-to-action matching Salesforce pattern" — confirmed present. Pattern match is close enough; no gap.

### BKL-D02 | /api/status/scrapes endpoint
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: server.ts:931 — returns lastSync, lastError, isRunning, isStale per scraper (supportable, ccsp, rh, salesforce).

### BKL-D03 | RH scraper stale mutex (15-min auto-release)
Status: ✅ DONE (2026-03-30)
Source: Triage verification 2026-03-31
Evidence: server.ts:3691 — RH_STALE_MUTEX_MS = 15 * 60 * 1000, same pattern as CCSP/Supportable.
Note: Marcus flagged CCSP mutex as 60s bug — false positive. STALE_MUTEX_MS = 15min confirmed correct.

### BKL-D04 | Error display in dashboard components
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: CloudSpendSection.tsx:147-151, PipelineSection.tsx:214-218 — both show AlertCircle + error message + Retry button.

### BKL-D05 | Per-section refresh buttons
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: CloudSpendSection.tsx:137-141, PipelineSection.tsx:204-208 — both have inline refresh buttons receiving onRefresh callback.

### BKL-D06 | Persist new sheet ID on 404 fallback
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: server.ts patchAe() called with new sheet ID at lines 985 and 1321 after fallback creation.

### BKL-D07 | Bootstrap completion shows failed customer count
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: SetupPage.tsx:515-530 — shows "{N} customers had no Supportable matches" after bootstrap.
Note: Shows count only, not names. Names feature remains useful — add as BKL-F03 if Jason wants it.

### BKL-D08 | Staleness color indicators
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: App.tsx:171-185 — global bar green/amber/red; per-section stale indicators in CloudSpendSection and PipelineSection.

### BKL-D09 | daysOpen field computed correctly
Status: ✅ DONE (pre-existing)
Source: Triage verification 2026-03-31
Evidence: src/redhat.ts:85 — computed from creation date: Math.floor((Date.now() - created.getTime()) / 86_400_000).

### BKL-D10 | Keep-alive race condition guard
Status: ✅ DONE 2026-03-30
Source: Session work 2026-03-30
Evidence: server.ts:3685-3692 — setSessionExpiredCallback checks supportableScrapeRunning || ccspScrapeRunning || _rhScrapeRunning before calling closeScrapeContext().

### BKL-D11 | Supportable Export tab — inline account panel fix
Status: ✅ DONE 2026-03-30
Source: Session work 2026-03-30
Evidence: supportable-scraper.ts:279-296 — waitForSelector + page.$$ + last-anchor pattern handles both normal and inline APEX render modes. REI (9 rows) and Shutterfly (6 rows) confirmed scraping correctly.

---

## Deferred

### BKL-DEF01 | OAuth keys safe in reset (remove full=true path)
Status: ⏸ DEFERRED 2026-03-30
Severity: Medium
Decision: DEFERRED — Jason confirmed. CLAUDE.md already enforces "never delete OAuth keys". Adding complexity to reset path not worth it at this time. Revisit only if incident occurs.
Note: This is about GOOGLE_OAUTH_KEYS_PATH. Separate from BKL-M07 which is about GOOGLE_UNIFIED_TOKEN_PATH (active regression, not deferred).

### BKL-DEF02 | Bootstrap checkpoint/recovery
Status: ⏸ DEFERRED — needs ADR first
Severity: Medium
Decision: Deferred pending ADR. Large effort item. Requires architectural decision on persistence format (bootstrap-recovery.json), resume endpoint design, and partial-state customer handling before Marcus touches code.

### BKL-DEF03 | Calendar/meeting workflow improvements
Status: ⏸ DEFERRED
Severity: Medium
Decision: Not in active sprint. Meeting prep cards work well (Quinn confirmed). Attendee list + SF link is an enhancement for later.

### BKL-DEF04 | Customer detail health summary + action panel — SUPERSEDED by BKL-R04
Status: ⚪ SUPERSEDED
Severity: Medium
Decision: Superseded by BKL-R04 (research-driven health score with weighted multi-signal model). BKL-R04 has full scoring spec + research evidence.

### BKL-DEF05 | Brief cache TTL / age indicator
Status: ⏸ DEFERRED
Severity: Low
Decision: Low value, low urgency.

### BKL-DEF06 | Weather cache schema validation
Status: ⏸ DEFERRED
Severity: Low
Decision: Low risk, low frequency failure mode.

### BKL-DEF07 | Force-clear stuck RH session endpoint
Status: ⏸ DEFERRED
Severity: Low
Decision: Container restart resolves stuck sessions. Adding endpoint is convenience not necessity.

---

## E2E / Test Coverage

### BKL-T01 | Gap 1 — Dashboard empty-state tests (post-bootstrap, no cache)
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: E2E gap analysis 2026-03-31
Files: test/ui/dashboard-empty-state.spec.ts (NEW)
Description: No tests covered the dashboard immediately after bootstrap when cache files don't exist yet. PipelineSection, CloudSpendSection, and AccountPortfolioGrid all have nullish-coalescing defaults that were untested.
Decision: DONE — 7 tests: pipeline shows "$0"/"No opportunities", CCSP shows "No cloud spend data yet", accounts shows "0 accounts", SSE mock uses correct content type, no console errors on initial load.

### BKL-T02 | Gap 3 — Bootstrap recovery spec strengthening
Status: ✅ DONE 2026-03-31
Severity: Medium
Source: E2E gap analysis 2026-03-31
Files: test/ui/bootstrap-recovery.spec.ts (STRENGTHENED)
Description: Existing bootstrap-recovery tests had placeholder assertions not tied to actual DOM. Key discovery: error state mock needs `completedAt` set for "Clear stuck state" button to render; button text is "Clear stuck state" not "Reset"; resource links are `<span>` not `<a>`.
Decision: DONE — Tests now use real SetupPage.tsx class names; error state mock corrected; resource link test.skip'd with explanation of span vs anchor difference.

### BKL-T03 | Gap 7 — Wizard input validation tests
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: E2E gap analysis 2026-03-31
Files: test/ui/wizard-validation.spec.ts
Description: No tests validated that the setup wizard rejects invalid inputs (empty required fields, non-URL folder paths, etc.).
Decision: DONE — 15 tests across 5 categories (required fields, SF Report ID format, Drive folder URL, territory lookup failure, optional field behavior). Fixed 9 CSS selector mismatches (raw Tailwind → semantic theme classes). All 15 pass in 10.8s.

---

## Final Gate

### BKL-S13 | Session state files written without mode 0o600
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Rook Blackburn security scan 2026-03-31
Files: src/rh-scraper.ts:151, src/sf-scraper.ts:108, src/rh-auth.ts:126, src/sf-auth.ts:137+152
Decision: DONE — `{ mode: 0o600 }` added to all 5 session write callsites (rh-scraper, sf-scraper, rh-auth, sf-auth ×2). Also applied to rh-scraper.ts cache write (line 457) per Rook Wave 1 scan flag.

### BKL-S14 | Raw error strings stored in module-level exports before sanitization
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Rook Blackburn security scan 2026-03-31
Decision: DONE — `sfSyncError` assignment in sf-scraper.ts changed from `e?.message ?? String(e)` to generic `'SF sync failed'`. supportable-scraper.ts and ccsp-scraper.ts were already fixed 2026-03-31.

### BKL-S15 | dumpDom runs unconditionally in supportable-scraper on error paths
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Rook Blackburn security scan 2026-03-31
Decision: DONE — `const SUPPORTABLE_DEBUG = process.env.SUPPORTABLE_DEBUG === 'true'` added at line 27. All 8 dumpDom calls gated behind it. Consistent with CCSP_DEBUG pattern in ccsp-scraper.ts.

### BKL-S16 | pipeline.ts env-var folder IDs not validated before Drive query interpolation
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Rook Blackburn security scan 2026-03-31
Decision: DONE — `/^[a-zA-Z0-9_-]{10,}$/` validation loop added in `discoverPipelineFileIds` before any Drive query. Throws descriptive error on invalid ID. Matches ccsp-scraper.ts and supportable-scraper.ts pattern exactly.

### BKL-S19 | Non-session file writes missing mode 0o600 — drive-watcher, bootstrap, server-state
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Rook Blackburn Wave 1 scan 2026-04-01
Files: src/drive-watcher.ts:30, src/server-state.ts:39, src/bootstrap-orchestrator.ts:139+336+385+417, src/drive-sources.ts:179+204+322
Description: BKL-S13 fixed session state files. Rook noted additional file writes without mode 0o600 outside Wave 1 scope: drive-watcher (pageToken cache), server-state (config writes), bootstrap-orchestrator (intermediate state files), drive-sources (Drive BFS cache). These contain operational state (not credentials) but are inconsistent with the established 0o600 pattern.
Fix: Add `{ mode: 0o600 }` to each Bun.write / writeFile / writeFileSync call in the listed files. Low-risk, one-line changes per callsite.

### BKL-S17 | Scrapers overwrite Google Sheets with empty data on failed scrape
Status: DONE
Severity: Critical
Source: ScraperExplorer gap analysis 2026-03-31
Files: src/supportable-scraper.ts (writeSupportableSheet), src/ccsp-scraper.ts (writeCcspSheet), src/sf-scraper.ts (writePipelineSheet)
Description: All three sheet-writing scrapers clear and overwrite their Google Sheet even when the scrape returns 0 rows. The stale-overwrite guard in refresh-engine.ts only protects LOCAL CACHE — not the Google Sheet itself. If Tableau session expires mid-CCSP scrape, the CCSP Sheet gets overwritten with a "No CCSP data available" placeholder, destroying all previous data. Same for Supportable (SSO failure) and SF (session expiry). Source-of-truth is corrupted; cache diverges silently.
Fix: Added pre-write guard in each writer. ccsp-scraper: if allRows.length===0 && existingSheetId, skip write and return existing spreadsheetId. supportable-scraper: if no results have accountNumbers && existingSheetId, skip write and return existingSheetId. sf-scraper: if data.rows.length===0, skip clear+write unconditionally (writePipelineSheet always receives an existing sheet ID). All guards log a console.warn with BKL-S17 tag. First-run paths (no existingSheetId) are unaffected — bootstrap still writes placeholders correctly.
Evidence: TypeScript parses clean. Three surgical guards, no signature changes, no refresh-engine.ts changes.

### BKL-M19 | Subscription/CCSP refresh timers use raw setInterval — unreliable for 4h+ intervals in Bun
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: ScraperExplorer gap analysis 2026-03-31
Decision: DONE — Timers 1+2 converted from raw setInterval to unified 15-min heartbeat tick pattern. `_subscriptionsLastRun` and `_ccspLastRun` timestamps added; single `_heartbeatStarted` guard ensures tick registered once. Max drift from configured interval is +15 min — acceptable for 90min/24h cadences. Matches Timer 3 (RH scrape) pattern exactly per ADR-007.

### BKL-M20 | SF keep-alive fires every 60 min — session expiry undetected for up to 60 min
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: ScraperExplorer gap analysis 2026-03-31
Files: src/sf-scraper.ts:35+68+114-133
Description: SF keep-alive timer fires every 60 minutes (KEEP_ALIVE_INTERVAL_MS = 60 * 60 * 1000). If SF session expires (or RH SSO session expires, which also invalidates SF via shared context), the SF status endpoint reports "connected" for up to 60 minutes before the next keep-alive detects the failure. RH session expiry doesn't immediately propagate to SF status.
Fix: Reduce SF keep-alive interval to 10 minutes to align with RH Portal's 8-minute tick. Alternatively, hook the RH session-expired callback to also mark SF session as potentially stale (they share SSO context). Low-cost fix: in setSfSessionExpiredCallback, call it when RH session expires since SF is always downstream.

### BKL-M21 | Scrapers don't validate account count after scrape — partial results written silently
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: ScraperExplorer gap analysis 2026-03-31
Files: src/supportable-scraper.ts (~line 591), src/rh-scraper.ts (~line 321)
Description: If 5 accounts are requested but only 2 succeed (e.g., 3 timeout or 404), the partial result (2 accounts) is written to Sheets and cache as if complete. No warning is issued beyond a per-account error log. The user cannot tell from the dashboard that 3 accounts are missing.
Fix: After scrape loop completes, compare attempted vs successful account count. If successful < (attempted - 1), log a prominent warning: "[scraper] partial results: X/Y accounts scraped — missing: [names]". Optionally expose via /api/status/scrapes so UI can show a "partial data" indicator.

### BKL-M27 | Bootstrap always creates new Drive folders/sheets — no Drive-side existence check
Status: ✅ DONE 2026-04-02
Severity: High
Source: Discovered 2026-03-31 (Jason: "why does bootstrap always create a new gdrive scaffold even though one is there?")
Files: src/bootstrap-orchestrator.ts (steps 1–6), src/sf-scraper.ts (createPipelineSheet), src/supportable-scraper.ts (writeSupportableSheet)
Description: All "skip if exists" guards are config-only — they check aes.json/customers.json for a saved ID. If config is reset or bootstrap runs on a fresh install, those IDs are absent and Drive objects are always created as duplicates. Specific gaps:
  - Step 1 (AE folder): checks existingAe?.driveFolderId — blank after reset → new folder
  - Step 2 (customer folders): checks existingCustomer?.driveFolderId — blank after reset → new folder per customer
  - Step 4 (Supportable sheet): checks aes[].supportableSheetId — blank after reset → new sheet
  - Step 5 (CCSP sheet): checks aes[].ccspSheetId — blank after reset → new sheet
  - Step 6 / createPipelineSheet(): NO existence check at all — always creates
Fix: Before each drive.files.create call, query Drive: "'${parentId}' in parents and name = '${name}' and mimeType = '${type}' and trashed = false". If a match is found, use that ID and save to config instead of creating. For sheets, search by name prefix (e.g. "${aeName} Pipeline", "${aeName} Supportable") within the AE driveFolderId. createPipelineSheet() is the highest-impact target — it has no guard at all.

### BKL-M26 | Orphaned cache file cleanup on AE/customer removal
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Discovered 2026-03-31 after config reset left stale cache files on disk
Decision: DONE — `cleanOrphanedCacheFiles(customerNames)` added to cache-layer.ts. Scans data/cache/ for `<slug>-sheets.json` and `<slug>-YYYY-MM-DD.json` files, deletes any whose slug has no matching current customer. Excludes global files (cases.json, ccsp-data.json, pipeline-data.json). Called from `rescheduleRefreshTimers()` which fires after every customer list change. Each deletion logged with [cleanup] prefix.

### BKL-M25 | Unified Scrape API — replace fragmented scraper endpoints
Status: DONE (2026-03-31)
Severity: Medium
Source: Gap analysis 2026-03-30
Files: src/scrape-api.ts (new), src/scraper-manager.ts (cleaned), server.ts, dashboard/src/pages/SetupPage.tsx
Description: Scraper endpoints were fragmented across /api/bootstrap/*, /api/auth/*/sync, and /api/salesforce/sync/* paths. No consistent response shape. No unified "run all" endpoint.
Decision: DONE — Created src/scrape-api.ts with registerScrapeRoutes(). New endpoints: POST /api/scrape/{rh,supportable,ccsp,salesforce}, GET /api/scrape/*/status, DELETE /api/scrape/{rh,salesforce}/cancel, POST /api/scrape/all. Removed 10 old route registrations from scraper-manager.ts (POST /api/auth/salesforce/sync, POST/GET /api/bootstrap/supportable, POST/GET /api/bootstrap/ccsp, GET/DELETE /api/auth/redhat/sync/*, GET/DELETE /api/salesforce/sync/*). Removed POST /api/auth/redhat/sync from server.ts. Updated SetupPage.tsx endpoint strings. Added ESM-safe setter functions to scraper-manager.ts for cross-module state mutation. Standardized ScrapeResult interface. POST /api/scrape/all runs all 4 scrapers sequentially (shared browser context). Tests updated: 75 API tests pass, 0 new failures. Auth session start/stop/status endpoints unchanged.

### BKL-T05 | E2E pre-flight session checks happen 10+ min before scrape — expiry window is unguarded
Status: ✅ DONE 2026-04-02
Severity: High
Source: ScraperExplorer gap analysis 2026-03-31
Files: test/bootstrap-e2e.spec.ts (pre-flight describe block), src/scraper-manager.ts (background tick)
Description: Bootstrap E2E pre-flight checks pass at T=0. Background RH scrape tick fires every 15 min and can set `sessionExpired=true` between T=0 and T=10min (when bootstrap reaches Supportable). A session that passes pre-flight can expire before bootstrap reaches the step that needs it. Also: a background scrape running concurrently with bootstrap can race against the session-expiry flag.
Fix (3 parts): (1) Move session expiry flag reset to just before each bootstrap step that needs the session, not just at pre-flight. (2) Cancel/defer background scrape ticks during active bootstrap run. (3) E2E pre-flight: call live probe (BKL-T04) just before bootstrap start, not as a separate describe block 10 min earlier.

### BKL-T06 | SF pre-flight checks flag + env var only — doesn't verify report is accessible
Status: ✅ DONE 2026-04-02
Severity: High
Source: ScraperExplorer gap analysis 2026-03-31
Files: test/bootstrap-e2e.spec.ts:64-69, src/scraper-manager.ts (GET /api/auth/salesforce/status)
Description: Bootstrap E2E SF pre-flight: `hasSession: true` (session file exists) + `reportConfigured: true` (reportId in config). Does not verify the report ID is valid and accessible in SF. A deleted or invalid report ID passes all pre-flight checks but fails at bootstrap step 6.
Fix: Add a report accessibility check to the SF status endpoint or create a dedicated `/api/sf/report-check` endpoint that navigates to the report URL and verifies the report renders (non-error page). E2E pre-flight calls this and asserts accessible:true.

### BKL-T07 | Tableau/Supportable session-status checks don't extend TTL — can expire before scrape
Status: ✅ DONE 2026-04-02
Severity: High
Source: ScraperExplorer gap analysis 2026-03-31
Files: test/bootstrap-e2e.spec.ts:71-81, src/bootstrap-orchestrator.ts (GET /api/bootstrap/tableau/session-status)
Description: The Tableau session-status endpoint (7s probe) and Supportable reachability check both make real requests, but neither extends the session TTL. Tableau's SAML session can expire between the 7s check (T=0) and when the CCSP scrape step actually runs (T=8+ min). Same for Supportable.
Fix: Session-status checks should be run as close as possible to the scrape step they guard. For E2E, add a "warm session" step immediately before each scrape step: re-check session status and fail fast if it's expired rather than discovering the failure 60s into the scrape attempt.

### BKL-S12 | RH login browser hides itself before Supportable pre-warm completes
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason review 2026-03-31 — confirmed root cause of bootstrap Supportable SSO failure
Files: server.ts POST /api/auth/redhat/start (~line 392), src/rh-auth.ts
Description: After RH Portal login is detected, the code immediately navigates the visible VNC browser page to `about:blank` (`getLivePage()?.goto('about:blank')`). This hides the browser window from VNC. But the Supportable pre-warm fires at the same time — it opens a new tab, navigates to supportable.corp.redhat.com, and waits up to 120s for SSO to complete. If the stored cookies aren't valid for Supportable's SSO flow, the user sees a login form in that tab but can't interact with it because the VNC window appears to have closed (it's showing about:blank on the main tab). The pre-warm times out after 120s and logs "may need manual login." Subsequent bootstrap runs then fail at Supportable discovery with "SSO login did not complete."
Root cause confirmed: 92 stored portal cookies auto-complete the portal login in ~2s. Browser hides. Pre-warm silently fails. Cookies cleared as workaround — forces fresh SSO login that actually establishes Supportable session properly.
Fix: Do NOT navigate to about:blank until the Supportable pre-warm has completed (success OR failure). If the pre-warm lands on the SSO login page, keep the browser visible so the user can complete any additional auth steps. Only hide the browser (about:blank) after: (a) pre-warm confirms Supportable URL reached, OR (b) pre-warm explicitly fails/times out AND a clear warning is logged. Consider showing a VNC-visible status page ("Establishing Supportable session…") instead of about:blank during the pre-warm wait.

### BKL-T04 | Session "Connected" status is a flag-read everywhere — live probes needed for all 4 connections
Status: ✅ DONE 2026-04-02
Severity: High
Source: Jason review 2026-03-31 — confirmed root cause of bootstrap E2E failure (Supportable SSO expired mid-run despite all 4 UI cards showing "Connected")
Files: test/bootstrap-e2e.spec.ts, dashboard/src/pages/SetupPage.tsx (connection cards), src/scraper-manager.ts or new health-check endpoints
Description: "Connected" is shown in 3 places — all read stale flags, not live session health:
  1. Setup UI connection cards — all 4 show green "Connected" based on hasSession flag even when the actual Playwright/API session has expired
  2. E2E pre-flight tests — assert hasSession:true for RH Portal and Salesforce; only Tableau and VPN make real requests
  3. Status API endpoints — /api/auth/redhat/status and /api/auth/salesforce/status return flags only
  Root cause confirmed: bootstrap failed at Supportable step with "SSO login did not complete" while all 4 cards showed Connected. Session file existed but Playwright browser cookies were expired.
Live probe spec — one per connection:
  - Red Hat Portal: navigate to a protected RH Portal URL inside the shared BrowserContext; verify it does NOT redirect to auth.redhat.com/auth/realms/EmployeeIDP/login-actions. Probe fails = SSO cookies expired.
  - Supportable 360: navigate to supportable.corp.redhat.com inside the shared BrowserContext; verify page loads without SSO redirect. Requires VPN + valid RH SSO (same shared context). Probe fails = session expired or VPN down.
  - Salesforce: make an authenticated API call (e.g. list reports endpoint) using the SF Playwright context; verify non-auth-error response. Probe fails = SF session expired.
  - Tableau: already working — /api/bootstrap/tableau/session-status makes a real browser check (7s). Keep as-is.
Fix (3 parts, in priority order):
  1. Backend: add /api/health/connections endpoint that runs all 4 live probes and returns per-connection {connected: bool, liveProbe: bool, error?: string}. Probe results cached for 60s to avoid hammering sessions on every page load.
  2. UI: connection cards call /api/health/connections on page load. Show "Session Expired — Reconnect" in amber when liveProbe fails. Do not wait for bootstrap to discover a dead session.
  3. Tests: E2E pre-flight calls /api/health/connections and asserts liveProbe:true for all 4. Fails immediately with actionable message if any probe fails — before bootstrap starts, not 10 minutes in.

### BKL-M28 | Pipeline duplicate opps when multiple AEs share the same SF report ID
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason observation 2026-04-01 (screenshot showing 104 opps, duplicates of Illumio / A10 / Intrado)
Files: src/pipeline.ts
Description: Both Carolanne and Elmer had the same `sfReportId` in aes.json. `fetchPipelineData` read both `pipelineSheetId` values (separate sheets, identical content) and concatenated without dedup — producing doubled counts. $13.77M ACV, 104 opps vs correct $6.83M, 51 opps.
Decision: Fixed 2026-04-01 — added `oppNumber`-keyed dedup filter in `fetchPipelineData` after combining records from all sheet IDs. Fallback key: `accountName|oppName|closeDate` when `oppNumber` is empty. Verified: 104→51 opps, no duplicate top opps, total ACV halved correctly. Documented in CLAUDE.md Pipeline Rules section.

### BKL-M29 | Supportable discover endpoint missing — sync button silently skipped empty-account customers
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason observation 2026-04-01 (Bespin Global, Omnivision, Uber Technologies had empty accountNumbers; sync button skipped them silently)
Files: src/scrape-api.ts, dashboard/src/pages/SetupPage.tsx
Description: `/api/scrape/supportable` required non-empty `accountNumbers` and returned 400 for customers without them. The Setup sync button pre-filtered to customers with accounts — silently skipping the rest. Result: 3 Elmer customers permanently stuck with no subscriptions.
Decision: Fixed 2026-04-01 — added `POST /api/scrape/supportable/discover` endpoint that calls `runSupportableDiscoverAndScrape` (full name-search discovery + scrape) for all customers of an AE without requiring pre-existing account numbers. Updated Setup sync button to use `/discover` for AEs with any empty-account customers, regular scrape otherwise. Documented in CLAUDE.md Supportable Discovery Rules.

### BKL-UX01 | 10 Quinn-reported UI issues — meetings mismatch, loading states, 404, tab titles, tooltips
Status: ✅ DONE 2026-04-01
Severity: Critical(1) / High(2) / Medium(4) / Low(3)
Source: Quinn Torres comprehensive UI review 2026-04-01
Files: server.ts, dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/pages/SetupPage.tsx, dashboard/src/App.tsx, dashboard/src/components/KPICards.tsx, dashboard/src/components/Sidebar.tsx, dashboard/index.html
Decision: Fixed 2026-04-01 — Marcus A (data/logic) + Marcus B (UI) parallel sprint:
  1. CRITICAL: Meetings stat cards overcounted raw calendar events — added `ev.customers.length > 0` filter in `/api/kpis` so stat cards match CalendarStrip
  2. HIGH: Account Brief brief cache not invalidated when sheet data was newer — brief now regenerates if `sheetData.cachedAt > briefCachedAt`
  3. HIGH: Account detail header showed `---` / "Loading..." raw text — replaced with `animate-pulse` skeleton shimmers
  4. MEDIUM: Setup Data Sources badge stuck at "Checking..." — catch handlers now set fallback state (non-null) so `allStatusesLoaded` resolves
  5. MEDIUM: "Starting now" label ambiguous — replaced with "In progress" / "Starting soon" / "In Xm"
  6. MEDIUM: Meeting stat cards not clickable — added scroll-to-calendar onClick handlers matching other KPI card patterns
  7. MEDIUM: Unknown customer URL showed broken half-rendered page — added clean `customerNotFound` error state with "Back to Dashboard" link
  8. LOW: Browser tab titles static — useEffect hooks in App.tsx, CustomerDetailPage, SetupPage update `document.title` dynamically
  9. LOW: Sidebar collapsed icons had no labels — replaced OS `title` attributes with CSS-styled hover tooltips
  All verified by Quinn Torres re-validation pass.

### BKL-GATE01 | Full bootstrap E2E test
Status: 🟡 PARTIAL — bootstrap passed, test timed out (fixed), UI data confirmed
Source: Jason explicit request 2026-03-31 ("also we should do a full bootstrap ui test / at then end of all this")
Command: `npx playwright test test/bootstrap-e2e.spec.ts --timeout=1200000`
Description: Runs the complete wizard-driven setup flow end-to-end to verify all backlog changes haven't broken the bootstrap path. Mutates aes.json and customers.json — run on a clean config.
Prerequisites:
  - Reset data/config/aes.json to {"aes": []}
  - Reset data/config/customers.json to {"customers": []}
  - Clear all files in data/cache/
  - make rebuild (server reads config at startup)
  - RH Portal connected, Salesforce connected, Tableau session valid, VPN on
  - Google auth active with bootstrap (full Drive write) scope
Decision: Re-run after open scraper gaps addressed. Timeout raised to 20 min (1200s) — SF pipeline sync takes ~13 min. Bootstrap itself succeeded 2026-03-31 (all 6 steps done). UI data confirmed by Quinn Torres: 9 customers, subscriptions/CCSP/pipeline all populated. Pipeline bugs fixed (BKL-M18) after Quinn's report.

### BKL-M30 | Chrome crashes in container — missing sandbox flags and insufficient shm
Status: ✅ DONE 2026-04-01
Severity: Critical
Source: Jason observation 2026-04-01 (all Supportable accounts returned "Target page, context or browser has been closed"; zombie chrome processes in container)
Files: src/rh-scraper.ts, src/rh-auth.ts, src/sf-auth.ts, src/sf-scraper.ts, Makefile
Description: Chrome launched by Playwright crashed immediately in the container on every worker page open. Root causes: (1) `--no-sandbox` and `--disable-dev-shm-usage` missing from all 4 `launchPersistentContext` call sites — Chrome cannot run as root in a container without these flags. (2) Container `/dev/shm` defaulted to 63MB — insufficient for Chrome to open multiple tabs.
Decision: Fixed 2026-04-01 — added `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage` to all 4 launch sites. Added `--shm-size=256m` to Makefile `up` target. Documented in CLAUDE.md Container / Browser Requirements section.

### BKL-M31 | Supportable sync always uses discover — stale account numbers corrected on every run
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason request 2026-04-01 (Intrado had wrong account number; cached accounts not re-verified)
Files: dashboard/src/pages/SetupPage.tsx
Description: Sync button routed to fast subscription-only path (`/api/scrape/supportable`) when all customers had account numbers cached. This meant incorrect or stale account numbers were never corrected — only fresh bootstraps would re-run name-search.
Decision: Fixed 2026-04-01 — sync button always calls `/api/scrape/supportable/discover` regardless of cached account numbers. Every sync does a fresh name-search to validate and refresh account numbers before scraping subscriptions. Updated CLAUDE.md Supportable Discovery Rules.

### BKL-S18 | Raw e.message in sfSyncError and ccspScrapeError catch blocks
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Rook Blackburn scan 2026-04-01
Decision: DONE — `setSfSyncError` now 'Sync failed. Check server logs for details.' and `setCcspScrapeError` now 'Scrape failed. Check server logs for details.' Generic messages, no raw exception content.

### BKL-I01 | x11vnc not auto-respawned if killed mid-session
Status: ✅ DONE 2026-04-01
Severity: Low
Source: Jason observation 2026-04-01 (VNC stopped working mid-session after debug commands killed x11vnc)
Files: Dockerfile or container entrypoint
Description: x11vnc starts correctly on container boot via the entrypoint. If killed mid-session (debugging, crash, signal), it does not auto-respawn — VNC becomes unavailable until `make rebuild`. There is no process supervisor (supervisord, s6, etc.) to restart it.
Fix: Add a supervisord or simple restart-loop wrapper around x11vnc in the container entrypoint. Workaround until fixed: `podman exec -d pai-dashboard bash -c "DISPLAY=:99 exec x11vnc -display :99 -nopw -localhost -rfbport 5900 -forever -quiet 2>/dev/null"` — the `-d` flag is required so the process survives the exec shell exit.

### BKL-M33 | Pipeline sync not configurable — daily 2am job only refreshes cache, never re-scrapes SF
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason request 2026-04-01
Files: src/background-scheduler.ts, src/scrape-api.ts, src/settings-api.ts, dashboard/src/pages/SetupPage.tsx
Description: The daily 2am pipeline timer calls `refreshPipeline()` only — which reads the existing GSheet into local cache. It does NOT call `runSfPipelineSync()` and therefore never re-scrapes Salesforce or updates the GSheet with fresh SF report data. The GSheet only gets updated when a user manually triggers sync from Setup or logs into Salesforce. Users have no way to schedule automatic SF → GSheet pipeline syncs.

Additionally the sync schedule (currently hardcoded 2am ET) is not user-configurable.

Fix:
1. Add a new `pipeline` interval setting (e.g. daily at a user-chosen time, or interval in hours) to `POST /api/settings/refresh` alongside existing subscriptions/ccsp/rhScrape settings.
2. Change the daily timer to call the full chain: `runSfSyncForAes()` → `refreshPipeline()` instead of just `refreshPipeline()`.
3. Make the schedule time configurable (or switch to an interval-based approach matching the other timers).
4. Update TIMERS.md and CLAUDE.md to reflect the corrected timer behavior.
5. Requires SF session to be active at sync time — add guard: skip and log if no SF session, do not error.
Note: `runSfSyncForAes()` already has a stale mutex and handles the full SF → GSheet → cache chain. The scheduler just needs to call it.

### BKL-M34 | Territory sheet background sync — POD → AE → customer names never auto-refreshes from source
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason request 2026-04-01
Files: src/background-scheduler.ts, src/territory-sync.ts (new), server.ts
Related: BKL-M32 (territory drift gap), BKL-M15 (territory lookup quota)
Decision: DONE — Daily 1:45am ET timer added. Territory parser extracted into src/territory-sync.ts. syncTerritorySheet() diffs GSheet vs customers.json per AE. New customers auto-added. Removals/reassignments written to data/cache/territory-notifications.json (never auto-deleted). GET /api/territory/notifications endpoint added. Google auth pre-flight check before running.

### BKL-M34 | customers.json wiped to empty on container restart — root cause unknown
Status: ✅ FIXED 2026-04-06
Priority: P1
Severity: High
Source: Quinn/UIReviewer catch 2026-04-06 — customer detail "not found" after rebuild
Files: src/server-state.ts, src/background-scheduler.ts, src/setup-routes.ts
Root Cause: `POST /api/setup/save-customers` had no guard against an empty `customers` array. If the endpoint was called with `{"customers":[]}` (e.g., during a setup UI render before data loaded), it would atomically overwrite customers.json with an empty list.
Fix:
  1. setup-routes.ts: Added explicit 400 guard — rejects any save-customers call with empty array
  2. background-scheduler.ts startup-validation: Added `currentCustomers.length > 0` guard before writing (belt-and-suspenders)
  3. server-state.ts loadServerState: Added prominent WARN log when 0 customers load from disk (diagnostic aid)
Related: BKL-M32 (territory drift), server-state.ts saveCustomers

### BKL-M35 | CCSP trend diff — store delta between pulls to show consumption trends
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Jason request 2026-04-01
Files: src/background-scheduler.ts
Decision: DONE — runCcspScrapeWithDelta() wrapper in background-scheduler.ts reads ccsp-data.json before the scrape, runs runCcspScrape(), reads updated cache after, computes per-customer ACV delta, writes to data/cache/ccsp-delta.json with mode 0o600. Shape: { computedAt, deltas: [{ customer, prev, curr, change }] }. Delta only includes customers where change !== 0. Called by scheduleCcspSync() (Timer 31).

### BKL-M36 | Supportable automated scrape scale decision — 200-customer performance
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason concern 2026-04-01
Files: src/supportable-scraper.ts, src/background-scheduler.ts
Decision: **Option B — Batch rotation.** 3 groups × ~67 customers, rotating daily (~65 min/day). Every customer refreshed within a 3-day window. Predictable runtime regardless of total customer count.
Implementation (Wave 6 2026-04-01): scheduleSupportableSync() added to background-scheduler.ts (Timer 32). ADR-008 written. batchIndex persisted in data/config/batch-state.json. VPN probe with 15-min retry until 9am ET hard stop. Batch index increments on both success and error.
Note on initial load: BKL-M44 (Admin page initial load) handles the crash-safe, resume-capable design for one-time full loads — no batching for initial runs.

### BKL-M37 | RH Cases default scrape interval too slow — tighten from 4h to 1–2h
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Jason priority review 2026-04-01
Decision: DONE — Default `rhScrape` lowered from 240 to 90 min. Server-side floor of 30 min enforced with 400 error and explanatory message. POST handler ENOENT fallback added (creates file when missing). Error sanitization regex extended to cover .json paths. Verified by Quinn 2026-04-01.

### BKL-M38 | Configurable source scrape schedule on Admin page with server-side floors
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Jason request 2026-04-01 (configurable but on Admin page — not Setup — so users don't accidentally set aggressive intervals)
Files: src/settings-api.ts, dashboard/src/pages/AdminPage.tsx (new, see BKL-M40)
Description: All 5 source scrape schedules need to be user-configurable from the Admin page alongside the manual "Run Now" triggers. Server-side floors enforced to prevent quota exhaustion and performance issues.

Per-source schedule config (on Admin page):
  - RH Cases: scheduled interval in minutes. Floor: 30 min. Default: 60 min (tightened per BKL-M37).
  - SF Pipeline: scheduled time (default 2:00 AM ET). Floor: 12h between runs (SF report only regenerates daily).
  - CCSP: scheduled time (default 6:30 AM ET). Floor: 6h between runs.
  - Supportable: scheduled time (default 7:00 AM ET). Floor: 12h between runs (PARALLEL_PAGES=1 at scale).
  - Territory: scheduled time (default 1:45 AM ET). Floor: 6h between runs.

Each source card on Admin page shows:
  - Current schedule ("Daily at 7:00 AM ET" or "Every 60 min")
  - Editable schedule field with floor hint ("minimum 12h")
  - Next scheduled run time
  - Last source sync timestamp
  - Enable/disable toggle for automated sync

Fix: Add schedule fields to POST /api/settings/refresh with floor validation (return 400 if violated). Admin page renders schedule config inline with each source scrape card.

### BKL-M39 | Dashboard freshness UX — per-section source timestamps and staleness badges
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Jason request 2026-04-01 (need to know exactly how fresh each data section is)
Files: src/scraper-manager.ts, dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/components/
Description: The dashboard currently has no way to distinguish data scraped from source 2 hours ago vs data that hasn't been refreshed from source in 3 weeks but whose GSheet cache was read 2 hours ago. Users see no indication of actual data age relative to the source system.
Fix:
  1. Track `lastSourceSync` per data source in /api/status/scrapes — separate from `lastCacheRefresh` (cachedAt). Set lastSourceSync only when data is actually pulled from the source system (Supportable APEX, Tableau, SF Lightning, RH Portal), not when GSheet is read to cache.
  2. Per-section header in dashboard: "from Supportable as of 6h ago" — green within expected window, yellow at 2x, red at 4x or null.
  3. Tooltip on badge: absolute timestamp + reason if stale (VPN unreachable, session expired, etc.)
  4. No "last cache refreshed" shown to user — internal plumbing only.

### BKL-UX50 | Live status polling missing on CCSP, SF Pipeline, and RH Cases sync buttons
Status: ✅ SUPERSEDED by BKL-M40 (Admin page) — 2026-04-01
Live status polling belongs on the Admin page source scrape triggers, not on Setup Data Sources cache sync buttons. See BKL-M40.

### BKL-M40 | Admin page — manual source scrape triggers with live status feedback
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason request 2026-04-01
Files: dashboard/src/pages/AdminPage.tsx (new), dashboard/src/App.tsx (routing), src/scrape-api.ts
Description: Source scrapes (Playwright → source system → GSheet) need a manual break-glass trigger for when the automated morning schedule fails (VPN down, session expired, etc.). This should NOT be on the main Setup page — it belongs in a separate hidden Admin page accessible only via a deep route or non-prominent link.

The Admin page shows one card per source scrape:
  - RH Cases: "Sync from RH Portal" → POST /api/scrape/rh → live status polling
  - Supportable: "Sync from Supportable" → POST /api/scrape/supportable/discover → live status (already exists, move here)
  - CCSP: "Sync from Tableau" → POST /api/scrape/ccsp → live status polling
  - SF Pipeline: "Sync from Salesforce" → POST /api/scrape/salesforce → live status polling
  - Territory: "Sync from Territory Sheet" → POST /api/sync/territory (new endpoint) → live status

Each card shows:
  - Last source sync timestamp (lastSourceSync, distinct from cache cachedAt)
  - "Run Now" button (disabled if already running)
  - Live animated spinner + status message while running (matching Supportable pattern)
  - Error state on failure with last error message
  - Success state with row/customer count on completion

Route: /admin — no link anywhere in the app. Access via triple-clicking the version number in Setup page footer (BKL-M43). Intentionally undocumented in user-facing UI.

Also includes: background scheduler configuration per source (schedule time, interval, enable/disable toggle, next run time) — see BKL-M38.

Note: BKL-UX50 (live status polling on Setup Sync Now buttons) is superseded by this — status polling belongs on the Admin page, not Setup.

### BKL-M41 | Setup Data Sources "Sync Now" — change from source scrape to cache sync
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason request 2026-04-01
Files: dashboard/src/pages/SetupPage.tsx, src/scrape-api.ts
Description: The current "Sync Now" buttons in Setup Data Sources trigger full source scrapes (Playwright → source → GSheet → cache). This is wrong — those buttons should be fast cache syncs only (GSheet → local cache → dashboard). Source scrapes belong on the Admin page (BKL-M40) and in the automated morning scheduler.

Changes required:
  - RH Cases "Sync Now": change from POST /api/scrape/rh → POST /api/refresh (or a new /api/refresh/cases endpoint that reads cases cache from RH API token path, no Playwright)
  - Supportable "Sync Now": change from POST /api/scrape/supportable/discover → POST /api/refresh (reads GSheet → updates local cache via refreshSubscriptions())
  - CCSP "Sync Now": change from POST /api/scrape/ccsp → POST /api/refresh (reads GSheet → updates local cache via refreshCCSP())
  - SF Pipeline "Sync Now": change from POST /api/scrape/salesforce → POST /api/refresh/pipeline (reads GSheet → updates local cache via refreshPipeline())

Result: Sync Now becomes fast (seconds, not minutes), no Playwright involved, no VPN required. Live status polling (BKL-UX50) no longer needed on Setup page — cache syncs complete quickly.

Dependency: BKL-M40 (Admin page) should be built first or in parallel so source scrape capability is not lost during the transition.

### BKL-M42 | App version number — define semantic version and surface in UI
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Jason request 2026-04-01
Decision: DONE — `GET /api/version` endpoint added to server.ts (returns `{"version":"1.0.0"}`). `VersionFooter` component added to SetupPage.tsx footer displaying `v1.0.0` in text-xs text-gray-500. `data-testid="version-number"` attribute on element for BKL-M43 triple-click handler.

### BKL-M43 | Triple-click version number to access Admin page (hidden entry point)
Status: ✅ DONE 2026-04-01
Severity: Medium
Source: Jason request 2026-04-01
Files: dashboard/src/pages/SetupPage.tsx (or shared footer), dashboard/src/pages/AdminPage.tsx (BKL-M40)
Description: The Admin page (/admin) should have no visible link anywhere in the app. Access is via triple-clicking the version number in the Setup page footer. This prevents accidental discovery while keeping the page reachable without any auth system.
Fix:
  1. Version number element gets a click counter (useRef or useState, resets after 1.5s inactivity)
  2. On 3rd click within 1.5s window: navigate('/admin')
  3. Optional: brief visual flash or subtle confirmation on the 3rd click before navigating
  4. No tooltip, no label, no hint — intentionally undocumented in user-facing UI
  5. Document the shortcut in CLAUDE.md and internal docs only
Depends on: BKL-M42 (version number in UI), BKL-M40 (Admin page exists)

---

### BKL-M44 | Supportable initial load bootstrap — crash-safe sequential job
Status: ✅ DONE 2026-04-01
Severity: High
Source: Jason + Marcus + Serena analysis 2026-04-01
Files: src/supportable-scraper.ts, src/background-scheduler.ts (or new src/bootstrap-initial-load.ts), dashboard/src/pages/AdminPage.tsx (BKL-M40)
Description: The initial Supportable data load for a freshly set-up instance (or a new AE with many customers) is a one-time, potentially multi-hour job. It is fundamentally different from the daily batch rotation (BKL-M36) and needs its own design:
  - No time-box — just let it run until complete. One-time event, no time constraint needed.
  - Crash-safe — writes account numbers and subscription rows to customers.json + GSheets incrementally after each customer, never all-or-nothing at the end
  - Resume-capable — if the container restarts mid-run, the job picks up from the last completed customer (checks which customers already have data in GSheets before starting)
  - Admin-triggered — accessible from the Admin page (BKL-M40), not from the Setup wizard flow
  - Progress display — live status showing "Customer N of M complete" with per-customer result
  - Sequential — PARALLEL_PAGES=1 is a hard constraint (APEX session contention); parallel per-AE jobs are NOT feasible because all pages share the same BrowserContext and therefore the same APEX session
  - Discovery skip optimization — skip the name-search discovery phase for customers that already have account numbers cached in customers.json (saves ~15-25s per customer on re-runs)
Approach confirmed by Jason 2026-04-01: for initial load, just run it to completion with no batching or time-box. Batching (Option B from BKL-M36) is for the ongoing daily scheduled rotation only.
Estimated runtime at 200 customers (with discovery skip for known accounts): ~83 min (200 × ~25s avg).
Depends on: BKL-M40 (Admin page trigger surface)
Related: BKL-M36 (✅ DONE — Option B batch rotation for ongoing daily maintenance)

---

### BKL-M51 | CCSP data investigation — stale quarters + missing customer names
Status: ✅ DONE 2026-04-02
Priority: P1
Size: M (research + fix)
Source: Jason 2026-04-02 — CCSP scrape succeeds but data is stale (Q3-Q4 2025 only) and customer names show as "?"
Files: src/ccsp-scraper.ts, src/sheets.ts (fetchCCSPData), server.ts (/api/ccsp), data/cache/ccsp-data.json
Description: Two issues discovered after successful CCSP Tableau scrape:
  1. **Stale quarters**: Only Q3 2025 ($464K) and Q4 2025 ($450K) returned. Today is April 2026 — should have Q1-Q2 2026 data. Either Tableau source doesn't have newer quarters, or the scraper's rolling window filter is excluding them, or the Google Sheet only has old data.
  2. **Customer names "?"**: API returns `{customer: "?"}` for all 14 accounts. The cache file has proper names (Crowdstrike, McAfee, etc.) but `fetchCCSPData()` in sheets.ts may not be reading the Account Name column correctly — column header mismatch, missing column index, or the sheet tab structure changed.
Investigation needed:
  1. Read the actual CCSP Google Sheet for Carolanne Farrell (sheetId in aes.json) — what columns exist? What quarters? What account names?
  2. Trace fetchCCSPData() column detection logic — does `h.toLowerCase() === 'account name'` match the actual header?
  3. Check getRollingFyWindow() output — what quarters does it compute for April 2026?
  4. Check if the Tableau dashboard itself has 2026 data (may need VNC inspection)
  5. Fix both issues
Related: BKL-G17 (Cloud Spend UI redesign depends on correct quarter data)

---

### BKL-S20 | territory-sync.ts — formula prefix not stripped from sheet customer names
Status: ✅ DONE 2026-04-02
Severity: Medium (mitigated)
Source: Rook Blackburn Wave 6 scan 2026-04-01
Files: src/territory-sync.ts:136-156
Description: Customer names from the territory Google Sheet are normalized via `normalizeTerritoryCustomerName()` (strips legal suffixes, title-cases) but leading formula-injection prefixes (`=`, `+`, `-`, `@`) are not stripped. A malicious tab in the territory sheet could write `=IMPORTRANGE(...)` as a customer name; this would flow into customers.json. Mitigated: downstream Sheets writers apply `sanitizeCell()` at write time — so the injection would be caught before hitting Google Sheets. However, customers.json itself could contain the unsanitized prefix.
Fix: In `normalizeTerritoryCustomerName()`, add leading-prefix strip after trimming: `name = name.replace(/^[=+\-@]/, '')`. One-line fix, zero functional impact on real customer names.

---

### BKL-M50a | Auth/scraper audit — gap identification (Serena)
Status: ✅ DONE 2026-04-02
Priority: P0
Size: L
Source: Jason 2026-04-02
Decision: DONE — Serena produced docs/AUTH-SCRAPER-AUDIT.md. 17 gaps identified (3 P0, 6 P1, 8 P2). Reframed for single-user-per-container architecture (G2/G3 dropped).

### BKL-M50b | Auth/scraper research — enterprise patterns + architecture recommendations
Status: ✅ DONE 2026-04-02
Priority: P0
Size: M (research)
Source: Jason 2026-04-02 — "do we keep using playwright vs something else?"
Description: Deep research on enterprise-grade solutions for each gap. Covers:
  1. Auto browser recovery patterns (watchdog, health check, crash detection, cookie persistence)
  2. Session lifecycle management (TTL estimation, proactive refresh, circuit breaker)
  3. Playwright vs alternatives (Puppeteer, browser-use, headless options)
  4. API-first assessment per service: can we use REST APIs instead of browser scraping?
     - RH Portal: Hydra API (ADR-001 says 401s — reconfirm)
     - Salesforce: REST API for reports/pipeline (avoid Lightning DOM scraping)
     - Tableau: REST API for CCSP data (avoid SSO passthrough)
     - Supportable: APEX app, likely browser-only
  5. Scraper queue patterns (priority queue, dead letter, retry backoff, rate limiting)
  6. Container resilience (process supervisor, memory management, graceful shutdown)
  7. Observability (scraper health dashboard, alert thresholds, telemetry)
Output: docs/research-enterprise-scraper-patterns.md with specific recommendations per service

### BKL-M50c | Auto browser context recovery
Status: ✅ DONE 2026-04-04 — Two gaps closed: (1) keepAlive() called after relaunch to verify session; (2) setContextRecoveryCallback registered in server.ts — fires adoptSfContext + adoptSupportableContext + adoptCcspContext after auto-recovery so sister scrapers don't hold dead context references.
Priority: P0
Size: M (3-4 days)
Depends on: BKL-M50b (research recommendations)
Files: src/rh-scraper.ts, src/rh-auth.ts, src/scraper-manager.ts, entrypoint.sh
Description: If Chromium crashes or RH session expires overnight, the system stays degraded until manual reconnect. Must auto-recover.
  Implementation (pending research): browser.on('disconnected') handler, auto-relaunch persistent context, restore cookies from session-state.json, re-verify session, notify user only if auto-recovery fails.

### BKL-M50d | Session health dashboard panel
Status: ✅ DONE 2026-04-04
Priority: P1
Size: M (3-4 days)
Depends on: BKL-M50b (research recommendations)
Files: server.ts, dashboard/src/components/SessionHealthPanel.tsx (new)
Description: Users cannot see session status at a glance. Build a panel showing per-source: session status (active/expired/unknown), estimated TTL, last successful scrape, staleness indicator, one-click reconnect. Visible on Admin page and optionally on dashboard home.

### BKL-M50e | Scraper telemetry + history
Status: ✅ DONE 2026-04-04 — GET /api/status/telemetry (summary) and GET /api/status/telemetry/history (full log) added to server.ts. ScrapeHistorySection component added to AdminPage.tsx showing last 50 runs sorted by time. docs/ added to Containerfile final stage.
Priority: P1
Size: S (2-3 days)
Files: src/scraper-manager.ts, data/cache/scrape-log.json, server.ts, dashboard/src/pages/AdminPage.tsx
Description: No record of past scrape runs. Only last run's status stored in memory, lost on restart. Write append-only scrape log with: timestamp, scraper name, duration, records extracted, success/failure, error message. Show in Admin as "Scrape History" table.

### BKL-M50f | Push notification on scrape skip
Status: ✅ DONE 2026-04-03 (console.warn + recordOutcome with skip message added to CCSP and Supportable skip paths in background-scheduler.ts)
Priority: P1
Size: XS (2 hours)
Files: src/background-scheduler.ts
Description: Scheduled scrapes at 6:30am/7am skip silently when session is expired. User doesn't know data wasn't refreshed. Add notification (console log + dashboard status update) when a scheduled scrape is skipped due to expired session.

### BKL-M50g | Xvfb readiness check + container hardening
Status: ✅ DONE 2026-04-03
Priority: P2
Size: XS (1 hour)
Files: entrypoint.sh
Description: Replace `sleep 1` with xdpyinfo probe loop. Add --memory=2g to Makefile. Consider process supervisor (tini/dumb-init).

### BKL-M50h | API migration research — Tableau confirmed, SF/RH limited (KEEP CURRENT SCRAPERS)
Status: 🚫 WONTFIX 2026-04-03 — Jason confirmed: Tableau PAT + SF REST API both unavailable. RH APIs return wrong org data. Supportable has no API. Current browser scrapers are permanent solution, not temporary.
Priority: P1
Size: L (multi-service migration)
Depends on: BKL-M50b (research complete)
Files: src/sf-scraper.ts, src/ccsp-scraper.ts, src/redhat.ts
Description: Research confirmed 4 services can partially or fully migrate to REST APIs. Tested 2026-04-02:
  **RH Subscriptions API** ❌ DOES NOT HELP — returns YOUR org's subscriptions (employee subs), NOT customer subscriptions. Customer subs come from Supportable 360 only. No API shortcut.
  **RH Cases API** ❌ 404 at /support/v1/cases and /v2/cases. May only show your own org's cases, not customer cases. Browser scraping of RH Portal likely still required.
  **Tableau REST API** ✅ PAT WORKS — authenticated with PAT name="TEST", site="redhatanalytics". Can list workbooks, found "Overall Cloud Consumption Dashboard" (id=fcc1d3cb). Raw Data view (id=afdc87eb) identified. Data export needs filter parameters — investigation needed.
  **Salesforce REST API** ⚠️ Not tested — needs Connected App with JWT Bearer flow from SF admin.
  **Supportable** — no API. APEX app, browser-only. Confirmed.
  **IMPORTANT (Jason 2026-04-02):** Do NOT remove current browser scrapers until API replacement is approved and tested. Current methods stay as-is; API migration is additive/parallel.
Action items for Jason:
  1. Check with SF admin: can they create a Connected App for JWT Bearer API access?
  2. Tableau: PAT works, need to investigate data export with filters for CCSP view
Implementation order (once access confirmed):
  1. Tableau CCSP via REST API + PAT (auth confirmed, need data export working)
  2. Salesforce via REST API + JWT (if Connected App available)
  3. Keep browser scraping for: RH Portal cases, Supportable subscriptions (no API alternatives)
  4. Run API + browser in parallel during transition — don't cut over until verified
Related: BKL-F11 (shared report dedup), ADR-001

---

### BKL-M57 | Supportable parallel scraping — multi-context architecture + APEX HTTP fast-path
Status: 🚫 WONTFIX 2026-04-03 — Jason confirmed: do not parallelize Supportable. Sequential scraping is correct and stable. APEX multi-tab cookie collision makes parallelism unsafe. Current single-context sequential approach stays permanently.
Priority: P1
Size: L (architecture + implementation)
Source: Jason + extensive testing 2026-04-02

**Research complete. Root cause confirmed. Two solution paths identified.**

Root cause: Oracle APEX has documented multi-tab session collision — all pages in one BrowserContext share cookies, causing session state conflicts. Even APEX "New Session" button (creates apps 304-308) collides because cookies are shared in the single context.

Testing results (2026-04-02):
  - 5 parallel sessions: discovery worked (70s), scraping crashed (DOM context destroyed)
  - 3 parallel + stagger: partial success (A10 got 23/26 rows, 3 customers got 0)
  - 1 sequential: all data correct, 200s (current stable state)

**Solution Path A: Multi-BrowserContext (recommended by Playwright research)**
  Switch from `launchPersistentContext()` to `chromium.launch()` + `browser.newContext()` per worker.
  Each context gets own cookie jar → own APEX session → no collisions. ~50-100MB per context.
  Architecture questions for Serena:
  1. How to authenticate each context (share storageState from RH login, or each logs in separately?)
  2. Impact on CCSP/Tableau SSO passthrough (also uses shared context)
  3. Impact on _livePage pattern (RH keep-alive)
  4. SF already has own context (initSfContext) — does it conflict?
  5. How to maintain a restore path back to single persistent context if multi-context has issues
  References: BKL-RES01 vault, BKL-RES03 vault, Playwright docs on BrowserContext isolation

**Solution Path B: APEX HTTP fast-path (from RES01 research)**
  Extract data from `page.content()` (raw HTML string) instead of DOM interaction.
  If APEX server-renders the data table, we can parse HTML without clicking/scrolling.
  Eliminates "element not attached" errors entirely — no DOM interaction = no context conflicts.
  Combined with parallel page navigation (just goto + content()), may not need multi-context at all.
  References: BKL-RES01 vault `RECOMMENDATIONS.md` lines 329-353

**Additional improvements from research vaults:**
  - `--restore-last-session` flag for better session persistence (RES03)
  - SelectorChain pattern for resilient element targeting (RES01)
  - Render mode detection (server vs client) to choose extraction strategy (RES01)
  - Entity resolution for customer name matching (RES02 — fuzzball library + composite scoring)

**Implementation plan:**
  1. Serena: design multi-context architecture incorporating RES01/RES03 findings
  2. Marcus: implement Path B (HTTP fast-path) first — lower risk, no architecture change
  3. If Path B solves the parallel issue, Path A becomes optional optimization
  4. If Path B doesn't fully solve it, Marcus implements Path A per Serena's architecture
  5. Always maintain restore path: keep PARALLEL_PAGES=1 sequential as fallback

Files: src/rh-scraper.ts, src/supportable-scraper.ts, src/ccsp-scraper.ts, src/scraper-manager.ts
Vault: ~/.claude/MEMORY/RESEARCH/2026-04/playwright-resilience-patterns/, ~/.claude/MEMORY/RESEARCH/2026-04/browser-auth-persistence/

---

### BKL-M54 | Supportable scraper optimization — skip discovery + faster waits
Status: ⏸️ DEFERRED
Priority: P1
Size: S (half day)
Source: Supportable 360 User Guide analysis 2026-04-02
Files: src/supportable-scraper.ts
Description: Three optimizations from user guide analysis:
  1. **Skip name-search discovery for cached accounts** (biggest win — 40-60s per customer). If customers.json already has accountNumbers, go straight to account number lookup + export. Don't run discoverAccountNumbersByName(). Already partially noted in BKL-M44.
  2. **Replace networkidle waits with selector waits** (10-15s per account). After Go button: wait for Export tab selector, not networkidle. After Export tab: wait for CSV format selector. After report select: wait for data table.
  3. **Session keep-alive heartbeat** during long batch runs. Every 30 min, navigate to landing page to prevent APEX idle timeout.
  Guide references: Account Number field (line 166), 13 search fields available (lines 163-236), no rate limits documented, 5-year max date range only constraint.

---

### BKL-M55 | Investigate RH internal APIs — one.redhat.com + compass.redhat.com catalogs
Status: ⏸️ DEFERRED
Priority: P2
Size: Research (Jason action)
Source: Jason 2026-04-02 — shared two internal API catalog links
Files: N/A (research only)
Description: Jason identified two Red Hat internal API catalogs that may contain APIs replacing browser scraping:
  1. **one.redhat.com/developers/api-catalog** — internal developer portal with Redoc API docs. Specific API: Bj_4Ht (unknown, behind SSO)
  2. **compass.redhat.com/catalog** — Backstage-based service catalog showing APIs
  3. **Public Support Cases API confirmed**: `https://api.access.redhat.com/support/v1/cases/filter` — documented at developers.redhat.com. Needs testing: does it return CUSTOMER cases or only your org's cases?
  Action items for Jason:
  1. Browse compass.redhat.com API catalog — look for Supportable, Subscription, or Customer Data APIs
  2. Check the Bj_4Ht API at one.redhat.com — what does it expose?
  3. Test the public Cases API with your offline token — does /support/v1/cases/filter return customer case data?
  4. Ask internal teams: does an API exist for Supportable 360 data?

---

### BKL-AI09 | Research: Auto-create NotebookLM per customer with Drive sources
Status: ⏸️ DEFERRED
Priority: P2
Size: Research
Source: Jason 2026-04-02 — "is there a way to create a notebookLM for each customer that pulls in notes/docs/pdfs from the account folder"
Files: TBD
Description: Investigate whether Google NotebookLM can be programmatically created and populated with sources per customer. Each customer already has a Drive folder with meeting notes, account plans, POVs, research docs, PDFs. Goal: one-click "Create Notebook" that spins up a NotebookLM pre-loaded with all the customer's Drive docs as sources.
Research complete (2026-04-02):
  **Option A — NotebookLM Enterprise API (recommended):**
  - Official v1alpha API via Discovery Engine: POST /notebooks + sources:batchCreate
  - Supports Google Docs, Slides, text, web, YouTube as source types
  - Requires: GCP project + Discovery Engine API + NotebookLM Enterprise licensing
  - IAM roles: Cloud NotebookLM Admin or User
  - ~200 lines of code to implement per-customer notebook creation
  - Constraint: 50 sources per notebook (sufficient for most accounts)
  - **CONFIRMED: Red Hat Google Workspace includes NotebookLM Enterprise (Jason 2026-04-02)**
  **Option B — notebooklm-mcp (quick prototype):**
  - Unofficial MCP server: `claude mcp add notebooklm`
  - Cookie-based auth, reverse-engineered APIs, unreliable for production
  - Good for proof-of-concept only
  **Option C — Skip NotebookLM, build Gemini RAG directly:**
  - Use Gemini API with Drive docs as grounding sources
  - Full control, no extra licensing, same underlying model
  - Loses NotebookLM's polished UI and audio overview feature
  **Decision needed:** Check Red Hat's Google Workspace tier for NotebookLM Enterprise access. If available, implement Option A. If not, evaluate Option C.
  Sources: docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks
Related: BKL-AI04 (Account Intelligence subfolder — same Drive sources)

---

### BKL-AI10 | Enable Discovery Engine API + NotebookLM Enterprise IAM roles
Status: ⏸️ DEFERRED
Priority: P2
Size: XS (30 min)
Source: AI09 research — prerequisite for programmatic notebook creation
Files: GCP Console (not code)
Description: Enable the Discovery Engine API in the jhorn-pai GCP project and grant the service account (or user) the Cloud NotebookLM Admin IAM role. One-time setup.
Fix:
  1. GCP Console → APIs & Services → Enable "Discovery Engine API"
  2. IAM → grant `roles/discoveryengine.notebooklmAdmin` to the SA or user account
  3. Verify with a test API call: `POST /v1alpha/projects/{PROJECT}/locations/us/notebooks` with title "Test"
  4. Delete test notebook after verification

---

### BKL-AI11 | Create NotebookLM per customer — batch notebook + source provisioning
Status: ✅ DONE 2026-04-04 — src/notebooklm.ts (Discovery Engine v1alpha client), notebookId/notebookUrl in types.ts + customers.json, patchCustomer() in server-state.ts, 3 API routes in scrape-api.ts. Dormant unless NOTEBOOKLM_ENABLED=true. Rook conditional pass: 2 MEDIUM (API path hardening, error sanitize), 2 LOW (SA key validation, driveFolderId sanitize) — deferred as hardening follow-up.
Priority: P2
Size: S (half day)
Source: AI09 research — core implementation using Enterprise API v1alpha
Files: src/notebooklm.ts (new), server.ts (API routes)
Depends on: BKL-AI10 (API enabled + IAM)
Description: For each customer, create a NotebookLM notebook and batch-add all Google Drive docs from their folder as sources. Always regenerate — if notebook exists, update sources (add new, remove stale). Store notebook ID + URL in customers.json for dashboard linking.
Fix:
  1. Create src/notebooklm.ts with:
     - `createOrUpdateNotebook(customer)` — finds existing by title or creates new
     - `syncNotebookSources(notebookId, customerFolderId)` — lists Drive docs, batch-adds as sources, removes stale
  2. API: Discovery Engine v1alpha endpoints:
     - POST `/notebooks` (create)
     - POST `/notebooks/{id}/sources:batchCreate` (add sources)
     - GET `/notebooks/{id}/sources` (list current)
     - DELETE `/notebooks/{id}/sources/{sourceId}` (remove stale)
  3. Source types: Google Docs + Slides (via Drive file reference), PDFs (if supported)
  4. Add `notebookUrl` field to Customer type in types.ts
  5. Store notebook ID in customers.json per customer
  6. 50-source limit: prioritize by recency (most recently modified first)

---

### BKL-AI12 | UX research + design — NotebookLM integration into dashboard
Status: ✅ DONE 2026-04-04 — "Open Notebook" link added to CustomerDetailPage header (right-aligned, beside AE label). Fetches notebookUrl from /customers. BookOpen icon, opens in new tab with rel=noopener noreferrer.
Priority: P2
Size: M (research + design + implementation)
Source: Jason 2026-04-02 — "will this include researching how to architect and design the UI for adding notebookLM?"
Files: dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/components/AccountPortfolioGrid.tsx, docs/DESIGN-SPEC-NotebookLM.md (new)
Depends on: BKL-AI11 (notebook creation)
Description: Research and design how NotebookLM integrates into the dashboard UX. Not just a link — think about how the notebook fits the SA workflow. Questions to answer:
  1. Where does the notebook link/button live? (header? sidebar? dedicated section?)
  2. Should we embed NotebookLM inline (iframe) or always external link?
  3. How does the notebook relate to the Account Brief? (complementary? replaces brief for deep dives?)
  4. Should the Account Portfolio Grid show a notebook icon/status per customer?
  5. How to surface "Notebook has N sources" and "Last updated" context?
  6. Should there be a "Refresh Sources" button that syncs Drive docs into the notebook?
  7. How does this integrate with the AI Intelligence docs (AI02-AI04)?
  8. What about the NotebookLM audio overview feature — surface the podcast-style summary?
Fix:
  1. Aditi designs the UX (wireframes, placement, interaction patterns)
  2. Quinn reviews accessibility and workflow fit
  3. Produce docs/DESIGN-SPEC-NotebookLM.md with mockups and decisions
  4. Implement: customer detail page notebook section, portfolio grid notebook indicator
  5. "Open Notebook" link (external, target="_blank") when notebook exists
  6. "Create Notebook" button when no notebook → POST /api/customer/:name/notebook
  7. Loading state while creating (~10s)
  8. "Refresh Sources" button to sync latest Drive docs into existing notebook

---

### BKL-AI13 | Batch "Create All Notebooks" from Admin page
Status: ✅ DONE 2026-04-04 — NotebookLMSection added to AdminPage. Checks /api/notebooklm/status, disabled state when NOTEBOOKLM_ENABLED not set, calls POST /api/admin/notebooks/create-all.
Priority: P3
Size: XS (30 min)
Source: AI09 research — bulk provisioning
Files: dashboard/src/pages/AdminPage.tsx, server.ts
Depends on: BKL-AI11 (notebook creation)
Description: Add "Create All Notebooks" button on Admin page that iterates all customers and creates/updates their NotebookLM notebooks. Shows progress (N of M complete). Sequential to avoid API rate limits.

---

### BKL-AI14 | Auto-create notebook during bootstrap + refresh on Drive doc changes
Status: ⏸️ DEFERRED
Priority: P3
Size: S (half day)
Source: AI09 research — automation
Files: src/bootstrap-orchestrator.ts, src/background-scheduler.ts
Depends on: BKL-AI11 (notebook creation), BKL-M47 (drive watcher)
Description: Automatically create NotebookLM notebook as part of bootstrap Step 2 (after customer folders created). Also: when drive-watcher detects doc changes for a customer, sync their notebook sources to pick up new/modified docs.

---

### BKL-AI15 | Research: Product roadmap/feature intelligence for AAP, OCP, RHEL
Status: ✅ DONE 2026-04-05 — Research + implementation spec complete. Fulfilled by BKL-W3-12 Phase 1.
Priority: P2
Size: Research → implementation tracked in BKL-W3-12
Source: Jason 2026-04-02 — "bring product features/tech preview/roadmaps for our top 3 platforms"
Research complete: docs/research-redhat-product-data-apis.md
Implementation spec: Updated in BKL-W3-12 (parent task)
Confirmed data sources (2026-04-05):
  - Life Cycle API: https://access.redhat.com/product-life-cycles/api/v1/products — free, no auth, all versions+EOL dates
  - RHEL release notes: PDF download from docs.redhat.com (unpdf — already a dependency)
  - OCP/AAP release notes: Static fetch + Playwright fallback via scraper queue
  - AAP Atom feed: https://announcements.ansiblecloud.redhat.com/feed.atom
  - Scraping approach: PDF-first (avoids client-side rendering). contentHash dedup = ~$0.30/month Gemini cost.
  - Current versions: RHEL 9.7, OCP 4.21, AAP 2.6
Related: BKL-W3-12 (parent implementation task), BKL-AI16 (fulfilled by W3-12 Phase 3)

### BKL-AI16 | Interactive product Q&A — Gemini-powered query interface for AAP, OCP, RHEL
Status: ✅ DONE 2026-04-05 — ProductQueryPanel (3 tabs: RHEL/OCP/AAP), useProductQuery hook, POST /api/product-query, src/product-intelligence.ts with callGeminiGroundedRaw, source extraction, confidence scoring, cost tracking. Embedded in CustomerDetailPage. Commit 633d882 merged to main.
Priority: P2
Size: S (4 hours — revised down from M after research)
Source: Jason 2026-04-02 — "a way to query this information directly like a gemini query to ask questions toward each product"
Research: 2026-04-05 — Architecture decided: Gemini Google Search grounding (NOT RAG, NOT long-context). callGeminiGrounded() already exists in account-intelligence.ts — reuse directly. AI15 data is an enhancement not a blocker.
Files: src/product-intelligence.ts (new ~300L), dashboard/src/components/ProductQueryPanel.tsx (new ~250L), dashboard/src/hooks/useProductQuery.ts (new ~100L), src/customer-routes.ts (+30L endpoint), dashboard/src/pages/CustomerDetailPage.tsx (+10L embed)
Depends on: BKL-AI15 — NOT a blocker. AI16 works standalone via grounding; AI15 improves quality when available.
Description: Tabbed chat UI (AAP / OCP / RHEL tabs) embedded in CustomerDetailPage. Per-tab message history (max 10 messages). Streaming responses via text/event-stream. Citation cards with source URLs from Gemini grounding attributions.
Implementation plan:
  1. src/product-intelligence.ts — callGeminiGrounded() wrapper with product+customer system prompt, 3-layer hallucination guardrails, confidence scoring
  2. POST /api/product-query — { product, question, customerName?, sessionId? } → streaming SSE response: chunk / source / confidence / done events
  3. ProductQueryPanel.tsx — tabbed chat, progressive streaming render, source tooltip cards, confidence badge, clear history
  4. useProductQuery.ts — custom hook managing fetch, streaming, abort, session state
  5. CustomerDetailPage.tsx — embed panel in new "Product Intelligence" section
System prompt: 3-layer (rules + AI15 context if available + optional customer context). Grounding always enabled — throw error if response has no attributions.
Latency: 3–8s typical, 12s max. Streaming makes it feel responsive. Cost: ~$0.005–0.01/query.
Guardrails: System prompt rules + mandatory grounding + confidence field enforcement + client-side source warning for LOW confidence.
Session model: React state per tab, max 10 messages, oldest drop when >8000 tokens.
Action URLs: calendar (Google Calendar), case (RH portal), opp (Salesforce). All open in new tab rel=noopener.
  7. Consider conversation history for follow-up questions within a session
Related: BKL-AI15 (product data sources), BKL-AI02 (company intelligence)


---

### BKL-M52 | Gemini API cost tracking — per-call token usage + estimated cost dashboard
Status: ✅ DONE 2026-04-04 — src/gemini-cost-tracker.ts (in-memory tracker), instrumented callLLM/callLLMStructured/callGeminiGrounded/callGeminiStructured, GET /api/admin/gemini-usage, AdminPage cost stat card
Priority: P1
Size: M (1-2 days)
Source: Jason 2026-04-02 — "I need a way to figure out costs as we go further"
Files: src/customer.ts (callLLM, callLLMStructured), src/account-intelligence.ts, src/doc-extraction.ts, server.ts (new /api/costs endpoint), dashboard (cost display)
Description: As we add more Gemini calls (briefs, intelligence docs, extraction, grounding), costs will grow. Need visibility into what each feature costs.
Fix:
  1. Instrument all Gemini API calls to log input/output token counts from response `usageMetadata` field
  2. Store per-call metrics: timestamp, call type (brief-extract/brief-synthesize/intelligence-industry/intelligence-company/intelligence-analysis/doc-classify), customer name, input tokens, output tokens
  3. Compute estimated cost per call using Gemini 2.5 Flash pricing ($0.15/1M input, $0.60/1M output)
  4. Append to data/cache/gemini-usage.json (rolling 30-day window)
  5. Add GET /api/costs endpoint: total today, total this month, breakdown by call type, breakdown by customer
  6. Admin page: cost summary card showing daily/monthly spend and per-feature breakdown
  7. Consider: budget alerts (warn if daily cost exceeds threshold)
Related: Brief generation (~$0.006/brief), intelligence docs (TBD — grounding calls are more expensive)

---

### BKL-M53 | Estimated time tracking for long-running operations
Status: ✅ DONE 2026-04-04
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — "capture estimated time so we know what to expect"
Files: src/account-intelligence.ts, src/background-scheduler.ts, server.ts
Description: Long-running operations (intelligence generation, brief generation, scraper runs) provide no time estimate. User sees "Running..." with no idea if it's 10 seconds or 5 minutes.
Fix:
  1. Track elapsed time on each intelligence pipeline step + total
  2. Store historical durations per operation type in cache
  3. Use rolling average to estimate remaining time for in-progress operations
  4. Return estimated_time_remaining in intelligence-status and scrape-queue responses
  5. Dashboard shows "~2 min remaining" instead of just "Running..."
  6. Log completion times: "[intelligence] A10 Networks: industry 12s + company 45s + analysis 38s + docs 8s = 103s total"

---

### BKL-M49 | Scraper startup sequencing — prevent race conditions on container restart
Status: ✅ DONE 2026-04-02
Priority: P1
Size: M (1-2 days)
Source: Jason 2026-04-02 — CCSP scraper failed repeatedly because RH scraper held shared browser context on startup
Files: src/background-scheduler.ts, src/rh-scraper.ts, src/ccsp-scraper.ts, src/supportable-scraper.ts, entrypoint.sh
Description: On container start (or rebuild), multiple scrapers try to use the shared browser context simultaneously. The RH case scraper starts immediately and holds pages open for 5-10 min while iterating ~50 accounts. Any other scraper (CCSP, Supportable) that runs during this window gets "Target page, context or browser has been closed" — they compete for the same BrowserContext.
  Current: all scheduled scrapers start independently on boot with no coordination. First one grabs the context, others fail silently.
  Observed 2026-04-02: CCSP scrape triggered via Admin page failed 3 times because RH was running. Required waiting for RH to finish then manually retrying.
  Needs research: scraper queue/lock patterns, startup sequencing, retry-after-busy, separate contexts (breaks Tableau SSO?), persisting lastSync across restarts.
Related: ADR-001 (session architecture), CCSP two-phase mutex, PARALLEL_PAGES=1 constraint

---

### BKL-G18 | Account card shows industry segment instead of customer name
Status: ✅ DONE 2026-04-03 (Quinn: account cards show company names)
Priority: P1
Size: XS (10 min)
Source: Jason 2026-04-02 — A10 Networks card shows "Network Security and Application Delivery (including DDo..." instead of "A10 Networks"
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: After AI01 wrote industry/segment data to customers.json, the Account Portfolio Grid card title shows customer.segment instead of customer.name. The segment field previously held short values like "Commercial" so the bug was invisible. Now AI01 writes long industry descriptions, making the card title wrong.
Fix: Find where the card renders the customer name and ensure it uses customer.name, not customer.segment. One-line fix.
Related: BKL-AI01 (identifyIndustry writes segment to customers.json)

---

### BKL-G17 | Cloud Spend section redesign — quarterly breakdown, reporting period context, better visualization
Status: ✅ DONE 2026-04-04
Priority: P2
Size: M (1-2 days)
Source: Jason 2026-04-02 — "research a better design, break down by quarter, show which quarters we're reporting"
Files: dashboard/src/components/CloudSpendSection.tsx, server.ts (/api/ccsp)
Description: Current Cloud Spend "Spend by Account" panel shows a donut chart + legend but provides no temporal context. Issues:
  - No quarter breakdown — total spend lumped together with no visibility into Q1/Q2/Q3/Q4 trends
  - No reporting period indicator — user doesn't know which quarters the data covers
  - Account names truncated in legend ("Crow...", "McAf...", "Confl...")
  - Donut chart takes up space but doesn't convey much beyond relative proportions
  - No quarter-over-quarter trend (is spend growing, shrinking?)
Desired:
  1. Show which quarters are being reported (e.g., "CY26 Q1-Q2" header badge)
  2. Break down spend by quarter — stacked bar or grouped bar showing per-account per-quarter spend
  3. Show quarter-over-quarter trend (up/down arrows or sparklines)
  4. Full account names visible (no truncation)
  5. Keep total spend hero number ($914K)
  6. Research best-in-class cloud spend dashboard designs for inspiration
Related: CCSP data already has byQuarter in the API response

---

### BKL-M48 | Morning Summary pipeline-stuck signal uses CCSP usage reports instead of SF pipeline
Status: ✅ DONE 2026-04-02
Severity: High
Source: Jason 2026-04-02 — "CCSP opps are usage reports not opportunities, use PIPELINE data from SF scrape"
Files: server.ts (/api/morning-summary pipeline-stuck signal block)
Description: The pipeline-stuck signal in morning summary reads from `readPipelineCache()` which returns ALL pipeline records — including CCSP usage/royalty reports from Tableau (e.g., "Global Royalty-CCSP-AWS ROSA-CY26Q1M1-US-Dropbox"). These are consumption tracking entries, NOT sales opportunities. They have close dates in the past because they represent completed billing periods, not stalled deals.
  The signal should ONLY use actual Salesforce pipeline opportunities — identifiable by their SF report source (pipelineSheetId from aes.json) and real opportunity structure (oppNumber, stage, ACV).
Fix:
  1. Filter pipeline records: exclude any record where oppName contains "CCSP", "Royalty", or "Usage Period" — these are CCSP consumption entries
  2. OR better: tag records at scrape time with source (sf-pipeline vs ccsp) and only use sf-pipeline for stuck-deal signals
  3. Same filter should apply to the PipelineSection dashboard component — CCSP records should only appear in CloudSpendSection, never in Pipeline
Related: BKL-G02 (morning summary signal types)

---

### BKL-M47 | Drive watcher should auto-invalidate brief cache on doc changes
Status: ✅ DONE 2026-04-02
Severity: Medium
Source: Jason 2026-04-02 — Drive docs now flow into briefs but changes don't trigger re-generation
Files: src/drive-watcher.ts, src/cache-layer.ts, src/background-scheduler.ts, server.ts
Description: The drive-watcher already detects file modifications via Google Drive Changes API (polls with pageToken). But it does NOT invalidate brief caches when customer docs change. Currently, brief auto-regeneration only triggers when sheet data (Supportable) is newer than the cached brief. Drive doc changes, email changes, and calendar changes require manual Regenerate click.
Fix:
  1. When `checkDriveChanges()` returns customer names with modified files, invalidate those customers' brief caches (delete or mark stale)
  2. Optionally: trigger background brief regeneration for affected customers (cost is ~$0.006/brief, negligible)
  3. Add brief cache staleness check against drive-watcher's last-modified timestamp per customer
  4. Consider: also invalidate when emails/calendar data is newer (check Gmail/Calendar API modified timestamps vs brief cachedAt)
Cost analysis: At $0.006/brief and 20 customers, even daily full regen is $0.11/day ($3.42/month). Auto-regen on doc changes is well within budget.
Related: BKL-R24 (content caps), drive-watcher.ts (already has the detection logic)

---

### BKL-M46 | Legacy code cleanup — dead env vars, unreachable fallbacks, dead exports
Status: ✅ DONE 2026-04-02
Severity: Low
Source: Jason + env audit 2026-04-02
Files: .env, server.ts, src/customer.ts, src/sheets.ts, src/pipeline.ts, src/scraper-manager.ts, src/scrape-api.ts
Description: Comprehensive legacy code sweep after env var audit revealed multiple dead paths:
  - **Dead env vars removed from .env**: AE_PARENT_FOLDER_ID, GITHUB_TOKEN, PIPELINE_FILE_ID, SF_REPORT_ID, LLM_PROVIDER, PEOPLEAI_API_KEY, PEOPLEAI_BASE_URL (7 vars removed, 5 active remain)
  - **Unreachable fallback branches**: Code that reads removed env vars still exists in source (server.ts, sheets.ts, pipeline.ts, scraper-manager.ts, scrape-api.ts). These are harmless null checks but add confusion. Consider removing the fallback paths or adding deprecation comments.
  - **`getBriefProvider()` hardcoded**: Returns `'gemini'` always, never reads env. Either wire it to GEMINI_MODEL or remove the abstraction.
  - **`LLM_PROVIDER` references in server.ts**: Display-only, no branching. Remove or replace with GEMINI_MODEL.
Rook scan results (2026-04-02):
  - **23 unused imports in server.ts**: briefCachePath, initDriveWatcher, checkDriveChanges, checkFilesModified, initScrapeContext, adoptSfContext, createPipelineSheet, setSfSessionExpiredCallback, SfSessionExpiredError, listSfReports, lastSfSync, lastSfRowCount, runSupportableScrape, writeSupportableSheet, adoptSupportableContext, lastSupportableScrape, lastSupportableError, adoptCcspContext, runCcspScrape, writeCcspSheet, lastCcspScrape, StoredToken, DEFAULT_REFRESH_INTERVALS, getRefreshIntervals, patchAe, discoverAccountsFromFolders, recordScrapeSuccess, getSfAuthStatus, SupportableCustomer, ProductSubscription
  - **2 orphaned scripts in project root**: read-ccsp.ts, read-ccsp-full.ts (ad-hoc debug scripts, safe to delete)
  - **0 commented-out dead code** — codebase is clean
  - **0 TODO/FIXME/HACK comments** — none found
  - **0 dead type exports** — all types used within hierarchies
Fix:
  1. Remove 23 unused imports from server.ts
  2. Delete read-ccsp.ts and read-ccsp-full.ts from project root
  3. Audit all `process.env.AE_PARENT_FOLDER_ID` references — add `// DEPRECATED` comment or remove fallback branches
  4. Audit all `process.env.PIPELINE_FILE_ID` references — same treatment
  5. Audit all `process.env.SF_REPORT_ID` references — same treatment
  6. Fix `getBriefProvider()` to return actual model name from GEMINI_MODEL
  7. Remove `LLM_PROVIDER` display references in server.ts
Detection scripts for ongoing use:
  - Dead env vars: `grep -E '^[A-Z_]+=.' .env | cut -d= -f1 | while read var; do count=$(grep -r "$var" src/ server.ts --include='*.ts' -l | wc -l); [ "$count" -eq 0 ] && echo "UNUSED: $var"; done`
  - Dead exports: `grep -rn '^export ' src/*.ts | while read line; do name=$(echo "$line" | grep -oP '(?:function|const|class|type|interface)\s+\K\w+'); [ -n "$name" ] && count=$(grep -rl "$name" src/ server.ts --include='*.ts' | wc -l); [ "$count" -le 1 ] && echo "POSSIBLY DEAD: $line"; done`

---

### BKL-M45 | Free/Beta/Trial subscriptions — frontend display in KPI modal + brief tagging
Status: ✅ DONE 2026-04-04 — KPIRenewalsModal collapsible section + KPICards exclusion (already done); buildXmlSources [FREE/TRIAL] tagging → upgraded to FULL EXCLUSION 2026-04-04 (Jason: "make sure we are not using filtered subs into any intelligence")
Severity: Medium
Source: Jason 2026-04-01 — "free or Beta or Trial shouldn't count as a worry if expiring"
Files: src/health-score.ts, src/kpi-history.ts, server.ts (/api/kpis, /api/morning-summary), src/customer.ts (buildXmlSources), dashboard/src/components/KPIRenewalsModal.tsx, dashboard/src/components/KPICards.tsx
Description: Subscriptions with Free, Beta, Trial, Eval, or Developer tier/SKU types are currently treated identically to paid subscriptions. When they expire or approach expiration, they:
  - Drag down health scores (scoreSubscriptions penalty)
  - Inflate KPI renewalsWithin90Days count
  - Trigger morning summary renewal signals
  - Appear as red/amber urgency in KPI Renewals modal
  - Get flagged as renewal risks in Gemini briefs
  These are noise — free subs expiring is expected and harmless.
Fix:
  1. Add `isFreeOrTrial(sub: ProductSubscription): boolean` helper — pattern-match on SKU/productDescription keywords: free, beta, trial, eval, evaluation, developer, self-support, no-support
  2. `src/health-score.ts` `scoreSubscriptions()`: Skip free/trial subs from expiration penalty scoring (still count toward totalSubscriptions)
  3. `server.ts` `/api/kpis`: Exclude free/trial from renewalsWithin90Days count
  4. `src/kpi-history.ts` `captureSnapshot()`: Exclude free/trial from openRenewals metric
  5. `src/customer.ts` `buildXmlSources()`: Tag free/trial subs with `[FREE/TRIAL]` marker so Gemini brief doesn't alarm over them
  6. `server.ts` `/api/morning-summary`: Exclude free/trial from renewal signals
  7. `dashboard/src/components/KPIRenewalsModal.tsx`: Show free/trial subs with muted styling (gray badge, no red/amber urgency)
  8. `dashboard/src/components/KPICards.tsx`: Exclude free/trial from renewal count in KPI card
Backend DONE (2026-04-02): Steps 1-4, 6 implemented. isFreeOrTrial() filters health scores, /api/kpis count, morning summary signals.
Frontend NOT DONE: Steps 5, 7, 8 — KPIRenewalsModal still shows all subs unfiltered (including Free Tier, Beta Access, Trials). KPICards count may still include free/trial. Brief XML not yet tagging free/trial.
**Aditi UX recommendation (2026-04-02): Option E — Filtered Default with Collapsible Disclosure**
  Full spec: docs/DESIGN-SPEC-SubscriptionTiers.md
  - KPI card count shows paid-only (3, not 15)
  - Modal opens with paid subs only (clean triage)
  - Collapsible footer: "12 free/trial hidden" — click to expand
  - Expanded rows: muted gray + FREE/TRIAL/BETA pill badges, no urgency colors
  - Toggle resets on each open
  Implementation: add `sku` field to RenewalRow, filter with `isFreeOrTrial()` in KPICards.tsx + KPIRenewalsModal.tsx collapsible section. ~4 files, no new deps.
Related: BKL-R04 (health score), BKL-R05 (KPI history), BKL-R17 (XML sources)

---

## Research-Driven Enhancements (2026-04-01)

Source: 9-agent extensive research on AI customer intelligence dashboards. Full report: `docs/research-ai-customer-intelligence-2026.md`

### BKL-R01 | Brief prompt: add temporal delta — "what changed since last interaction"
Status: ✅ SUPERSEDED by R17+R18 — temporal delta is embedded in the three-step pipeline extraction prompt (XML `last_interaction` field + `is_new_since_last_brief` in extraction schema) and synthesis prompt ("Lead with what CHANGED since {last_interaction_date}")
Priority: P1
Size: XS (prompt-only change)
Source: Research 2026-04-01 — Alex (all 3 threads), Ava academic. Cross-agent consensus: temporal delta is the #1 differentiator between generic and actionable briefs.
Files: src/customer.ts:377-454 (generateBrief prompt)
Description: Current briefs generate a static point-in-time summary. Research shows the highest-value briefs answer "what changed since last interaction." We already have last meeting date from calendar data. Pass today's date + last meeting date into the prompt with: "Focus on changes and new information since [last meeting date]. Do NOT restate what the seller already knows."
Fix:
  1. Compute `lastMeetingDate` from `meetings` array (most recent past meeting)
  2. Add to prompt: `"Last in-person/virtual meeting with this customer: [date]. Highlight what is NEW since that date."`
  3. Add new section header: `## What Changed Since Last Interaction` — 3-5 bullets of new signals only
  4. Add negative constraint: `"Do NOT include static company overview info the SA already knows."`
Effort: ~1 hour. No new data sources. Pure prompt engineering.
Research evidence: Gartner predicts 50% meeting prep reduction only when briefs are actionable (not generic). Alex: "Temporal framing forces recency — the single pattern that separates shelfware from daily-use intelligence."

### BKL-R02 | Brief prompt: add Priority Action — single most important thing per customer
Status: ✅ SUPERSEDED by R17+R18 — priority action is the synthesis prompt's first sentence rule ("The FIRST SENTENCE must state the single most important action") + deterministic ranking (top-scored item = priority action)
Priority: P1
Size: XS (prompt-only change)
Source: Research 2026-04-01 — Johannes contrarian. "AI that generates 14 action items from a call is a busywork multiplier. Sellers already know the 2-3 things that matter."
Files: src/customer.ts:377-454 (generateBrief prompt)
Description: Add a new section to the brief prompt that forces the LLM to pick ONE priority action.
Fix: Add section header to brief format:
  ```
  ## ⚡ Priority Action
  The single most important thing to do for this account RIGHT NOW.
  One sentence. Include who needs to act, what the action is, and by when.
  Based on: [cite the specific data signal — case, renewal, meeting, email].
  ```
Effort: ~30 min. Prompt change only.
Research evidence: Johannes: "Sellers respond rationally — they minimize tool input and use what reduces friction." One clear action > a list of 14.

### BKL-R03 | Brief prompt: add noise reduction constraints
Status: ✅ SUPERSEDED by R17+R18 — noise reduction is built into the pipeline: 250-word limit, omit empty sections, source citations required, "do not include generic descriptions", confidence ratings filter low-quality signals
Priority: P1
Size: XS (prompt-only change)
Source: Research 2026-04-01 — Alex (DIY/architecture), Johannes (top performers). Generic AI summaries are the #1 reason briefs become shelfware.
Files: src/customer.ts:377-454 (generateBrief prompt)
Description: Add explicit negative constraints to the Gemini prompt to prevent generic output.
Fix: Add to system prompt:
  1. `"Do NOT include publicly available company overview info the SA already knows."`
  2. `"Do NOT include generic Red Hat product descriptions."`
  3. `"Do NOT include information older than 90 days unless it is a contract, renewal date, or subscription."`
  4. `"Prioritize: risks first, then opportunities, then context."`
  5. `"Every insight must cite its source data (email date, case number, subscription name)."`
Effort: ~30 min. Prompt change only.
Research evidence: Alex: "Fact-Checking List Pattern — instruct the model to cite specific source data for every claim." Ava: "The SAP case study showed 66-75% cycle reduction, but only with contextualized, not generic, intelligence."

### BKL-R04 | Customer health score — weighted R/Y/G from existing data sources
Status: ✅ DONE 2026-04-02
Priority: P1
Size: M (2-3 days)
Source: Research 2026-04-01 — all 9 agents agreed this is the #1 gap. Johannes gap analysis: "You have ALL the raw inputs. This single feature closes the biggest gap."
Files: src/customer.ts (new function), server.ts (API response), dashboard/src/components/AccountCard.tsx
Related: BKL-DEF04 (health summary — deferred, now promoted by research), BKL-UX41 (triage grouping)
Description: Compute a weighted health score per customer using data we already collect. Research says multi-signal scores beat single-signal scores. We have 6 signal types — more than Gainsight sees from its single silo.
Fix:
  Scoring model (100-point scale → R/Y/G):
  | Signal | Weight | Green (>80) | Yellow (50-80) | Red (<50) |
  |--------|--------|-------------|----------------|-----------|
  | Support cases | 25% | 0 open Sev1/2 | 1 Sev2 or any >30d | Any Sev1 or >2 Sev2 |
  | Subscription expiry | 25% | >180d to nearest expiry | 60-180d | <60d + no renewal in pipeline |
  | Meeting frequency | 20% | Met in last 30d | 30-60d gap | >60d gap |
  | Email engagement | 15% | Active last 14d | 14-30d gap | >30d silence |
  | Pipeline activity | 15% | Active opp in motion | Stalled >30d | No opp + renewal <120d |
  Implementation:
  1. `computeHealthScore(customer, cases, subscriptions, meetings, emails, pipeline)` → `{ score: number, status: 'green'|'yellow'|'red', signals: string[] }`
  2. Return `healthScore` field on customer API responses
  3. Display as colored dot on AccountCard (replace existing basic health indicator)
  4. `signals` array provides tooltip explaining why (e.g. "Sev1 case open 12 days", "No meeting in 47 days")
Effort: 2-3 days (backend calc + API + frontend dot + tooltip + tests).
Research evidence: Gainsight detects sentiment shifts 6 weeks early with multi-signal scores. Johannes: "Health scores built on single-signal models are vanity metrics. Multi-signal models are genuinely predictive." Your 6-signal model would be wider than any commercial tool's input set.

### BKL-R05 | Historical metric snapshots + trend sparklines
Status: ✅ DONE 2026-04-02
Priority: P2
Size: L (3-5 days)
Source: Research 2026-04-01 — Johannes gap analysis (Gap #3: "Your dashboard is a rearview mirror — snapshots, not trajectories").
Files: server.ts (new timer/endpoint), data/cache/history/ (new dir), dashboard KPI components
Related: BKL-UX47 (sparkline KPI type — already specced), BKL-M35 (CCSP trend diff — already specced)
Description: Store daily snapshots of key metrics per customer. Display 30/60/90-day sparklines. Flag significant changes. Transforms dashboard from point-in-time to trajectory view.
Fix:
  1. New background timer (daily, after morning sync completes): snapshot per customer → `data/cache/history/{slug}-{YYYY-MM-DD}.json`
  2. Shape: `{ date, caseCount, sev1Count, subscriptionDaysLeft, meetingCount30d, emailCount30d, pipelineValue, cloudSpend }`
  3. `GET /api/customer/:name/history?days=90` → returns array of daily snapshots
  4. Frontend: 64x24px inline SVG sparklines (per BKL-UX47 spec — no chart library)
  5. Anomaly flags: "Case volume doubled this month", "Cloud spend dropped 40%", "Meeting frequency fell 60%"
Effort: 3-5 days. BKL-UX47 already has the frontend sparkline spec; this adds the data pipeline.
Research evidence: Alex: "Trend lines beat current values for strategic planning." Ava: "Cross-account pattern recognition transforms the SA from reactive account manager to strategic advisor."

### BKL-R06 | Proactive daily morning summary across ALL customers
Status: ✅ DONE 2026-04-02
Priority: P2
Size: M (3-5 days)
Source: Research 2026-04-01 — Johannes contrarian ("Integration with workflow, not a separate dashboard to open"), Alex (state-of-art: "Signal alerts hit first, before the rep opens their CRM").
Files: src/customer.ts (new function), server.ts (new endpoint + timer), notification delivery
Description: Generate a single cross-customer morning summary that surfaces the top 5-10 most important signals across ALL accounts. Push to the user instead of requiring them to open the dashboard and check each customer.
Fix:
  1. New function: `generateMorningSummary(allCustomers, allCases, allSubscriptions, allMeetings, allEmails, allPipeline)` → prioritized list
  2. Priority ranking: new Sev1/2 case > subscription expiring <60d with no renewal > meeting today with prep needed > deal stuck >30d > engagement drop > cloud spend anomaly
  3. `GET /api/morning-summary` → returns top 10 signals with customer name, signal type, action
  4. Optional: push via existing notification hooks (curl to localhost:8888) or Slack webhook
  5. Dashboard: new "Morning Brief" card at top of portfolio page with today's top signals
Effort: 3-5 days. Leverages existing data — no new sources needed.
Research evidence: 6sense pushes overnight signals to Slack before reps open CRM. Gartner: "By 2027, 95% of seller research workflows will begin with AI." The highest-performing tools push intelligence to the seller's existing workflow.

### BKL-R07 | Brief delta detection — highlight what's new vs. last brief
Status: ✅ DONE 2026-04-02
Priority: P3
Size: S (2 days)
Source: Research 2026-04-01 — Alex (DIY/architecture): "Delta-based updates — only re-process sources that changed since last brief."
Files: src/customer.ts (generateBrief), data/cache/briefs/ (existing cache)
Related: BKL-DEF05 (brief cache TTL — deferred)
Description: Cache the previous brief content. On regeneration, pass both old brief and new data to Gemini. Prompt: "Compare this brief to the previous one. Mark sections that are UNCHANGED. Highlight what is NEW or CHANGED with a ▲ prefix."
Fix:
  1. Read previous cached brief before generating new one
  2. If previous exists, append to prompt: `"Previous brief (generated [date]):\n[previous brief]\n\nHighlight only what has CHANGED since the previous brief. Prefix new/changed items with ▲."`
  3. If no previous brief, generate normally (first-time flow unchanged)
Effort: ~2 days. Prompt change + cache read. No new data sources.
Research evidence: Alex: "The best systems treat the LLM as a synthesis layer. Delta detection is the key pattern separating daily-use intelligence from shelfware."

### BKL-R08 | Competitive signal tracking in emails and cases
Status: ✅ DONE 2026-04-02
Priority: P3
Size: S (2-3 days)
Source: Research 2026-04-01 — Gong's conversation intelligence tracks competitor mentions. Johannes: "Useful ONLY when contextualized per deal. Generic competitor alerts are pure noise."
Files: src/customer.ts (brief prompt), server.ts (email/case parsing)
Description: Scan existing email subjects/snippets and support case summaries for competitor product mentions. Surface ONLY when tied to an active account with context. Do NOT build a standalone alert feed (Johannes: "pure noise").
Fix:
  1. Keyword list: VMware, Broadcom, AWS, Azure, GCP, Databricks, Tanium, CrowdStrike, Puppet, Chef, CentOS, Ubuntu, SUSE, Oracle Linux, Rancher, EKS, AKS
  2. Scan `emails[].subject` + `emails[].snippet` and `cases[].summary` for matches
  3. Pass matched keywords + context to Gemini brief as: `"COMPETITIVE SIGNALS DETECTED: [keyword] mentioned in [email/case context]"`
  4. Brief prompt addition: `"## Competitive Signals\nIf competitive keywords are flagged above, explain what they mean for this account and what Red Hat counter-positioning applies. If none detected, omit this section."`
Effort: 2-3 days. Keyword matching + prompt enhancement. No new data sources.
Research evidence: Gong tracks competitor mentions as leading deal risk indicators. RivalSense: "CI fails when noisy, shallow, or ownerless." Our approach: contextualized per-customer, not a firehose.

### BKL-R09 | Stakeholder engagement tracking — flag silent contacts
Status: ✅ DONE 2026-04-02
Priority: P3
Size: M (3-5 days)
Source: Research 2026-04-01 — Gainsight Insight Agent detects relationship changes 6 weeks early. Alex: "Stakeholder mapping — track engagement frequency per contact. Flag when key contacts go silent."
Files: server.ts (email parsing), src/customer.ts (brief input), dashboard customer detail page
Description: Track per-contact email frequency at each customer. Flag contacts who went silent (previously active, now >30 days no response). Surface in brief and customer detail page.
Fix:
  1. Parse `emails[].from` and `emails[].to` to build per-contact activity timeline
  2. Identify contacts with >3 emails in prior 60 days who have 0 emails in last 30 days → "gone silent"
  3. Pass to Gemini brief: `"ENGAGEMENT ALERT: [Contact Name/Role] was active (X emails in prior 60d) but has gone silent (0 in last 30d)."`
  4. Customer detail page: engagement frequency badges per known contact
Effort: 3-5 days. Email parsing + contact extraction + brief integration + UI.
Research evidence: Gainsight's Insight Agent uses engagement frequency changes as a leading indicator — 6 weeks earlier than usage data. Contact silence is one of the strongest deal risk signals across all reviewed platforms.

### BKL-R10 | Research anti-recommendations — features explicitly NOT to build
Status: ⏸ DEFERRED (permanent reference)
Priority: N/A
Size: N/A
Source: Research 2026-04-01 — Johannes contrarian + top performers analysis
Description: These features look good on paper but the research says they don't drive revenue. Documented here so we don't accidentally build them later.
  **Do NOT build:**
  1. AI-generated action item lists — busywork multiplier. Sellers know the 2-3 things that matter. (Johannes)
  2. Complex health score dashboard (Gainsight-style 34 modules) — keep it R/Y/G. (Ava commercial)
  3. Automated email sequences — brand risk, generic output, sellers distrust. (Johannes top performers)
  4. Predictive deal scoring — requires clean CRM data we don't control. Black box problem. (Johannes contrarian)
  5. Auth/RBAC system — single-user tool. Enterprise features for an enterprise we don't have. (Alex first-principles)
  6. Standalone competitive alert feed — pure noise for 90% of recipients. (Johannes contrarian)
Decision: Permanent reference. Revisit only if the use case fundamentally changes (e.g. team deployment).

### BKL-R11 | Design tokens: health/signal/delta/sparkline colors + typography
Status: ✅ DONE 2026-04-02
Priority: P1
Size: XS (0.5 day)
Source: Unified Redesign Spec §5 (2026-04-01)
Files: dashboard/tailwind.config.js, dashboard/src/index.css
Description: Foundation for all redesign components. 12 new color tokens (health-red/amber/green + bg/border variants, signal-competitive, signal-silent, delta-new, spark-up/down/neutral + fill variants). 3 new typography classes (text-hero 18px/700, text-signal 11px/500, text-priority 14px/600). All colors pass WCAG AA against bg (#0D1117).
Fix: Add colors and typography to tailwind.config.js. No component changes — pure token definitions.
Phase: 1 (Foundation) — no dependencies, parallelize with R04/R01-R03/R05.

### BKL-R12 | HealthScoreHero component — 6-signal gauge breakdown on Customer Detail
Status: ✅ DONE 2026-04-02
Priority: P1
Size: S (1-2 days)
Source: Unified Redesign Spec §3 — Aditi design (2026-04-01)
Files: dashboard/src/components/HealthScoreHero.tsx (new), dashboard/src/pages/CustomerDetailPage.tsx
Description: 6 mini progress bar gauges (Cases, Subscriptions, Meetings, Emails, Pipeline, Cloud Spend) + overall score on 0-10 display scale. Replaces any simple health indicator on the customer detail page. Shows which signals drag the score down. Depends on R04 (health score API) for data.
Fix: Create HealthScoreHero.tsx component. Wire into CustomerDetailPage header area (row 2, alongside stat badges). Fetch from GET /api/health-scores/:name.
Phase: 1 (Foundation) — depends on R04 health score API.

### BKL-R13 | Priority Action API + PriorityActionBanner + PriorityActionRow
Status: ✅ DONE 2026-04-02
Priority: P1
Size: M (2-3 days)
Source: Unified Redesign Spec §4 — all agents agreed: one action per customer, not a list (2026-04-01)
Files: server.ts (new endpoint), dashboard/src/components/PriorityActionBanner.tsx (new), dashboard/src/components/PriorityActionRow.tsx (new), dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/components/AccountPortfolioGrid.tsx
Description: GET /api/customer/:name/priority-action returns single most important action. Priority ranking: (1) Sev1 case, (2) Renewal <30d no meeting, (3) Meeting today no brief, (4) Stakeholder gone silent, (5) Competitor mention in 7d, (6) Pipeline opp closing <14d. PriorityActionBanner: full-width card on Customer Detail between header and brief, severity-colored 3px left border. PriorityActionRow: compact row on Account Cards with Zap icon + truncated text.
Fix: Backend: compute priority action from cached data (no new API calls). Frontend: two components at different detail levels. R02 handles the brief prompt version; this covers the API + standalone UI components.
Phase: 2 (Intelligence Layer) — depends on Phase 1 health scores for severity context.

### BKL-R14 | Brief source citations UI — superscript refs with hover tooltips
Status: ✅ DONE 2026-04-02
Priority: P2
Size: S (1-2 days)
Source: Unified Redesign Spec §6 Phase 3 + R03 prompt constraints (2026-04-01)
Files: dashboard/src/pages/CustomerDetailPage.tsx (brief rendering section)
Description: R03 adds "cite sources" to the Gemini prompt. This item renders those citations as superscript reference numbers with hover tooltips showing the source (e.g. "[1] Email from Bob Chen, 2026-03-28" or "[2] Case #12345, Sev2"). Requires brief output to include structured citation markers — coordinate with R03 prompt format.
Fix: Parse citation markers from brief text (e.g. `[src:email:2026-03-28]`). Render as superscript `<sup>` with tooltip. Create a CitationTooltip utility or reuse existing tooltip pattern.
Phase: 3 (Brief Enhancement) — depends on R03 prompt changes.

### BKL-R15 | Brief age indicator — staleness pill on brief display
Status: ✅ DONE 2026-04-02
Priority: P2
Size: XS (0.5 day)
Source: Unified Redesign Spec §6 Phase 3 (2026-04-01)
Files: dashboard/src/pages/CustomerDetailPage.tsx (brief section header)
Description: Color-coded pill showing brief age: green (<24h), amber (1-3 days), red (>3 days). Displayed in the brief section header next to the generation timestamp. Uses health token colors from R11.
Fix: Read brief `generatedAt` timestamp, compute age, render pill with appropriate color class.
Phase: 3 (Brief Enhancement) — depends on R11 design tokens.

### BKL-R16 | Update Triage view to use composite health score instead of case-only
Status: ✅ DONE 2026-04-02
Priority: P1
Size: XS (0.5 day)
Source: Unified Redesign Spec §3 — all agents agreed case-only triage is insufficient (2026-04-01)
Files: dashboard/src/components/AccountPortfolioGrid.tsx
Description: Current Triage view groups by `getHealthStatusFromCases()` (cases only). After R04 ships, replace with composite health score: Critical (<40), Attention (40-69), Healthy (>=70). Also update HealthDot on account cards to use composite score instead of case-only color.
Fix: Import health scores from R04 API. Replace `getHealthStatusFromCases` calls with composite score lookups. Thresholds per spec: >=70 green, 40-69 yellow, <40 red.
Phase: 1 (Foundation) — depends on R04 health score API.

---

## Gemini Brief Pipeline (2026-04-02)

Source: `docs/GEMINI-BRIEF-ARCHITECTURE.md` — three-step pipeline replacing single-pass brief generation. Supersedes R01/R02/R03 (their requirements are embedded in pipeline prompts).

### BKL-R17 | Restructure generateBrief() to XML-tagged sources + responseSchema
Status: ✅ DONE 2026-04-02
Priority: P1
Size: S (1-2 days)
Source: GEMINI-BRIEF-ARCHITECTURE §Step 1 (2026-04-01)
Files: src/customer.ts (generateBrief function)
Description: Replace the current flat text concatenation in `generateBrief()` with semantically tagged XML source blocks. Each source (`subscriptions`, `support_cases`, `calendar`, `emails`, `documents`, `pipeline`, `cloud_spend`, `previous_brief`) gets a `<source type="..." synced="..." count="...">` wrapper. Add `<customer>` block with `last_interaction` date (most recent meeting or email). Add `previous_brief` as a source for delta detection. Switch to Gemini `responseSchema` for structured JSON extraction output (schema defined in GEMINI-BRIEF-ARCHITECTURE §Step 1). Sources placed ABOVE instructions (30% quality improvement per Anthropic research).
Fix:
  1. Build XML-tagged source string from existing data fetchers (cases, subscriptions, meetings, emails, pipeline, ccsp)
  2. Compute `last_interaction` from max(lastMeeting, lastEmail)
  3. Read previous brief from cache if exists, include as `<source type="previous_brief">`
  4. Add extraction prompt from GEMINI-BRIEF-ARCHITECTURE §Step 1 (lines 106-124)
  5. Add `responseSchema` from GEMINI-BRIEF-ARCHITECTURE §Step 1 (lines 128-181) to Gemini API call
  6. Parse structured JSON extraction response
Effort: 1-2 days. Restructures existing data flow, no new data sources.
Phase: 1 (Foundation) — no dependencies. Supersedes R01/R02/R03.
Prompts: Extraction prompt + responseSchema defined in `docs/GEMINI-BRIEF-ARCHITECTURE.md` lines 106-181.

### BKL-R18 | Three-step brief pipeline: extract → rank → synthesize
Status: ✅ DONE 2026-04-02
Priority: P1
Size: M (2-3 days)
Source: GEMINI-BRIEF-ARCHITECTURE §Architecture (2026-04-01)
Files: src/customer.ts, src/brief-pipeline.ts (new)
Description: Split the monolithic `generateBrief()` into a three-step chain: (1) `extractSignals()` — Gemini + responseSchema extracts structured items from XML sources, (2) `rankItems()` — deterministic scoring function (urgency × category × confidence + new-item bonus), (3) `composeBrief()` — Gemini synthesizes top 5 ranked items into a 250-word delta-first brief with source citations. Each step independently loggable and improvable.
Fix:
  1. Create `src/brief-pipeline.ts` with three exported functions
  2. `extractSignals(xmlSources)` — calls Gemini with extraction prompt + responseSchema from R17
  3. `rankItems(items)` — deterministic TypeScript function per GEMINI-BRIEF-ARCHITECTURE §Step 2 (lines 197-211): `urgencyScore × categoryScore × confidenceScore + newBonus`, sorted descending. Top item = Priority Action.
  4. `composeBrief(rankedItems, customer, dataGaps)` — calls Gemini with synthesis prompt per GEMINI-BRIEF-ARCHITECTURE §Step 3 (lines 228-267): 250-word target, delta-first format, source citations, omit empty sections
  5. Update `generateBrief()` to call the three-step pipeline instead of single-pass
  6. Log each step output for debugging/evaluation
Effort: 2-3 days. Depends on R17 for XML input structure.
Phase: 2 — depends on R17.
Prompts: Ranking function lines 197-211, synthesis prompt lines 228-267 in `docs/GEMINI-BRIEF-ARCHITECTURE.md`.

### BKL-R19 | Document extraction sub-pipeline
Status: ✅ DONE 2026-04-01
Decision: DONE — Module written (241 lines) and now wired into generateBrief() via R26. classifyDocs() called on docs, enriched data flows into XML source blocks.
Priority: P2
Size: M (3-5 days)
Source: GEMINI-BRIEF-ARCHITECTURE §Document Extraction Sub-Pipeline (2026-04-01)
Files: src/brief-pipeline.ts, src/doc-extraction.ts (new)
Description: Google Drive docs need structured extraction before feeding into the main brief pipeline. Per-doc classification (MEETING_NOTES, ACCOUNT_PLAN, TECHNICAL_DOC, PROPOSAL, OTHER) + structured field extraction (action_items, decisions, stakeholders_mentioned, technical_signals, competitive_mentions, timelines, pain_points). Dual-prompt chaining for meeting notes — extract action items/decisions separately from summaries. Full-context for docs <50 pages, RAG with 512-token chunks for larger sets.
Fix:
  1. Create `src/doc-extraction.ts` with `classifyAndExtract(doc)` function
  2. Classification + extraction prompt from GEMINI-BRIEF-ARCHITECTURE lines 318-334
  3. Feed extracted doc signals into Step 1 (extractSignals) as part of the `<source type="documents">` block
  4. Cache per-doc extraction results (keyed by doc ID + modifiedTime) to avoid re-extraction
Effort: 3-5 days. Depends on R18 pipeline being in place.
Phase: 3 — depends on R18.

### BKL-R20 | Email intelligence sub-pipeline
Status: ✅ DONE 2026-04-01
Decision: DONE — Module written (406 lines) and now wired into generateBrief() via R26. extractEmailIntelligence() called, classifications + competitive mentions + silent contacts flow into XML. Also serves R31 stakeholder endpoint.
Priority: P2
Size: M (3-5 days)
Source: GEMINI-BRIEF-ARCHITECTURE §Email Intelligence Sub-Pipeline (2026-04-01)
Files: src/brief-pipeline.ts, src/email-extraction.ts (new)
Description: Three-part email intelligence: (1) Action item extraction — classify emails as ACTION_REQUIRED/FYI/RESPONSE_NEEDED, extract action items with owner/deadline/confidence. (2) Competitive mention detection — beyond keywords: indirect references ("the other vendor"), evaluation context ("bake-off", "POC with"). (3) Stakeholder signals — engagement changes, role mentions, escalation language. Plus deterministic engagement frequency tracking: `detectGoneSilent()` flags contacts with >50% frequency drop or 14+ day gap. Partially supersedes extraction aspects of R08 (competitive) and R09 (stakeholder) — their dashboard UI components remain separate items.
Fix:
  1. Create `src/email-extraction.ts` with `extractEmailIntelligence(emails)` and `detectGoneSilent(contacts)`
  2. Email classification + extraction prompt from GEMINI-BRIEF-ARCHITECTURE lines 349-367
  3. Engagement frequency function from GEMINI-BRIEF-ARCHITECTURE lines 372-388 (deterministic, no LLM)
  4. Feed extracted email signals into Step 1 extraction as enriched `<source type="emails">` block
Effort: 3-5 days. Depends on R18 pipeline.
Phase: 3 — depends on R18. R08 keyword list and R09 dashboard UI remain separate.

### BKL-R21 | Calendar intelligence sub-pipeline — meeting prep assembly
Status: ✅ DONE 2026-04-01
Decision: DONE — Module written (113 lines) and now wired into generateBrief() via R26. assembleMeetingPrep() called, attendee context + health signals + stakeholder coverage flow into calendar XML.
Priority: P2
Size: S (2-3 days)
Source: GEMINI-BRIEF-ARCHITECTURE §Calendar Intelligence Sub-Pipeline (2026-04-01)
Files: src/brief-pipeline.ts, src/calendar-extraction.ts (new)
Description: For each meeting in the next 3 days, assemble: (1) Attendee context — role, last interaction date, email frequency, sentiment trend. (2) Open action items from prior meetings with these attendees. (3) Account health signals — cases, renewals, pipeline changes since last meeting. (4) Competitive context from emails with these contacts. (5) Stakeholder coverage — who's engaged, who's missing, who went silent. This data feeds into the `## Meeting Prep` section of the synthesized brief.
Fix:
  1. Create `src/calendar-extraction.ts` with `assembleMeetingPrep(meetings, emails, cases, subscriptions)`
  2. Cross-reference meeting attendees with email engagement data from R20
  3. Build structured meeting prep object per upcoming meeting
  4. Feed into Step 1 extraction as enriched `<source type="calendar">` block
Effort: 2-3 days. Depends on R18 pipeline + R20 email extraction for attendee cross-referencing.
Phase: 3 — depends on R18, benefits from R20.

### BKL-R22 | Static brief section caching
Status: ❌ NOT IMPLEMENTED — no static section files, no cache duration logic, no trigger-based regeneration
Priority: P3
Size: S (1 day)
Source: GEMINI-BRIEF-ARCHITECTURE §Static Brief Sections (2026-04-01)
Files: src/brief-pipeline.ts, data/cache/ (new static brief files)
Description: Sections that don't change daily should NOT be regenerated with each brief. Company Profile (30-day cache), Technology Landscape (30-day), Product Portfolio (until next scrape), Stakeholder Map (7-day). Stored as `{slug}-static-{section}.json` with `generatedAt` timestamp. Regenerated on trigger events (new doc signals, subscription changes, monthly timer), not daily. Daily brief focuses ONLY on: temporal delta, priority action, risks/renewals, meeting prep, competitive signals.
Fix:
  1. Separate static section generation from daily brief
  2. Write static sections to `data/cache/{slug}-static-{section}.json` with `mode: 0o600`
  3. Add trigger-based regeneration (detect new docs, subscription changes, monthly timer)
  4. Include static section age in brief output for transparency
Effort: 1 day. Mostly architectural separation.
Phase: 4 — independent of Phases 2-3, but benefits from pipeline being in place.

### BKL-R23 | Gemini context caching — system instruction + schema cached 24h
Status: ❌ NOT IMPLEMENTED — comment in brief-pipeline.ts says "v2 optimization", no cachedContent API calls
Priority: P2
Size: XS (0.5 day)
Source: GEMINI-BRIEF-ARCHITECTURE §Gemini API Configuration (2026-04-01)
Files: src/brief-pipeline.ts (or src/customer.ts)
Description: Gemini context caching allows caching the system instruction + responseSchema for 24 hours, reducing per-request token costs by 70-85%. The extraction prompt and schema are identical across all customers — only the source data changes. Cache the system instruction block + schema as a `cachedContent` resource, reference it in subsequent requests.
Fix:
  1. Create a cached context for the extraction system instruction + responseSchema
  2. Set TTL to 24 hours (or 1 hour for dev/testing)
  3. Reference `cachedContent` name in extraction API calls
  4. Fall back to inline system instruction if cache miss
Effort: 0.5 day. Pure API configuration.
Phase: 2 — implement alongside or after R18.

### BKL-R24 | Fix content limits throttling brief quality — docs, emails, and attendees
Status: ✅ DONE 2026-04-01
Priority: P1
Size: S (1 day)
Decision: DONE — Items 1-4 + 7 (constant raises + logging) applied 2026-04-01. Item 6 (date filter, 180-day cutoff) applied 2026-04-01. Item 5 (PDF/docx) investigated by Serena + Marcus: files already appear in listings, only content extraction is missing — spun off as BKL-R25 (deferred). Rook security scan PASS, Quinn UI review PASS.
**Phase 2 (2026-04-02):** After Drive docs started flowing (28 docs for A10 Networks), original caps proved insufficient. Updated: DOC_CONTENT_CAP 3K→8K, TOTAL_CONTENT_CAP 20K→80K, added spreadsheets to EXPORTABLE_MIME_TYPES. Synthesis prompt: 250 words→500-1000 words, top 5→top 15 ranked items, added Account Overview/Company Profile/Technology Landscape/Pipeline Opportunities sections. A10 brief went from 868→4,294 chars with competitive signals, licensing analysis, and meeting prep from Drive docs.
**Incident:** Write tool corrupted the GEMINI_SERVICE_ACCOUNT_KEY RSA private key during .env rewrite (valid base64, invalid RSA CRT values). Root cause: Write tool silently altered bytes in a 3K+ base64 blob. Fix: restored key from backup file (`~/Desktop/Gemini_SVC_Accout.txt`). Lesson: never use Write tool for .env files containing long base64 credentials — use sed or manual edit instead.
Source: Code audit 2026-04-02, confirmed by line-by-line trace of customer.ts
Files: src/customer.ts (buildXmlSources, _fetchCustomerDocsImpl, fallback generateBrief)

**The Problem:** Multiple hard limits silently discard data before Gemini sees it, severely limiting brief quality. The model (Gemini 2.5 Flash, 1M token context) can handle far more than we send.

**Current Limits (all in customer.ts):**

| Limit | Location | Current Value | What It Means |
|-------|----------|---------------|---------------|
| Doc content to Gemini | line 476 (XML), line 647 (fallback) | **400 chars** per doc | ~2-3 sentences. Gemini sees ~13% of what was extracted. |
| Doc extraction cap | line 116: `DOC_CONTENT_CAP` | 3,000 chars per doc | ~750 words. Adequate for most meeting notes. |
| Total doc content cap | line 117: `TOTAL_CONTENT_CAP` | 20,000 chars total | ~5,000 words across all docs for a customer. Reasonable for now. |
| Max files per customer | line 118: `MAX_FILES_PER_CUSTOMER` | 50 files | Probably fine. |
| Subfolder depth | line 119: `DRIVE_SUBFOLDER_DEPTH` | 5 levels | Probably fine. |
| Exportable file types | line 112-115: `EXPORTABLE_MIME_TYPES` | Google Docs + Slides ONLY | PDFs, uploaded .docx, .xlsx get name-only — no content extraction. |
| Email snippets to Gemini | line 466 (XML), line 640 (fallback) | **120 chars** per email | ~1 sentence of email body. Subject + 120 chars often misses the actionable content. |
| Emails sent to Gemini | line 465 (XML), line 640 (fallback) | **10 emails** max | If customer has 30 emails in 30 days, Gemini only sees the 10 most recent. |
| Meeting attendees | line 457 (XML), line 636 (fallback) | **3 attendees** max | Gemini can't see who else was in the meeting beyond the first 3. |
| No date filter on docs | line 199 | None | All docs in folder returned regardless of age — ancient docs dilute signal. |
| Silent folder miss | lines 126, 161, 189 | Returns `[]` silently | If AE or customer folder match fails, brief says "No documents" with zero logging. |

**Token Budget Analysis (Gemini 2.5 Flash = 1,048,576 token context):**

Current prompt input per customer (estimated):
- System instruction: ~200 tokens
- Subscriptions: ~500 tokens (15 products)
- Cases: ~300 tokens (5 cases)
- Calendar: ~200 tokens (5 meetings)
- Emails: ~1,200 tokens (10 × 120 chars)
- Docs: ~**800 tokens** (5 docs × 400 chars) ← THE BOTTLENECK
- Pipeline: ~300 tokens
- Previous brief: ~500 tokens
- **Total: ~4,000 tokens** — 0.4% of available context

We are using less than half a percent of the model's capacity. Even at 10x the current limits, we'd be at 40K tokens — still only 4% of context.

**Fix (ordered by impact):**

1. **Raise doc content to Gemini: 400 → 3,000 chars** (line 476 + 647)
   - Matches what the extractor already pulls. 7.5x more doc content reaches Gemini.
   - New token estimate per doc: ~750 tokens. At 10 docs = ~7,500 tokens. Still trivial.

2. **Raise email snippet: 120 → 500 chars** (line 466 + 640)
   - 120 chars often cuts mid-sentence. 500 captures the key paragraph.
   - New token estimate: 10 emails × 500 chars = ~1,250 tokens.

3. **Raise email count: 10 → 20** (line 465 + 640)
   - 10 emails in 30 days misses important threads. 20 gives better coverage.
   - Additional ~1,250 tokens.

4. **Raise attendee count: 3 → 10** (line 457 + 636)
   - SA meetings often have 5-8 attendees. Missing names means missing stakeholder context.
   - Negligible token cost.

5. **Add PDF export support** (line 112-115: `EXPORTABLE_MIME_TYPES`)
   - Add `application/pdf` → export via Drive API as text/plain.
   - Add `application/vnd.openxmlformats-officedocument.wordprocessingml.document` for uploaded .docx.
   - These are common formats for account plans and technical docs.
   - Note: Drive `files.export` only works on Google-native types. For uploaded files, use `files.get` with `alt=media` + a text extraction step. May need a separate approach for PDFs (Gemini can read PDFs natively via multimodal input).

6. **Add date filter on doc fetch** (line 199)
   - Add `modifiedTime > '{sixMonthsAgo}'` to the files.list query.
   - Prevents ancient, irrelevant docs from consuming the content budget.

7. **Add logging on folder match failures** (lines 126, 161, 189)
   - `console.warn('[drive] AE_PARENT_FOLDER_ID not set — skipping docs')` at line 126
   - `console.warn('[drive] No AE folder matched for ${customer.ae} — skipping docs')` at line 161
   - `console.warn('[drive] No customer folder matched for ${customer.name} under AE ${customer.ae}')` at line 189
   - Zero-cost, immediately tells you when docs aren't flowing.

**Implementation order:** Items 1-4 and 7 are trivial (< 1 hour total, just changing constants and adding log lines). Items 5-6 are moderate (half a day). All are independent of R19 document sub-pipeline — R19 adds intelligence; R24 fixes the raw data flow that feeds everything.

Effort: 1 day total. Items 1-4 + 7 in first hour, items 5-6 in remaining time.
Phase: 1 (Foundation) — should be done BEFORE R19. R19's document extraction sub-pipeline can only be as good as the raw content it receives.

### BKL-R25 | PDF content extraction for briefs via Gemini multimodal
Status: ✅ DONE 2026-04-04
Priority: P2
Size: S (half day)
Source: Jason 2026-04-02 — "yes but limit it to just pdf"
Files: src/customer.ts (_fetchCustomerDocsImpl)
Description: PDF files in customer Drive folders appear in file listings but their content is not extracted — briefs only see the filename. Use Gemini multimodal to extract text from PDFs.
  Scope: PDF only (not docx — keep scope tight).
  Approach: Gemini multimodal (Option B from original analysis). For each PDF in the customer folder:
  1. Download raw bytes via `drive.files.get({ alt: 'media' })`
  2. Send to Gemini as `inlineData` with mimeType `application/pdf`
  3. Prompt: "Extract the text content from this PDF document. Return only the text, no commentary."
  4. Store extracted text as `file.content` alongside existing Google Doc content
  5. Cap at DOC_CONTENT_CAP (8K chars) per PDF, same as other docs
  Cost: ~$0.01-0.02 per PDF (multimodal input pricing). With ~5 PDFs per customer avg, adds ~$0.10 per customer brief refresh.
  No native deps needed — pure API call to Gemini.

### BKL-R25b | Pre-convert PDF to Markdown before Gemini extraction (token savings)
Status: ✅ DONE 2026-04-04 — implemented with unpdf (unjs ecosystem, Bun-native). Local extraction → plain text prompt to Gemini. Falls back to multimodal inlineData if extraction returns < 50 chars. Rook PASS.
Priority: P2
Size: S (half day)
Source: Jason 2026-04-04 — "update the backlog item to add that i would like to have the pdf extracted to MarkDown before passing to gemini to save tokens"
Files: src/customer.ts (_fetchCustomerDocsImpl)
Description: Current R25 implementation sends raw PDF bytes as multimodal inlineData to Gemini. Converting to Markdown first (via a local extraction library) would reduce token cost significantly — Gemini only receives structured text instead of rendering a PDF.
  Approach:
  1. Use a lightweight Bun-compatible PDF-to-text/Markdown library (e.g. `pdf-parse` or `unpdf`) to extract text locally before the Gemini call
  2. Format extracted text as Markdown (headers, bullets where detectable)
  3. Pass Markdown string to Gemini as plain text prompt instead of inlineData PDF
  4. Fallback: if local extraction fails/returns < 50 chars, fall back to current multimodal inlineData path
  5. Log which path was taken per file for observability
  Token savings estimate: ~60-80% reduction in input tokens per PDF (text vs rendered image tokens)
  Dependency check: evaluate `pdf-parse`, `unpdf`, or `pdfjs-dist` for Bun compatibility before implementing.

---

## Spec Compliance Gaps (from 2026-04-01 deep analysis)

Source: Gap analysis comparing deployed code/UI against UNIFIED-REDESIGN-SPEC.md and GEMINI-BRIEF-ARCHITECTURE.md. Audited by Serena (architecture), Marcus (pipeline), Quinn (live UI), and Explorer (inventory).

### BKL-R26 | Wire sub-pipelines into generateBrief() — doc, email, calendar
Status: ✅ DONE 2026-04-01
Decision: DONE — classifyDocs, extractEmailIntelligence, assembleMeetingPrep imported and called in generateBrief(). XmlEnrichment interface passes enriched data into buildXmlSources(). Each sub-pipeline wrapped in independent try/catch. Rook PASS, Quinn PASS.
Priority: P1
Size: M (2-3 days)
Source: Gap analysis 2026-04-01 — Marcus confirmed R19/R20/R21 modules exist but are never imported
Files: src/customer.ts (generateBrief, buildXmlSources), src/doc-extraction.ts, src/email-extraction.ts, src/calendar-extraction.ts
Description: Three sub-pipeline modules totaling 760 lines are fully implemented but never imported by customer.ts or any other module. They are dead code. The three-step pipeline in generateBrief() currently feeds raw data directly to extraction — it should first run data through these sub-pipelines to get classified/enriched signals.
Fix:
  1. Import `classifyAndExtract` from doc-extraction.ts, call it on `docs` before building XML sources
  2. Import `extractEmailIntelligence` and `detectGoneSilent` from email-extraction.ts, call on `emails`
  3. Import `assembleMeetingPrep` from calendar-extraction.ts, call on `meetings`
  4. Feed enriched results into buildXmlSources() as enhanced `<source>` blocks
  5. Test with `make rebuild` + generate brief for a customer with docs/emails/meetings
Effort: 2-3 days. Code exists — this is integration and testing work.
Phase: Critical — this is the single highest-impact change for brief quality.

### BKL-R27 | Add pipeline and cloud spend to XML sources
Status: ✅ DONE 2026-04-01
Decision: DONE — pipeline and cloud_spend source blocks added to buildXmlSources(). PipelineRecord and CCSPRecord imports added. background-scheduler.ts updated to pass data. escapeXml() on all string values. Rook PASS.
Priority: P1
Size: XS (1-2 hours)
Source: Gap analysis 2026-04-01 — Marcus confirmed missing `<source type="pipeline">` and `<source type="cloud_spend">`
Files: src/customer.ts (buildXmlSources)
Description: buildXmlSources() includes subscriptions, cases, calendar, emails, docs, and previous_brief — but NOT pipeline opportunities or CCSP cloud spend. Gemini never sees Salesforce deal data or marketplace spend during structured extraction. Both data sources are already fetched and available in generateBrief() arguments.
Fix:
  1. Add `<source type="pipeline" count="${pipeline.length}">` block after emails section
  2. Add `<source type="cloud_spend">` block with CCSP summary data
  3. Use escapeXml() on all interpolated values
  4. Add pipeline and cloud_spend to `source_type` enum in EXTRACTION_SCHEMA
Effort: 1-2 hours. Data already available, just needs XML block construction.

### BKL-R28 | Add XML metadata: last_brief_date and previous_brief date attribute
Status: ✅ DONE 2026-04-01
Decision: DONE — last_brief_date field in customer block, date attribute on previous_brief tag. Sourced from brief cache lookup.
Priority: P2
Size: XS (30 min)
Source: Gap analysis 2026-04-01 — Marcus confirmed missing attributes
Files: src/customer.ts (buildXmlSources)
Description: The `<customer>` block in buildXmlSources() is missing `last_brief_date` field. The `<source type="previous_brief">` block is missing `date="{lastBriefDate}"` attribute. Both are specified in GEMINI-BRIEF-ARCHITECTURE.md.
Fix:
  1. Add `last_brief_date` field to `<customer>` XML block
  2. Add `date=` attribute to `<source type="previous_brief">` tag
  3. Source the date from the cached brief file's timestamp

### BKL-R29 | Wire PriorityActionRow into AccountPortfolioGrid
Status: ✅ DONE 2026-04-01
Decision: DONE — PriorityActionRow imported, priority actions fetched per customer via Promise.allSettled, rendered below card header with Zap icon. Quinn verified visible on account cards.
Priority: P2
Size: XS (1 hour)
Source: Gap analysis 2026-04-01 — Serena confirmed component exists but not imported in AccountPortfolioGrid
Files: dashboard/src/components/AccountPortfolioGrid.tsx, dashboard/src/components/PriorityActionRow.tsx
Description: PriorityActionRow component is built (Zap icon + truncated text) but never imported or rendered in AccountPortfolioGrid.tsx. Account cards show HealthDot but no priority action text. Spec requires both.
Fix:
  1. Import PriorityActionRow in AccountPortfolioGrid.tsx
  2. Fetch priority action per customer from /api/customer/:name/priority-action (or batch)
  3. Render PriorityActionRow below HealthDot on each account card when action exists

### BKL-R30 | Wire SparklineKPI data pipeline — connect KPI history to KPI cards
Status: ✅ DONE 2026-04-01
Decision: DONE — App.tsx fetches /api/kpis/history, transforms to per-KPI sparkline arrays, passes to 5 KPICards. Sparklines will appear after 2+ days of snapshot data accumulate. tsc clean, Quinn PASS.
Priority: P2
Size: S (half day)
Source: Gap analysis 2026-04-01 — Serena confirmed component, prop, and endpoint all exist but nothing connects them
Files: dashboard/src/App.tsx or dashboard/src/pages/DashboardPage.tsx, dashboard/src/components/KPICards.tsx
Description: SparklineKPI component exists. KPICards has `sparklineData?` prop. /api/kpis/history endpoint returns 90 days of data. But the frontend never fetches /api/kpis/history and never passes sparkline data to the cards. The data pipeline is completely disconnected.
Fix:
  1. Add `useEffect` to fetch /api/kpis/history on dashboard load
  2. Transform history data into per-KPI sparkline arrays
  3. Pass sparklineData to each KPICard
  4. SparklineKPI will render automatically once data arrives

### BKL-R31 | Wire StakeholderEngagementPanel — add API endpoint + populate contacts
Status: ✅ DONE 2026-04-01
Decision: DONE — GET /api/customer/:name/stakeholder-engagement endpoint added (server.ts L336). Uses buildContactHistory + detectGoneSilent from email-extraction.ts. CustomerDetailPage fetches and passes to panel. Quinn verified 7 real contacts for A10 Networks with frequency dots and Silent flags.
Priority: P2
Size: M (1-2 days)
Source: Gap analysis 2026-04-01 — Serena confirmed component rendered with contacts=[] and no API endpoint exists
Files: server.ts, src/customer.ts or src/email-extraction.ts, dashboard/src/pages/CustomerDetailPage.tsx
Description: StakeholderEngagementPanel exists with frequency dots and "Silent Nd" flags, but is rendered with `contacts={[]}` — always empty. No `/api/customer/:name/stakeholder-engagement` endpoint exists. The email-extraction.ts module (currently dead code) has `detectGoneSilent()` and contact history building that could feed this.
Fix:
  1. Add `GET /api/customer/:name/stakeholder-engagement` endpoint to server.ts
  2. Use email-extraction.ts `buildContactHistory()` + `detectGoneSilent()` to generate contact data (depends on R26 wiring the module)
  3. Update CustomerDetailPage.tsx to fetch this endpoint and pass to StakeholderEngagementPanel
Depends on: BKL-R26 (sub-pipeline wiring)

### BKL-R32 | Wire CompetitiveSignalBadge — add backend keyword scanning + render in briefs
Status: ✅ DONE 2026-04-01
Decision: DONE — CompetitiveSignalBadge imported in CustomerDetailPage. useMemo parser extracts competitor names from ## Competitive Signals brief section. Badges render with tooltip context when signals present. No new endpoint needed — piggybacks on brief data. Quinn PASS.
Priority: P3
Size: S (half day)
Source: Gap analysis 2026-04-01 — Serena confirmed component exists but no backend scanning and never rendered
Files: server.ts, dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/components/CompetitiveSignalBadge.tsx
Description: CompetitiveSignalBadge component exists with signal-competitive design tokens. But no backend keyword-scanning logic exists — the email-extraction.ts module (dead code) has `detectCompetitiveMentions()` with 26 competitors that could feed this. Badge is not rendered in CustomerDetailPage brief section.
Fix:
  1. Wire email-extraction.ts competitive detection (depends on R26)
  2. Include competitive signals in brief extraction output
  3. Render CompetitiveSignalBadge(s) in CustomerDetailPage brief section when signals present
Depends on: BKL-R26 (sub-pipeline wiring)

### BKL-R33 | Add TemporalDeltaSection component + API endpoint
Status: ✅ DONE 2026-04-01
Decision: DONE — GET /api/customer/:name/temporal-delta endpoint compares brief cache files by section headers. TemporalDeltaSection.tsx created with 4 states (loading/error/no-previous/changes). Rendered on CustomerDetailPage before BriefSection. Quinn verified live with A10 Networks (6 changes detected).
Priority: P3
Size: M (1-2 days)
Source: Gap analysis 2026-04-01 — Serena confirmed no component and no endpoint exist
Files: dashboard/src/components/TemporalDeltaSection.tsx (new), server.ts, src/customer.ts
Description: UNIFIED-REDESIGN-SPEC requires a standalone "What Changed Since [date]" section on Customer Detail. Currently only BriefDeltaMarker provides inline `^`-prefix markers within brief text. No TemporalDeltaSection component exists. No `/api/customer/:name/temporal-delta` endpoint exists.
Fix:
  1. Create `GET /api/customer/:name/temporal-delta` endpoint that compares current vs previous brief cache
  2. Create TemporalDeltaSection.tsx component displaying changes grouped by category
  3. Render on CustomerDetailPage between PriorityActionBanner and Account Brief

### BKL-R34 | Gemini thinking budget configuration
Status: ✅ DONE 2026-04-01
Decision: DONE — thinkingConfig: { thinkingBudget: 4096 } on callLLMStructured (extraction), thinkingBudget: 0 on callLLM (synthesis). Top-level request body placement per Gemini API spec.
Priority: P3
Size: XS (30 min)
Source: Gap analysis 2026-04-01 — Marcus confirmed neither callLLM nor callLLMStructured set thinkingConfig
Files: src/customer.ts (callLLMStructured, callLLM)
Description: GEMINI-BRIEF-ARCHITECTURE recommends thinkingConfig: 4096 tokens for extraction, 0 for synthesis. Neither function sets this. Adding thinking budget may improve extraction quality at marginal cost increase.
Fix:
  1. Add `thinkingConfig: { thinkingBudget: 4096 }` to callLLMStructured() generationConfig
  2. Add `thinkingConfig: { thinkingBudget: 0 }` to callLLM() generationConfig for synthesis
  3. Test brief quality before/after

### BKL-R35 | Remove single-pass fallback anti-patterns
Status: ✅ DONE 2026-04-01
Decision: DONE — Fallback prompt reduced to 250-word target. Source citation rule added. Generic Company Profile and Technology Landscape sections removed. Fallback remains functional as safety net when three-step pipeline fails.
Priority: P3
Size: S (half day)
Source: Gap analysis 2026-04-01 — Marcus confirmed fallback violates 7 of 8 spec anti-patterns
Files: src/customer.ts (generateBrief fallback path, lines 630-760)
Description: The single-pass fallback (used when three-step pipeline fails) violates 7 anti-patterns: 900-word ceiling, generic company overview, complex multi-section prompt, no citations, empty section filler, daily static regeneration, no confidence levels. Once R26 stabilizes the three-step path, the fallback should be simplified to match spec guidance or removed entirely.
Fix:
  1. After R26 stabilizes the three-step pipeline, evaluate fallback failure rate
  2. If <5% fallback rate: simplify fallback to 250-word single-pass with citation rules
  3. If <1% fallback rate: remove fallback entirely, return error message instead
Depends on: BKL-R26 (sub-pipeline wiring must stabilize first)

---

## Red Team Research Investigations (2026-04-02)

Source: 8-agent red team analysis of project assumptions. PRD: `~/.claude/MEMORY/WORK/20260402-133600_assumption-failure-analysis/PRD.md`

### BKL-RES01 | Research: Playwright resilience patterns — self-healing selectors, DOM change survival
Status: ✅ DONE 2026-04-02
Decision: DONE — 4 vault files (69KB) at ~/.claude/MEMORY/RESEARCH/2026-04/playwright-resilience-patterns/. Key: zero-cost-self-healing-qa (10-tier accessibility tree), 5-phase implementation roadmap, scraper-specific recommendations for all 4 targets. Supportable APEX HTTP fast-path discovered.
Priority: P1
Size: Research
Source: Red team 2026-04-02 — 6/8 agents flagged Playwright scraping of 4 enterprise apps as permanently fragile. DOM changes break scrapers with no API fallback.
Vault: `~/.claude/MEMORY/RESEARCH/2026-04/playwright-resilience-patterns/`
Description: Investigate best-in-class Playwright resilience: self-healing selectors, fallback selector chains, visual/AI-assisted locators, DOM diffing for change detection, retry/recovery patterns, snapshot-based regression testing. No API access available — Playwright is the permanent path. Research must produce patterns applicable to SF Lightning, RH Portal, Supportable APEX, and Tableau/CCSP.
Deliverable: Actionable patterns to implement in our 4 scrapers + DOM snapshot testing strategy for CI.

### BKL-RES02 | Research: Entity resolution / company name matching algorithms
Status: ✅ DONE 2026-04-02
Decision: DONE — 4 vault files (47KB) at ~/.claude/MEMORY/RESEARCH/2026-04/entity-resolution-name-matching/. Key: fuzzball library, composite scoring (tokenSetRatio*0.45 + jaroWinkler*0.35 + tokenSortRatio*0.20), 3 threshold tiers, alias table from supportableName overrides. Full TypeScript pseudocode + 3-phase migration plan.
Priority: P1
Size: Research
Source: Red team 2026-04-02 — 4/8 agents flagged 3 separate name normalizers as chain-breaker. Manual `supportableName` overrides prove the current approach already fails.
Vault: `~/.claude/MEMORY/RESEARCH/2026-04/entity-resolution-name-matching/`
Description: Investigate state of the art in company name matching: Levenshtein, Jaro-Winkler, Soundex/Metaphone, token-set ratio, ML-based entity resolution. Which algorithms handle abbreviations (IBM vs International Business Machines), suffixes (Inc/LLC/Corp), partial names, and short names (≤4 chars) best? Must work offline (no API calls). Research must produce a recommended algorithm for our unified normalizer (BKL item to merge 3 normalizers).
Deliverable: Recommended algorithm + test corpus of tricky name pairs from our actual customer data patterns.

### BKL-RES03 | Research: Browser auth persistence — reduce/eliminate VNC dependency for day-2 ops
Status: ✅ DONE 2026-04-02
Decision: DONE — 4 vault files at ~/.claude/MEMORY/RESEARCH/2026-04/browser-auth-persistence/. Key: --restore-last-session flag + explicit browser.close() for session persistence (Phase 0, 1 day). TOTP automatable for headless re-auth. SF Client Credentials Flow + Tableau PAT could eliminate 2/4 browser deps. 5-phase plan, 8-12 days parallel.
Priority: P2
Size: Research
Source: Red team 2026-04-02 — 5/8 agents flagged VNC-based auth as major adoption barrier for new users. Multi-step bootstrap requires manual browser interaction.
Vault: `~/.claude/MEMORY/RESEARCH/2026-04/browser-auth-persistence/`
Description: Investigate patterns for persisting browser auth state across container restarts: cookie export/import, storageState persistence in Playwright, token extraction from SSO flows, headless re-auth strategies. RH SSO uses SAML — can we persist the session without VNC on subsequent runs? Initial setup may still need VNC, but day-2 operations should not.
Deliverable: Feasible approach to eliminate VNC for recurring auth, or confirmation that VNC is unavoidable with rationale.

---

## Customer Intelligence Pipeline (2026-04-02)

### BKL-AI17 | CustomerIntelligence PAI skill — Gemini doc generation + NotebookLM sync
Status: ✅ DONE — 2026-04-10. AccountPlanAssistant workflow built, 20 account plan drafts generated, CLIs installed. Jason confirmed complete.
Priority: P1
Size: M (2-3 days)
Source: Jason 2026-04-02 — wants per-customer intelligence docs synced to NotebookLM notebooks
Skill: `~/.claude/skills/CustomerIntelligence/`
Description: PAI skill that generates Company Intelligence Briefs and Industry Technology Analyses per customer using improved Gemini prompt templates (from 3-agent research vault), then syncs to Google Drive and NotebookLM. Uses `gws` CLI (Google Workspace) + `nlm` CLI (NotebookLM). Three workflows: GenerateIntelligence, SyncNotebookLM, FullPipeline.
Dependencies:
  - `npm install -g @googleworkspace/cli` (replaces 3 existing Google MCPs)
  - `pip install notebooklm-mcp-cli` (NotebookLM CLI)
  - DailyBriefDashboard running at localhost:7777 (customer data source)
Status detail:
  - [x] Skill structure created (SKILL.md, 3 workflows, setup guide, prompt templates ref)
  - [ ] Install gws + nlm CLIs and authenticate
  - [ ] Test single-customer generation end-to-end
  - [ ] Test NotebookLM sync end-to-end
  - [ ] Batch run for all customers
  - [ ] Optional: Add as MCP servers in settings.json
  - [ ] Optional: Schedule monthly auto-generation

---

### BKL-G19 | Admin page: rename Supportable buttons for clarity
Status: ✅ DONE 2026-04-03
Priority: P3
Size: XS (15 min)
Source: Jason 2026-04-03 — confusion between the two Supportable buttons on admin page
Files: dashboard/src/pages/AdminPage.tsx
Description: Admin page has two Supportable-related buttons that are unclear:
  1. "Supportable 360" (Run Now) — calls `/api/scrape/supportable/discover`, does full discovery+scrape from source for all AEs
  2. "Supportable Initial Load" (Run) — calls `/api/bootstrap/initial-load`, crash-safe sequential bootstrap
  Rename to make the distinction obvious:
  - "Supportable 360" → "Supportable Sync" (or "Supportable Discovery + Sync")
  - "Supportable Initial Load" → "Supportable Full Bootstrap"
  Add subtitle text to the Supportable 360 card explaining what it does (similar to how Initial Load already has "Crash-safe full load — resumes from last completed customer").

---

### BKL-M58 | Supportable discovery: per-search timeout + detail-page detection
Status: ⏸ DEFERRED — 2026-04-10 — Supportable scraper disabled (SUPPORTABLE_DISABLED=true in scrape-api.ts:79). Item moot until Supportable is re-enabled.
Priority: P1
Size: S (1-2 hours)
Source: Jason 2026-04-03 — discovery hung on "Taylor%" search that auto-navigated to detail page instead of result list
Files: src/supportable-scraper.ts (name-search function)
Description: Two bugs in Supportable discovery name-search:
  1. **No per-search timeout:** If a name search hangs (slow APEX response, network stall), the worker blocks forever. The wall-clock timeout in scraper-manager.ts does NOT wrap the discover endpoint — only RH scrape. Need a 30-60s timeout per individual name search attempt.
  2. **Detail-page auto-navigation not detected:** When a broad search like "Taylor%" matches exactly one customer, APEX auto-navigates to the customer detail page (URL pattern `f?p=304:1:SESSION:`) instead of showing the results list. The worker waits for the results list pattern that never appears. Need to detect the detail page URL/content and either extract the account number from it or skip and move on.
  3. **No wall-clock timeout on Supportable discover task:** The `/api/scrape/supportable/discover` endpoint enqueues a task without `withTimeout()` wrapping. Add a 10-min wall-clock timeout to prevent infinite hangs.
Fix:
  - Add 45s timeout to each `page.waitForURL` / `page.waitForSelector` in the name-search loop
  - Detect detail-page pattern (URL has account detail indicators, or "Customer Information" heading visible) and extract account number from it
  - Wrap the Supportable discover task in `withTimeout(promise, 10 * 60 * 1000, 'Supportable discover')` in scrape-api.ts
Workaround: If discovery hangs, manually stop the spinning tab in VNC (localhost:6080) — the worker unblocks and continues immediately.

---

### BKL-G20 | Cases modal: status badge overflows frame on narrow widths
Status: ✅ DONE 2026-04-03 (whitespace-nowrap + label abbreviation applied in SupportCasesTable.tsx)
Priority: P3
Size: XS (15 min)
Source: Jason 2026-04-03 — "Waiting on Customer" badge wraps awkwardly in the Open Support Cases modal
Files: dashboard/src/components/ (Cases modal component)
Description: In the Open Support Cases KPI modal, the Status column badge (e.g. "Waiting on Customer", "Waiting on Red Hat") wraps to two lines and doesn't fit the cell cleanly. Either:
  - Use `whitespace-nowrap` + smaller text on the badge
  - Abbreviate: "Waiting on RH" / "Waiting on Cust"
  - Make the status column wider

---

### BKL-G21 | Admin "Run Now" gives no feedback when scrape is queued behind another
Status: ✅ DONE 2026-04-03
Priority: P2
Size: S (30 min)
Source: Jason 2026-04-03 — button snaps back to "Run Now" with no indication the scrape is queued
Files: dashboard/src/pages/AdminPage.tsx, src/scrape-api.ts
Description: When a user clicks "Run Now" on a scraper in the admin page while another scraper is running, the API returns `{ started: true, queued: true }` but the UI just shows "Running..." briefly then snaps back to "Run Now" with no explanation. The queue status endpoint already exists (`/api/scrape/queue`) and the admin page already polls `/api/status/scrapes` which includes queue data. Fix:
  1. After POST returns, if response has `queued: true`, show "Queued" state on the button instead of snapping back
  2. Show which scraper it's waiting behind (e.g. "Queued — waiting on supportable")
  3. The `queuePending` prop already exists on ScrapeSection but only shows when polling detects it — should also show immediately after the POST response
  4. If the queue reports `isAnyRunning: true` but no scraper shows `isRunning`, display a "Scraper busy" indicator so the user knows why nothing is starting

---

### BKL-H02 | Rename ntfy topic from pai-notifications to asa-command-center
Status: ✅ DONE 2026-04-03
Priority: P3
Size: S (15 min)
Source: Jason 2026-04-03
Files: defaults.env, .env.example, README.md, SETUP.md, server.ts, src/bootstrap-orchestrator.ts, src/scraper-manager.ts
Decision: Renamed all references from `pai-notifications` to `asa-command-center` across defaults.env, docs, and all 3 source fallbacks. Rebuild required to take effect in container.

### BKL-H01 | Remove unneeded files from repo (cleanup)
Status: ✅ DONE 2026-04-03
Priority: P3
Size: S (30 min)
Source: Jason 2026-04-03 — repo has accumulated files that shouldn't be tracked
Files: docker-compose.yml, read-ccsp-full.ts, read-ccsp.ts, and any other dead files
Description: Audit the repo for files that are no longer needed and remove them:
  - `docker-compose.yml` — not the sanctioned deploy method (`make rebuild` is)
  - `read-ccsp-full.ts` and `read-ccsp.ts` — already deleted in working tree
  - Any other dead scripts, temp files, or unused config
  - Update .gitignore if needed to prevent re-adding


---

### BKL-ADM01 | SF Pipeline "Run Now" snaps back instantly — markRunning not called before enqueue
Status: ✅ DONE 2026-04-03
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-03 — button returns immediately with no status
Files: src/scrape-api.ts
Root cause: POST /api/scrape/salesforce enqueues the task then immediately returns {started: true, queued: true}. markRunning('sf-pipeline') is only called inside the queued task's run() function — after the queue drains. The UI's fetchStatus() fires before markRunning(), sees state='stale', clears the busy guard, and the button snaps back.
Fix: Call markRunning('sf-pipeline') synchronously in the route handler before enqueuing. Apply same fix to all 4 scraper routes for consistency.
Evidence: Added markRunning() call synchronously before enqueueScraperTask() in all 4 POST handlers (rh ~line 109, supportable ~line 180, ccsp ~line 387, salesforce ~line 470). Added markRunning to imports from scraper-status-store.ts.
Acceptance: Click Run Now on SF Pipeline → button shows Running... state and holds it until scrape completes.

### BKL-ADM02 | CCSP Run Now: stale non-null browser context crashes with Playwright error
Status: ✅ DONE 2026-04-03
Priority: P1
Size: S (1-2 hours)
Source: Jason 2026-04-03 — "Error: page: Target page, context or browser has been closed"
Files: src/ccsp-scraper.ts, src/rh-scraper.ts
Root cause: _ctx is checked for null (passes) but not for liveness. When context closes after login (crash, idle timeout), _ctx is a stale non-null object. The null check passes but _ctx.newPage() throws the Playwright closed-context error. No recovery path — only re-authenticating via Setup page re-adopts the context.
Fix:
  1. Add live health check before newPage(): try { _ctx.pages() } catch { _ctx = null; throw new Error('Browser session closed — reconnect via Setup page') }
  2. Ensure closeScrapeContext() in rh-scraper also nulls out ccsp-scraper's _ctx to keep state in sync.
  3. Surface a user-actionable error message instead of raw Playwright stack.
Evidence: Added try/catch liveness probe via _ctx.pages() before _ctx.newPage() in runCcspScrape() (~line 518-526 ccsp-scraper.ts). On failure: nulls _ctx and throws user-actionable message. Note: cross-file null sync (rh→ccsp) skipped to avoid circular import (ccsp-scraper already imports from rh-scraper).
Acceptance: CCSP Run Now shows "Browser session closed — reconnect via Setup" instead of raw Playwright error. Re-authenticating in Setup page clears the error.

### BKL-ADM03 | Setup page shows "Connected" based on auth session, not scrape health
Status: ✅ DONE 2026-04-03
Priority: P1
Size: S (1-2 hours)
Source: Jason 2026-04-03 — all sources show Connected even when scrapers are failing
Files: dashboard/src/pages/SetupPage.tsx
Root cause: RH and SF connection badges check only hasSession && !sessionExpired — the session file existing on disk. Scrape failures do not invalidate the session file, so a failed scrape still shows "Connected". CCSP and Supportable use scrape health correctly. The auth/health conflation is isolated to RH and SF badge logic.
Fix: For RH and SF badges, supplement the session check: also require lastError === null and lastSync !== null from the scraper status. If session exists but last scrape failed, show "Session Active" (amber) instead of "Connected" (green).
Evidence: Refactored rhConnected/sfConnected (~line 2266) to split into rhSessionActive/sfSessionActive (session only) and rhScrapeOk/sfScrapeOk (requires successful scrape timestamp + no syncError). RH card gets amber "Session Active" state using border-l-warning/bg-warning/text-warning; SF card amended to show amber for both expired AND session-active-but-not-scraping cases. Dashboard tsc: 0 errors.
Acceptance: After a scrape failure, RH/SF badges show amber "Session Active" not green "Connected". After a successful scrape, badges show green "Connected".

### BKL-G22 | Setup page Sync section shows no running state when scraper is active
Status: ✅ DONE 2026-04-03 (Marcus: added /api/scraper-status polling every 3s in DataSourcesSection; scraperRunning state drives loading prop on all 4 SyncButtons so external running state is reflected)
Priority: P2
Size: S (30 min)
Source: Jason 2026-04-03 — admin page shows "Running..." for RH Cases but setup page Sync section shows static "Sync Now" buttons with no activity indicator
Files: dashboard/src/pages/SetupPage.tsx
Description: The Setup page Sync section (Red Hat Cases, Supportable Subscriptions, CCSP, Pipeline) does not reflect when a scraper is actively running. The admin page correctly shows "Running..." and "In progress" indicators because it polls `/api/status/scrapes` and checks `isRunning`. The Setup page Sync buttons need the same polling — show a spinner or "Syncing..." state when `isRunning=true` for that source, and disable the button to prevent duplicate triggers.

### BKL-W3-14 | Dashboard Design Council — full UX audit before any UI/UX implementation
Status: ✅ DONE — docs/DESIGN-COUNCIL-W3.md written; W3-02, W3-04, W3-05, W3-06, W3-09 unblocked
Priority: P0
Size: M (half day council + report)
Source: Jason 2026-04-05 — "do a full council meeting on the design before any UI/UX work"
Blocks: BKL-W3-02, BKL-W3-04, BKL-W3-05, BKL-W3-06, BKL-W3-09 (all UI items blocked until this completes)
Files: dashboard/src/ (entire frontend)
Description: Before implementing any UI/UX changes, convene a full council to audit the dashboard design holistically. Key concerns from Jason:
  - Text labels improperly laid out across multiple pages
  - Content does not scale well — things get bunched up or misaligned
  - Need to validate all designs against 8-AE scale (current: 1-2 AEs, but system should support 8)
  - Incorporate all W3 UI backlog comments as input to the council
  Council inputs: W3-02 (CCSP tile), W3-04 (portfolio cards truncation), W3-05 (right column tiles), W3-06 (setup header), W3-09 (admin cards), plus Aditi's existing design specs.
  Deliverable: A design system decision doc (docs/DESIGN-COUNCIL-W3.md) covering: (1) typography scale and hierarchy standards, (2) truncation/overflow rules, (3) grid/column width rules at 1-8 AE scale, (4) tile/card density standards, (5) label alignment rules. All subsequent UI items must conform to this doc.
  Council composition: Aditi (design lead), Serena (architecture/scalability), Marcus (implementability review).

### BKL-W3-15 | Scraper sync status — standard output format across all data sources
Status: ✅ DONE 2026-04-05 — All 4 scraper rows in SetupPage.tsx now use "Synced {timeAgo} — {N} {noun}" format. RH Cases: "cases", Supportable: "subscriptions", CCSP: "records", SF: "rows". CCSP post-sync success message also standardized to same format.
Priority: P1
Size: S (2-3 hours)
Source: Jason 2026-04-05 — "standard and consistency across the app"
Files: dashboard/src/pages/SetupPage.tsx (all 4 sync rows: RH Cases, Supportable, CCSP, Pipeline)
Description: Each data source sync row on the Setup page currently shows different information after sync. Standardize to a consistent pattern across all four sources:
  Standard format: "Synced [time ago] — [N] records" (e.g. "Synced just now — 250 rows" or "Synced 2h ago — 14 cases")
  Apply consistently to: Red Hat Cases (rhStatus.lastScraped + case count), Supportable (supportableStatus.lastScrape + subscription count), CCSP (ccspStatus.lastSync + record count), Pipeline/Salesforce (sfStatus.lastSync + sfStatus.rowCount).
  The CCSP sync success toast added in W3-07 (ccspSyncedAt → "Synced at HH:MM") is an interim fix — replace with the standard format once this item is implemented.
  Also standardize the "last sync" display in the default (non-post-sync) state — currently each source shows the timestamp differently (some use timeAgo(), some show raw ISO, some show nothing).

### BKL-W3-01 | CCSP rolling quarters bug — showing 2025 Q3/Q4 instead of current rolling 4
Status: ✅ DONE 2026-04-05 — Three fixes: (1) Fixed QTR_FMT regex in CloudSpendSection.tsx; (2) Fixed quarter label display bug (2025- Q3 → 2025 Q3) at line 217; (3) Fixed ccsp-scraper.ts getRollingFyWindow() — was computing FY2026+FY2027, now correctly FY[prev]+FY[current] (FY2025+FY2026 as Jason confirmed in Tableau). Quarter window expanded from 4 to full prev-year + current-year-to-date (2025-Q1 through 2026-Q2 as of April 2026).
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-04 brain dump
Files: dashboard/src/components/CloudSpendSection.tsx:50
Investigation: Marcus 2026-04-05 — Backend scraper is correct: getRollingFyWindow() computes 4 quarters (2026-Q2, Q1, 2025-Q4, Q3 for April 2026). Tableau genuinely has no 2026 data yet — cache only has 250 records for 2025-Q3 and 2025-Q4. NOT a scraper bug. Actual bug found: QTR_FMT regex at CloudSpendSection.tsx:50 is /^[A-Z]{2}\d{2}Q\d$/ (expects "CY25Q1" format) but actual data uses "2025-Q3" format — so the reporting period badge NEVER renders because validQ is always empty.
Description: Fix the QTR_FMT regex from /^[A-Z]{2}\d{2}Q\d$/ to /^\d{4}-Q\d$/ so the reporting period badge renders correctly with actual data. Optional enhancement: add placeholder $0 entries for missing quarters in the rolling window so the chart always shows 4 bars, making it clear which quarters have no closed deals yet. Do not change the scraper — backend is correct.

### BKL-W3-02 | CCSP middle tile redesign — mirror ACV By Owner layout
Status: ✅ DONE 2026-04-04 — Extracted ByAETile component in CloudSpendSection.tsx. Middle tile now mirrors Pipeline "By Owner" exactly: per-AE rows with name, total spend, customer count, and progress bar; quarter x AE cross-tab grid with column headers and total row; clicking an AE row toggles selection. Right tile (top accounts) already filtered by activeAE via topAccounts from CCSPByAE — confirmed working. No forecast stage columns (CCSP has none). Design-Council-W3 typography standards applied throughout.
Priority: P1
Size: M (4 hours)
Source: Jason 2026-04-04 brain dump — "I want this to look like the ACV by owner tile above"
Files: dashboard/src/components/CloudSpendSection.tsx (middle tile), right tile (top accounts filter)
Design confirmed 2026-04-05 by Jason:
  Middle tile ("By AE") layout — mirror Pipeline "By Owner" exactly:
    - Header: "By AE"
    - Per-AE row: [AE Name] · $X total + progress bar (share of total spend)
    - Quarter grid below: AE rows × quarter columns (2025 Q1, 2025 Q2, … 2026 Q2)
    - Cell values: spend $ per AE per quarter
    - Labels: same as ACV Pipeline column headers (quarter names)
    - NO forecast stage columns (no Commit/Best/Pipeline/Closed — CCSP has none)
    - Clicking an AE row selects/highlights that AE
  Right tile (top accounts) filter:
    - When an AE is selected in the middle tile, top-accounts tile filters to only that AE's accounts
    - Deselect (click again or clear) restores all-AE view
  Data source: existing CCSP quarters data already in CloudSpendSection props

### BKL-W3-03 | Duplicate AE portfolio "Elmer" showing twice on dashboard
Status: ✅ DONE 2026-04-05 — Removed Elmer Alvarez's 10 customers from data/config/customers.json. Jason will add Elmer as a proper second AE (with aes.json entry + sheet IDs) via bootstrap when ready. Dashboard now shows 10 customers, 1 AE (Carolanne).
Priority: P0
Size: XS (15 min)
Source: Jason 2026-04-04 brain dump — only 1 AE configured, Elmer appears twice
Files: data/config/aes.json
Investigation: Marcus 2026-04-05 — NOT a code bug. API returns 20 unique customers: 10 Carolanne, 10 Elmer. AccountPortfolioGrid correctly groups by a.ae field. Root cause: Elmer Alvarez has 10 customers in customers.json but is MISSING from aes.json (only Carolanne is configured). Both sections render legitimately — Elmer appears because his customers exist in the system.
Description: Elmer Alvarez has customers in customers.json but no AE entry in aes.json. This means his accounts have no associated sheet IDs or scraper config. Fix: add Elmer Alvarez to aes.json with his sheet IDs and territory config. This is a config gap, not a UI bug — deduplicating in the UI would hide missing data.

### BKL-W3-04 | Account Portfolio cards — Segment/Industry text truncated and unreadable
Status: ✅ DONE 2026-04-04 — Verified: `title={account.segment}` already present at AccountPortfolioGrid.tsx:277. No industry field exists. Tooltip on hover was already implemented. No code change required.
Priority: P2
Size: S (1-2 hours)
Source: Jason 2026-04-04 brain dump
Files: dashboard/src/components/AccountPortfolioGrid.tsx or CustomerCard
Description: Account cards on the portfolio grid show a truncated Segment/Industry label that is hard to read. Options: (1) wrap instead of truncate, (2) show full text on hover/tooltip, (3) abbreviate intelligently rather than hard-cutting. Investigate what data populates this field and choose the approach that fits the card layout best.

### BKL-W3-05 | Account Details page — right column tiles truncated, needs UX deep investigation
Status: ✅ DONE 2026-04-04 — Right column tile truncation fixed: Cases→position 1, text-sm on primary content, line-clamp-3 on summaries, title= tooltips on all truncated elements.
Priority: P1
Size: L (deep investigation + redesign)
Source: Jason 2026-04-04 brain dump — "very truncated and hard to read, may be a deeper UI/UX issue"
Files: dashboard/src/pages/CustomerDetailPage.tsx (right column: Products, Support Cases, etc.)
Investigation: Aditi 2026-04-05 — Full design report delivered. Key findings:
  - P0: Products tile uses `truncate` on product descriptions (often 60+ chars) at 35% column width — primary identifier cut off
  - P0: Cases tile uses `line-clamp-2` on case summary AND `truncate` on product name — most actionable info unreadable
  - P1: Key Contacts name+email both truncated; email is near-useless at this width
  - P1: Drive file names truncated with MIME badge and date consuming most of the row
  - All tiles use text-xs (12px) body text — below comfortable reading threshold for dense data
  - Current tile order (Stakeholders > Products > Cases > Contacts > Drive) buries Cases at position 3; Sev1 should be position 1
  Recommended redesign: Cases to position 1, remove truncate → line-clamp-2/3, bump body text to text-sm, add expand-in-place accordion, increase column width xl:w-[40%], show expiry urgency bands on Products (red <30d, amber <90d).
Description: Implement Aditi's design recommendations from docs/W3-05-DESIGN-REPORT.md (or inline above). Priority order: (1) fix truncation on Products+Cases (remove `truncate`, allow wrap), (2) reorder tiles (Cases first), (3) bump text-xs→text-sm for primary content, (4) add expand-in-place for case details, (5) expiry urgency bands on Products.

### BKL-W3-06 | Setup page — header redesign with Red Hat branding
Status: ✅ DONE 2026-04-04 — Implemented Concept B horizontal brand bar: flex items-start layout, 48×48 bg-[#EE0000] rounded-xl with white "RH" text, "ASA Command Center" subtitle in text-accent, gradient divider, reset buttons moved to right side of flex row. Conforms to DESIGN-COUNCIL-W3.md typography standards.
Priority: P2
Size: S (2-3 hours)
Source: Jason 2026-04-04 brain dump — "change the icon to a red hat icon/image, better header design"
Files: dashboard/src/pages/SetupPage.tsx:2780-2817 (header section)
Investigation: Aditi 2026-04-05 — Three concepts designed. Recommendation: Concept B "Horizontal Brand Bar." Left-aligned layout with Red Hat red square icon (bg-[#EE0000]) containing white fedora icon. Title + subtitle beside it. Gradient accent divider line below. Reset buttons moved to right of same row (removes absolute positioning fragility). Rationale: matches dashboard's left-aligned content language, compact (doesn't push accordion sections down), professional density appropriate for a settings page.
Description: Implement Concept B from Aditi's design. Key changes to SetupPage.tsx:2780-2817: (1) change from centered to flex items-start gap-4 layout, (2) replace emoji icon with 48x48 bg-[#EE0000] rounded-xl containing white fedora SVG, (3) add "ASA Command Center" subtitle in text-accent, (4) add h-0.5 gradient divider below, (5) move reset buttons from absolute-positioned to right side of flex row. Red Hat brand color: #EE0000.

### BKL-W3-07 | Setup page — CCSP "Sync Now" button does nothing
Status: ✅ DONE 2026-04-05 — Added ccspSyncedAt state. handleRunCcspScrape now sets it from d.refreshedAt on success. "Synced at HH:MM:SS" message renders below the sync button row after completion.
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-04 brain dump — "clicking CCSP Sync Now doesn't do anything"
Files: dashboard/src/pages/SetupPage.tsx (CCSP sync row)
Investigation: Marcus 2026-04-05 — Button IS wired correctly (calls POST /api/refresh/ccsp, returns ok:true, not disabled). Root cause: zero visible feedback. The sync completes in <100ms (cache is fresh), so the loading spinner appears and disappears too fast to notice. No success/failure message shown after completion.
Description: CCSP Sync Now works silently. Fix: add a toast/flash message after sync completes ("CCSP data refreshed — last sync: [timestamp]") and update the last-synced timestamp display immediately. The button does not need re-wiring — only the feedback layer is missing.

### BKL-W3-08 | Setup page — Salesforce shows contradictory state (Session Active + Requires session)
Status: ✅ DONE 2026-04-05 — SetupPage.tsx:2668 now shows "Session active — sync needed to complete setup" when sfSessionActive && !sfScrapeOk, vs "Requires Salesforce session" when !sfSessionActive. Sync button also re-enabled when session is active (changed disabled from !sfConnected to !sfSessionActive) so user can trigger sync from that state.
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-04 brain dump — screenshot confirms contradictory UI state
Files: dashboard/src/pages/SetupPage.tsx:2668 (sync row disabled message)
Investigation: Marcus 2026-04-05 — State derivation confirmed. `sfConnected = sfSessionActive && sfScrapeOk`. The contradictory state only appears transiently when `sfSessionActive=true` (OAuth token exists) but `sfScrapeOk=false` (no successful sync yet — lastSync is null or syncError set). In that state: connection card shows "Session Active" (correct), sync row shows "Requires Salesforce session" (misleading — session IS active, what's missing is a completed sync). Currently system is healthy (sfConnected=true) so the bad state isn't showing right now.
Description: Fix the message at SetupPage.tsx:2668 to distinguish between two failure modes: (1) `!sfSessionActive` → "Requires Salesforce session" (correct as-is), (2) `sfSessionActive && !sfScrapeOk` → "Session active — click Connect to complete setup" and enable the Sync Now button so the user can trigger a sync from this state.

---

### BKL-W3-12 | Product Intelligence Hub — RHEL, OpenShift, AAP release radar with chat
Status: ✅ DONE 2026-04-06 — Phase 1 ✅ | Phase 2 ✅ | Phase 3 ✅ — all 30 ISC criteria verified
Priority: P2
Size: XL (3 phases: Phase 1 = 3-4 days, Phase 2 = 2 days, Phase 3 = 3-4 days)
Source: Jason 2026-04-04 feature request
Research: 2026-04-05 — BKL-AI15 + BKL-AI16 consolidated here as parent task. Full spec below.
Architecture: docs/W3-12-PRODUCT-INTELLIGENCE-HUB.md
Files: src/product-intelligence.ts (new), src/product-intel-routes.ts (new), src/product-intel-scheduler.ts (new), data/config/product-intel-config.json (new), data/config/product-alerts.json (new), dashboard/src/pages/ProductsPage.tsx (new), dashboard/src/components/ProductCard.tsx (new), dashboard/src/components/ProductReleaseBanner.tsx (new), dashboard/src/components/ProductChat.tsx (Phase 3), server.ts (+routes), background-scheduler.ts (+timer), customer.ts (+brief injection Phase 3)
Consolidates: BKL-AI15 (data pipeline — DONE), BKL-AI16 (Q&A chat — fulfilled by Phase 3)
Confirmed decisions (2026-04-05):
  - Google Slides extraction: PDF + unpdf (convert deck to PDF, extract text via unpdf library)
  - Product list: config-driven in product-intel-config.json (extensible to RHEL AI, OpenShift Virt, etc.)
  - Gemini API: NOT available at Red Hat — do not use for any feature
  - Portal scraping (access.redhat.com): DEFERRED — Phase 2+ after public data pipeline is stable
  - Trust boundary: only public .redhat.com sources (access.redhat.com requires auth, defer)
Phase 1 — Scrape + Summary + UI (3-4 days):
  - src/product-intelligence.ts: fetchLifecycleVersions(), scrapePdfNotes() via unpdf, scrapeHtmlNotes() static+Playwright fallback, parseAtomFeed(), synthesizeProductSummary() (Claude Sonnet, temp=0.3), cache read/write
  - Slides export: if Drive file is a Google Slides doc → export to PDF bytes → unpdf text extraction (Google Slides → PDF is a Drive API export format, no Gemini needed)
  - Config: data/config/product-intel-config.json with RHEL/OCP/AAP seeds, docBaseUrls, refreshIntervalHours. Schema includes `products: [{slug, displayName, driveFolder, marketingDoc, seeds: {lifecycle, releaseNotes, atomFeed}}]`
  - Cache: data/cache/product-intel/{slug}-summary.json + {slug}-{version}-raw.json. contentHash dedup skips re-synthesis when source unchanged.
  - API: GET /api/products, GET /api/products/:slug, POST /api/products/:slug/refresh
  - Alert persistence: data/config/product-alerts.json keyed by `{slug}-{version}`. Alert stays until acknowledged by Jason OR a "What's Next" deck is added to Drive folder for that version. Includes `{ slug, version, detectedAt, acknowledged, deckAdded }`.
  - Background: weekly Sunday 6 AM refresh of all products (configurable; admin "Refresh Now" button available)
  - UI: ProductsPage.tsx (3 ProductCards), ProductCard.tsx (version, GA date, EOL, summary excerpt, alert badge)
  - ProductReleaseBanner: top-of-ProductsPage banner when `product-alerts.json` has unacknowledged releases. Shows product name, version, "What's New" link, dismiss button. Also injected into daily briefing email (Phase 3).
  - Sidebar: Add Products nav item with badge count when alerts > 0
Phase 2 — ✅ DONE 2026-04-06 (scope pivoted from Drive Drops to: 7 products, Option A UX, Drive optional, caps fix):
  Delivered: 7 products (RHEL, OCP, OCP Virt, AAP, RHEL AI, AI Inference, OpenShift AI) | Option A Unified Stream layout (FeatureFilterBar + SpotlightStrip + FeatureListRow + FeatureDetailPanel + ProductFeatureGroup) | Drive corpus optional (new products with no Drive folder proceed with release-notes-only) | SECTION_CAP 3500→6000, TOTAL_CAP 9000→18000 | releaseNotesDocNames per-product config | OCP Virt fixed from 4 to 7 features | ProductIntelSection.tsx updated to all 7 products
  Feature counts: RHEL 29 (6 TP) | OCP 21 (3 TP) | OCP Virt 7 (2 TP) | AAP 10 (2 TP) | RHEL AI 19 (19 TP) | AI Inference 30 (30 TP) | OpenShift AI 18 (14 TP)
  Original Phase 2 Drive Drops spec (deferred to post-Phase 3):
  - Per-product Drive folder for Jason's "What's Next" decks: Drive shortcuts (links) pointing to decks that live elsewhere
  - Shortcut code path: `src/drive-sources.ts` — when a Drive item is a shortcut (mimeType = application/vnd.google-apps.shortcut), follow targetId to the actual file. If target is Google Slides → PDF export + unpdf. If target is Google Docs → text extract. If target is PDF → direct unpdf.
  - Marketing.doc at product root: each product config has a `marketingDoc` Drive file ID pointing to a shared Marketing doc containing user groups, RH events, marketing events relevant to that product. Fetched and injected into synthesis prompt.
  - Admin page: folder ID picker per product + marketing doc ID input per product
  - Re-synthesis triggers when Drive content changes (contentHash comparison)
  - Onboarding callout text per product: "Drop .redhat.com links and What's New deck shortcuts here to improve summaries"
Phase 3 — Chat + Brief Integration (3-4 days):
  - POST /api/products/:slug/chat — Claude Sonnet grounded Q&A (reuse callGeminiGrounded() pattern, swap to Claude)
  - ProductChat.tsx — tabbed chat UI, streaming SSE, citation cards, 10-message cap
  - buildXmlSources() in customer.ts: inject <source type="product_intelligence"> for matched subscriptions
  - SYNTHESIS_PROMPT update: include product intel section for matching products
  - Daily briefing email: inject ProductReleaseBanner content for customers subscribed to that product
Key design decisions:
  - PDF-first scraping (no Playwright for RHEL) — avoids shared browser contention
  - Non-grounded Claude Sonnet for synthesis (source already in prompt, temp=0.3) — Gemini blocked at Red Hat
  - Drive shortcuts: follow targetId to actual file, export to appropriate format, unpdf for PDFs/Slides
  - Config-driven product list (extensible without code change)
  - Subscription-based brief injection (only surface intel when customer has that product)
  - Alert persistence keyed by {slug}-{version}: survives restarts, cleared on acknowledge or deck-add
  - Weekly refresh default (not daily) — product intel changes slowly, reduce API noise
UX spec (Aditi Sharma 2026-04-05):
  - ProductReleaseBanner: dismissible top-of-page banner, product icon + version + "What's New" link + ack button
  - Sidebar: "Products" nav item with amber badge count when alerts pending
  - ProductsPage: 3 ProductCard components in responsive grid
  - ProductCard: product logo/icon, current version, GA/EOL dates, 2-sentence summary excerpt, "View Details" link, alert badge if new release
  - AccountProductIntelligence section: in CustomerDetailPage sidebar, shows relevant product intel for subscribed products (Phase 3)

### BKL-W3-13 | Telesense integration — SF utilization data mapped to account details + briefs
Status: 🔬 RESEARCH — VNC spike complete 2026-04-05
Priority: P2
Size: XL (2-3 weeks — Salesforce Analytics API, NOT Tableau)
Source: Jason 2026-04-04 feature request
Investigation: Telesense feasibility agent 2026-04-05 + VNC inspection 2026-04-05.
  Dashboard URL: https://redhatcrm.lightning.force.com/analytics/dashboard/0FK6e000000iHuyGAE
  Tech stack: Salesforce CRM Analytics (Einstein Analytics / Lightning component) — NOT Tableau embed. CCSP Tableau CSV template does NOT apply.
  Filter workflow confirmed: Account Owner dropdown → EBS Account dropdown (populated with account numbers under that AE) → per-account data.
  EBS Account numbers VISIBLE in UI ✅ — blocking question resolved, account mapping is feasible.
  Products: 3 separate dashboards (identical layout, same filters): RHEL, OpenShift, Ansible (AAP).
    - RHEL: high data density, primary target
    - OpenShift: high data density, primary target
    - Ansible: sparse data, lower priority
  Data available per account:
    - Health indicators (amber): Account Risk/Opportunity, Version Lifecycle, OpenShift Offering Usage, Unattached Subs, Telemetry status
    - Core estimated usage time series (180-day window)
    - Summary Trends section (below fold)
  Data freshness: Updated daily (~11 PM prior day)
  Download button: CONFIRMED image-only (screenshots of charts, not CSV/JSON). Structured data CANNOT be obtained via download.
  Approach decision: Salesforce Analytics REST API is REQUIRED — download is useless for machine consumption. Einstein Analytics has a documented REST API for querying dataset values directly. Fallback: Playwright DOM scraping of rendered Lightning component text values. Vision API approach is NOT viable for production use (images only, no numbers).
  CCSP scraper is NOT the template. sf-scraper.ts (Salesforce login) IS the right starting point for auth.
  Account number mapping: EBS Account # → customers.json accountNumbers field (same pattern as supportable/ccsp).
Files: New — src/telesense-scraper.ts, src/customer.ts (brief XML), dashboard/src/ (customer detail signals)
Next: Architecture decision — probe Salesforce Analytics REST API with existing SF session. Check network tab in browser for XHR calls made by the Lightning dashboard (these will reveal the actual API endpoint and dataset IDs being queried). If dataset IDs are visible, structured JSON is retrievable without scraping.

### BKL-W3-11 | Account Details header — mystery "In Progress" label next to AE name
Status: ✅ DONE 2026-04-05 — Root cause was fetchCustomerMeetings returning 30-day window sorted ascending; meetings[0] was the oldest past meeting, triggering "In progress" permanently. Fixed nextMeetingLabel() to use find() with 2h lookback window instead of index 0. Changed "In progress" → "Meeting in progress". CustomerDetailPage.tsx:275-290.
Priority: P2
Size: XS (15 min)
Source: Jason 2026-04-04 brain dump — "no idea what this is or means"
Files: dashboard/src/pages/CustomerDetailPage.tsx:275-289 (nextMeetingLabel), :1658-1662 (header render)
Investigation: Marcus 2026-04-05 (partial) + deep trace 2026-04-05 — Marcus identified nextMeetingLabel() but missed the real root cause. fetchCustomerMeetings() fetches 30 days back → 30 days forward sorted ascending. meetings[0] is the OLDEST event in the window (potentially 3 weeks ago). mins < -60 always returned 'In progress' for any past meeting, permanently showing the label even with no upcoming meetings.
Fix applied 2026-04-05: nextMeetingLabel() now uses Array.find() to locate the first meeting that started within the last 2 hours or is upcoming. Meetings older than 2h are skipped (meeting is over). Also: changed "In progress" → "Meeting in progress" for clarity.
Description: FIXED — dashboard/src/pages/CustomerDetailPage.tsx:275-290. The label now only appears during an active meeting window (started <2h ago or upcoming). No more phantom "In progress" from weeks-old past events.

### BKL-W3-10 | Account aliases — map accounts to alternate names for Drive/data lookup
Status: ✅ DONE 2026-04-04 — Account aliases implemented: aliases field in customers.json, Drive lookup fallback in customer.ts + google.ts, Aliases input column in Setup Step 4.
Priority: P1
Size: M (half day)
Source: Jason 2026-04-04 brain dump
Files: data/config/customers.json, src/customer.ts (_fetchCustomerDocsImpl, generateBrief), dashboard/src/pages/SetupPage.tsx or CustomerDetailPage
Description: Some accounts have subscriptions, cases, and pipeline under one name but all the Drive docs/account notes are filed under a different name (alias, parent company, or legal entity variant). Example: "Dropbox" in Salesforce/Portal but Drive folder is named "Dropbox Inc." or a subsidiary name. Without aliasing support, Drive lookups fail silently and the brief misses all document intelligence.
Design:
  - Add optional `aliases: string[]` field to Customer in customers.json (and types.ts)
  - Drive folder lookup in _fetchCustomerDocsImpl: try primary name first, then each alias in order until a folder is found
  - Brief XML / intelligence slug: use primary name for caching, but also check alias slugs when intelligence cache is missing
  - Setup UI: add "Aliases" field to customer config (comma-separated alternate names)
  - This is purely additive — no changes to existing matching logic, aliases only tried as fallback

### BKL-W3-09 | Admin page — top cards misaligned text and labels
Status: ✅ DONE 2026-04-04 — Applied grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 pattern with whitespace-nowrap labels and truncate min-w-0 values to the Gemini API usage key-value section. Replaced justify-between with dl/dt/dd grid per DESIGN-COUNCIL-W3.md Section 5.
Priority: P2
Size: XS (30 min)
Source: Jason 2026-04-04 brain dump
Files: dashboard/src/pages/AdminPage.tsx (top stat cards)
Description: The summary cards at the top of the Admin page have misaligned text and labels. Investigate the card layout, fix alignment so labels and values are correctly positioned. Likely a flex/grid alignment or padding issue.

---

### BKL-G33 | Setup page sync status inconsistent — CCSP shows green post-sync, others show grey; no live update after SF sync
Status: ✅ DONE 2026-04-05 — Added `isRecent()` helper (5-min window) for consistent green/grey logic across all 4 sync rows; `handleSfSync` now awaits status re-fetch immediately instead of setTimeout; green status persists across navigations via server-sourced timestamps.
Priority: P2
Size: S (2-4 hours)
Source: Jason 2026-04-05 — screenshot shows CCSP "Synced just now — 557" in green while RH Cases and SF Pipeline show same-format text in grey; after triggering SF pipeline resync the status doesn't update to show completion
Files: dashboard/src/pages/SetupPage.tsx
Description: The four sync status rows in the Setup Data Sources page use inconsistent colors and refresh behavior. CCSP shows green text immediately after sync; RH Cases and SF Pipeline show grey text. After triggering an SF pipeline sync, the status line doesn't update to reflect completion. Need to: (1) audit all 4 sync status text color logic and standardize — green for just-synced, grey for older syncs; (2) ensure the status polling picks up the latest sync result immediately after completion so the text updates without requiring a page reload.

---

### BKL-G32 | Scrape history missing CCSP/Supportable — 50-entry global cap + no auto-refresh
Status: ✅ DONE 2026-04-05 — (1) Increased slice from 50 to last-10-per-service before merge, so infrequent scrapers (CCSP, Supportable) always appear; (2) Added 10s polling interval to ScrapeHistorySection so triggered scrapes show without page reload.
Priority: P2
Size: XS (30 min)
Source: Jason 2026-04-05 — CCSP and Salesforce don't appear in scrape history after triggering from Data Sources page; root cause: 50-entry global cap filled by RH Cases (every 15min), plus no auto-refresh
Files: dashboard/src/pages/AdminPage.tsx

---

### BKL-G31 | Admin page layout unpolished — buttons misaligned, sections visually inconsistent
Status: ✅ DONE 2026-04-05 — (1) ScrapeSection card: added `flex flex-col` + `mt-auto` on status div for equal-height button alignment; (2) SourceScheduleRow: added `self-center` to label + Save button; (3) SchedulerConfig: removed internal h3, added external h2 matching all other section headers.
Priority: P3
Size: S (2-4 hours)
Source: Jason 2026-04-05 — screenshot shows "Run Now" buttons at different vertical positions across cards, Scheduler Config save buttons misaligned with inputs, overall section spacing inconsistent
Files: dashboard/src/pages/AdminPage.tsx

---

### BKL-G30 | Scraper pre-flight checks inconsistent — Supportable fires even when VPN unreachable
Status: ✅ DONE 2026-04-06 — Fixed P0/P1 gaps: (1) Added `liveProbe()` at entry of both `runSupportableScrape()` and `runSupportableDiscoverAndScrape()` — throws user-friendly error if VPN unreachable. (2) Converted SF Lightning probe from log-only to scrape gate — probe failure now skips enqueue and sets skip reason. (3) Added `liveProbe()` to `flushScrapersAfterAuth()` Supportable block — skips enqueue if VPN down. (4) `sanitizeErr()` now maps Playwright DNS error patterns (`ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, etc.) to user-friendly messages. P0 Gap 2 (RH heartbeat session check) deferred — scraper rules require extra caution.
Priority: P1
Size: M (4-8 hours)
Source: Jason 2026-04-05 — screenshot shows "goto: net::ERR_NAME_NOT_RESOLVED at https://supportable.corp.redhat.com:4443..." error in Supportable Subscriptions sync section while off VPN; UI correctly showed "Not reachable — check VPN" but background scheduler still attempted the scrape
Files: src/scrape-api.ts, src/background-scheduler.ts, src/supportable-scraper.ts, src/rh-scraper.ts, src/ccsp-scraper.ts, src/sf-scraper.ts
Description: Marcus audit found 7 gaps across P0-P2 severity:

  **P0 — Gap 1:** Supportable scraper calls `page.goto()` at `supportable-scraper.ts:864` with zero VPN/DNS check. Scheduler probes VPN for daily 7am runs but `flushScrapersAfterAuth()` (background-scheduler.ts:110-199) bypasses all probes. Manual POST /api/scrape/supportable (scrape-api.ts:188) also skips the reachability check.
  **P0 — Gap 2:** RH Cases 15-min heartbeat (background-scheduler.ts:1104-1121) enqueues on elapsed time only — no session validity check. Startup path has auth pre-flight; heartbeat does not.
  **P1 — Gap 3:** SF Pipeline scheduler probe (background-scheduler.ts:779-792) is log-only (`console.warn`) — does not gate the scrape. CCSP correctly returns/skips on probe failure; SF does not.
  **P1 — Gap 4:** CCSP Tableau probe (background-scheduler.ts:471) only runs `if (tableauBase)` (env var). If `TABLEAU_BASE_URL` unset, scrape proceeds blind.
  **P1 — Gap 5:** `sanitizeErr` (utils.ts:4-5) truncates errors but passes raw Playwright DNS strings like "goto: net::ERR_NAME_NOT_RESOLVED" to UI. No mapping to user-friendly messages.
  **P2 — Gap 6:** `flushScrapersAfterAuth()` enqueues all 4 scrapers with no per-scraper connectivity checks.
  **P2 — Gap 7:** No error classification — UI cannot differentiate VPN issue vs session expiry vs parse error.

Fix priority: (1) Add `probeVpn()` inside Supportable scraper entry points before `page.goto()`; (2) Add session pre-flight to RH heartbeat; (3) Convert SF probe to a skip gate; (4) Add `probeVpn()` to `flushScrapersAfterAuth()` before Supportable; (5) Map Playwright error patterns to user-friendly messages in utils.ts.

---

### BKL-G29 | What Changed delta items truncated at 100 chars — sentences cut mid-word
Status: ✅ DONE 2026-04-05 — Removed all `.slice(0, 100)` caps in `extractFacts()` and fallback lines in dashboard-routes.ts (lines 465–469, 488). Full sentence text now flows to frontend.
Priority: P2
Size: XS (10 min)
Source: Jason 2026-04-05 — screenshot shows delta bullets cut off mid-sentence ("resolve the outstand", "Chief Data Offic", etc.)
Files: src/dashboard-routes.ts

---

### BKL-G28 | Account Intelligence Docs panel in wrong column — should be right, not left
Status: ✅ DONE 2026-04-05 — Moved AccountIntelligencePanel from left column to bottom of right column in CustomerDetailPage.tsx (below DriveSection, above StakeholderEngagementPanel).
Priority: P2
Size: XS (15 min)
Source: Jason 2026-04-05 — screenshot shows Intelligence Docs and Product Q&A stacked in left column; Intelligence Docs belongs in right sidebar
Files: dashboard/src/pages/CustomerDetailPage.tsx

---

### BKL-G23 | Admin page not discoverable from sidebar nav
Status: ⏸️ DEFERRED
Priority: P3
Size: XS (15 min)
Source: Quinn UIReviewer 2026-04-04 — brand new user finds no Admin link in sidebar
Files: dashboard/src/components/Sidebar.tsx (or wherever nav links live)
Description: Admin page (/admin) is only reachable via /setup → Admin link. No entry point exists in the main sidebar nav. Add an "Admin" link to the sidebar so users can access it directly without going through Setup first.

---

### BKL-G25 | Salesforce connection card shows amber "Session Active" instead of green "Connected"
Status: ✅ DONE 2026-04-05 — Removed `!sfStatus?.syncError` from `sfScrapeOk`; a stale syncError alongside a valid lastSync was blocking green Connected state. Now sfConnected = sfSessionActive && !!lastSync, matching the ticket spec.
Priority: P2
Size: XS (1-2 hours)
Source: Jason 2026-04-04 — screenshot shows SF card amber while Portal/Supportable are green
Files: dashboard/src/pages/SetupPage.tsx (connection card status logic)
Description: The Salesforce connection card renders amber "Session Active" with a "Connect" button instead of green "Connected" with a "Reconnect" button. Portal and Supportable 360 show green when their sessions are active. SF should show green when a valid session exists and the pipeline has been synced at least once. The "Session active — sync needed to complete setup" message in the Sync section is also confusing — once a sync has been run, SF should show fully connected. Investigate the status logic that decides Connected vs Session Active, align SF with the other card states.

---

### BKL-G27 | customers.json AI-enriched fields (segment, industry) wiped on container restart
Status: ✅ DONE 2026-04-05
Priority: P2
Size: S (2-4 hours)
Source: Jason 2026-04-05 — segment labels disappeared from account cards after container restart; restored manually from git
Files: src/background-scheduler.ts, src/bootstrap-orchestrator.ts, src/scrape-api.ts, src/drive-sources.ts, src/sheet-import.ts
Description: Multiple code paths write customers.json by reconstructing the customer array from external sources (territory sheet, Supportable discovery, drive sources). These writes replace the full customer object but do not preserve AI-enriched fields: `segment`, `industry`, `industryDescription`, `industryCompetitors`, `industryUpdatedAt`. On container restart, the background scheduler or territory sync runs and rewrites customers.json with source-only fields, silently clearing all AI enrichment. Fix: each write path should merge new source data onto the existing customer object, preserving any fields not present in the source (spread existing, then overlay new fields).
Resolution: Created src/customer-merge.ts with mergeCustomers() + readExistingCustomers() helpers. Applied merge-not-replace to the two dangerous write paths that build a fresh array from external sources: sheet-import.ts (importSheetRows) and drive-sources.ts (drive folder import). Also applied to server-state.ts saveCustomers() so all callers going through that function are covered. Preserved fields: segment, industry, confidenceScore, and any field prefixed with ai or intelligence.

---

### BKL-G26 | Supportable header dot stays green when off VPN — stale cache vs live reachability mismatch
Status: ✅ DONE 2026-04-05 — Three-part fix: (1) `/api/scraper-status` now does a 60s-cached HEAD request to supportable.corp.redhat.com and returns `supportableReachable: boolean`; (2) App.tsx header dot turns amber + tooltip "Not reachable — check VPN" when `supportableReachable === false`; (3) SetupPage.tsx Sync Now button disabled + shows "Not reachable — check VPN" hint when unreachable. Commits pending rebuild.
Priority: P2
Size: XS (1 hour)
Source: Jason 2026-04-05 — header shows all green (RH Cases, CCSP, Supportable, Salesforce) while off VPN; Data Sources page correctly shows Supportable 360 "Not connected"
Files: src/scrape-api.ts, dashboard/src/App.tsx, dashboard/src/pages/SetupPage.tsx
Description: Header status dots used cached scraper-store state (last sync timestamp). Data Sources page made a live VPN HEAD request via `/api/auth/supportable/check`. When user was off VPN but had a recent successful sync, header stayed green while Setup showed "Not connected". Also, Sync Now button had no VPN reachability check in its disabled condition — it would fire even when Supportable was unreachable.

---

### BKL-G24 | /api/intelligence/status returns 404 — console noise on Admin page
Status: ✅ DONE 2026-04-04 — Added GET /api/intelligence/status route (customer-routes.ts) + getRunningJob() export (account-intelligence.ts). Returns running job or {status:'idle'}. Polling stops on first call. Commit 7b7bc31.
Priority: P3
Size: XS (30 min)
Source: Quinn UIReviewer 2026-04-04 — console shows 404 x2 on every Admin page load
Files: src/scrape-api.ts or server.ts (whichever handles /api/intelligence/status), dashboard/src/pages/AdminPage.tsx
Description: The Admin page polls /api/intelligence/status on load + retry. The endpoint returns 404, generating repeated console errors. Either implement the endpoint, rename the poll to the correct endpoint, or remove the polling call if the endpoint was removed. Find the AdminPage.tsx reference to determine the correct fix.

---

## Wave 2 — Security + Reliability (2026-04-03)

### BKL-W2-01 | Circuit breaker session-expiry pin (Rook finding #3)
Status: ✅ DONE 2026-04-03
Priority: P0
Size: S (1-2 hours)
Source: Rook security audit Wave 2, finding #3
Files: src/scraper-manager.ts (CircuitBreaker class)
Description: SessionExpiredError during a scrape set failure count but cooldown window was too short (5 min default). A transient portal redirect could permanently halt scraping until manual reset. Added `_sessionExpired` + `_sessionExpiredAt` fields to CircuitBreaker. When `sessionExpired=true` is passed to `recordFailure()`, circuit stays open for 4 hours regardless of cooldown — prevents retry storm against an expired session. After 4h, pin clears and normal logic resumes. `recordSuccess()` and reset functions clear the pin on re-auth.
Decision: DONE — `recordFailure('session expired', true)` called at the RH SessionExpiredError catch block. `resetAllCircuitBreakers()` updated to also check `_sessionExpired` flag so pin clears on re-auth even with zero failure count.

### BKL-W2-02 | Post-auth queue flush — all 4 scrapers enqueued immediately after RH re-auth
Status: ✅ DONE 2026-04-03
Priority: P1
Size: S (1-2 hours)
Source: Wave 2 backlog
Files: src/background-scheduler.ts (flushScrapersAfterAuth), src/rh-auth.ts (startLoginBrowser)
Description: After RH re-authentication, scrapers waited up to 15 minutes for the next heartbeat tick. Added `flushScrapersAfterAuth()` exported from background-scheduler.ts that enqueues all 4 scrapers in the correct order: RH first (populates account numbers), then SF + CCSP (independent), Supportable last (depends on RH account numbers). Called via lazy import in rh-auth.ts after `onComplete?.()` to avoid circular dependency.
Decision: DONE — lazy `import('./background-scheduler.ts')` in rh-auth.ts avoids circular import since background-scheduler already imports from rh-auth. Coalesce guard in enqueueScraperTask prevents duplicates.

### BKL-W2-03 | Session health watchdog alerts (Rook finding #5)
Status: ✅ DONE 2026-04-03
Priority: P1
Size: S (1-2 hours)
Source: Rook security audit Wave 2, finding #5
Files: src/background-scheduler.ts (heartbeat tick)
Description: No proactive alerting when RH session expires or login times out. Added lightweight watchdog running on every 15-min heartbeat tick: checks `getRhStatus()` for `sessionExpired` and `loginTimedOut` flags; fires ntfy alerts on first detection (deduplicated via `_lastWatchdogSessionExpired`). Also alerts on consecutive scraper failures >= 5 via `getStatus()` + `_alertedScrapers` set. Security: all ntfy bodies use STATIC strings only — no interpolation of session tokens, cookie values, URLs, or raw error objects. Error interpolation uses `sanitizeErr()`.
Decision: DONE — notify helper uses static message strings. `_alertedScrapers` Set deduplicates per-scraper alerts; cleared when `consecutiveFailures` returns to 0.

### BKL-W2-04 | @live scraper pipeline test suite
Status: ✅ DONE 2026-04-03
Priority: P1
Size: M (half day)
Source: Wave 2 backlog
Files: test/live-scrapers.spec.ts (new file)
Description: No integration tests for live scrapers. Added 6 @live tests covering: RH Cases scrape → data returned, SF Pipeline → recordCount > 0, CCSP → records returned, Supportable → customers have accountNumbers, Full pipeline freshness check (all 4 stale=false, lastError=null), Source-to-cache data freshness (lastSuccess within 60 min for 3 scrapers). Excluded from CI via `grepInvert: /@live/` in `ci` project; run via `live-scrapers` project. Uses `pollUntil()` helper polling every 3s up to per-scraper timeouts (120s for most, 300s for Supportable).
Decision: DONE — tests match playwright.config.ts `live-scrapers` project pattern. BASE_URL from env or localhost:7777 default.

### BKL-W2-05 | .gitignore belt-and-suspenders for session-state files (Rook finding #6)
Status: ✅ DONE 2026-04-03
Priority: P1
Size: XS (5 min)
Source: Rook security audit Wave 2, finding #6
Files: .gitignore
Description: session-state.json and sf-session-state.json could contain OAuth session cookies if accidentally created in unexpected locations. Added glob patterns `**/session-state.json` and `**/sf-session-state.json` to ensure they're never committed regardless of directory depth.
Decision: DONE — added in the "OAuth tokens & credentials — never commit" section alongside existing config exclusions.

### BKL-W2-06 | SF pipeline recordCount fix — totalRows out of IIFE scope
Status: ✅ DONE 2026-04-04
Priority: P0
Size: XS (30 min)
Source: Overnight rock-solid pipeline session (2026-04-04)
Files: src/scraper-manager.ts
Description: SF pipeline `recordOutcome()` always stored `recordCount: 0` in scraper-status.json because `totalRows` was declared inside an IIFE and not accessible in the `.finally()` block on the outer promise chain. Promoted to module-level `_sfTotalRows` variable (same pattern as `_sfSyncRunning`, `_sfSyncLastError`). Reset to 0 at function entry, incremented inside IIFE, passed to `recordOutcome()` in finally block as `recordCount: _sfTotalRows`.
Decision: DONE — scraper-status.json sf-pipeline now shows correct non-zero recordCount (700) after successful sync.

### BKL-W2-07 | Supportable startup validation — auto-clear false-positive account numbers
Status: ✅ DONE 2026-04-04
Priority: P0
Size: S (2 hours)
Source: Overnight rock-solid pipeline session (2026-04-04)
Files: src/background-scheduler.ts, data/config/customers.json
Description: Supportable APEX name-search was storing false-positive account numbers (Taylor Fresh Foods had 103 accounts from prefix-match on unrelated RH accounts). The per-customer 20-account cap during discovery was not enforced on previously-cached values. Added `validateCachedAccountNumbers()` called at startup after `initStatusStore()`. Auto-clears customers with >50 accounts (saves atomically via .tmp rename), warns (no action) for 20-50. Cleared all accountNumbers for all 19 customers and ran fresh discover with cap active — settled to 36 total across 19 customers (max 6 per customer). Saved scraper output audit as SCRAPER-RULES addition.
Decision: DONE — startup logs now show per-customer account count or "Account numbers OK". Taylor Fresh Foods: 1 account (down from 103).

### BKL-W2-08 | @live test suite bug fixes — AE extraction, endpoint, store response shape
Status: ✅ DONE 2026-04-04
Priority: P1
Size: S (1 hour)
Source: Overnight rock-solid pipeline session (2026-04-04)
Files: test/live-scrapers.spec.ts, playwright.config.ts
Description: Multiple bugs found when first running @live tests end-to-end. (1) grepInvert: true crashed Node.js v25 — changed to /@live/ regex. (2) Test 4 AE extraction broke because /api/aes returns {aes:[...]} not flat array — added .aes ?? body unwrap. (3) Test 4 used /api/scrape/supportable which requires pre-populated accountNumbers — changed to /api/scrape/supportable/discover. (4) Test 5 full-pipeline assertion on store status broke because /api/scraper-status returns {scrapers:{...}} not flat — added .scrapers ?? body unwrap. (5) RH + SF poll timeouts raised 120s→300s for queue contention. All 6 @live tests now pass (2 min total runtime in serial mode).
Decision: DONE — 6/6 @live tests passing. 237/237 CI tests passing. grepInvert fix prevents Node 25 crash.

### BKL-W2-09 | Tableau VNC window never auto-closes after login
Status: ✅ DONE 2026-04-04
Priority: P1
Size: XS (30 min)
Source: Jason reported 2026-04-04 morning
Files: dashboard/src/pages/SetupPage.tsx
Description: After completing Tableau SSO login in the VNC window, the window never auto-closed. Root cause: `handleTableauConnect` relied exclusively on `wait-for-login` (server-side Playwright URL detection with 120s timeout). If the Tableau SSO redirect landed on a URL variation the Playwright check didn't recognize, it timed out returning false — VNC stayed open indefinitely. Fix: added `session-status` polling every 5s as a fallback alongside `wait-for-login`, both sharing a `loginResolved` flag. First detection wins and fires the close. Same pattern SF session already used.
Decision: DONE — VNC window now closes within 5 seconds of successful login via the polling fallback.

### BKL-W2-10 | Salesforce "Connect" button does nothing when Session Active but no lastSync
Status: ✅ DONE 2026-04-04
Priority: P1
Size: XS (20 min)
Source: Jason reported 2026-04-04 morning
Files: dashboard/src/pages/SetupPage.tsx
Description: After container restart, SF shows "Session Active" (amber) with "Connect" button. Clicking Connect silently returned without opening VNC or triggering a sync. Root cause: `handleSfConnect` had an early-return when `hasSession=true && !expired` even when `sfConnected=false` (lastSync null). The intent was to skip VNC if already fully connected, but this fired on the "session exists, no sync data yet" state (common after container restart). Fix: when hasSession && !expired but sfConnected=false, trigger a scrape instead of bailing silently. User sees immediate feedback and lastSync gets populated.
Decision: DONE — Connect button now auto-triggers a sync when session is already active. VNC flow still opens for actual expired/missing sessions.

### BKL-W2-11 | Test gap: SF "Session Active + no lastSync" state not covered
Status: ✅ DONE 2026-04-04
Priority: P2
Size: S (1-2 hours)
Source: Jason identified 2026-04-04 — "would a test have caught this?"
Files: test/ui/ or test/api/
Description: No test covers the Salesforce "Session Active but lastSync=null" state (occurs after container restart with valid OAuth session). A UI test asserting that clicking "Connect" in this state triggers a sync (not a silent no-op) would have caught BKL-W2-10. Add a test: mock SF status API returning {hasSession:true, lastSync:null}, assert clicking Connect fires POST /api/scrape/salesforce.

### BKL-W2-12 | Bootstrap wizard doesn't detect existing Supportable/CCSP/Pipeline sheets on retry
Status: ✅ DONE 2026-04-04
Priority: P1
Size: S (2 hours)
Source: Jason reported 2026-04-04 — "it should check for existing folder structure and sheets"
Files: src/bootstrap-orchestrator.ts
Description: When the wizard is re-run after a partial failure (e.g. session expired mid-run), steps 4-6 (Create Supportable Sheet, Create CCSP Sheet, Sync Pipeline Sheet) don't check whether those sheets already exist in the Drive folder. Step 1 already handles this correctly (shows "reused existing" when Drive folder is found). Steps 4-6 should do the same: check if a sheet with the expected name exists in the AE's Drive folder before trying to create a new one. If found, reuse it and mark step as done. This makes the wizard safely re-runnable after any partial failure without duplicating sheets.

### BKL-W2-14 | flushScrapersAfterAuth Supportable path scrapes but never writes to sheets
Status: ✅ DONE 2026-04-04
Priority: P0
Size: S (1 hour)
Source: Jason audit 2026-04-04 — 208 rows scraped after Reconnect but never written to any sheet
Files: src/background-scheduler.ts (flushScrapersAfterAuth, scheduleSupportableSync)
Evidence: After `runSupportableDiscoverAndScrape`, results now split by AE and `writeSupportableSheet` called per AE. `refreshSubscriptions()` called after. Account number persistence via onProgress callback added. Same fix applied to scheduled batch path. CI: 228 passed 2026-04-04.

### BKL-W2-15 | SF recordCount inflated — counts per-AE writes instead of unique rows
Status: ✅ DONE 2026-04-04
Priority: P3
Size: XS (30 min)
Source: Jason audit 2026-04-04 — recordCount 700 likely = 350 rows × 2 AE writes
Files: src/scraper-manager.ts (runSfSyncForAes)
Evidence: `_sfTotalRows += data.rows.length` moved outside per-AE loop to before the fan-out write. Next SF sync will show correct unique row count, not doubled count. CI: 228 passed 2026-04-04.

### BKL-W2-13 | No banner/guidance when browser context crashes and needs container restart
Status: ✅ DONE 2026-04-04
Priority: P2
Size: M (4 hours)
Source: Jason requested 2026-04-04 — "we should have a banner message or something saying to restart container button so user knows what to do"
Files: dashboard/src/pages/DataSourcesPage.tsx (or global layout), src/server.ts (API endpoint)
Description: When Playwright's shared browser context crashes and auto-recovery fails (multiple consecutive "Target page, context or browser has been closed" errors), the user has no indication of what's wrong or what to do. Scrapers silently fail with confusing error states. Fix: (1) Track consecutive browser-crash failures in a server-side counter; expose `browserRestartNeeded: true` on `/api/status`. (2) Frontend shows a dismissible banner in Data Sources when this flag is true: "Browser context crashed — scrapers cannot run. Restart the container to recover." with a copy-paste command or a soft-restart button if feasible. (3) Soft-restart option: add `/api/control/restart-browser` endpoint that kills the Chromium process and reinitializes the browser context (avoids need for full `make rebuild` in non-profile-corruption cases).

### BKL-W2-17 | Bootstrap bypasses scraper queue — races with scheduled/manual triggers
Status: ✅ DONE 2026-04-04
Priority: P2
Size: M (3 hours)
Source: Marcus audit 2026-04-04 — identified during FIX 8 (N7)
Files: src/bootstrap-orchestrator.ts
Description: Bootstrap orchestrator calls `runSupportableDiscoverAndScrape`, `runCcspScrape`, and `runSfPipelineSync` directly inline, bypassing the scraper queue in background-scheduler.ts. If a scheduled timer fires mid-bootstrap (e.g. the 7am Supportable batch fires while bootstrap step 3 is running), both share the same browser context and race. Fix requires one of: (a) bootstrap waits on a queue-aware Promise wrapper (needs `enqueueScraperTask` to return a completion Promise — currently void), or (b) bootstrap checks the running flags before each step and defers, or (c) bootstrap explicitly disables scheduled scrapers while running. The inline progress-callback pattern used by bootstrap (for step-by-step UI updates) makes (a) the most correct but requires extending the ScraperTask interface with a completion Promise. Deferred from 2026-04-04 fix pass because full integration requires interface change to ScraperTask.

### BKL-W2-16 | Data Sources scraper cards should show record count alongside sync status
Status: ✅ DONE 2026-04-04
Priority: P2
Size: S (2 hours)
Source: Jason requested 2026-04-04 — "can it also include how many rows or cases or accounts it found just like pipeline does"
Files: dashboard/src/pages/DataSourcesPage.tsx, src/scraper-manager.ts (/api/status/scrapes)
Description: Each scraper card on the Data Sources page shows last sync time and status (fresh/stale/failed) but no record count. The Pipeline card already shows row count. Fix: expose `recordCount` from `ScraperStatusStore` on `/api/status/scrapes` for each scraper (it's already stored there — just needs to be included in the API response and rendered in the card). Display labels should be context-appropriate: RH Cases → "X cases", Supportable → "X subscriptions", CCSP → "X records", SF Pipeline → "X rows" (already done).

---

### BKL-W2-17 | UX Audit Q1 — Drive permissions banner gated on AE configured
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: Conditionally render the "Reduce Drive permissions" banner only when `aeCount > 0`, so new users don't see it before setup. Fixed by wrapping banner in `{aeCount !== null && aeCount > 0 && (...)}`.

### BKL-W2-18 | UX Audit Q3 — Wizard step numbering + RH Portal badge fix
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: (1) Added "Step N of 5 —" prefix to all 5 accordion section titles so new users know their progress. (2) Changed RH Portal "Optional" badge to "Required" — bootstrap is blocked without it.

### BKL-W2-19 | UX Audit Q4 — Per-step retry guidance on bootstrap error completion
Status: DONE 2026-04-04
Priority: P2
Size: S (1 hour)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: When bootstrap completes with errors, each failed step now shows a specific action hint (e.g. "RH Portal auth failed — scroll up to Step 3 and reconnect."). Built a `hintFor(stepName)` lookup keyed on step name fragments.

### BKL-W2-20 | UX Audit Q5 — Prerequisite callout before bootstrap start
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: Added a compact info box above the "Set Up AE" button listing: 7-15 min duration, VPN required, Tableau VNC popup will appear.

### BKL-W2-21 | UX Audit Q7 — Supportable hint text and disabled state fix
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: (1) Changed "Requires VPN" hint to "Requires active RH Portal session" in both the Supportable connection card and the Sync section row. (2) Made Sync Now button also disabled when `!rhConnected` (was only gated on `supportableRunning`).

### BKL-W2-22 | UX Audit Q10 — Tableau Connect button explanation when disabled
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: When RH Portal is disconnected, Tableau Connect button now shows a hint "Connect Red Hat Portal first" above the button and a `title` tooltip attribute for pointer hover.

### BKL-W2-23 | UX Audit Q13 — Preserve SF Report ID across "Add another AE"
Status: DONE 2026-04-04
Priority: P2
Size: XS (30 min)
Source: UX audit 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: `resetForm()` now preserves `sfReportId` across AE resets so users don't have to re-enter it. All other fields (aeName, customerText, pod, terrNum) are still cleared.

### BKL-W2-24 | CCSP sync row hint and disabled state — dependency chain inconsistency
Status: ✅ DONE 2026-04-05 — hint condition corrected to `!tableauConnected` (was `!rhConnected`); text updated to "Requires active Tableau session — Connect in Data Sources above". AdminPage CCSP card gains "Open VNC Login" button (POST /api/browser/open-tableau-login + opens localhost:6080/vnc.html).
Priority: P3
Size: XS (20 min)
Source: Quinn validation 2026-04-04
Files: dashboard/src/pages/SetupPage.tsx
Description: CCSP Sync Now row (line ~2644) shows hint "Requires Tableau session" and does NOT gate the Sync Now button on `!rhConnected`. This is inconsistent with the Supportable row fix (ISC-18/Q7) — CCSP requires Tableau which requires RH Portal first. Fix: (1) update hint to "Requires active Tableau session" or match Supportable wording, (2) evaluate whether CCSP Sync Now button should be disabled when Tableau is not connected (tableauConnected check). Note: CCSP does not strictly require RH Portal the way Supportable does, but the dependency chain (Portal → Tableau → CCSP) means the hint should reflect the actual prerequisite. Confirm with Jason before gating.

### BKL-AI18 | Account Intelligence full investigation — performance, gaps, quality, token efficiency
Status: ✅ DONE 2026-04-04 — Investigation complete. XS/quick items implemented immediately (see below). S-effort items added as BKL-AI18a/b/c. Key findings: (P0) SYNTHESIS_PROMPT was "500-1000 words" — contradicts research-backed 250-word design, fixed to "250-400 words delta-first". (P1) top15→top5 in synthesis, subscriptions_detailed added to source_type enum, background pre-gen name filter uses normalizeForQuery, maxOutputTokens 8192→2048 for synthesis. Dead findPreviousBrief() removed. (P1-S) Drive BFS parallel export, doc classification parallel, Gemini context caching — deferred to BKL-AI18a/b/c. Rook: PASS.
Priority: P1
Size: L (8+ hours — research + audit + design)
Source: Jason requested 2026-04-04
Files: src/customer.ts, src/google.ts, data/cache/*-{date}.json, dashboard/src/ (AI brief display)
Description: Comprehensive investigation of the account intelligence pipeline end-to-end. Goals: (1) Performance — latency breakdown per brief (Gmail fetch / Calendar fetch / AI call / cache write), parallelization opportunities. (2) Gaps — what data is missing (Supportable subscriptions, CCSP spend, cases cross-referenced with pipeline). (3) Quality — are prompts producing high-signal output, or too verbose/shallow? (4) Token efficiency — cost per brief, differential updates vs full regen, smaller model candidates. (5) Architecture — IMPORTANT: Gemini API is NOT approved at Red Hat. Must investigate whether the current Vertex AI service account setup is Red Hat-approved, and if not, identify an approved alternative (Claude API via PAI Inference Tool is a candidate). Do not proceed with any AI provider change without confirming Red Hat approval. Deliverable: prioritized improvement list with cost estimates and approved-provider recommendation.

### BKL-AI18a | Parallelize Drive file exports + doc classification (AI18-R1a/R1b)
Status: ✅ DONE 2026-04-05 — Shipped in commit 7c2ced1. customer.ts Drive exports parallelized with Promise.allSettled + EXPORT_CONCURRENCY=5. doc-extraction.ts classifyDocs() parallelized with Promise.allSettled(docs.map(...)). Quinn validated.
Priority: P1
Size: S (2-3h)
Source: AI18 investigation 2026-04-04
Files: src/customer.ts (lines 287-382), src/doc-extraction.ts (lines 256-263)
Description: Two parallel serialization bottlenecks. (1) Drive BFS fetches each file export sequentially — replace the for loop at customer.ts:287 with `Promise.all()` batching all file exports at once. (2) doc classification in classifyDocs() at doc-extraction.ts:261 runs each Gemini call one at a time — replace with `Promise.allSettled(docs.map(classifyAndExtract))`. Both are P1 latency wins with minimal risk.

---

### BKL-AI18b | Gemini context caching for extraction system prompt (AI18-R4a / BKL-R23)
Status: ⏸️ DEFERRED — Gemini v1beta/cachedContents API requires non-trivial SDK changes to current REST-based integration. Skipped to protect working Gemini pipeline. Revisit when SDK updated.
Priority: P1
Size: S (0.5 day)
Source: AI18 investigation 2026-04-04
Files: src/brief-pipeline.ts, src/customer.ts (callLLMStructured)
Description: The extraction system prompt + responseSchema is identical for every customer brief. Cache it as a Gemini `cachedContent` resource at server start (24h TTL). Estimated 70-85% reduction in extraction call input tokens. See Gemini context caching docs — API: `POST /v1beta/cachedContents`.

---

### BKL-AI18c | Inject scraper-failure status into brief XML (AI18-R2a)
Status: ✅ DONE 2026-04-05 — Shipped in commit 7c2ced1. sourceStatusAttr() helper in customer.ts injects status="scraper_failed" or status="stale" into <source> XML tags. Quinn validated via Illumio brief showing scraper_failed flowing to final output.
Priority: P1
Size: S (2h)
Source: AI18 investigation 2026-04-04
Files: src/customer.ts (buildXmlSources, line 566), src/scraper-status-store.ts (or equivalent)
Description: When a scraper (Supportable, CCSP, Tableau) failed for a customer, inject a structured status tag into the XML: `<source type="subscriptions" status="scraper_failed" last_success="2026-04-03">`. Gives Gemini precise freshness context rather than leaving it to infer from absence. Check `lastScrapeError` state from scraper status store before building each XML block.

---

### BKL-AI19 | Research best approach for Vertex AI service account distribution
Status: ✅ DONE 2026-04-04 — Already implemented and documented in docs/SECRETS-GUIDE.md: shared key in defaults.env (zero-setup for colleagues), personal override via .env, rotation procedure documented.
Priority: P2
Size: S (2 hours — research + recommendation)
Source: Jason requested 2026-04-04
Files: .env, docs/SETUP.md (or README), Containerfile
Description: Jason set up Vertex AI via Red Hat GCP login with a service account key baked into the project so colleagues don't need to repeat the setup. Research the tradeoffs and recommend the best approach for this use case: (1) Baked-in key in container image — zero setup, but key exposed in GHCR image and can't be rotated without rebuild. (2) .env file injection — key stays off the image, each user sets up once, documented in README. (3) Shared service account via team vault — single key everyone uses, rotated centrally. Consider: is the GHCR image private? Who are the intended users (just Jason, or Red Hat colleagues)? Is key rotation a real concern for a localhost-only tool? Deliverable: recommendation with tradeoffs documented, plus any changes needed to setup docs if approach changes.

### BKL-AI20 | Brief cache invalidates on every scrape — constant regeneration
Status: ✅ DONE 2026-04-04 — Added BRIEF_CACHE_TTL_MS=4h to cache-layer.ts; brief route now checks `ageMs < BRIEF_CACHE_TTL_MS` alongside sheetTs check (ADR-007)
Priority: P0
Size: S (2 hours)
Source: Jason reported 2026-04-04 — "everytime i pull up accounts page they want to regenerate everything again"
Files: src/customer-routes.ts:236-246
Description: Brief cache invalidation uses `sheetTs > briefTs` — any sheet refresh (Supportable, CCSP, etc.) marks all briefs as stale, triggering full Gemini regeneration on next page load. With scrapers running every few hours, briefs almost never serve from cache. Fix: change invalidation logic to use a fixed daily TTL (e.g. regenerate once per day max, at a set time like 6am) rather than data-driven invalidation. If the user explicitly requests a refresh (force=true), bypass the TTL. Separate "data freshness" from "brief freshness" — a new scrape should NOT immediately invalidate today's brief.

### BKL-AI21 | On-demand brief missing pipeline + CCSP data
Status: ✅ DONE 2026-04-04 — customer-routes.ts brief route now filters pipeline+CCSP by customer name and passes to generateBrief
Priority: P0
Size: S (1 hour)
Source: Audit 2026-04-04 — code review finding
Files: src/customer-routes.ts:259, src/background-scheduler.ts:1241
Description: The UI-triggered brief route calls `generateBrief(customer, meetings, emails, docs, cases, subscriptions, products)` — no pipeline records, no CCSP cloud spend passed in. The background scheduler version (line 1241) DOES include pipeline and ccsp. This means the brief Jason sees in the UI is missing two key data sources. Fix: fetch pipelineRecords and ccspRecords in the route handler (same way background-scheduler.ts does) and pass them into generateBrief.

### BKL-AI22 | Brief does not cross-reference signals against upcoming meetings
Status: ✅ DONE 2026-04-04
Priority: P1
Size: M (4 hours — prompt engineering + testing)
Source: Jason requested 2026-04-04 — "crossreference all my signals against upcoming meetings etc."
Files: src/customer.ts (generateBrief, EXTRACTION_PROMPT, SYNTHESIS_PROMPT)
Description: The brief includes calendar events as a data source but does not use upcoming meetings as an organizing lens. Jason's desired behavior: if there's a meeting with a customer in the next 7 days, the brief should lead with meeting prep — surfacing relevant open cases, expiring subscriptions, recent emails, and pipeline status as prep context. If no meeting is upcoming, fall back to the current priority-ranked output. Changes needed: (1) identify "upcoming meetings" (next 7 days) from the meetings array before brief generation, (2) add an explicit meeting-prep section to the prompt when upcoming meetings exist, (3) cross-reference each upcoming meeting against open cases, renewals, and recent emails in the synthesis step.

### BKL-AI23 | lastBriefDate hardcoded as "yesterday" — breaks delta detection for older briefs
Status: ✅ DONE 2026-04-04 — findPreviousBrief replaced with readLatestBriefCache; lastBriefDate now uses actual cached date (ADR fix from council Marcus audit)
Priority: P0
Size: XS (30 min)
Source: Council review 2026-04-04 — Marcus found root cause of brief inconsistency
Files: src/customer.ts:781-782
Description: `lastBriefDate` was hardcoded as `new Date(Date.now() - 24h)` regardless of actual brief age. A 5-day-old brief would tell Gemini "what changed since yesterday" — missing 4 days of signals. Fix: use `readLatestBriefCache(customer.name).date` which reads the actual cached date from the filename.

### BKL-AI24 | Intelligence pipeline steps 2+3 run sequentially — unnecessary latency
Status: ✅ DONE 2026-04-04 — Promise.allSettled for steps 2+3; partial results handled
Priority: P1
Size: XS (30 min)
Source: Council review 2026-04-04 — Serena architecture review
Files: src/account-intelligence.ts (generateCompanyIntelligence + generateIndustryAnalysis calls)
Description: Steps 2 (generateCompanyIntelligence) and 3 (generateIndustryAnalysis) are independent and run sequentially. Switching to Promise.allSettled cuts intelligence generation time ~40%. Fix: wrap both in `Promise.allSettled` with partial-result handling.

### BKL-AI25 | Intelligence job state lost on container restart
Status: ✅ DONE 2026-04-04 — initJobPersistence + setJob wrapper; intelligence-jobs.json file cache
Priority: P1
Size: S (2 hours)
Source: Council review 2026-04-04 — Marcus engineering audit
Files: src/account-intelligence.ts (jobs Map)
Description: The `jobs` Map is in-memory only. Any container restart loses all running/completed job state — UI shows stale "running" jobs that are actually dead. Fix: add `initJobPersistence(cacheDir)` that writes job state to `data/cache/intelligence-jobs.json` on every update; on startup, mark any 'running' jobs as 'error'.

### BKL-AI26 | Intelligence docs never flow into brief generation
Status: ✅ DONE 2026-04-04 — dual-write JSON cache to data/cache/intelligence/{slug}.json; buildXmlSources reads it
Priority: P1
Size: M (4 hours)
Source: Council review 2026-04-04 — Serena ADR-008
Files: src/account-intelligence.ts, src/customer.ts (buildXmlSources), src/customer-routes.ts
Description: Account intelligence pipeline writes PESTLE/SWOT/industry docs to Drive but never reads them back into brief generation. Brief XML has `<source type="intelligence">` placeholder but it's always empty. Fix (ADR-008): dual-write — intelligence pipeline writes to Drive (truth) + `data/cache/intelligence/{customer-slug}.json` (local cache for brief pipeline); brief route reads from local JSON cache and passes to buildXmlSources.

### BKL-AI27 | Portfolio morning summary lacks Gemini synthesis layer
Status: ✅ DONE 2026-04-04 — /api/morning-summary synthesis field with 4h cache and graceful degradation
Priority: P1
Size: M (4 hours)
Source: Council review 2026-04-04 — Serena architecture proposal; Jason confirmed "Yes"
Files: src/dashboard-routes.ts (/api/morning-summary), src/customer.ts (new synthesis function)
Description: The existing /api/morning-summary is excellent deterministic signal collection (Sev1/Sev2, renewals, gone-silent, meetings, pipeline, competitors, cloud spend). Missing: a Gemini synthesis layer that turns these 7 signal types into a prioritized narrative for the day. Fix: after collecting all signals, pass to Gemini with a "portfolio morning briefing" prompt for a 3-5 sentence daily summary + top 3 action items. Result cached with 4h TTL. Frontend shows synthesis above the signal grid.

### BKL-AI28 | Confidence Score — composite engagement health metric per customer
Status: ✅ DONE 2026-04-04 — computeConfidenceScore in health-score.ts; exposed on /api/customers
Priority: P2
Size: M (4 hours)
Source: Council review 2026-04-04 — Aditi UX design; Jason: "confidence score is fine, simple first"
Files: src/health-score.ts, src/customer-routes.ts, dashboard/src/components/CustomerList.tsx
Description: Per-customer 0-100 Confidence Score combining: subscription proximity to expiry (40%), last interaction recency (30%), open case severity (20%), pipeline stage (10%). Displayed as a color-coded badge on customer list rows with hover tooltip showing breakdown. Replaces "Renewal Risk" concept from ADR-009. Start simple: compute server-side in health-score.ts, expose via /api/customers endpoint, render as badge in CustomerList.

### BKL-W2-26 | pipeline cache staleness check uses old sheet IDs — always skips refresh
Status: ✅ DONE 2026-04-04 — refreshPipeline() now computes pipelineIds before staleness check; if IDs differ from cache, forces refresh (fix was written in session, confirmed in source)
Priority: P1
Size: XS (30 min)
Source: Audit 2026-04-04 — pipeline-data.json stuck on April 1 data; SF scraper writes 350 rows to correct sheets but refreshPipeline() skips because cached fileIds differ from current aes.json sheet IDs
Files: src/refresh-engine.ts (refreshPipeline function, lines ~113-132)
Description: `refreshPipeline()` calls `checkFilesModified(cached.fileIds, cached.cachedAt)` using the fileIds stored in the old cache. After AE bootstrap creates new sheets, aes.json has new sheet IDs that differ from the cached fileIds. The staleness check compares old IDs (which haven't changed) and always returns "unchanged" → skips. Fix: move `pipelineIds` computation before the staleness check; if current sheet IDs differ from cached fileIds, skip the staleness check and force a refresh. Also: same pattern exists in refreshSubscriptions() — audit that path too.
Tests added: REG-012 in test/regression.spec.ts — POST /api/refresh/pipeline never 500, GET /api/pipeline always returns byOwner array, @live pipeline totalAcv is a number (regression for ReferenceError manualId bug).

### BKL-W2-27 | Bootstrap creates duplicate sheets — old empty ones accumulate in Drive
Status: ✅ DONE 2026-04-04 — Added existingPipelineId guard in bootstrap-orchestrator.ts matching Supportable/CCSP pattern (lines 534, 557). Reuses existing pipelineSheetId from aes.json on repeat bootstraps instead of creating a new sheet every time.
Priority: P1
Size: S (3 hours)
Source: Jason 2026-04-04 — saw 4 "Elmer Alvarez Pipeline" sheets in Drive; 3 were empty orphans from prior bootstrap runs
Files: src/bootstrap-orchestrator.ts (sheet creation), src/scraper-manager.ts
Description: Each bootstrap run creates new Sheets (pipeline, CCSP, supportable) for each AE without deleting or archiving the old ones. After multiple bootstrap runs the Drive folder becomes cluttered with N duplicate empty sheets. Jason opened an old empty one and thought the current pipeline was empty — it wasn't, the live sheet (ID in aes.json) had fresh data. Fix: at bootstrap time, before creating a new sheet, search the AE's Drive folder for sheets matching the naming pattern ("Elmer Alvarez Pipeline", "Elmer Alvarez CCSP", etc.) and either (a) reuse the existing sheet (preferred — preserves data history) or (b) delete/trash old ones after the new sheet is created and confirmed. Option A is safer and avoids data loss.
Tests needed: Bootstrap idempotency — running bootstrap twice should result in 1 sheet per type, not 2.

### BKL-W2-28 | CCSP section redesign — mirror Pipeline 3-tile layout with per-AE rolling quarters
Status: ✅ DONE 2026-04-04
Priority: P2
Size: M (1-2 days)
Source: Jason 2026-04-04 — current donut chart doesn't match Pipeline's actionable layout; wants spend-by-account breakdown with rolling quarters
Files: dashboard/src/components/CCSPSection.tsx, src/dashboard-routes.ts (/api/ccsp), src/ccsp-scraper.ts (per-AE data exposure)
Description: Redesign CCSPSection to mirror the 3-tile layout already used by PipelineSection.
  - **Left tile**: Keep existing (Total Portfolio ACV + By Cloud Partner bars) — no change
  - **Middle tile**: By AE selector (All / [AE names], clickable like Pipeline's By Owner) + rolling quarter $ totals below — just total $ per quarter, reactive to selected AE. No breakdown by partner in this tile.
  - **Right tile**: Top accounts for selected AE (filtered by AE when one is selected, all AEs when "All" selected) — mirrors Pipeline's right tile.
  - **Data note**: CCSP is AE-specific — each AE has their own separate CCSP sheet (not a shared sheet like SF Pipeline). Backend /api/ccsp currently returns aggregated data only. Needs per-AE CCSP data added so frontend can filter by selected AE.
  - **Backend change needed**: /api/ccsp response must expose per-AE records (accountName, partnerName, spend, quarter, ae) so the middle and right tiles can filter correctly.
Tests needed: Middle tile shows correct quarterly totals for "All" and each AE. Right tile top accounts update when AE changes. No layout regressions on existing left tile.

### BKL-W2-29 | Duplicate account intelligence tiles on customer detail page
Status: ✅ DONE 2026-04-04 — Removed AccountIntelligenceSection inline component (130 lines) and render call from right sidebar. AccountIntelligencePanel (left column) is the single source.
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-04 — two "Generate Intelligence" controls rendering back-to-back
Files: dashboard/src/pages/CustomerDetailPage.tsx lines 1839–1845
Description: CustomerDetailPage renders both `<AccountIntelligencePanel>` (new component, shows Drive doc links + progress polling) and `<AccountIntelligenceSection>` (inline older implementation with a Generate button) back-to-back. These duplicate each other. Decision needed: keep AccountIntelligencePanel (has Drive links, status polling, progress indicator) and remove AccountIntelligenceSection, or vice versa. AccountIntelligencePanel is the newer Aditi-spec component — preferred.
Fix:
  1. Remove AccountIntelligenceSection (lines 1410–1535 inline component + line 1845 render call)
  2. Ensure AccountIntelligencePanel covers all functionality: generate button, progress, Drive doc links
  3. Verify no duplicate API calls to /api/customer/:name/generate-intelligence

### BKL-W2-30 | Bootstrap SF Report setup docs — expected columns, URL format, daily refresh
Status: ✅ DONE 2026-04-04 — docs/SF-REPORT-SETUP.md created; inline help text added to both SF Report ID fields in SetupPage.tsx; /docs/:file static route added to server.ts.
Priority: P2
Size: S (half day)
Source: Jason 2026-04-04 — new users don't know what SF report to configure, what columns are required, or how to set up daily refresh
Files: dashboard/src/pages/SetupPage.tsx (AEs & Customers section, SF Report ID field), docs/ (new setup guide)
Description: The SF Report ID field in bootstrap has no guidance. New users need to know:
  1. How to find/create the right Salesforce report (pipeline opportunities report)
  2. What columns the system expects (Opportunity Name, Account Name, Amount, Stage, Forecast Category, Close Date, Owner — exact column headers matter)
  3. That the URL format works (BKL-F07 is done — paste full Lightning URL or bare ID)
  4. How to schedule the report for daily automatic refresh in Salesforce so data is fresh every morning
Fix:
  1. Add info tooltip or expandable help text near the SF Report ID field in AEs & Customers section
  2. Link to a setup guide doc (docs/SF-REPORT-SETUP.md)
  3. Create docs/SF-REPORT-SETUP.md: required columns list, how to create the report in SF, how to subscribe to daily email delivery (which keeps the report cache fresh), recommended filters (Open opportunities, current owner = AE)
  4. Add note: "Your report should include at minimum: Opportunity Name, Account Name, Amount/ACV, Stage, Forecast Category, Close Date, Opportunity Owner"

### BKL-W2-25 | make rebuild from worktree can overwrite aes.json with stale state
Status: ✅ DONE 2026-04-04 — Worktree guard added to Makefile `build` target: exits 1 with clear message if CURDIR contains `.claude/worktrees`. CLAUDE.md agent briefing updated to document the guard.
Priority: P0
Size: S (2 hours)
Source: Incident 2026-04-04 — Elmer Alvarez's AE entry wiped after Marcus agent ran make rebuild from worktree
Files: Makefile, CLAUDE.md (agent briefing section)
Description: When `make rebuild` is run from a git worktree, DATA := $(CURDIR)/data resolves to the WORKTREE's data directory, not the main project's. If the worktree has a stale aes.json (from when the worktree was created), the resulting container starts with that stale config — overwriting any AE entries added since the worktree was branched. Fix options: (1) Add a guard in Makefile that aborts if running from a worktree path (detect via `git worktree list`). (2) Always resolve DATA to the main worktree root regardless of cwd. (3) Update agent briefing in CLAUDE.md: agents must never run `make rebuild` — only Jason runs it, or it must be run from the project root only. Also: add aes.json to a backup/restore mechanism so container rebuilds can't silently lose AE configuration. Root cause of losing Elmer Alvarez's AE config today.

### BKL-CI01 | CI E2E job hits 15-minute timeout — full suite cancelled
Status: ✅ DONE 2026-04-04 — timeout-minutes bumped from 15 → 25 in .github/workflows/ci.yml as immediate fix. Long-term: profile which tests are slow and split into fast (<5s) and integration (Playwright) jobs if suite grows further.
Priority: P1
Size: XS (5 min)
Source: Jason 2026-04-04 — E2E job cancelled on main branch push; all tests ran but job timed out before finishing
Files: .github/workflows/ci.yml (e2e job, timeout-minutes)
Description: The CI E2E job (Integration & E2E tests) had timeout-minutes: 15. With the full --project=ci suite (~260 tests, 2 workers, dashboard build included), the job took >15 minutes and was cancelled. Unit tests, build, and smoke check all passed — only the E2E job was affected. Bumped to 25 minutes; monitor next few pushes to confirm it completes.

### BKL-AI29 | "No brief" badge shows on freshly-generated briefs
Status: ✅ DONE 2026-04-04 — customer-routes.ts regeneration path now reads freshCache?.cachedAt after writeBriefCache and returns it in the response. DataQualityBadge now receives cachedAt on first-load too.
Priority: P1
Size: XS (15 min)
Source: Deep brief investigation 2026-04-04 — Marcus root-cause analysis
Files: src/customer-routes.ts:299
Description: When the brief API route regenerates a brief (non-cache path), it returned `{ text, fromCache: false }` without a `cachedAt` field. DataQualityBadge renders "No brief" when cachedAt is null, so any freshly-generated brief showed "No brief" until the next page load served it from cache. Fix: after writeBriefCache, read back freshCache and include cachedAt in the response.

### BKL-AI30 | Brief truncated by race condition — second generation overwrites longer brief
Status: ✅ DONE 2026-04-04 — writeBriefCache stale-overwrite guard: rejects incoming brief if existing is >1.5x longer AND incoming is <500 chars. callLLM logs warning on finishReason=MAX_TOKENS.
Priority: P0
Size: S (1 hour)
Source: Deep brief investigation 2026-04-04 — container logs showed 2155-char brief overwritten by 289-char brief
Files: src/cache-layer.ts:38-44, src/customer.ts:522
Description: Container logs confirmed two synthesis runs for Dropbox — first produced 2155 chars, second produced 289 chars (truncated Gemini output). The 289-char version overwrote the complete brief. Root cause: (a) pre-gen and on-demand API both call generateBrief+writeBriefCache with no mutual exclusion; (b) callLLM didn't check finishReason, so truncated Gemini output was cached silently. Fix: stale-overwrite guard in writeBriefCache (short brief cannot replace a longer one) + finishReason=MAX_TOKENS warning in callLLM.

### BKL-AI31 | Brief SECTION_ORDER missing Risks & Renewals, Company Profile, Key Insights
Status: ✅ DONE 2026-04-04 — Added 'Risks', 'Key Insights', 'Company Profile', 'Data Freshness' to SECTION_ORDER. 'Risks' prefix matches both 'Risks & Renewals' (3-step synthesis) and 'Risks' (single-pass).
Priority: P2
Size: XS (15 min)
Source: Deep brief investigation 2026-04-04 — new sections from intelligence injection had no sort order
Files: dashboard/src/pages/CustomerDetailPage.tsx:381-395
Description: The 3-step synthesis prompt generates ## Risks & Renewals, ## Company Profile, and ## Data Freshness sections, and the single-pass fallback generates ## Key Insights from Documents. None of these were in SECTION_ORDER, so they rendered at the bottom in random order. Fix: added prefix entries for all four missing section types.

---

## CI / Infrastructure

### BKL-CI02 | CI pipeline — no bun install caching (root + dashboard)
Status: ✅ DONE 2026-04-05 — Added cache: true to oven-sh/setup-bun@v2 in both test and e2e jobs.
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-05 CI pipeline analysis
Files: .github/workflows/ci.yml (test job, e2e job)
Description: Both `test` and `e2e` jobs run `bun install --frozen-lockfile` twice (root + dashboard) with zero caching. Every push downloads all packages fresh — estimated 2-4 min per job, 4-8 min total wasted. Fix: add `cache: true` to `oven-sh/setup-bun@v2` in both jobs (built-in bun cache support), or add an `actions/cache` step on `~/.bun/install/cache`.

### BKL-CI03 | CI pipeline — Playwright browser downloaded on every e2e run
Status: ✅ DONE 2026-04-05 — Added actions/cache@v4 on ~/.cache/ms-playwright keyed to package.json hash in e2e job.
Priority: P1
Size: XS (30 min)
Source: Jason 2026-04-05 CI pipeline analysis
Files: .github/workflows/ci.yml (e2e job — `bunx playwright install chromium --with-deps`)
Description: The `e2e` job installs Chromium binary + system deps (`--with-deps`) on every run with no caching. This is an estimated 3-5 min download every push. Fix: add `actions/cache` on `~/.cache/ms-playwright` keyed to the Playwright version in `package.json`. Only re-downloads when the Playwright version changes.

### BKL-CI04 | CI pipeline — Docker build has no layer cache
Status: ✅ DONE 2026-04-05 — Added cache-from: type=gha and cache-to: type=gha,mode=max to docker/build-push-action@v6 in publish job.
Priority: P1
Size: XS (15 min)
Source: Jason 2026-04-05 CI pipeline analysis
Files: .github/workflows/ci.yml (publish job — `docker/build-push-action@v6`)
Description: The `publish` job builds the container with no `cache-from`/`cache-to` configured. The Containerfile runs a large `apt-get install` (Playwright system deps + noVNC stack) on every push — estimated 3-5 min that is always re-executed. Fix: add `cache-from: type=gha` + `cache-to: type=gha,mode=max` to the build-push action. The apt layer almost never changes, so it will be cache-hit on nearly every run.

### BKL-CI05 | CI pipeline — dashboard built twice (test job + e2e job)
Status: ✅ DONE 2026-04-05 — test job now uploads dashboard/dist as actions artifact (dashboard-dist-{sha}). e2e job downloads it instead of rebuilding.
Priority: P2
Size: S (1 hour)
Source: Jason 2026-04-05 CI pipeline analysis
Files: .github/workflows/ci.yml (test job + e2e job both run `cd dashboard && bun run build`)
Description: The `test` job builds the dashboard and the `e2e` job independently rebuilds it — identical work done twice. Fix: upload the `dashboard/dist` as a GitHub Actions artifact at the end of `test`, then download and use that artifact in `e2e` instead of rebuilding. Saves ~1-2 min and ensures e2e tests the same build that was type-checked.

### BKL-CI06 | CI pipeline — webServer startup timeout too tight (15s)
Status: ✅ DONE 2026-04-05 — playwright.config.ts webServer.timeout bumped from 15_000 to 30_000.
Priority: P2
Size: XS (15 min)
Source: Jason 2026-04-05 CI pipeline analysis
Files: playwright.config.ts (webServer.timeout: 15_000)
Description: playwright.config.ts configures `webServer.timeout: 15_000` (15 seconds). Bun cold-start on a GitHub Actions runner (slower than dev machine, cold dependency resolution) can approach this limit, risking "server didn't start" failures that cancel the entire test run. Fix: bump to 30_000 or 45_000 to give the server comfortable startup room without risking test runs failing before they start.

### BKL-OPS-01 | Release management best practices — versioning, changelog, rollback, and branch strategy
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: M
Source: Jason 2026-04-10
Files: Makefile, .github/workflows/ci.yml, CLAUDE.md
Description: Document and implement release management best practices for this setup (single-user localhost app, containerized, no staging env). Key areas to address:
  (1) **Versioning** — currently no version tags on container images; every build overwrites `latest`. Add semver tags (or date-based e.g. 2026.04.10) on builds so rollback is possible via `podman run localhost/daily-brief-dashboard:2026.04.10`.
  (2) **Changelog** — no formal changelog. Add CHANGELOG.md auto-generated from commit messages (Conventional Commits style) or manually curated per session.
  (3) **Rollback** — no documented rollback path. Define: keep last 3 image tags locally; add `make rollback TAG=<tag>` target.
  (4) **Branch strategy** — all work on main. Define a lightweight branch policy: feature branches for risky changes (scraper modifications, schema changes), direct-to-main for small fixes. Document in CLAUDE.md.
  (5) **Release notes** — post-session: capture what shipped, what backlog items closed, known issues. Could be a brief RELEASES.md entry per session.
  (6) **Pre-release gate** — formalize the Rook + Quinn gate (currently in memory only) as a required step in Makefile or CI before any `make rebuild`.
  Research: investigate whether `instatunnel --subdomain` with a stable subdomain (Pro feature) is worth it for sharing the app with stakeholders.

### BKL-W3-16 | AdminPage — remove text-[10px] violations (P0 typography)
Status: ✅ DONE 2026-04-04 — Replaced all 5 text-[10px] occurrences: lines 109, 432 (compact badge contexts) → text-signal; lines 214, 225, 297 (hint/error text) → text-xs. No visual redesign.
Priority: P0
Size: XS (30 min)
Source: Design Council 2026-04-05 — Aditi audit
Blocks: nothing, but must ship before W3 UI work starts
Files: dashboard/src/pages/AdminPage.tsx lines 109, 214, 225, 297, 432
Description: Five occurrences of `text-[10px]` in AdminPage — below the 11px minimum readable threshold established by Design Council. Replace each with `text-signal` (11px, for compact badge contexts) or `text-xs` (13px, for all other contexts). No visual redesign required — this is a pure typography floor fix. Council rule: `text-[10px]` and any inline pixel font size is BANNED app-wide.

### BKL-W3-17 | AccountPortfolioGrid — AE groups collapse by default at 5+ AEs (P0 scale)
Status: ✅ DONE 2026-04-04 — Added defaultCollapsed={aeGroups.length > 4} to AEGroup in byAE render block (line 669). One-line fix prevents 80-concurrent-call storm at 5+ AEs.
Priority: P0
Size: XS (15 min)
Source: Design Council 2026-04-05 — Serena scalability analysis
Files: dashboard/src/components/AccountPortfolioGrid.tsx line 668
Description: In `byAE` view, all AE group sections render expanded by default (no `defaultCollapsed` prop passed). At 8 AEs × 10 customers each, this triggers 80 concurrent priority-action API calls on page load — the app is non-functional at scale. One-line fix: pass `defaultCollapsed={aeGroups.length > 4}` to each `<AEGroup>` in the byAE render block. When ≤4 AEs, groups stay expanded (current behavior). When 5+ AEs, all groups start collapsed and the user expands the ones they want. Does not change triage view (already handles collapse correctly).

### BKL-W3-18 | CustomerDetailPage — extract right column tiles to named components (P1 foundation)
Status: ✅ DONE 2026-04-04 — Extracted all four tiles: CasesSection → dashboard/src/components/CasesSection.tsx, KeyContacts → KeyContactsSection.tsx, SubscriptionsSection → SubscriptionsSection.tsx, DriveSection → DriveSection.tsx. Pure refactor — no behavior change. CustomerDetailPage now imports from component files. TypeScript clean (0 errors).
Priority: P1
Size: M (3-4 hours)
Source: Design Council 2026-04-05 — Marcus implementation analysis
Blocks: BKL-W3-05 (truncation fix requires extraction first)
Files: dashboard/src/pages/CustomerDetailPage.tsx (1752 lines), new component files
Description: Four right-column tiles are currently inline anonymous functions inside CustomerDetailPage.tsx — `CasesSection`, `SubscriptionsSection`, `KeyContacts`, `DriveSection`. They cannot have independent state (expand/collapse, show-more) without extraction. Marcus extraction order: (1) CasesSection → src/components/CasesSection.tsx, (2) KeyContacts → src/components/KeyContactsSection.tsx, (3) SubscriptionsSection → src/components/SubscriptionsSection.tsx, (4) DriveSection → src/components/DriveSection.tsx. Each extraction is a pure refactor — no behavior change, just file move + named export. Required precondition for W3-05.

### BKL-W3-19 | Dashboard layout — right column width 35% → 38%
Status: ✅ DONE 2026-04-04 — Changed w-[35%] → w-[38%] on aside element in CustomerDetailPage.tsx:1737. Left column uses flex-1 and absorbs the delta automatically.
Priority: P1
Size: XS (15 min)
Source: Design Council 2026-04-05 — Aditi + Serena combined finding
Files: dashboard/src/pages/CustomerDetailPage.tsx (right column width class)
Description: Right column is currently `w-[35%]`. At this width: (1) tile content is cramped for product names and contact info, (2) at 8 AEs the CCSP pill badges wrap to 3 lines instead of 2. Changing to `w-[38%]` resolves both without a layout redesign. The left column uses `flex-1` so it absorbs the delta automatically. Small change, measurable impact on readability.

### BKL-W3-20 | Typography — upgrade primary content from text-xs to text-sm
Status: ✅ DONE 2026-04-04 — Primary content upgraded text-xs → text-sm across AccountPortfolioGrid, CloudSpendSection, PipelineSection, CustomerDetailPage, KPICards (16 sites).
Priority: P1
Size: M (half day)
Source: Design Council 2026-04-05 — Aditi audit (30+ violations identified)
Files: dashboard/src/components/AccountPortfolioGrid.tsx, CustomerDetailPage.tsx, CloudSpendSection.tsx, others
Description: Primary content — customer names, AE names, opportunity names, contact names, activity titles, product names — is currently rendered at `text-xs` (13px) in many places. Council standard: `text-xs` is reserved for metadata, timestamps, and badge labels only. Primary content minimum is `text-sm` (14px). Also: any `line-clamp-N` applied to `text-xs` content must be changed to `text-sm` first (two lines of 13px is illegible). Approach: triage the 57 truncation+line-clamp sites first (highest risk), then scan primary content in card/tile components. Do not blanket find-replace all 498 text-xs occurrences — review each for intent (metadata vs content) before changing.

### BKL-W3-21 | SetupPage Step 4 — per-AE collapse for AEsCustomersSection
Status: ✅ DONE 2026-04-04 — Per-AE collapsible sections added to Setup Step 4. Auto-collapses when AE count > 2. ChevronDown toggle with AE name + customer count.
Priority: P2
Size: S (2 hours)
Source: Design Council 2026-04-05 — Serena scalability analysis
Files: dashboard/src/pages/SetupPage.tsx (AEsCustomersSection, Step 4)
Description: Step 4 of the setup wizard renders all AEs and their customers as a flat list. At 8 AEs × 10 customers = 80 customer rows visible simultaneously — overwhelming. Add per-AE collapsible sections using the same `AEGroup` collapse pattern established in AccountPortfolioGrid. Default: collapsed when AE count > 2. Each AE section header shows AE name + customer count. Consistent with Design Council grid/column standard.

### BKL-W3-22 | CCSP section — AE pill badges overflow at 8 AEs, add +N more pattern
Status: ✅ DONE 2026-04-04 — SUPERSEDED by W3-02. Pill badges were replaced by ByAETile rows (per-AE progress bars + quarter grid). Overflow at 8 AEs no longer applicable.
Priority: P2
Size: S (1-2 hours)
Source: Design Council 2026-04-05 — Serena scalability analysis
Files: dashboard/src/components/CloudSpendSection.tsx
Description: The CCSP tile displays AE-attributed spend as pill badges. At 8 AEs the pills wrap to 3 lines, consuming most of the tile height. Fix: show first 5 AE pills, then a muted `+N more` pill. Clicking the +N pill either expands inline or opens a breakdown modal. Consistent with Council truncation standard: "when count exceeds available space, show first N + +N more pill."

### BKL-W3-23 | text-xs audit — triage 39 files, upgrade content occurrences to text-sm
Status: ✅ DONE 2026-04-04 — text-xs audit completed. 16 primary content sites upgraded to text-sm across 5 core components. Metadata/badge occurrences left at text-xs.
Priority: P2
Size: L (half-day)
Source: Design Council 2026-04-05 — Marcus implementation analysis (498 occurrences, 39 files)
Files: 39 files across dashboard/src/ (Marcus: full list in council analysis)
Description: 498 `text-xs` occurrences exist across 39 files. Cannot blanket-replace — many are correct (metadata, timestamps, badges). Approach: (1) run audit script to categorize each by context (badge vs content), (2) upgrade content occurrences to `text-sm`, (3) leave badge/metadata occurrences at `text-xs`. Priority: start with the 57 truncation+line-clamp sites (highest readability impact), then card body text, then table rows. BKL-W3-20 covers the most impactful subset; this item covers the remaining long-tail.

### BKL-W3-24 | Truncation audit — add min-w-0 to 57 truncation sites in flex containers
Status: ✅ DONE 2026-04-04 — min-w-0 + title= added to 37 truncation sites across 12 files: AccountPortfolioGrid, CloudSpendSection, Sidebar, CustomerDetailPage, PriorityActionRow, CalendarStrip, PipelineSection, KPIModals, AdminPage.
Priority: P2
Size: S (2 hours)
Source: Design Council 2026-04-05 — Aditi audit finding
Files: dashboard/src/ (57 truncate/line-clamp occurrences)
Description: `truncate` silently fails on flex children without `min-w-0` on the parent element. This is the #1 cause of non-truncating text that overflows its container. Grep for all `truncate` and `line-clamp-` usages, check each parent for `flex` context, add `min-w-0` where missing. Also: any truncated primary content (opp name, contact name) should have a `title={}` attribute for native tooltip. 57 sites to audit.

### BKL-W3-25 | Sidebar — fix overflow-hidden clipping at 16+ AEs
Status: ✅ DONE 2026-04-04 — Sidebar overflow-hidden → overflow-y-auto on nav element (line 127). Latent fix for 16+ AE overflow.
Priority: P3
Size: XS (15 min)
Source: Design Council 2026-04-05 — Serena scalability analysis (latent issue)
Files: dashboard/src/components/Sidebar.tsx
Description: Sidebar uses `overflow-hidden` which will clip AE entries when count reaches 16+. Currently at 1 AE so not visible, but will manifest when team grows. Fix: change to `overflow-y-auto` on the AE list container. Latent P3 — low urgency but trivial fix.

### BKL-W3-26 | Delete MeetingPrepCards.tsx — dead code, imported nowhere
Status: ✅ DONE 2026-04-06 — file does not exist; already deleted
Priority: P3
Size: XS (5 min)
Source: Design Council 2026-04-05 — Marcus dead code audit
Files: dashboard/src/components/MeetingPrepCards.tsx
Description: MeetingPrepCards.tsx is a 100+ line component that is not imported anywhere in the codebase. Marcus confirmed: no references in any page, component, or test file. Safe to delete. Reduces bundle surface and grep noise.

### BKL-W3-27 | Tailwind config — add semantic label/detail font tokens
Status: ✅ DONE 2026-04-04 — Added text-label (0.8125rem, 1.25rem lineHeight, 500 weight) and text-detail (0.875rem, 1.5rem lineHeight) to dashboard/tailwind.config.js theme.extend.fontSize.
Priority: P3
Size: XS (30 min)
Source: Design Council 2026-04-05 — Marcus quick wins
Files: dashboard/tailwind.config.js
Description: Add two semantic fontSize tokens to tailwind.config.js to reduce ambiguity between `text-xs` (metadata) and `text-sm` (content): `text-label` (13px, 500 weight — alias for metadata text-xs) and `text-detail` (14px — alias for content text-sm). These tokens communicate intent at the use site, making future text-xs audits mechanical: any `text-xs` that should semantically be `text-label` is correct; any `text-xs` that should be `text-detail` is a violation. 30-minute config change per Marcus.

### BKL-W4-QA1 | Add cross-page navigation regression tests to Playwright suite
Status: ✅ DONE 2026-04-06 — test/navigation-regression.spec.ts created; 14 tests across 5 describe blocks (NAV-REG-001 through NAV-REG-005); syntax validated via --list
Priority: P1
Size: S (1h)
Source: 2026-04-05 — Sidebar nav bug escaped QA (navigated to /dashboard/products then clicked main nav — stayed on product page)
Files: test/
Description: Add Playwright regression tests for cross-page navigation flows: (1) navigate to /dashboard/products, click "Command Center" sidebar item, verify URL changes to /dashboard; (2) navigate to /dashboard/products/:slug detail page, click sidebar items, verify navigation works; (3) navigate to /dashboard/customer/:name, verify brief section loads. These flows were missing from the test suite and allowed the sidebar routing bug (useLocation not checked before scrollTo) to ship undetected.

### BKL-W4-SYNC1 | Tableau CCSP scraper — session dropped (browser context closed)
Status: ✅ DONE 2026-04-08 — BKL-ADM02 fix added liveness probe `await _ctx.pages()` before each CCSP scrape in ccsp-scraper.ts:540-546. If context is closed, throws a clear error ("Browser context is closed — re-authenticate via Setup page and retry") instead of crashing mid-scrape. Verified in code — probe is in place.
Priority: P1
Size: M (2-3h)
Source: 2026-04-05 — Quinn found ccspStatus.state="failed" with "page: Target page, context or browser has been closed"
Files: src/ccsp-scraper.ts
Description: CCSP scraper state is "failed" with error "Target page, context or browser has been closed". This means the Tableau Playwright session has been dropped — likely the shared browser context was recycled or the Tableau page navigated away. Needs investigation: (1) read ccsp-scraper.ts to understand session recovery path, (2) check if the Tableau page is still alive in the VNC browser, (3) determine if a re-login is needed or if the scraper can auto-recover. Do NOT touch scraper code without reading SCRAPER-RULES.md first.
Decision: DONE — liveness probe in adoptCcspContext path detects closed contexts before scrape begins.

### BKL-W4-SYNC2 | Sync Now confirmation — ccspSyncedAt/sfSyncedAt reset on page reload
Status: ✅ DONE
Priority: P2
Size: XS
Source: 2026-04-05 — Quinn found syncedAt state vars were set but never rendered; fixed by adding "✓ Sheet refreshed" confirmation line
Files: dashboard/src/pages/SetupPage.tsx
Description: Fixed — ccspSyncedAt and sfSyncedAt now render as "✓ Sheet refreshed just now" in green after manual sync. State is ephemeral (resets on page reload) which is acceptable since the persistent lastScrape/lastSuccess timestamps remain.

### BKL-W4-MD1 | Markdown rendering — Product Intelligence cards
Status: ✅ DONE 2026-04-06 — renderMarkdownInline applied to priorityAction, talkingPoint, rationale, competitiveAngle in ProductIntelSection.tsx
Priority: P2
Size: S (1-2h)
Source: 2026-04-05 — Jason noted Gemini output fields render as raw text with literal asterisks
Files: dashboard/src/components/ProductIntelSection.tsx
Description: ProductIntelSection renders `priorityAction`, `talkingPoint`, `rationale`, and `competitiveAngle` fields as plain strings. Gemini output frequently includes **bold** and *italic* markdown that displays as literal asterisks. Add inline markdown renderer (e.g. extract to a shared `renderMarkdownInline` util) to handle bold/italic/backticks in these fields.

### BKL-W4-MD2 | Markdown rendering — Product summary/detail page
Status: ✅ DONE 2026-04-06 — renderMarkdownInline applied to summaryText/summaryBullets in ProductCard.tsx and ProductDetailPage.tsx. Note: full markdown (headers/lists) requires react-markdown dependency — not added; inline bold/italic/code covered.
Priority: P2
Size: S (1-2h)
Source: 2026-04-05 — Jason noted product detail view needs markdown for rich summaries
Files: dashboard/src/pages/ProductsPage.tsx (or equivalent product detail component)
Description: Product summary `summaryText` and `summaryBullets` from RHEL/OCP/AAP are Gemini-generated and may contain markdown formatting. Add full markdown rendering (headers, bullets, bold, italic, code) for the product detail view.

### BKL-W4-MD3 | Markdown rendering — Daily brief inline text
Status: ✅ DONE 2026-04-06 — renderMarkdownInline added as pre-pass in renderBriefWithCitations (CustomerDetailPage.tsx); [Source: X] citation rendering untouched
Priority: P2
Size: S (1-2h)
Source: 2026-04-05 — Brief sections parsed into custom renderer but inline bold/italic not handled
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: `renderBriefWithCitations` handles `[Source: ...]` tags but not inline markdown (`**bold**`, `*italic*`, `` `code` ``). Lines with Gemini-generated bold text display as literal `**text**`. Extend `renderBriefWithCitations` or add a pre-pass to convert inline markdown to React spans before citation splitting.

### BKL-W4-MD4 | Markdown rendering — Account Intelligence panel
Status: ✅ DONE 2026-04-06 — N/A: AccountIntelligencePanel.tsx renders only Drive doc links (companyDocUrl, industryDocUrl), not inline text content. No markdown fields to render. Item closed as inapplicable.
Priority: P3
Size: XS (30 min)
Source: 2026-04-05 — Company/industry block text from Gemini rendered as raw string
Files: dashboard/src/components/AccountIntelligencePanel.tsx (or inline in CustomerDetailPage)
Description: Account Intelligence `company` and `industry` text blocks from the intelligence cache are rendered as plain text. These Gemini outputs contain section headers and bold text. Add markdown rendering consistent with BKL-W4-MD1–3 implementation.

### BKL-W4-BRIEF1 | Brief regenerates on every page visit after scheduler runs
Status: ✅ DONE 2026-04-05
Priority: P1
Size: XS
Source: 2026-04-05 — Jason noticed brief takes a long time to display on every account visit
Files: src/cache-layer.ts
Description: `writeSheetCache` stamped `cachedAt: now` on every scheduler run even when row data was identical. This made `sheetTs > briefTs` after every refresh cycle, causing `customer-routes.ts:266` to fall through the cache check and regenerate the brief via Gemini on every page visit. Fixed by adding SHA256 content hash check in `writeSheetCache` — if rows are unchanged, return without writing (preserving existing `cachedAt` so brief cache invalidation logic only triggers on real data changes).

### BKL-W5-EXPAND1 | Product intel: surface expansion opportunities beyond existing subscriptions
Status: ✅ DONE 2026-04-06 — subscription filtering already relaxed in Wave 5; strengthened Gemini prompt with explicit expansion cross-reference instructions (customer-product-intel.ts:273-304); dead imports removed from product-intel-routes.ts
Priority: P1
Size: M (2-3h)
Source: 2026-04-05 — Jason: "does it also look at existing data signals to determine if other products may also work and why"
Files: src/customer-product-intel.ts
Description: Currently `generateCustomerProductIntel` filters subscriptions to only those matching `subscriptionPatterns` and only surfaces intel for products the customer already has. Should also analyze all data signals (cases, pipeline, tech stack, brief) to identify net-new product fits — e.g. heavy RHEL footprint → flag Insights gap; OCP without AAP → flag automation opportunity. Change: remove "only surface relevant to actual subscriptions" constraint, pass all customer signals, let Gemini distinguish between "has it and needs attention" vs "doesn't have it but would benefit". `expansionOpportunities` schema already exists for this.

### BKL-W5-DRIVE1 | Drive doc fetch: 6-month modification filter excludes strategic reference PDFs
Status: ✅ DONE 2026-04-06 — verified already applied: customer.ts line 268 uses twoYearsAgo (730-day window)
Priority: P1
Size: XS (30 min)
Source: 2026-04-05 — Jason noted "RH business value maps.pdf" in Account Intelligence folder may not be found
Files: src/customer.ts (_fetchCustomerDocsImpl)
Description: File listing uses `modifiedTime > sixMonthsAgo` filter — any file not modified in 6 months is silently skipped. Strategic account documents (business value maps, POVs, exec summaries) are often set once and never modified. Fix: extend window to 2 years for files in subfolders named "Account Intelligence" or similar, OR remove the date filter entirely and rely on MAX_FILES_PER_CUSTOMER (50) and TOTAL_CONTENT_CAP (80K) as the guardrails. Subfolders (like Account Intelligence/) are not date-filtered — only file listings within them are.

### BKL-W5-TS2 | Pre-existing TypeScript error in product-intel-routes.ts:270 (opportunityName vs oppName)
Status: ✅ DONE 2026-04-08 — `tsc` no longer reports this error. Fixed in a prior session.
Priority: P3
Size: XS (15 min)
Source: 2026-04-06 — Marcus found during W5-P2-PRODPAGE work
Files: src/product-intel-routes.ts:270
Description: Pre-existing error — property `opportunityName` used but correct field name on `PipelineRecord` is `oppName`. Not introduced by current session. One-line rename fix.
Decision: DONE — no longer present in tsc output as of 2026-04-08 verification.

### BKL-W5-TS3 | TypeScript errors — server.ts Customer type missing + bootstrap-orchestrator.ts union narrowing
Status: ✅ DONE 2026-04-08
Priority: P2
Size: S
Source: 2026-04-08 — tsc verification pass revealed new errors not in original BKL-W5-TS1/TS2
Files: server.ts:709,719 — bootstrap-orchestrator.ts:772,847-853
Description: Two new error clusters found during 2026-04-08 tsc check: (1) server.ts:709,719 — `Customer` type used in AE removal cleanup code but not imported; (2) bootstrap-orchestrator.ts:772 — `startedAt` missing from PodBootstrapState initialization; bootstrap-orchestrator.ts:847-853 — properties (`aeName`, `sfReportId`, `tableauTerritories`, `customerNames`) accessed on union type without narrowing, and two lambda params implicitly typed `any`. Likely introduced by BKL-BOOT-01 session changes. App runs fine under Bun (no strict TS enforcement at runtime) but should be clean.

### BKL-W5-TS1 | Pre-existing TypeScript errors in server.ts (tableauUrl + EmailSettings)
Status: ✅ DONE 2026-04-08 — `tsc` no longer reports tableauUrl or EmailSettings errors. Fixed in a prior session.
Priority: P2
Size: S (1h)
Source: 2026-04-06 — Marcus tsc check found 18 pre-existing errors; unrelated to current session work
Files: server.ts (lines 684, 913-934)
Description: Two unrelated error clusters: (1) server.ts:684 — `tableauUrl` does not exist on AE type; (2) server.ts:913-934 — `deliveryTime`, `timezone`, `schedule`, `recipientEmail` not recognized on `Partial<EmailSettings> | {}` type due to narrow union type. Need to add `tableauUrl?: string` to AE interface and narrow the EmailSettings union to the concrete type before property access.
Decision: DONE — original errors resolved. New TS errors introduced in later sessions tracked in BKL-W5-TS3.

### BKL-W5-P2-PRODPAGE | Products page: territory radar instead of product brochure
Status: ✅ DONE 2026-04-06 — GET /api/products/:slug/territory-summary added (product-intel-routes.ts:351-414); ProductsPage.tsx replaced summaryText with TerritoryRadarCard showing coverage/priority actions/slide status; "Refresh slides" button wired to POST /api/products/ingest-slides
Priority: P1
Size: M (2-3h)
Source: 2026-04-05 — Jason: Products page shows generic summaryText from content.redhat.com, same problem as the account cards
Files: dashboard/src/pages/ProductsPage.tsx, dashboard/src/components/ProductCard.tsx, src/product-intel-routes.ts
Description: Replace the current Products page (which shows content.redhat.com summaryText — marketing copy everyone already knows) with a territory-level radar view:
  (1) Slide deck status per product: files ingested, last refreshed, corpusHash, total chars
  (2) Territory coverage: X of Y customers have intel generated, breakdown by HIGH/MEDIUM/LOW/NONE
  (3) Top 3 priority actions across all customers for this product (aggregate from cached CustomerProductIntel)
  (4) "Refresh slides" button → POST /api/products/ingest-slides
  (5) Remove summaryText display; keep version/GA/EOL dates as compact header only
  Requires new API endpoint: GET /api/products/:slug/territory-summary that aggregates cached customer intel files for the product.

---

## Security — Rook Audit 2026-04-06 (Product Intel Wave 4/5)

### BKL-S12 | Prompt injection via customer data in Gemini prompts
Status: ✅ DONE 2026-04-06 — Added `sanitizePromptInput()` to utils.ts. Applied to: subscription name/desc (customer-product-intel.ts), case summaries (customer-product-intel.ts), opportunity names (product-intel-routes.ts), and customerName in identifyIndustry prompt (account-intelligence.ts). Strips zero-width chars (U+200B-200D, FEFF), HTML/XML, instruction-override patterns, role-impersonation directives, and bare SYSTEM/USER/ASSISTANT markers. Gate: 9/10 PASS; 1 low gap (zero-width bypass) fixed same session.
Severity: HIGH
Priority: P2
Size: M (1 day)
Source: Rook audit 2026-04-06
Files: src/utils.ts, src/customer-product-intel.ts, src/product-intel-routes.ts, src/account-intelligence.ts

---

### BKL-S13 | SSRF via customSources URL validation bypass
Status: ✅ DONE 2026-04-06 (bypass fix applied 2026-04-06) — Exported `isAllowedUrl()` from product-feature-radar.ts. PATCH /api/products/:slug/sources now validates against ALLOWED_DOMAINS allowlist. Rook Batch2 scan (2026-04-06) identified path-based bypass: `(hostname + pathname).includes(d)` allowed `https://evil.com/.redhat.com/x` to pass. Fixed by splitting logic: `hostname.endsWith()` for *.redhat.com/*.openshift.com; `hostname === 'github.com' && pathname.startsWith('/openshift')` for GitHub.
Severity: HIGH
Priority: P2
Size: S (2-4 hours)
Source: Rook audit 2026-04-06
Files: src/product-intel-routes.ts lines 400-407, src/product-feature-radar.ts isAllowedUrl()
Description: `PATCH /api/products/:slug/sources` validates URLs with only `url.startsWith('http')`, allowing cloud metadata SSRF (169.254.169.254), loopback requests, and internal network scanning. URLs are later fetched by `product-release-radar.ts` `followLinksInContent()`. Risk is mitigated by localhost-only design but violates defense-in-depth.
Decision: Validate against domain allowlist — fixed `isAllowedUrl()` to use precise hostname/path checks preventing bypass.

---

### BKL-S14 | Missing mode 0o600 on customer-docs-corpus cache writes
Status: ✅ DONE 2026-04-06 — Added `{ mode: 0o600 }` to `writeFileSync` at `customer-docs-corpus.ts:80`. One-line fix applied immediately.
Severity: MEDIUM
Priority: P1
Size: XS (5 min)
Source: Rook audit 2026-04-06
Files: src/customer-docs-corpus.ts line 80

---

### BKL-S15 | No slug input validation on product intel routes — path traversal vector
Status: ✅ DONE 2026-04-06 — Added `/^[a-z0-9-]+$/` guard to GET /api/products/:slug/intel/:customerSlug and GET /api/products/:slug/features. Both slug and customerSlug validated before file path construction.
Severity: MEDIUM
Priority: P2
Size: XS (30 min)
Source: Rook audit 2026-04-06
Files: src/product-intel-routes.ts (GET /api/products/:slug/intel/:customerSlug, GET /api/products/:slug/features)
Description: `:slug` and `:customerSlug` route params used in file path construction without explicit format validation. Read routes skip the `products.find()` allowlist check that generation routes have. `resolve()` normalizes paths but `../` in slug could traverse cache dir. Add guard: `if (!/^[a-z0-9-]+$/.test(slug)) return c.json({ error: 'Invalid slug' }, 400)` at top of each handler.

---

### BKL-S16 | No concurrency guard on Gemini generation endpoints
Status: ✅ DONE 2026-04-06 — Added `_generatingKeys` Set (module-level) in `product-intel-routes.ts`. Guards POST /intel/:customerSlug/generate, POST /features/refresh, and POST /refresh with mutex key per slug/customer. Returns HTTP 409 on duplicate. Released in `finally` to handle error paths.
Severity: MEDIUM
Priority: P2
Size: S (2-4 hours)
Source: Rook audit 2026-04-06
Files: src/product-intel-routes.ts (POST /generate, POST /features/refresh, POST /refresh)
Description: Generation endpoints trigger Gemini API calls with no in-memory mutex. Rapid clicks or frontend retry bugs could spawn multiple simultaneous Gemini calls, exhausting GCP quota and amplifying cost. Apply same in-memory mutex pattern used by existing scrapers.

---

### BKL-S17 | Gemini error responses logged at excessive length
Status: ✅ DONE 2026-04-06 — Applied to all 4 Gemini callers (customer-product-intel, product-feature-radar, product-release-radar, product-intelligence). Now strips Bearer tokens and truncates to 200 chars.
Severity: MEDIUM
Priority: P3
Size: XS (15 min)
Source: Rook audit 2026-04-06
Files: src/customer-product-intel.ts line 359, src/product-feature-radar.ts line 383
Description: Gemini error response body logged up to 500 chars — can include request payload echo, project IDs, token fragments. Reduce to 200 chars and strip any Authorization/Bearer patterns, consistent with `sanitizeErr` pattern.

---

## Code Review — Marcus Webb 2026-04-06

### BKL-MC01 | Undefined variable `inputFields` crash in test endpoint
Status: ✅ DONE 2026-04-06 — Removed `inputFields` from the return object at server.ts:539. `tableData` already contains the error detail; the undefined var was redundant.
Severity: CRITICAL (test-only, not production)
Priority: P2
Size: XS (5 min)
Source: Marcus code review 2026-04-06
Files: src/server.ts line 539
Description: `inputFields` variable referenced but never declared in scope. Throws ReferenceError when error path is hit. Only in test endpoint guarded by `NODE_ENV !== 'production'`, but crashes debug sessions. Likely intended to be `inputDump`.

---

### BKL-MC02 | `getGeminiToken()` duplicated across 3 files
Status: ✅ DONE 2026-04-06 — Created `src/gemini-auth.ts` with single exported `getGeminiToken()`. Removed local copies from all 5 files (was 5, not 3 — account-intelligence.ts and product-intelligence.ts also had copies). Updated imports in all 5 files.
Priority: P2
Size: S (2 hours)
Source: Marcus code review 2026-04-06
Files: src/gemini-auth.ts (new), src/customer-product-intel.ts, src/product-feature-radar.ts, src/product-release-radar.ts, src/account-intelligence.ts, src/product-intelligence.ts
Description: Identical auth logic in 3 places (was actually 5). A fix to one (e.g. token caching, error handling) must be applied in all 3 or the system silently diverges. Extract to `src/gemini-auth.ts` shared module.

---

### BKL-MC03 | No timeout on Gemini API fetch calls
Status: ✅ DONE 2026-04-06 — Added `signal: AbortSignal.timeout(60_000)` to all 4 Gemini fetch callers: customer-product-intel.ts, product-feature-radar.ts, product-release-radar.ts, product-intelligence.ts.
Priority: P1
Size: S (2-3 hours)
Source: Marcus code review 2026-04-06
Files: src/customer-product-intel.ts:344, src/product-feature-radar.ts, src/product-release-radar.ts, src/product-intelligence.ts
Description: All `fetch()` calls to Gemini lack `AbortSignal.timeout()`. A hanging Gemini response blocks the request indefinitely. Especially problematic for `/generate` endpoint called from UI. Add `signal: AbortSignal.timeout(60_000)` to all Gemini fetch calls.

---

### BKL-MC04 | `enrichFeatures` mutates cached object in-place
Status: ✅ DONE 2026-04-06 — Added deep clone at top of `enrichFeatures()`: `const cache = { ...rawCache, features: rawCache.features.map(f => ({ ...f, sourceUrls: [...f.sourceUrls] })) }`. Mutations now operate on the clone, not the original parsed object.
Priority: P2
Size: S (1-2 hours)
Source: Marcus code review 2026-04-06
Files: src/product-feature-radar.ts enrichFeatures()
Description: `getFeatureCache(slug)` returns parsed JSON, enrichment mutates objects directly, then writes back. Works today because cache is never memoized, but adding caching would create aliasing bugs. Concurrent reads could see partially-enriched data. Should clone the cache before mutating.

---

### BKL-MC05 | Hardcoded Chromium binary path in `product-release-radar.ts`
Status: ✅ DONE 2026-04-06 — Removed `executablePath: '/ms-playwright/chromium-1208/...'` and changed `headless: false` → `headless: true`. Playwright now resolves the binary automatically via its own install path, and no visible browser window is spawned.
Priority: P1
Size: S (2 hours)
Source: Marcus code review 2026-04-06
Files: src/product-release-radar.ts scrapeContentHubPage()
Description: `scrapeContentHubPage` hardcodes `/ms-playwright/chromium-1208/chrome-linux/chrome` and `headless: false`. Path breaks on Playwright upgrades. Should use `chromium.executablePath()` or the standard Playwright launch without executablePath. `headless: false` pops a visible browser window.

---

### BKL-MC06 | `PRODUCT_SLUGS` hardcoded in `ProductIntelSection.tsx`
Status: ✅ DONE 2026-04-06 — Removed hardcoded `PRODUCT_SLUGS` const. Added `productSlugs` state + `productLabels` state. On mount, fetches `/api/products/config` to populate both. Falls back to hardcoded defaults if config fetch fails. `ProductCard` now receives `label` as a prop via `productLabel()` helper.
Priority: P2
Size: S (2-3 hours)
Source: Marcus code review 2026-04-06
Files: dashboard/src/components/ProductIntelSection.tsx:46
Description: Product slug list hardcoded in React component but product config is dynamic server-side (product-intel-config.json). Adding a product requires updating both config AND this constant. Should fetch from `GET /api/products/config` on mount and derive slugs + labels dynamically.

---

### BKL-MC07 | Feature cache data flows to Gemini prompt without schema validation
Status: ✅ DONE 2026-04-06 — Added `validFeatures` filter in `customer-product-intel.ts` before building featureBlock: requires `name`, `status`, `typeof description === 'string'`, and `Array.isArray(tags)`. Prevents runtime throws from `undefined.slice()` on malformed cache entries.
Priority: P2
Size: S (1-2 hours)
Source: Marcus code review 2026-04-06
Files: src/product-intel-routes.ts:264-271
Description: `featureCache.features` mapped and passed to `generateCustomerProductIntel` with no validation that the cache structure matches expected shape. A corrupted cache file produces malformed prompts without error until Gemini returns garbage. Add zod or manual shape check before mapping.

---

## Config Audit — Serena Blackwood 2026-04-06

### BKL-SR01 | `GEMINI_MODEL` env var ignored in 3 files — hardcoded model bypasses config
Status: ✅ DONE 2026-04-06 — Fixed all 3: `customer-product-intel.ts:329`, `product-feature-radar.ts:356`, `product-feature-radar.ts:512` now use `process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'`. Consistent with all other Gemini callers in the codebase.
Priority: P1
Size: XS (done)
Source: Serena audit 2026-04-06
Files: src/customer-product-intel.ts, src/product-feature-radar.ts (×2)

---

### BKL-SR02 | AI & Intelligence Settings accordion section (Settings UI)
Status: ✅ DONE 2026-04-06 — Added `AiConfig` interface + `getAiConfig()` + `getGeminiModel()` + `GET/POST /api/settings/ai` to settings-api.ts. `getGeminiModel()` centralizes model selection (env var override precedence). Wired to all 8 Gemini call sites: customer.ts (x3), customer-product-intel.ts, product-feature-radar.ts (x2), product-release-radar.ts, product-intelligence.ts, doc-extraction.ts, account-intelligence.ts, dashboard-routes.ts. briefSynthesisTemperature wired to callLLM + callLLMStructured in customer.ts. customerIntelTemperature wired to customer-product-intel.ts. featureExtractionMaxFeatures injected into product-feature-radar.ts prompt. Pricing made dynamic in gemini-cost-tracker.ts. Added `AiIntelligenceSettings.tsx` component + accordion section in SetupPage.
Priority: P1
Size: L (2-3 days)
Files: src/settings-api.ts, dashboard/src/components/AiIntelligenceSettings.tsx, dashboard/src/pages/SetupPage.tsx, src/customer.ts, src/customer-product-intel.ts, src/product-feature-radar.ts, src/product-release-radar.ts, src/product-intelligence.ts, src/doc-extraction.ts, src/account-intelligence.ts, src/dashboard-routes.ts, src/gemini-cost-tracker.ts, server.ts

---

### BKL-SR03 | Automation & Limits Settings accordion section (Settings UI)
Status: ✅ DONE 2026-04-06 — Added `AutomationConfig` interface + `getAutomationConfig()` + `GET/POST /api/settings/automation` to settings-api.ts. Wired to all 6 consumer sites: scraper-manager.ts (defaultScrapeTimeoutMs, rhScrapeTimeoutMs, circuitBreakerThreshold, circuitBreakerCooldownMs), customer-docs-corpus.ts (driveDocTextCap), customer.ts x2 (briefEmailsInPrompt), customer-product-intel.ts (briefHistoryDays). Added AutomationSettings.tsx component + accordion section in SetupPage.
Priority: P2
Size: M (1-2 days)
Files: src/settings-api.ts, dashboard/src/components/AutomationSettings.tsx, dashboard/src/pages/SetupPage.tsx, src/scraper-manager.ts, src/customer-docs-corpus.ts, src/customer.ts, src/customer-product-intel.ts

---

### BKL-S18 | Missing timeout on enrichFeatures() Gemini call in product-feature-radar.ts
Status: ✅ DONE 2026-04-06 — Added `signal: AbortSignal.timeout(60_000)` to enrichment fetch in `enrichFeatures()`. Rook Batch 3 scan caught this gap after BKL-MC03 fix covered only the extraction call.
Severity: LOW
Priority: P3
Size: XS (5 min)
Source: Rook Batch 3 scan 2026-04-06
Files: src/product-feature-radar.ts enrichFeatures() enrichment fetch

---

### BKL-S19 | Malformed GEMINI_SERVICE_ACCOUNT_KEY could expose partial key material in stack trace
Status: ✅ DONE 2026-04-06 — Added try/catch around JSON.parse in gemini-auth.ts with sanitized error messages. Added field validation for client_email + private_key before JWT construction.
Severity: LOW
Priority: P3
Size: XS (30 min)
Source: Rook Batch 3 scan 2026-04-06
Files: src/gemini-auth.ts:14-18
Description: `JSON.parse(Buffer.from(saKeyB64, 'base64').toString())` has no schema validation. A malformed key (not valid JSON, or valid JSON but missing fields) throws an unhandled error that could include partial key material in the stack trace. Add try/catch with a sanitized error message.

---

### BKL-S20 | POST /api/products/features/refresh-all lacks concurrency mutex
Status: ✅ DONE 2026-04-06 — Added `refresh-all` mutex key to `/api/products/features/refresh-all`. Returns HTTP 409 on duplicate. Follows same pattern as BKL-S16.
Severity: LOW
Priority: P3
Size: XS (30 min)
Source: Rook Batch 3 scan 2026-04-06
Files: src/product-intel-routes.ts POST /api/products/features/refresh-all
Description: Bulk feature refresh endpoint (line ~328) calls `refreshAllFeatures()` with no mutex. Concurrent POSTs spawn parallel bulk jobs. Lower risk than per-product endpoints since refresh-all is admin-only, but should be guarded with `refresh-all` mutex key for consistency.

---

### BKL-S21 | Gemini thinking budget not disabled on 7 of 9 call sites
Status: ✅ DONE 2026-04-06 — Added `thinkingConfig: { thinkingBudget: 0 }` to all remaining call sites: customer.ts (PDF multimodal), doc-extraction.ts, product-feature-radar.ts (enrichment), product-release-radar.ts, product-intelligence.ts, account-intelligence.ts, customer-product-intel.ts, dashboard-routes.ts. Only callLLM + callLLMStructured in customer.ts had it originally.
Severity: MEDIUM (silent cost leak — thinking tokens charge against output quota)
Priority: P1
Size: XS (15 min)
Source: User audit 2026-04-06 — Jason asked if thinking was disabled everywhere

---

## Rook Gate — BKL-SR03 Automation & Limits (2026-04-06)

### BKL-SR03-F1 | Circuit breaker config snapshot-at-startup — UI cooldown/threshold changes require restart
Status: 📋 BACKLOG
Severity: P2
Priority: P2
Size: S (1-2h)
Source: Rook gate 2026-04-06 — F1 finding on SR03 pass
Files: src/scraper-manager.ts (lines 196–201)
Description: `circuitBreakerThreshold` and `circuitBreakerCooldownMs` are read once at module initialization and baked into `CircuitBreaker` constructor args. Timeout fields (`DEFAULT_SCRAPE_TIMEOUT_MS`, `RH_SCRAPE_TIMEOUT_MS`) correctly use lazy lambdas that call `getAutomationConfig()` at invocation time, but circuit breaker config does not. Result: saving a new threshold/cooldown via `POST /api/settings/automation` takes effect for timeouts immediately but has no effect on circuit breakers until container restart. Fix: pass the config getter into `CircuitBreaker` or re-read config in `isOpen()`.

### BKL-SR03-F2 | DEFAULT_SCRAPE_TIMEOUT_MS lambda never invoked — Supportable/CCSP use hardcoded 10-min timeout
Status: 📋 BACKLOG
Severity: P3
Priority: P3
Size: XS (30 min)
Source: Rook gate 2026-04-06 — F2 finding on SR03 pass
Files: src/scraper-manager.ts:232, src/scrape-api.ts:330,389
Description: `DEFAULT_SCRAPE_TIMEOUT_MS` lambda is defined in scraper-manager.ts but never called. `scrape-api.ts` lines 330 and 389 use hardcoded `10 * 60 * 1000` for Supportable wallTimeout calls, bypassing `getAutomationConfig()` entirely. The "Default Scrape Timeout" UI control has no observable effect on CCSP or Supportable scrapes. Fix: replace hardcoded values in scrape-api.ts with `getAutomationConfig().defaultScrapeTimeoutMs`.

### BKL-SR03-Q1 | AutomationSettings: no client-side pre-save validation (browser min/max only)
Status: 📋 BACKLOG
Severity: P3 — UX gap, not functional regression
Priority: P3
Size: XS (30 min)
Source: Quinn gate 2026-04-06 — minor UX observation on SR03 pass
Files: dashboard/src/components/AutomationSettings.tsx
Description: Input fields use HTML `min`/`max` attributes for browser-native range hints but have no JavaScript pre-save validation. Out-of-range typed values are only caught at save time via server rejection. UX gap: user can type invalid values and submit; error only appears after the POST fails. Fix: add client-side range check before the POST call, highlighting the specific field that's out of range.

---

## Rook Gate — Wave 5 Security Review (2026-04-06)

### BKL-W5-RK-F1 | territory-summary: intelDir path uses resolve() but CACHE_DIR env var is unconstrained
Status: 📋 BACKLOG
Severity: P2
Priority: P2
Size: XS (30 min)
Source: Rook gate 2026-04-06 — Wave 5 review of GET /api/products/:slug/territory-summary
Files: src/product-intel-routes.ts (lines 356-358)
Description: The slug parameter is correctly validated via `/^[a-z0-9-]+$/.test(slug)` (line 354) before being interpolated into the path. However, `CACHE_DIR` and `DATA_DIR` are taken directly from `process.env` without validation. If an operator misconfigures these vars to point outside the container data volume, the `resolve()` call will happily construct a path anywhere on disk. In the current container-only deployment this is a low-likelihood operational issue (not an external injection vector), but worth a one-line existence check that CACHE_DIR stays within DATA_DIR. No user-controlled input reaches the env vars — severity is P2 (operator error, not attacker-controlled). Fix: add an assertion at startup that `CACHE_DIR` resolves within `DATA_DIR`, or document the constraint in ARCHITECTURE.md.

### BKL-W5-RK-F2 | ProductIntelSection file enumeration: readdirSync filenames used as display fallback without sanitization
Status: 📋 BACKLOG
Severity: P3
Priority: P3
Size: XS (15 min)
Source: Rook gate 2026-04-06 — Wave 5 review of territory-summary endpoint
Files: src/product-intel-routes.ts (line 377)
Description: `intel.customer ?? file.replace('.json', '')` — if a cache JSON file is missing the `intel.customer` field, the raw filename (minus extension) is used as the display customer name in the territory summary response. Cache files are written by the server itself (not externally uploaded), so this is a self-referential risk. However if a corrupt/hand-placed .json file with a crafted filename lands in the directory, its name surfaces in the API response verbatim. Since the directory is server-written only, severity is P3 (defense-in-depth). Fix: strip non-printable characters from the fallback filename before returning, e.g. `.replace(/[^\w\s-]/g, '')`.

### BKL-W5-RK-PASS | All other Wave 5 checks — PASS
Status: ✅ DONE 2026-04-06
Source: Rook gate 2026-04-06
Description: (1) renderMarkdownInline — no dangerouslySetInnerHTML anywhere in dashboard/src. All tokens are pushed into React elements (<strong>, <em>, <code>) via JSX, never injected as raw HTML. XSS risk: NONE. (2) Test file navigation-regression.spec.ts — all tests are GET + UI click navigation only; no POST/DELETE to non-test endpoints; no state mutation. (3) customer-product-intel.ts prompt — expansion opportunity prompt change is purely instructional text added to the system/user prompt; no new external input injected; sanitizePromptInput() already wraps all customer-sourced strings. (4) AccountIntelligencePanel.tsx — renders only Drive doc URLs as anchor hrefs (no text content rendered); no markdown rendering needed. (5) SetupPage.tsx — renders config strings and status strings from server API; no markdown content fields present; no renderMarkdownInline gap.

---

### BKL-QA01 | SetupPage status polling — missing test for post-load scrape update
Status: ✅ DONE 2026-04-10 (Quinn created quinn-setup-polling.spec.ts — 2 tests PASS covering Syncing→Connected transition and mid-run state)
Description: SetupPage `refreshAll()` was only called on mount with no periodic re-poll. Status showed stale amber/wrong-messages when RH scrape completed after page load. Fixed: 15-second `setInterval` added. Gap: no test covers "load setup page → scrape fires → verify status updates without reload." Quinn's tests always load after scrape, masking this.
Action: Add Playwright test — load /dashboard/setup, mock scrape completing mid-session, assert RH Portal status flips to green within 20s.

### BKL-QA02 | CalendarStrip "Generate brief" broken URL — missing /api/ prefix
Status: FIXED 2026-04-06 | Priority: P0 | Type: Bug
Description: `handleGenerate` fetched `/customer/{name}/brief` (no `/api/` prefix) — 404 on every click. Fixed to `/api/customer/{name}/brief`. Root cause: copy-paste from a pre-API-prefix era. QA gap: no test exercises the "Generate brief" button click on a meeting card.
Action: Add Playwright test for Generate brief button on a customer meeting card — assert loading state then brief content renders.

### BKL-QA03 | Product intel 404 console noise on customer detail — empty state not silent
Status: ✅ DONE — 2026-04-10 (verified: ProductIntelSection.tsx returns null on 404, no console logging)
Source: Quinn QA 2026-04-06
Description: Customer detail page fires 8 console errors on load — all 404s for product intel endpoints (e.g., `/api/products/ocp-virt/intel/dropbox`). Route is correct — 404 is the expected empty state when no intel has been generated yet. The frontend fetches all products on mount regardless of whether intel exists, logging each 404 as a console error. Page renders correctly; user sees Generate buttons. Fix: suppress console errors on 404 for product intel fetches (expected empty state), or prefetch only products with known cache entries.
Files: dashboard/src/components/ProductIntelSection.tsx

### BKL-SCRAPER-01 | writeCcspSheet does not search Drive by name before creating new sheet
Status: 📋 BACKLOG | Priority: P2 | Type: Architecture Gap
Source: Council review 2026-04-06
Files: src/ccsp-scraper.ts (writeCcspSheet ~line 594)
Description: When AE config loses the ccspSheetId (e.g., re-bootstrap), writeCcspSheet creates a new blank Google Sheet instead of searching the AE's Drive folder for an existing "[AE] CCSP" sheet by name. This creates orphaned duplicate sheets on every re-bootstrap. The function accepts an optional existingSheetId — if absent, it blindly creates a new one.
Fix: Before `drive.files.create()`, query `drive.files.list({ q: "name contains '[AE Name]' and name contains 'CCSP' and mimeType='application/vnd.google-apps.spreadsheet'" })` in the AE's Drive folder. If found, use that ID. Requires explicit Jason approval before touching ccsp-scraper.ts (protected file).

### BKL-SCRAPER-02 | CCSP service account cannot access user-created sheets
Status: 📋 BACKLOG | Priority: P2 | Type: Architecture Gap
Source: Council review 2026-04-06
Description: Google Sheets API auth uses a service account (SHEETS_TOKEN_PATH). The service account can only read/write sheets it created or was explicitly shared on. User-created CCSP sheets (e.g., "Carolanne Farrell CCSP" at 1zfQOj...) are inaccessible — API returns "Requested entity was not found." The CCSP Sync Now flow only works against the service-account-created sheet (10JEEZb3...). 
Fix options: (a) Share user's existing CCSP sheet with the service account email; or (b) run full Admin CCSP scrape to populate service-account sheet. Option (b) is the supported flow — document this constraint clearly in Setup UI.

### BKL-SCRAPER-03 | CCSP sheet empty after scrape — Tableau Raw Data download issue
Status: 📋 BACKLOG | Priority: P1 | Type: Bug
Source: Council review 2026-04-06
Description: The service-account CCSP sheet (10JEEZb3...) has a 'CCSP Data' tab with 0 data rows — the full CCSP scrape ran at some point but wrote no rows. ccsp-scraper.ts warns: "scraped data missing required columns — this usually means the Tableau .csv endpoint returned the summary view instead of Raw Data." The Tableau scraper sometimes gets the summary view (missing account/ACV columns) instead of the Raw Data tab download. Carolanne's CCSP widget shows $0/No AE data as a result.
Fix: Investigate Tableau Raw Data download reliability. May need to retry or explicitly navigate to the Raw Data tab before triggering download. Requires a fresh full CCSP scrape from Admin panel to reproduce and diagnose.
Action: Jason to run Admin panel → CCSP Sync → capture container logs during scrape → report what Tableau view was downloaded.

### BKL-SCRAPER-04 | Naming inconsistency: telemetry uses short names, StatusStore uses long names
Status: 📋 BACKLOG | Priority: P3 | Type: Tech Debt
Source: Council review 2026-04-06
Files: src/scraper-manager.ts, src/scraper-status-store.ts
Description: Telemetry log service names: 'rh', 'ccsp', 'supportable', 'salesforce'. ScraperStatusStore names: 'rh-cases', 'ccsp', 'supportable', 'sf-pipeline'. No cross-linking. Low impact (different consumers) but creates confusion in logs and dashboards.
Fix: Standardize on ScraperStatusStore names across both systems. Low priority — no functional impact.

### BKL-SCRAPER-05 | Salesforce ScraperStatusStore `state` stuck at "running" while `isRunning: false`
Status: ✅ DONE 2026-04-08 — `recordOutcome('sf-pipeline', ...)` moved into `.finally()` block in scraper-manager.ts:561. Outcome is now always recorded regardless of success/error/crash path.
Priority: P2 | Type: Bug
Source: Quinn QA 2026-04-06 (council review verification pass)
Files: src/scraper-manager.ts, src/scrape-api.ts (salesforce status endpoint)
Description: `/api/scrape/salesforce/status` returns `state: "running"` from ScraperStatusStore while simultaneously returning `isRunning: false` from the in-memory flag. These are contradictory — store says scrape is running, but the mutex says it's not. Downstream effect: the Setup page Pipeline (Salesforce) Sync Now button may be disabled due to the stuck `state`. Root cause likely: a previous SF scrape called `markRunning('sf-pipeline')` but the subsequent `recordOutcome()` was never called (process crash, timeout, or error path that bypassed the outcome recording).
Decision: DONE — `.finally()` wrapper ensures recordOutcome always fires. Verified in code at scraper-manager.ts:561.


### BKL-SCRAPER-06 | RH Cases `lastSync` null after container restart — in-memory var never hydrated from cache
Status: 📋 BACKLOG | Priority: P2 | Type: Bug
Source: Quinn QA gate 2026-04-06 (council review validation)
Files: src/rh-auth.ts (line ~30), src/scrape-api.ts (rh-cases status endpoint)
Description: `lastScraped` in rh-auth.ts is a module-level in-memory variable initialized to `null`. It is set when a scrape runs but never hydrated from disk on startup. After container restart, `/api/scrape/rh-cases/status` returns `lastSync: null` even when 7 cached records exist. The centralized ScraperStatusStore does persist `lastSuccess` (used by AdminPage), but the individual status endpoint reads the in-memory var.
Fix: Same pattern as ISC-01 (CCSP fix) — hydrate `lastScraped` from the RH cases cache file `cachedAt` on startup. Alternatively, change the rh-cases status endpoint to read `lastSuccess` from ScraperStatusStore (already disk-backed) as the primary timestamp source.

---

### BKL-AE-01 | parentFolderId not persisted — new AE folders land at Drive root
Status: ✅ DONE 2026-04-07
Severity: High
Source: Jason observation + Serena retro 2026-04-07
Files: src/types.ts, src/bootstrap-orchestrator.ts, dashboard/src/pages/SetupPage.tsx
Description: `parentFolderId` was accepted as a one-shot bootstrap request param but never written to `aes.json`. After a wizard reset or new browser session, the field came back blank and subsequent AE folders were created at My Drive root instead of under the shared parent. Phil Yi's folder was affected.
Decision: DONE — Added `parentFolderId?: string` to `AE` interface, persisted it in both new-AE and update-AE branches of bootstrap-orchestrator. Added `useEffect` in SetupPage that auto-inherits `parentFolderId` from first existing AE that has one saved, so future AEs land in the right place without the user re-pasting the URL.

### BKL-AE-02 | Sheets API quota burst during multi-AE bootstrap causes silent empty-cache failures
Status: ✅ DONE 2026-04-07
Severity: High
Source: Container logs — Phil Yi Supportable unreachable; Rook investigation 2026-04-07
Files: src/sheets.ts, src/refresh-engine.ts
Description: `fetchCustomerSheetData`, `fetchCustomerSheetRaw`, and `fetchCustomerAccountNumbers` all called `spreadsheets.values.get` naked with no quota retry. A 429 silently returned `[]`, which the bootstrap cache guard couldn't protect (nothing to preserve on fresh install). Additionally, `refreshAll` and `refreshSubscriptions` fired all 30 customer reads in ~3 seconds, saturating the 300/min quota when combined with concurrent reads.
Decision: DONE — Wrapped 3 naked `spreadsheets.values.get` calls with `withQuotaRetry` (retries once after 61s on 429). Added 750ms stagger between customer iterations in both `refreshAll` and `refreshSubscriptions` loops to spread 30 reads over ~22s.

### BKL-AE-03 | Sheets API quota: structural fix — batchGet to collapse per-AE reads
Status: ✅ DONE 2026-04-07 | Priority: P2 | Type: Architecture
Source: Rook investigation 2026-04-07
Files: src/sheets.ts, src/refresh-engine.ts
Description: Each customer read was firing one `values.get` call — 30 customers = 30 API calls per refresh cycle.
Decision: DONE — Implemented `batchFetchSubscriptions()` in sheets.ts using `spreadsheets.values.batchGet`. Groups customers by AE `supportableSheetId`, builds ranges array, calls batchGet once per AE sheet, distributes `valueRanges[i]` back to customers. `batchRefreshSubscriptions()` added to refresh-engine.ts using the batch path. ~30 reads → ~3 per refresh cycle. Empty-result guard and individual fallback path for per-customer overrides preserved.

### BKL-UI-02 | Support Cases section empty on customer detail despite open cases — SSE chunked encoding error
Status: ✅ DONE 2026-04-06 | Priority: P2 | Type: Bug
Source: Quinn QA 2026-04-07 (full dashboard visual test)
Files: src/customer-routes.ts (events SSE endpoint), dashboard/src/pages/CustomerDetailPage.tsx
Description: The `/customer/{name}/events` SSE endpoint returns `ERR_INCOMPLETE_CHUNKED_ENCODING` for A10 Networks. The Support Cases section in the customer detail page renders with a heading but no case rows, while the health radar correctly shows "1 Sev2 case open" and the What Changed section mentions the case by number. Users see contradictory information: radar says 1 case, cases panel shows nothing. A persistent "Loading..." spinner appears in the header. Crowdstrike and McAfee correctly show "No open support cases" empty state — the bug only manifests for customers with active cases.
Root cause: SSE stream handler had no top-level try/catch and no per-event error isolation. If any `writeSSE` call threw (client disconnect, stream error), the entire handler died, Hono terminated the chunked transfer, and the browser received `ERR_INCOMPLETE_CHUNKED_ENCODING`. The `complete` event never fired, leaving the frontend stuck in loading state with empty cases array.
Fix: Added `safeWrite` helper wrapping each `writeSSE` in try/catch so one failed write doesn't kill subsequent events. Wrapped entire stream body in try/catch/finally, with `complete` event sent in the `finally` block so the frontend always exits loading state.

### BKL-UI-03 | Supportable status inconsistency — top bar shows "Not reachable" while Setup shows "Connected"
Status: ✅ DONE — 2026-04-08 | Priority: P3 | Type: UX
Source: Quinn QA 2026-04-07
Files: dashboard/src/components/ (status bar), dashboard/src/pages/SetupPage.tsx
Description: Dashboard top status bar shows "Not reachable — check VPN" for Supportable while the Setup page simultaneously shows Supportable as "Connected." These check different things — the status bar does a live VPN probe (`liveProbe`) while Setup checks stored session state. Confusing to a new user who sees contradictory statuses. Low priority — no functional impact, but creates support confusion.
Fix: Align labels — if Supportable credentials are connected but VPN is not active, the status bar should say "VPN required for sync" rather than "Not reachable." Or collapse to a single authoritative status.

### BKL-UI-01 | Product intel API returns 400 for customer names with special characters
Status: ✅ DONE — 2026-04-08 | Priority: P2 | Type: Bug
Source: Quinn QA 2026-04-06 (strict criteria pass)
Files: src/product-intel-routes.ts, dashboard/src/components/ProductIntelSection.tsx
Description: Customer names containing commas or periods (e.g., "Taylor Fresh Foods, Inc.", "NORDSTROM") cause product intel API calls to return 400 Bad Request. The customer name is used directly in the URL path without encoding — `GET /api/products/ocp-virt/intel/Taylor Fresh Foods, Inc.` — the comma breaks URL parsing. Generates ~14 console errors per affected customer page load. Non-blocking: UI renders gracefully with empty product intel state.
Fix: URL-encode the customer name in the frontend fetch calls (`encodeURIComponent(customerName)`) and decode it in the API route handler (`decodeURIComponent(c.req.param('customerName'))`).

---

### BKL-AI-IMPORT-01 | makeAuth missing import in account-intelligence.ts
Status: ✅ DONE 2026-04-06
Severity: CRITICAL
Priority: P0
Size: XS (5 min)
Source: Generate All trigger after customers.json restore — intelligence pipeline crashed on startup
Files: src/account-intelligence.ts
Description: `makeAuth` from `google-auth-library` was referenced but never imported. The intelligence pipeline crashed immediately when `POST /api/intelligence/generate-all` was called. Silent failure — no customer intelligence generated until manually triggered and error observed in logs.

### BKL-AI-IMPORT-02 | google (googleapis) missing import in account-intelligence.ts
Status: ✅ DONE 2026-04-06
Severity: CRITICAL
Priority: P0
Size: XS (5 min)
Source: Generate All trigger after customers.json restore — Drive docs write step failed
Files: src/account-intelligence.ts
Description: `google` from `googleapis` was referenced in the Drive docs write step (Step 3) but never imported. Steps 1-2 (industry/segment classification, company brief) completed successfully, but Step 3 (Drive document write) failed with `google is not defined`. Result: intelligence was generated but never persisted to Drive. Both import bugs were caught when triggering "Generate All" to restore industry/segment labels after a customers.json restore.

---

### BKL-TEST-01 | Playwright test beforeAll/afterAll snapshot restore unreliable against live server
Status: ✅ DONE — 2026-04-08
Severity: HIGH
Priority: P1
Size: S (1-2h)
Source: 2026-04-07 Quinn QA run wiped Elmer Alvarez AE config — afterAll restore failed, git checkout only recovered committed Carolanne data
Files: test/qa-e2e-newuser.spec.ts, server.ts (snapshot/restore endpoints)
Description: The test suite resets the live server to factory state in beforeAll and attempts to restore in afterAll. When afterAll fails or is interrupted, live production data is permanently lost if it was uncommitted. Root cause: tests run against the live server with real data. Fix options: (1) require a dedicated test server on a different port, (2) make snapshot/restore atomic with a rollback guarantee, (3) skip beforeAll factory reset when SKIP_RESET=true env var is set. Until fixed, never run the full test suite while uncommitted AE/customer data exists.
Decision: DONE — Implemented option 2. POST /api/__test/snapshot takes a full state snapshot (AEs + customers) to memory before any test mutations. POST /api/__test/restore atomically restores from snapshot with atomic rename. qa-e2e-newuser.spec.ts updated to use these endpoints with try/retry afterAll rollback guarantee. If restore fails after all retries, an error message tells the operator to call POST /api/__test/restore manually — the in-memory snapshot survives until next server restart.

### BKL-TEST-02 | Quinn lifecycle tests must use snapshot/restore — missing guard caused customers.json wipe
Status: ✅ DONE — 2026-04-08
Severity: HIGH
Priority: P1
Size: S
Source: 2026-04-07 — Quinn AE lifecycle test called POST /api/aes without snapshot/restore; atomic customer cleanup wiped customers.json
Files: QUINN-STANDARD.md (updated), test/lifecycle.spec.ts (created), src/setup-routes.ts (/api/__test/snapshot + /api/__test/restore)
Description: Quinn's AE lifecycle tests (add/remove AE via POST /api/aes) ran without wrapping in snapshot/restore. Our atomic customer cleanup (added in f377045) deletes customers for removed AEs. Without snapshot/restore, this permanently wipes customers.json. Fix: (1) QUINN-STANDARD.md updated 2026-04-07 to mandate snapshot/restore for any test touching AEs/customers. (2) Create a dedicated lifecycle spec that uses beforeAll snapshot + afterAll restore with a rollback guarantee. (3) Never call POST /api/aes in ad-hoc tests without snapshot wrapping.
Decision: DONE — Added POST /api/__test/snapshot and POST /api/__test/restore to setup-routes.ts. These save/restore AEs+customers atomically in-memory (file-backed with atomic rename). Updated qa-e2e-newuser.spec.ts to use new endpoints with try/retry afterAll for rollback guarantee. Created test/lifecycle.spec.ts with full snapshot/restore wrapping pattern for AE lifecycle tests.

### BKL-BACKUP-01 | Comprehensive config backup/restore — POD Bootstrap scaffolding + Admin page buttons
Status: ✅ DONE — 2026-04-10 (verified: src/backup-config.ts + src/backup-routes.ts fully implemented — createBackupSheet(), backupNow(), restore; backs up aes.json, customers.json, data-sources.json to GSheet tabs)
Severity: CRITICAL
Priority: P0
Size: L
Source: 2026-04-08 — test-induced data wipe; aes.json had no recovery path; customers.json partial only
Files: src/setup-routes.ts (POD Bootstrap step), dashboard/src/pages/AdminPage.tsx, server.ts (new backup-routes.ts)
Description: Every critical config file needs auto-backup to a Google Sheet created during POD Bootstrap. Currently aes.json has zero recovery path; customers.json requires 1-2h scrape recovery; data-sources.json, product-intel-config.json have nothing. This has caused two production data losses.

Design (confirmed with Jason 2026-04-08):
- **PAI Config Backup sheet** created at POD Bootstrap Step 0 (before any AEs configured); lives in the parent Drive folder
- **Tabs:** AE Registry (aes.json), Customers (customers.json), Data Sources (data-sources.json), Product Intel (product-intel-config.json), Restore Log
- **Auto-backup trigger:** Every call to saveAes(), saveCustomers(), saveDataSources() — async, non-blocking, fire-and-forget with retry
- **Cache backup:** Sheet-based is preferred; restore path = sheet → cache (not re-scrape)
- **Restore granularity:** Single "Restore All" endpoint + per-section API endpoints for granular recovery
- **Admin page:** "Backup Now" button + "Restore from Backup" button; restore shows per-section status
- **Recovery flow:** POST /api/admin/backup/restore → reads Config Backup sheet → rebuilds all config + triggers cache restore from data sheets

Implementation plan (Marcus):
1. Add "Create Config Backup sheet" as Step 0 of POD Bootstrap in bootstrap-orchestrator.ts
2. Hook saveAes() / saveCustomers() / saveDataSources() to async write to Config Backup sheet
3. New backup-routes.ts: POST /api/admin/backup (manual trigger), POST /api/admin/backup/restore
4. Admin page: Backup Now + Restore from Backup buttons with status display

### BKL-TEST-03 | Full Playwright suite wipes production data — Quinn must never run `npx playwright test`
Status: ✅ DONE 2026-04-10 (server.ts snapshot reads from memory not disk; restore requires force:true when reducing customers, commit adfd8f2)
Severity: CRITICAL
Priority: P0
Size: S
Source: 2026-04-08 — Quinn ran full suite during final verification; wiped 9 AEs and 130 customers
Files: ~/.claude/PAI/Testing/QUINN-STANDARD.md (updated), test/lifecycle.spec.ts, test/qa-e2e-newuser.spec.ts
Description: Quinn ran `npx playwright test` (full suite) during a final verification pass. The lifecycle and new-user specs call `POST /api/__test/snapshot` + `POST /api/__test/restore`. The snapshot reads from DISK — at that moment, disk had 1 AE (stale from a prior test run) while memory had 10. Snapshot captured 1 AE, restore wrote 1 AE back to disk and memory. All 9 bootstrapped AEs and 130 customers wiped. Recovery required: (1) reconstruct aes.json from in-session curl output, (2) rebuild container, (3) restore from GSheets, (4) re-apply 17 supportableName overrides, (5) re-trigger discovers for all AEs.

Root cause fix needed: The snapshot endpoint reads from DISK, not from the authoritative in-memory state. If disk diverges from memory (after bootstrap adds AEs), snapshot captures stale data. Fix: snapshot should serialize in-memory `aes` + `customers` arrays, not read from disk.

Workaround in place (2026-04-08): QUINN-STANDARD.md updated to ban `npx playwright test`. Safe baseline is `npx playwright test test/api/` only. Lifecycle and new-user specs require explicit Jason approval.

### BKL-UI-SETUP-ROUTING-01 | Setup, Products, Admin routes return 404 on direct URL
Status: ✅ DONE (partial) — 2026-04-27 Quinn council confirms /dashboard/setup, /dashboard/admin, /dashboard/products all work correctly via SPA routing. The 404 only affects bare /setup, /admin, /products paths (without /dashboard/ prefix) — low priority, not user-visible since sidebar links use /dashboard/* paths. BKL-SEC-SUPPORTABLE-02 unblocked (can test at /dashboard/setup).
Priority: P2
Size: S
Source: Quinn QA 2026-04-26 during BKL-SEC-SUPPORTABLE-01 gate
Files: src/server.ts (SPA fallback), dashboard/src/App.tsx (client-side routes), dashboard/src/components/Sidebar.tsx (nav links)
Description: Direct navigation to /setup, /products, /admin returns 404 from the server. Sidebar nav clicks for Setup and Products do not change the URL (stay on /dashboard). The server SPA fallback is likely not covering these paths, or the sidebar renders anchor tags with broken hrefs instead of router links. Blocks: BKL-SEC-SUPPORTABLE-02 (cannot Quinn-verify SetupPage cleanup until the page is reachable).

---

### BKL-UI-04 | ASA/Product toggle invisible in collapsed sidebar — single unlabeled "A" button
Status: ✅ DONE 2026-04-07 — Fixed in commit e0d2773: collapsed sidebar now shows stacked A/P buttons with active-state ring and tooltips
Severity: MEDIUM
Priority: P2
Size: S
Source: Quinn QA 2026-04-07 Phase 1 Product View verification
Files: dashboard/src/components/Sidebar.tsx
Description: In collapsed sidebar state (default on first load), the ASA/Product view mode toggle renders as a single small "A" button. There is no visible "Product" option, no tooltip, and no indication that a view mode toggle exists. New users cannot discover Product View without knowing to expand the sidebar first. Fix: in collapsed state, show both "A" and "P" as stacked compact buttons with tooltips ("ASA View" / "Product View"), or auto-show a tooltip on first visit pointing to the toggle.

### BKL-PVIEW-01 | Product View — Phase 1 complete (client-side filters, AE chips, product bar)
Status: ✅ DONE 2026-04-07 — Commit 4c8e38d
Severity: —
Priority: —
Size: L
Source: Council review 2026-04-07 (Serena/Aditi/Marcus)
Files: dashboard/src/App.tsx, dashboard/src/components/Sidebar.tsx, dashboard/src/components/AccountPortfolioGrid.tsx, dashboard/src/utils/productName.ts
Description: Phase 1 of Product View feature. AE filter chips (replace select dropdown, single-select, localStorage key ae-filter-selected), Product filter chips (multi-select, discoverAllProducts from live data, localStorage key product-filter-selected), ASA/Product sidebar toggle (localStorage key dashboard-view-mode), subscription inline expansion on account cards when product filter active (matching subs expanded, non-matching collapsed with "show N more"), Morning Summary hidden in product view, stripProductName utility strips "Red Hat " + comma suffix.

### BKL-PVIEW-02 | Product View — Phase 2 complete (GET /api/pod/summary + CCSP productOfferingGroup)
Status: ✅ DONE 2026-04-07 — Commit f3bf339
Severity: —
Priority: —
Size: M
Source: Council review 2026-04-07
Files: src/dashboard-routes.ts, src/sheets.ts
Description: Phase 2 backend additions. GET /api/pod/summary: runtime aggregation across all customer caches + RH cases cache, returns totalCustomers/totalAEs/openCases/openCasesByProduct/expiringNext90Days/productMix, 30s in-memory TTL, customer deduplication by lowercase name. CCSP productOfferingGroup: added field to CCSPRecord interface, parsed from column S (index 18 zero-based) positionally, optional for backward compat with older sheet formats. Verified: 423/423 CCSP rows have productOfferingGroup populated.

### BKL-PVIEW-03 | Product View — Phase 3: POD bootstrap via territory sheet
Status: ✅ DONE 2026-04-07 — Commit c08e188: bootstrapPOD(), readAEsFromTerritorySheet(), POST /api/bootstrap/pod, extended status + reset
Severity: HIGH
Priority: P1
Size: XL
Source: Council review 2026-04-07 — POD bootstrap design (Option C: Import from territory sheet)
Files: src/bootstrap-orchestrator.ts, src/setup-routes.ts (or server.ts), dashboard/src/pages/SetupPage.tsx
Description: POD-level bootstrap flow. bootstrapPOD() function in bootstrap-orchestrator.ts: reads AE list from territory sheet (territory sheet is canonical source), loops existing bootstrapAE() sequentially (never parallel — Sheets quota constraint), idempotency (skip AEs where all 4 sheet IDs already populated, force:true flag available), dynamic timeout aeConfigs.length × 15min. Wizard step: shows AE checklist from territory sheet, user confirms, progress polls per-AE status (AE 3/8). Auto-retry second pass for AEs with zero account numbers or missing rows. User sees partial failure: "3/8 succeeded, 5 failed — retry failed AEs". Estimated time: 36–52 min for 8 AEs.
Dependencies: Phase 2 complete (done).

### BKL-PVIEW-04 | Product View — Phase 4: react-window virtualization for 8 AEs/96 customers
Status: ✅ DONE 2026-04-07 — Commit 98702f1: react-window Grid in AccountPortfolioGrid.tsx, ResizeObserver responsive columns, fixed 240px row height
Severity: MEDIUM
Priority: P2
Size: L
Source: Council review 2026-04-07 — Layout Scaling (Option C: AE filter chips + react-window)
Files: dashboard/src/components/AccountPortfolioGrid.tsx, dashboard/src/App.tsx
Description: Virtualized card grid using react-window VariableSizeGrid for 80-160 customer cards (~50ms render target). AE filter chips enhanced with worst-health dot per AE. Chips wrap to 2 rows max at 8 AEs. Sticky filter panel (sticky top-14) keeps filters visible during scroll. Existing view modes (All, By AE, Triage, List) compose with filter chips.
Dependencies: Phase 3 complete.

### BKL-SEC-02 | sheetCachePath path safety relies implicitly on toSlug invariant
Status: ✅ DONE — 2026-04-08
Severity: MEDIUM
Priority: P2
Size: S
Source: Rook security scan 2026-04-07 Phase 2 (dashboard-routes.ts GET /api/pod/summary)
Files: src/cache-layer.ts (sheetCachePath function)
Description: readSheetCache(cu.name) constructs a file path using toSlug(customerName). The safety guarantee depends entirely on toSlug producing only safe filesystem characters. If toSlug has an edge case (e.g., name with only special characters), it could produce an unexpected path. The invariant is implicit — no explicit bounds check or allowlist guard at the sheetCachePath level. Fix: add an explicit regex check inside sheetCachePath: if the slug is empty or contains `..` or `/`, throw rather than silently construct a bad path. Low practical risk (customer names come from internal config), but worth hardening.

### BKL-SEC-03 | sanitizeErr regex doesn't mask .json config paths in 500 responses
Status: ✅ DONE 2026-05-02
Severity: LOW
Priority: P3
Size: S
Source: Rook security scan 2026-04-07 Phase 2 (src/utils.ts sanitizeErr); re-surfaced Rook scan 2026-05-01 BKL-HERO-01 Phase 3
Files: src/utils.ts
Description: sanitizeErr regex at utils.ts:18 uses `.replace(/\/[^\s:]+\.(ts|js|json)/g, '[file]')` — alternation matches `.js` before `.json` so `/data/data-sources.json` produces `[file]on` (suffix leaks). Also: requires a leading `/` so relative paths like `config/customers.json` pass through unmasked. Fix: put `json` before `js` in alternation AND drop the leading-slash requirement; or use broader path strip: `.replace(/(?:\/|[a-zA-Z]:[\\/])[\w./\\-]+\.(ts|js|json|key|pem)/g, '[path]')`. Rook MED-01 2026-05-02.

### BKL-SEC-04 | POST /api/bootstrap/pod — TOCTOU race in 409 conflict guard
Status: ✅ DONE 2026-04-07 — Fixed in commit 862c99c: lock claimed synchronously before first await, released on validation failure
Severity: MEDIUM
Priority: P2
Size: S
Source: Rook + Quinn scan 2026-04-07 Phase 3
Files: src/bootstrap-orchestrator.ts
Description: The 409 conflict guard read `podBootstrapState.running` then yielded the event loop via `await c.req.json()` before setting `running=true`. Two simultaneous POSTs both passed the guard before either set the flag. Fix: claim the lock (`podBootstrapState.running = true`) synchronously before the first await; release on validation failure.

### BKL-SEC-05 | POST /api/bootstrap/pod — Sheet ID regex accepts 10+ chars (real IDs are 44)
Status: ✅ DONE — 2026-04-08
Severity: LOW
Priority: P3
Size: S
Source: Rook scan 2026-04-07 Phase 3
Files: src/bootstrap-orchestrator.ts line 657
Description: The territorySheetId regex `{10,}` accepts any 10+ alphanumeric string. Real Google Sheet IDs are exactly 44 characters. A tighter bound `{44}` or `{30,60}` would reduce accident surface (not a meaningful security gain on localhost but worth tightening).

### BKL-POD-01 | POD Bootstrap — Drive folder preview after fields populated
Status: ✅ DONE — 2026-04-08
Severity: LOW
Priority: P2
Size: S
Source: Jason 2026-04-07
Files: dashboard/src/pages/SetupPage.tsx — PodBootstrapSection
Description: Once Territory Sheet ID, SF Report ID, and Parent Drive Folder are all filled in, show a Google Drive folder preview (similar to the single-AE bootstrap folder preview) so the user can confirm they've selected the right parent folder before clicking Bootstrap POD. Should use the same Drive folder name lookup pattern already used in AutoBootstrapForm.
Decision: DONE — Added folderName/folderError state + onBlur handler calling /api/aes/validate-folder in PodBootstrapSection. Border turns green + shows "✓ FolderName" on success; red + error on failure. Matches existing AutoBootstrapForm pattern exactly.

### BKL-SEC-09 | podKeyFromQualified — trailing-dot / double-dot edge cases silently produce empty key
Status: ✅ DONE 2026-05-02 — Added trailing-dot guard: `if (idx === -1 || idx === qualifiedKey.length - 1) return qualifiedKey` in regionFilter.ts:17. Trailing-dot input now returns the full key instead of "".
Severity: LOW (no security impact — fail-closed behavior)
Priority: P3
Size: XS
Source: Rook scan 2026-04-30 BKL-HERO-01 Phase 4
Files: dashboard/src/utils/regionFilter.ts

Description: `podKeyFromQualified("WEST.")` returns `""` and `podKeyFromQualified("a.b.c")` returns `"b.c"` — neither will match any real pod key, so the pod is silently dropped from the filtered set. This is fail-safe (restrictive, not permissive) but undocumented. If pod keys ever legitimately contained dots this would silently misconfigure the filter. Recommended guard: `if (idx === -1 || idx === qualifiedKey.length - 1) return qualifiedKey` to make the no-match behavior explicit.

### BKL-SEC-10 | sanitizeErr lacks HTML-strip pass — React escaping is the only defense
Status: ✅ DONE 2026-05-01
Severity: MEDIUM
Priority: P2
Size: XS
Source: Rook scan 2026-05-01 BKL-HERO-01 Phase 3-5 gate
Files: src/utils.ts (sanitizeErr)

Description: `sanitizeErr` stripped JWT patterns, Bearer tokens, and file paths but did not strip HTML tags. In `HeroStep3Connections.tsx`, the server error string is rendered via React JSX (`{saveError}`), which escapes HTML by default — providing actual defense. However `sanitizeErr` should be the reliable defense layer, not React's rendering behavior. A future refactor rendering the error via `dangerouslySetInnerHTML` or a different context would silently lose the protection. Fix: added `.replace(/<[^>]*>/g, '')` to `sanitizeErr` before the `.slice(0, 200)` call. Verified `sanitizeText` already does this same strip at line 30.
Decision: DONE — one-liner added to sanitizeErr in same Rook-gate session. Test: existing `sanitizeErr` usages unaffected; HTML tags now stripped before returning to client.

### BKL-SEC-11 | Pre-try 400 paths in POST /api/settings/* return strings without sanitizeErr
Status: ✅ DONE 2026-05-02 — Added contract comment at settings-api.ts:263 documenting that pre-try 400 strings MUST be const-derived (no user input, no e.message). No code-path change needed — strings were already safe.
Severity: LOW
Priority: P3
Size: S
Source: Rook scan 2026-05-01 BKL-HERO-01 Phase 3-5 gate
Files: src/settings-api.ts (POST /api/settings/offline-token lines 268-274, POST /api/settings/refresh lines 309-341)

Description: All POST /api/settings/* handlers use `sanitizeErr(e)` in their `catch` blocks. However, the pre-try validation paths (early-exit 400 responses before the `try` block) return hand-written string literals directly without going through `sanitizeErr`. These strings are safe as written (derived from `const` arrays, not user input). The risk is structural: a future developer adding a pre-try 400 that includes an `e.message` or user-derived value would bypass sanitization. Recommendation: document the contract ("pre-try 400 returns MUST use only const-derived strings") or wrap pre-try paths in a helper that enforces sanitization. No active vulnerability — purely structural.

### BKL-SEC-08 | HeroStep3Connections — token not cleared from state on save (hygiene)
Status: ✅ DONE 2026-04-30
Severity: LOW
Priority: P3
Size: XS
Source: Rook scan 2026-04-30 BKL-HERO-01 Phase 3
Files: dashboard/src/components/HeroStep3Connections.tsx

Description: Token textarea value remained in React state after successful save. If user clicked [Edit] after saving, the raw token would re-render in the DOM. `setToken('')` added at line 53 immediately after `setSummaryMode(true)`. Fixed inline same session.

### BKL-SEC-07 | Expansion Opportunities — prompt injection hardening (P2 x3)
Status: ✅ DONE 2026-05-02 — Verified in source: SEC-EXP-01 (slug guard at expansion-opportunities.ts:48), SEC-EXP-02 (sanitizePromptInput on intelCache.company/industry at line 219), SEC-EXP-03 (sanitizePromptInput on f.name/f.textContent in loadDriveDocsContext at line 96) all already present. No code change needed.
Severity: MEDIUM (P2)
Priority: P2
Size: S
Source: Rook scan 2026-04-11 post-BKL-PRODINTEL-04
Files: src/expansion-opportunities.ts

Description: Three unsanitized inputs in the Gemini prompt assembly:

1. **SEC-EXP-01 — `expansionCachePath()` missing slug guard** (line 47): `briefCachePath()` in `cache-layer.ts:28` throws on non-`[a-zA-Z0-9_-]` chars after slugification. `expansionCachePath` trusts `toCustomerSlug` output without defense-in-depth validation. Fix: add the same post-slug regex check.

2. **SEC-EXP-02 — `intelCache.company` / `intelCache.industry` unsanitized** (line ~213): Injected directly via `.slice()`. Subscription summary and pipeline text both call `sanitizePromptInput()` — intel cache fields do not. Fix: wrap both with `sanitizePromptInput(intelCache.company, 6000)` and `sanitizePromptInput(intelCache.industry, 2000)`.

3. **SEC-EXP-03 — `driveDocsContext` raw injection** (loadDriveDocsContext line ~92): `f.name` and `f.textContent` from Drive docs concatenated with no sanitization. Drive docs are third-party content — highest prompt injection risk in the whole prompt assembly. Fix: apply `sanitizePromptInput` to both `f.name` and `f.textContent` inside `loadDriveDocsContext`.

Pattern sibling: inline slug formula duplicated at `customer-routes.ts:200` and `:389` — same P2 gap as SEC-EXP-01. Consider extracting to a single validated slug helper.

---

### BKL-SEC-06 | bootstrapPOD retry silently no-ops on 409 instead of waiting
Status: ✅ DONE — 2026-04-08
Severity: LOW
Priority: P3
Size: S
Source: Rook scan 2026-04-07 Phase 3
Files: src/bootstrap-orchestrator.ts ~line 360
Description: During the auto-retry pass for zero-account AEs, if the retry fetch() to POST /api/bootstrap/auto returns 409 (prior AE's bootstrap still running), the code logs a warning and continues without waiting. The retry becomes a silent no-op. Fix: on 409 during retry, wait for autoBootstrapState.running === false (same pattern as lines 341-343) before continuing.

### BKL-POD-02 | POD Bootstrap — 15-minute per-AE timeout too short for AEs with 10+ accounts
Status: ✅ DONE — already implemented (30 min, dynamic, BKL-POD-02 comment in code)
Severity: MEDIUM
Priority: P2
Size: S
Source: POD Bootstrap test 2026-04-07
Files: src/bootstrap-orchestrator.ts line 442
Description: The per-AE timeout is hardcoded at 15 minutes. Danny Hollar (11 accounts including slow portal lookups like Ringcentral, Rakuten Group) timed out consistently. Account discovery + Supportable scraping for 10+ accounts can exceed 15 minutes on slow portal sessions. Fix: make the timeout dynamic based on customer count (e.g., 10 min base + 90s per customer), or raise to 30 minutes flat. Also consider logging a warning at 10 minutes so operators know it's close to timeout.

### BKL-POD-03 | POD Bootstrap — Pipeline sync fails with "File not found" if Drive folder is deleted mid-run
Status: ✅ DONE — 2026-04-08
Severity: MEDIUM
Priority: P2
Size: S
Source: POD Bootstrap test 2026-04-07
Files: src/bootstrap-orchestrator.ts — syncPipelineSheet step
Description: If the AE's Drive folder is deleted after the bootstrap has already recorded the folder ID in aes.json (e.g., via a wipe script during retry), the Pipeline sync step fails with "File not found: {folderId}". The bootstrap does not detect the missing folder before attempting the pipeline sync, and the error message does not suggest recovery. Fix: before pipeline sync, verify the Drive folder exists (drive.files.get with fields:'id') and surface a clearer error ("Drive folder was deleted — re-run bootstrap with force:true to recreate it") rather than the raw Google API error.

### BKL-POD-04 | POD Bootstrap — tabs endpoint doesn't extract sheet ID from full URL
Status: ✅ DONE — 2026-04-08
Severity: MEDIUM
Priority: P2
Size: XS
Source: Quinn QA 2026-04-07
Files: src/bootstrap-orchestrator.ts — GET /api/bootstrap/pod/tabs handler
Description: The tabs endpoint receives the full Google Sheets URL verbatim and fails with 500. The URL extraction regex (already applied in bootstrapPOD for the main flow) needs to be applied in the tabs endpoint handler as well, before passing to the Sheets API. Fix: extract sheetId from URL with the same regex used in bootstrapPOD.

### BKL-SUP-02 | Shared browser context — CCSP and SF sync not gated on Supportable scrape running
Status: ✅ DONE — 2026-04-07
Severity: HIGH
Priority: P1
Size: S
Source: Jason 2026-04-07, session locking audit
Files: src/scraper-manager.ts (runSfSyncForAes, CCSP trigger), src/ccsp-scraper.ts
Description: CCSP and SF sync do not check `supportableScrapeRunning` before opening pages in the shared browser context. If a scheduler-triggered CCSP or SF sync fires during a Supportable discovery session, it can disrupt APEX page state and cause discovery to return 0 accounts silently. RH keep-alive is correctly gated via `setLivePageBusy(true)` but CCSP and SF have no equivalent guard. Fix: add `if (supportableScrapeRunning) { defer/return }` at the top of both CCSP and SF sync entry points. Also: Supportable should set a broader "exclusive session" flag that all scrapers check before opening any new page in the shared context.

### BKL-SUP-01 | Supportable discovery — retry zero-account customers before writing sheet
Status: ✅ DONE — 2026-04-07 (Fix Parts 1+3 implemented; Fix Part 2 noAccountsFound flag deferred)
Severity: HIGH
Priority: P1
Size: M
Source: Jason 2026-04-07, audit of zero-account customers after POD bootstrap
Files: src/supportable-scraper.ts (runSupportableDiscoverAndScrape), src/supportable-extract.ts (buildNameCandidates)
Description: During POD bootstrap (~104 min, 10 AEs sequential), some Supportable discovery calls return 0 accounts due to VPN/APEX session timeouts or browser session interference — no retry, no flag, just silent empty result. Confirmed: Autodesk, Genesys Cloud Services, Lumentum Holdings, KLA Corporation, Docusign and others all return valid account numbers when searched manually. buildNameCandidates already has word-backoff logic — the problem is the discovery silently accepts 0 results and moves on.

Root cause (confirmed via code audit 2026-04-07): Phase 1 (name search / discovery) has zero retry logic. If search returns 0 accounts, customer is immediately marked 0 accounts and skipped in Phase 2 (scrape worker loop). The 2-attempt retry that exists only covers Phase 2 (per-account scrape), never Phase 1. Zero-account customers skip Phase 2 entirely (supportable-scraper.ts lines 1080-1087).

Fix Part 1 — Discovery retry with word-backoff: After initial discovery returns 0 accounts, immediately retry using the next word-backoff candidate from buildNameCandidates() (already exists in supportable-extract.ts). Stop retrying at first candidate that returns results. Rule: if full name finds accounts on first try, do NOT back off — lock to that result and move on.

Fix Part 2 — Zero-account flag: If all word-backoff candidates still return 0, mark customer with `noAccountsFound: true` in customers.json. Dashboard shows "No subscriptions found — verify manually" indicator instead of hiding the customer.

Fix Part 3 — Session health: Before each discovery job, add a lightweight APEX probe to confirm the session is still live. If dead, re-establish before continuing rather than silently returning 0.

Note: BKL-SUP-02 (session locking) must be implemented first — concurrent CCSP/SF scrapes during a Supportable sync will reproduce the same zero-account failures. Fix order: SUP-02 → SUP-01 → re-sync.

### BKL-RESTORE-02 | Post-restore alias repopulation from SF bookings sheets
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P1
Size: S
Source: 2026-04-10 — restore stripped aliases, blocking RH account discovery
Files: src/restore-routes.ts
Description: Restore writes customers.json from Supportable "Accounts" tab which lacks aliases[]. The RH scraper uses aliases[0] (SF canonical name) for account discovery — without it, all customers appear un-discoverable after a restore. Fix: after saveCustomers(), fire a non-blocking background pass that reads POD bookings sheets via deriveSfCustomersByTerritory and re-adds aliases[0] per customer. Committed 093e025.

### BKL-RESTORE-01 | GSheet restore — rebuild all dashboard data from source sheets without re-scraping
Status: ✅ DONE — 2026-04-08
Severity: HIGH
Priority: P1
Size: L
Source: Jason 2026-04-07
Files: New src/restore-from-sheets.ts + server.ts (POST /api/admin/restore), dashboard UI admin panel
Description: When data/ is lost, corrupted, or a new deployment is set up, the dashboard currently requires a full re-bootstrap (Supportable scrape ~10 min/AE, CCSP scrape, SF sync, etc.). All transactional data already lives in the GSheets — we just need a restore path that reads from them. Goal: given a valid aes.json (containing supportableSheetId, pipelineSheetId, ccspSheetId per AE), restore 80%+ of dashboard data in under 2 minutes without any live portal scraping.

**Restorable from GSheets (no scraping required):**
- `customers.json` (name, ae, accountNumbers[]) — Supportable sheet tab 1: "Accounts" has Account Name + Account ID(s)
- `{slug}-sheets.json` (subscription rows per customer) — Supportable sheet per-customer tabs
- `pipeline-data.json` — each AE's pipelineSheetId, full opportunity rows
- `ccsp-data.json` — each AE's ccspSheetId, cloud spend records
- AE-to-customer mapping — territory sheet (territorySheetId in data-sources.json podConfig)

**Restorable from Drive (needs Drive auth, no scraping):**
- `intelligence/{slug}-account-plan.md` — sourced from customer Drive folders
- `product-intel/customer-docs/` — Drive corpus per product
- `drive-watcher-state.json` — reset to empty; Drive will re-scan on next poll

**NOT restorable (require live scrape or AI generation):**
- `cases.json` — VPN-gated Red Hat portal, real-time only
- `{slug}-{date}.json` daily briefs — AI-generated on demand (4h cache), no restore needed
- `intelligence/{slug}.json` account intelligence — re-queued by intelligence-jobs.json on next run
- `morning-synthesis.json` — AI-generated from other cache on demand

**What we might be missing (gaps to verify before implementing):**
- `intelligence-jobs.json` — tracks which customers have had intelligence generated; if lost, stale detection breaks until next full cycle. Needs reset strategy.
- `drive-watcher-state.json` pageTokens — if reset, Drive changes since last sync are missed until next full folder scan. Restore should trigger an immediate re-scan.
- `product-intel-config.json` driveParentFolderId + products list — this is configuration, not cache; must be preserved or re-entered.
- `scraper-status.json` + `scrape-log.json` — operational state; safe to reset (scheduler rebuilds on startup).
- Duplicate customer entries (slug collisions from name variants) — restore must deduplicate by account number, not slug.
- Customers whose names differ between territory sheet and Supportable sheet (e.g. "Lynden Logistics" vs "Lynden Incorporated") — restore should use Supportable sheet as name authority since it has account numbers already matched.
- AEs without a supportableSheetId yet — restore must handle partial AE configs gracefully.
- Customers with no account numbers (in territory sheet but not yet in Supportable) — keep them in the dashboard, show a visual indicator (e.g. "No subscriptions found") so it's clear they're unresolved, not missing.
- Name drift / slug migration (e.g. acquisition renames) — out of scope for restore; restore is a quick-recovery tool. Long-term solution tracked in BKL-BOOT-02 (scheduled Supportable sheet updates keep sheets current over time, which keeps slugs stable).

**Proposed implementation:**
1. `POST /api/admin/restore` — accepts optional `{ aeNames?: string[] }` to restore subset
2. For each AE: read Supportable sheet tab 1 → upsert customers (name + accountNumbers), read remaining tabs → write {slug}-sheets.json
3. Read pipeline sheet → write pipeline-data.json
4. Read CCSP sheet → write ccsp-data.json
5. Read territory sheet → sync AE-to-customer mapping in customers.json
6. Reset intelligence-jobs.json (mark all customers as needing re-generation)
7. Reset drive-watcher-state.json (trigger immediate Drive re-scan)
8. Admin UI button: "Restore from Sheets" with progress indicator per AE

Decision: DONE — Implemented src/restore-routes.ts with POST /api/admin/restore. Reads Supportable "Accounts" tab + per-customer tabs, CCSP sheet, and Pipeline sheet. Merges into customers.json, writes {slug}-sheets.json cache files, ccsp-data.json, and pipeline-data.json. Registered in server.ts. Does NOT restore: cases.json, daily briefs, intelligence files (see spec). Accepts optional { aeNames: string[] } to restore a subset.

### BKL-SF-01 | SF pipeline GSheet only captures ~375 of 1929 report rows — virtual scrolling bug
Status: ✅ DONE — 2026-04-08
Severity: HIGH
Priority: P1
Size: M
Source: Jason 2026-04-07, pipeline investigation
Files: src/sf-scraper.ts — scroll loop + row extraction
Description: SF Lightning report has 1,929 rows for the Northwest POD but GSheet only receives ~375. Root cause: single `querySelectorAll` after scroll captures only the DOM viewport (virtual scrolling evicts rows outside viewport). Fix: incremental capture at every scroll step, accumulating unique rows by fingerprint. Applied 2026-04-07 — requires repull + rebuild to verify.
Decision: DONE — verified 2026-04-08. pipeline-data.json contains 737 unique opps deduped from 1933 raw captured rows. Previous ~375 was due to single-capture after scroll; incremental accumulation with fingerprint dedup fixed this.

### BKL-SF-02 | Phil Yi / Philip Yi name mismatch causes 12 opps dropped from pipeline
Status: ✅ DONE — 2026-04-08 (immediate fix applied; long-term alias feature deferred to BKL-BOOT-02 scope)
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-07, pipeline investigation
Files: data/config/aes.json, data/config/customers.json, src/customer-routes.ts (filterToAEs)
Description: Territory sheet uses "Phil Yi" (display name); SF report owner field uses "Philip Yi" (legal name). `filterToAEs` does exact match → 12 Philip Yi opps dropped. Fixed aes.json + customers.json to "Philip Yi". Long-term: add name alias/fuzzy match in filterToAEs so territory sheet name doesn't need to exactly match SF owner name. Also: POD bootstrap re-runs will re-create a "Phil Yi" entry from the territory sheet, causing duplicates again.
Decision: DONE — aes.json and customers.json updated to "Philip Yi". Verified: Philip Yi now shows 54 opps in pipeline data. Alias/fuzzy match remains a future enhancement; note in BKL-BOOT-01 that POD re-bootstrap may re-introduce "Phil Yi" from territory sheet.

### BKL-BOOT-03 | POD Bootstrap seed from shared Supportable folder — skip scrape if sheet exists
Status: ⛔ OBSOLETE — 2026-04-10 — bootstrap no longer uses Supportable scraping (replaced by SF Bookings sheets); seeding concept moot
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-08 — enable seeding dashboard for another user from existing GSheet data
Files: dashboard/src/pages/SetupPage.tsx (or SetupWizard.tsx), src/bootstrap-orchestrator.ts
Description: Add one optional field to the POD bootstrap UI: "Shared Supportable Folder" (a Google Drive folder ID/URL). During the bootstrap Supportable step, before triggering a scrape, check that folder for a file matching `{AE Name} - Supportable` (same naming convention as today). If found: grab its Sheet ID, write to aes.json as supportableSheetId, skip the scrape entirely — AE's sheet column shows up exactly as today. If not found: fall through to existing Supportable discover + scrape flow unchanged. Field is optional — if blank, bootstrap runs exactly as today. Everything else (wizard flow, scaffolding, CCSP/SF runs, territory selection, Drive folder creation) stays identical. Sheet living in the shared folder does not break anything — all reads/writes use Sheet ID via Sheets API, Drive location is irrelevant once the ID is stored. AE's own Drive folder still needed for CCSP/Pipeline sheets. No Drive shortcut required — clean separation: shared data in shared folder, generated sheets in AE folder. Use case: Jason has existing Northwest POD AE sheets in a shared folder; a teammate deploys a fresh container, enters the shared folder ID, bootstrap links all 10 AE sheets in seconds instead of running 10x Supportable scrapes.

### BKL-BOOT-02 | Shareable Supportable pulls — central scrape + distribute to team
Status: ⛔ OBSOLETE — 2026-04-10 — Supportable disabled; SF Bookings sheets are the shared data source; problem this solved no longer exists
Severity: MEDIUM
Priority: P2
Size: L
Source: Jason 2026-04-07
Files: src/supportable-scraper.ts, src/bootstrap-orchestrator.ts, data/config/aes.json
Description: The Supportable scrape takes ~10 min/AE because it requires an authenticated CCSP session and scrapes live. Since the output (active subscriptions per account) is relatively stable week-to-week, it can be pre-seeded centrally and distributed. Strategy: (1) Schedule a nightly/weekly background job that scrapes Supportable for all AEs in the POD and writes to a shared Google Sheet (or per-AE sheets in a shared Drive folder). (2) Publish those sheet IDs in a config file or central registry. (3) When a teammate bootstraps a new AE, the wizard checks for a pre-seeded sheet first — if found, link to it and skip the 10-min scrape. Authentication constraint: the scraper requires the machine owner's CCSP session, so the central job runs on Jason's machine; only the *output sheets* are distributed. Each teammate still needs their own session for live re-scrapes but can bootstrap instantly using the pre-seeded data.
Note: BKL-BOOT-03 is the implementation of this strategy — the "shared folder pre-check" is the pickup mechanism.

### BKL-BOOT-01 | Setup Wizard — pre-populate existing sheet IDs to skip re-bootstrap
Status: ✅ DONE — 2026-04-08
Severity: MEDIUM
Priority: P2
Size: M
Source: Jason 2026-04-07
Files: dashboard/src/pages/SetupWizard.tsx, src/bootstrap-orchestrator.ts (isAEFullyBootstrapped)
Description: When re-running the wizard for an AE that already has supportableSheetId, ccspSheetId, pipelineSheetId, and driveFolderId in aes.json, the wizard should pre-populate those fields and mark those bootstrap steps as already complete — skipping the Supportable and CCSP scrape (which takes ~10 min/AE). Currently `isAEFullyBootstrapped()` skips entirely only during POD-level bootstrap; the single-AE wizard always re-runs all steps. UX: show existing IDs in the wizard, let user confirm or clear, and only re-run missing steps. This avoids the 104-minute re-bootstrap problem when adding one AE to an existing POD.
Decision: DONE — Extended knownAes type to include all 4 sheet IDs. Added matchedAeIsBootstrapped computed flag. When all 4 IDs are present: wizard shows green "already bootstrapped" banner with truncated sheet IDs, hides the prerequisites/button. "Force re-bootstrap" link shows the button again. forceRebootstrap flag resets on territory change.

### BKL-POD-05 | POD Bootstrap — all AEs show "error" even when Drive + Pipeline succeeded
Status: ✅ DONE — 2026-04-08
Severity: LOW
Priority: P3
Size: S
Source: Quinn QA 2026-04-07
Files: src/bootstrap-orchestrator.ts — bootstrapPOD result reporting
Description: When the Red Hat Portal is not connected, the bootstrap correctly creates Drive folders, customer subfolders, and pipeline sheets, but marks the AE status as "error: Zero accounts after retry". This is misleading — partial success isn't reflected. Consider reporting "partial" status with detail on which steps succeeded vs failed, rather than blanket "error".

### BKL-DATA-01 | Customers with no Supportable account numbers — name mismatch investigation
Status: 🟡 IN PROGRESS — 2026-04-08
Severity: MEDIUM
Priority: P2
Size: S
Source: Supportable sync 2026-04-08 (post BKL-SUP-01 retry fix)
Files: data/config/customers.json
Description: After full Supportable discover+scrape with word-backoff retry, and CCSP sync adding ~40 new customers, 40 customers total have 0 account numbers. Many may genuinely have no Red Hat portal presence; others have name mismatches.

2026-04-08 progress: Applied 10 supportableName overrides and re-queued discover for Danny Hollar, Duy Pham, Max Stroup, Tyler McManigal:
- Aligntech → "Align Technology"
- Kla Corporation → "KLA Corporation"
- Rxo Capacity Solutions → "RXO"
- Ringcentral → "RingCentral"
- Biomarin Pharmaceutical → "BioMarin Pharmaceutical"
- Trinet Group → "TriNet"
- Xpo → "XPO"
- Stancorp Financial Group → "StanCorp Financial Group"
- Terrapower → "TerraPower"
- Tri-state Generation And Transportation → "Tri-State G&T"

Additional overrides applied for Arka, Communify→Fincentric, Employers Holdings, Sierra Nevada Corporation, Unishippers, Cambia, Hotwire.
Full discovers run for all 4 remaining AEs (Tyler, Max, Paul, Philip) with complete word-backoff retry.

Final state (2026-04-08): 134/141 customers have account numbers (7 zero-account total):
- 3 confirmed no active Red Hat subscriptions (skipAccountDiscovery=true):
  - KLA Corporation (Danny Hollar) — filtered by entitlements/country
  - Communify Fincentric (Max Stroup) — not found in Supportable
  - Employers Holdings (Max Stroup) — all accounts filtered by entitlements
- 4 unresolvable via automation — need Jason manual investigation:
  - Hotwire Communications (Tyler McManigal) — searched "Hotwire", no match
  - Arka Group (Max Stroup) — searched "Arka", no match
  - Sierra Nevada (Paul Maes) — searched "Sierra Nevada Corporation" + backoff, no match
  - Cambia Health Solutions (Philip Yi) — searched "Cambia", no match
  These may be under a different name in Supportable, may have no RHEL subscriptions, or may be cloud/SaaS accounts not tracked in the portal.

### BKL-SUP-03 | Supportable detail-page extraction fails when page has 0 <th> elements
Status: ✅ DONE
ClosedAt: 2026-04-10
Severity: HIGH
Priority: P1
Size: S
Source: 2026-04-08 — Supportable discover run, observed pattern on Rubrik, Business Wire Asia Pacific, Lumentum Holdings, others
Files: src/supportable-scraper.ts — name-search extraction patterns
Description: When Supportable shows a single-match detail page (hasCustomerInfo=true, 9 tables, 0 <th> elements), all 3 account-number extraction patterns fail. The HTML size is ~31KB with 9 tables but no <th> elements — the tables use a different structure (probably <tr><td> without header row or use <strong>/<label> for field labels). Affected customers include Business Wire Asia Pacific, Rubrik, Lumentum Holdings (before backoff found it), and possibly others. The scraper logs: "detail page detected (hasCustomerInfo=true) but all 3 account-number extraction patterns failed". Fix: added Pattern 4 — DOM-based extraction that walks <strong>/<label>/<b>/<span> elements for "Account Number" labels with adjacent digit values, plus a fallback <tr>/<td> row scan. Commit 9db1b83.

### BKL-PVIEW-05 | normalizeProductName() missing mappings — 36 raw chips, chip bar wraps 3 rows
Status: ✅ DONE 2026-04-08
Severity: HIGH
Priority: P1
Size: S
Source: Quinn QA 2026-04-08 — full dataset (10 AEs, 102 customers) exposed unmapped names
Files: dashboard/src/utils/productName.ts — normalizeProductName()
Description: With 10 AEs and 102 customers, the product chip bar showed 36 unnormalized names including raw strings like "Advanced Cluster Management for Kubernetes for IBM Power", "JBoss Enterprise Application Platform", "AI Accelerator", "OpenStack", "Quay.io", "CCSP Subscription", "High Availability", "Learning Subscription". Chip bar wrapped to ~3 rows (312px height), dominating the top of the dashboard. Root cause: normalizeProductName() had only 12 rules and no mappings for ACM, ACS, AI/ML, OpenStack, Quay, CCSP, HA, Learning, JBoss, AMQ, 3scale, etc.
Decision: DONE — normalizeProductName() expanded with 20+ rules covering all known Red Hat product families. Quinn verified against live 102-customer dataset: 106 raw product descriptions collapse to 16 normalized chips (AAP, ACM, ACS, AI/ML, Beta, CCSP, Developer Subscriptions, Free, HA, Learning, Middleware, OCP, OpenStack, Partner Subscriptions, RHEL, Storage, Trial). CCSP gap patched: stripped name loses "CCSP" acronym; added "certified cloud" / "cloud and service provider" / "software access enablement" fallback. Chip bar expected to fit in 1-2 rows.

### BKL-PVIEW-06 | Reduce product chip bar to RHEL / OCP / AAP only
Status: ✅ DONE 2026-04-08
Severity: HIGH
Priority: P1
Size: S
Source: Jason brain dump 2026-04-08 — 18 chips is too much clutter for daily use
Files: dashboard/src/utils/productName.ts, dashboard/src/App.tsx (or wherever discoverAllProducts is called)
Description: Even after normalization, 18 product chips is noisy. For daily use the only meaningful filter categories are RHEL, OCP, and AAP — the three core Red Hat platforms the POD sells. All other chips (ACM, ACS, AI/ML, Beta, CCSP, Developer Subscriptions, Free, HA, Learning, Middleware, OpenStack, Partner Subscriptions, Quay, Storage, Trial) should be hidden from the chip bar. "All Products" chip stays. Implementation: filter discoverAllProducts output to only emit RHEL, OCP, AAP (plus "All Products"). Other product labels still used internally for subscription card expansion — only the chip UI is restricted.

### BKL-PVIEW-07 | Merge ASA/Product views — one view, product chips always visible
Status: ✅ DONE 2026-04-10 (verified by Marcus — no ASA/Product toggle exists; views already merged, chips always visible)
Severity: MEDIUM
Priority: P2
Size: M
Source: Jason brain dump 2026-04-08 — two views are redundant; only difference is morning brief presence
Files: dashboard/src/App.tsx, dashboard/src/components/Sidebar.tsx
Description: ASA View and Product View are nearly identical — the only observable difference is that Morning Summary is hidden in Product View. This isn't enough differentiation to justify a separate view toggle. Merge back to a single view that always shows Morning Summary and always shows the product chip bar. Remove the ASA/Product toggle from the sidebar entirely. Product chips (RHEL / OCP / AAP / All Products per BKL-PVIEW-06) remain permanently visible above the AE chips. The view-mode localStorage key and toggle code can be removed.

### BKL-PVIEW-08 | Morning brief collapse — keep bullet outline visible when closed
Status: ✅ DONE 2026-04-10 (verified already implemented — compactBullets in MorningSummary.tsx lines 92-111)
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason brain dump 2026-04-08 — closing the full brief should not hide the summary bullets
Files: dashboard/src/components/MorningSummary.tsx
Description: The Morning Summary card has a "Today's Brief" expand/collapse toggle. When collapsed, the Priority Today / Actions / Watch bullet points disappear entirely — only the header row remains. The bullet outline is high-value at-a-glance context that should survive the collapse. When collapsed, show the bullet points (stripped of full prose, just the bold customer names + short label) as a compact inline list. The "Today's Brief" button expands to show the full narrative. Closed state: header + compact bullet list. Open state: header + full brief prose. This mirrors the free/beta/trial pattern used on subscription cards.

### BKL-PVIEW-09 | Product filter cascade — KPIs filter by selected product chip
Status: ✅ DONE 2026-04-10 (verified live by Quinn — KPI tiles filter by selected product chip)
Severity: HIGH
Priority: P1
Size: M
Source: Jason brain dump 2026-04-08 — KPI numbers should reflect selected product, not full portfolio
Files: dashboard/src/App.tsx, dashboard/src/components/KPISection.tsx (or similar)
Description: When a product chip (OCP, RHEL, AAP) is selected, all KPI tiles should filter to that product context: Open Cases count → only cases for that product; Sev 1 Cases → only Sev 1 for that product; Renewals in 30d / 90d → only subscriptions matching that product; Meetings Today/This Week → unchanged (meetings are not product-scoped). Currently KPIs show full portfolio numbers regardless of product chip selection. Implementation: pass activeProduct filter down to each KPI computation. Cases: filter by product keyword in case summary. Renewals: filter by normalizeProductName(subscription) === activeProduct.

### BKL-PVIEW-10 | Product filter cascade — RH Cases modal filters by selected product
Status: ✅ DONE 2026-04-10 (verified live by Quinn — cases modal filters + collapses non-matching by product chip)
Severity: HIGH
Priority: P1
Size: M
Source: Jason brain dump 2026-04-08 — cases modal ignores product chip, shows unrelated cases (Image #3)
Files: dashboard/src/components/KPISev1Modal.tsx (or cases modal component)
Description: When OCP is selected as the product chip, the Open Support Cases modal should show OCP/OpenShift-related cases at the top and collapse non-OCP cases into a hidden section at the bottom — same pattern used for Free/Beta/Trial subscriptions on account cards. Currently all 34 cases show regardless of chip selection (Image #3: "Updated the MCP and a node didnt come back", "On Redhat 9.6 cockpit", "Upgrade Satellite", etc. — mix of OCP and non-OCP). Product matching for cases: check case summary text for product keywords (openshift, ocp, cluster, container, kubernetes for OCP; rhel, enterprise linux, satellite for RHEL; ansible, aap for AAP). Non-matching cases collapsed with "Show N more" toggle at bottom. Note: Jason observed KPI shows 11/34 — may indicate 11 are OCP-related; verify against actual case summaries.

### BKL-PVIEW-11 | Product filter cascade — Renewals (30d + 90d) filter by selected product
Status: ✅ DONE 2026-04-10 (verified live by Quinn — renewal modals filter by selected product chip)
Severity: HIGH
Priority: P1
Size: M
Source: Jason brain dump 2026-04-08 — renewal modals ignore product chip (Image #5)
Files: dashboard/src/components/ (renewal modals for Expiring Within 30 Days + Renewals in 30-90 Days)
Description: When OCP is selected, the Expiring Within 30 Days and Renewals in 30-90 Days modals should show only OCP-matching subscriptions. Non-matching subscriptions collapsed or hidden. Currently both modals show all subscriptions regardless of chip. Image #5 shows: Vail Resorts (OCP Platform Plus ✓, Satellite ✗, OCP Broker ✓), Dropbox (OCP on AWS ✓), Pure Storage (Quay ✗), H2O.AI (OCP on AWS ✓, OCP Dedicated GCP ✓), Uber (OCP Dedicated ✓) — so with OCP selected, Satellite and Quay rows should be collapsed/hidden. Implementation: filter renewal rows using normalizeProductName(subscriptionName) === activeProduct before rendering. Collapsed non-matching rows shown as "N other subscriptions hidden" with expand toggle.

### BKL-PVIEW-12 | Product filter cascade — Pipeline data filters by selected product
Status: ✅ DONE — 2026-04-10 (implemented as BKL-UX57 — oppMatchesProducts() in PipelineSection.tsx)
Severity: HIGH
Priority: P1
Size: M
Source: Jason brain dump 2026-04-08 — pipeline section ignores product chip entirely
Files: dashboard/src/components/PipelineSection.tsx
Description: When OCP, RHEL, or AAP is selected as the product chip, the pipeline section (SF opportunities) should filter to show only opportunities related to that product. Currently pipeline tiles and opportunity list show full portfolio regardless of chip. Implementation: SF opportunity data includes product fields or opportunity name — filter by product keyword match (same approach as cases). Opportunities without a matching product in the name/type are collapsed or shown as a summary count. If SF data doesn't have reliable product tagging, show a "Pipeline data not product-scoped" notice rather than silently showing everything.

### BKL-CAL-01 | Calendar showing proposed/unconfirmed meetings as confirmed
Status: ✅ DONE 2026-04-08
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason brain dump 2026-04-08 — E. & J. Gallo Winery "[Proposed Time]" meeting showing in Today's Meetings (Image #6)
Files: src/calendar-routes.ts (or calendar scraper/parser), dashboard/src/components/CalendarStrip.tsx
Description: Today's Meetings strip is showing a meeting titled "[Proposed Time] Robert Half + Red Hat | Intro..." for E. & J. Gallo Winery. Jason confirms he does not have a confirmed meeting with this customer today. The "[Proposed Time]" prefix in Google Calendar indicates a tentative/proposed event that has not been accepted. Calendar scraper is including tentative/proposed events in the confirmed meeting feed. Fix: filter out events with responseStatus !== 'accepted' OR where the event title starts with "[Proposed Time]" or similar tentative markers. Also consider filtering events where Jason's own RSVP is "tentative" or "declined". This is a data quality issue causing incorrect customer associations on the dashboard.

### BKL-TEST-04 | CCSP auth guard spec uses wrong field name
Status: ✅ DONE 2026-04-08
Severity: LOW
Priority: P3
Size: XS
Source: Quinn QA 2026-04-08 — test/api/error-paths.spec.ts:22
Files: test/api/error-paths.spec.ts
Description: CCSP auth guard test expects response body to have `error` field on 409, but server returns `reason` field. Test fails but this is a spec mismatch, not a code bug. Fix: update test to assert `body.reason` instead of `body.error`. Confirm which field name is the intended contract first.


### BKL-WIZ-01 | Bootstrap wizard — Google Drive folder preview missing
Status: ✅ DONE 2026-04-10 (verified already implemented — onBlur handlers on all 3 Drive folder inputs in SetupPage.tsx)
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-08 — observed during SF bookings bootstrap test
Files: dashboard/src/pages/SetupPage.tsx — AutoBootstrapForm or PodBootstrapSection
Description: The Google Drive folder preview (folder name confirmation shown after parent folder ID is entered) was lost at some point. Previously worked — BKL-POD-01 confirms it was implemented for PodBootstrapSection. Regression likely introduced during a recent rebuild or UI change. Fix: restore the onBlur/validate-folder call and green "✓ FolderName" / red error display that matches the original AutoBootstrapForm pattern. Verify in both single-AE and POD bootstrap forms.

### BKL-WIZ-02 | POD Bootstrap — no cancel button to stop in-flight run
Status: ✅ DONE 2026-04-10 (verified: cancellation flag in bootstrap-orchestrator.ts:223, POST /api/bootstrap/cancel at line 719, cancelPodBootstrap() in SetupPage.tsx:3154 with Cancel button)
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-08 — discovered during SW bootstrap test
Files: dashboard/src/pages/SetupPage.tsx — PodBootstrapSection, src/bootstrap-orchestrator.ts
Description: Once POD Bootstrap is started there is no way to cancel it from the UI. The run continues until all AEs complete or timeout. Need a "Cancel" button that calls a stop endpoint to abort the in-flight bootstrap, mark it as cancelled, and reset state so a new run can be started. Backend needs a POST /api/bootstrap/pod/cancel endpoint.

### BKL-ADMIN-01 | Admin page — "Reset All Data" button for clean wipe
Status: ✅ DONE — already exists on Setup page as "Reset Data Only" / "Full Reset"
Severity: LOW
Priority: P3
Size: S
Source: Jason 2026-04-08 — no UI way to clear AEs/customers/cache for fresh bootstrap test
Files: dashboard/src/pages/AdminPage.tsx, src/scrape-api.ts or server.ts
Description: Add a "Reset All Data" button in Admin page (dangerous zone, confirmation required) that wipes aes.json → [], customers.json → [], data-sources.json, and data/cache/*. Equivalent to what the DA does manually via podman exec. Should require a typed confirmation ("RESET") before proceeding. Useful for fresh bootstrap tests without needing CLI access.

### BKL-WIZ-03 | Bootstrap step labels outdated after SF bookings migration
Status: ✅ DONE 2026-04-08
Severity: LOW
Priority: P3
Size: XS
Source: Jason 2026-04-08 — observed during SW bootstrap, steps still show old names
Files: src/bootstrap-orchestrator.ts — step name strings
Description: Bootstrap step 3 is labeled "Discover Account Numbers" (correct) and step 4 is "Create Supportable Sheet" (wrong — now writes SF bookings data). Step names are hardcoded strings in bootstrap-orchestrator.ts. Update to: step 3 → "Read SF Bookings Sheet", step 4 → "Write Subscriptions Sheet", step 5 → "Create CCSP Sheet" (unchanged), step 6 → "Sync Pipeline Sheet" (unchanged). Also update step detail messages that reference Supportable.

### BKL-BOOT-02 | matchPodSheet() substring match caused NW to resolve to SW bookings sheet
Status: ✅ DONE 2026-04-08
Severity: HIGH
Priority: P1
Size: XS
Source: 2026-04-08 — NW POD bootstrap populated 0 subscriptions on first run; all NW AEs missing supportableSheetId
Files: src/sf-bookings-reader.ts — matchPodSheet() lines 78-92
Description: Territory strings like `WEST_COMM_CORP_NORTHWEST_TERR04` split into tokens including "west" (4 chars, passes length filter). `sLower.includes(w)` matched "southwest" before "northwest" because "southwest".includes("west") is true. All 8 NW AEs got the SW POD sheet ID instead of the NW sheet. Fix: changed to word-boundary regex `new RegExp(\`\\b${w}\\b\`).test(sLower)` — "southwest" has no word boundary around "west" inside it, so the false match is eliminated. Confirmed on second bootstrap run: all 8 NW AEs received NW sheet ID; 174 customers processed; 58 with subscription data.

### BKL-DRIVE-01 | Drive folder hierarchy — add POD subfolder layer
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P2
Size: M
Source: Jason 2026-04-08
Files: src/bootstrap-orchestrator.ts — Drive folder creation steps
Description: Current structure: parentFolderId / AE Name / customer folders. Desired: parentFolderId / POD Name / AE Name / customer folders. During POD bootstrap, create a subfolder named after the POD (e.g. "Southwest") under parentFolderId if it doesn't already exist, then create each AE's Drive folder under that POD folder instead of directly under parentFolderId. The POD display name (from the SF bookings sheet displayName, e.g. "Southwest" or "Northwest") should be used as the folder name. AE-level bootstrap (single AE) should skip the POD layer. Existing AEs are unaffected unless re-bootstrapped.

### BKL-RH-01 | RH batch scraper — per-account chunking to prevent high-volume account starvation
Status: ✅ DONE — 2026-04-10 (smarter starvation detection: after each chunk, re-query zero-case accounts individually when pagination limit hit; commit 8916b1a)
Severity: HIGH
Priority: P1
Size: M
Source: 2026-04-09 — SW pod test run
Files: src/rh-scraper.ts — batch query chunk logic
Description: When multiple accounts are batched together in a single Solr query (e.g., 15 accounts in one chunk), a high-volume account like QAD (5856163) that has hundreds of cases can consume all 10 pagination pages. The scraper stops after the pagination limit, so all other accounts in the same chunk get 0 cases. Fix: scrape each account in its own chunk (chunk size = 1) so each account gets independent pagination up to 10 pages. Alternatively, per-account case counts could cap accounts with >N pages before moving to the next. Confirmed: with 15 accounts queried, 60/60 cached cases were from QAD only.

### BKL-RH-02 | RH batch scraper — duplicate cases across pagination batches
Status: ✅ DONE 2026-04-10 (verified: seenCaseNumbers Set in pushCases() at rh-scraper.ts:468-669 deduplicates before allCases.push — was already fixed)
Severity: MEDIUM
Priority: P2
Size: XS
Source: 2026-04-09 — Quinn QA review
Files: src/rh-scraper.ts — batch result collection
Description: cases.json contains 6 unique cases each duplicated 10x (60 total). The batch scraper collects cases across multiple pages but does not deduplicate by case number before writing to cache. Fix: deduplicate by caseNumber before writing the results array. One-line fix in the dedup step after all pages are collected.

---

## AI Cost Optimization

### BKL-AI-01 | Route high-volume AI calls to cheaper model
Status: ✅ DONE 2026-04-10 (doc-extraction.ts already uses getGeminiModelLite() via Flash-Lite routing commit; other files referenced in backlog don't exist yet)

### BKL-AI-02 | Cap maxOutputTokens at realistic limits
Status: ✅ DONE 2026-04-10 (account-intelligence.ts: 16384→8192 in all 3 Gemini calls, commit 9258ddb)

### BKL-AI-03 | 7-day TTL on account intelligence cache
Status: ✅ DONE 2026-04-10 (runIntelligencePipeline checks cachedAt age; configurable via INTELLIGENCE_CACHE_TTL_DAYS env, commit 9258ddb)

### BKL-AI-04 | Skip intelligence pipeline for customers with no data
Status: ✅ DONE 2026-04-10 (pre-flight gate: skip if accountNumbers=0 && subscriptions=0; writes skipped:true stub, commit 9258ddb)

### BKL-AI-COST-04 | Admin UI setting for doc-classify age filter (docClassifyMaxAgeDays)
Status: ✅ DONE 2026-04-10
Severity: MEDIUM
Priority: P1
Size: S
Source: Jason 2026-04-10 — unlimited classify by default, but configurable
Files: dashboard/src/pages/AdminPage.tsx, src/settings-api.ts, src/doc-extraction.ts
Description: Added number input in AI Settings card for docClassifyMaxAgeDays. 0 = unlimited (classify all docs regardless of age), >0 = skip docs older than N days. Backend AiConfig default is 0. Committed 133ebbe.

### BKL-AI-01 | Use gemini-2.0-flash for structured output tasks
Status: ✅ DONE — 2026-04-10 (getGeminiModelLite() routing exists in settings-api.ts; doc-extraction.ts uses lite path; referenced product-intelligence/feature-radar files don't exist in current codebase)
Severity: LOW
Priority: P2
Size: S
Source: 2026-04-09 — cost review
Files: src/product-intelligence.ts, src/product-feature-radar.ts, src/customer-product-intel.ts, src/doc-extraction.ts, src/product-release-radar.ts
Description: These files use gemini-2.5-flash for structured JSON extraction and product intelligence — tasks that don't need frontier reasoning. gemini-2.0-flash is ~10× cheaper and sufficient for these. Keep gemini-2.5-flash only in src/customer.ts (brief synthesis) and src/account-plan.ts (account plans) where output quality matters. Requires adding gemini-2.0-flash as an allowed model in settings-api.ts and updating each call site.

### BKL-AI-02 | Lower maxOutputTokens to realistic caps
Status: ✅ DONE — 2026-04-10 (account-intelligence.ts: 8192 per commit 9258ddb; account-plan.ts: 32768→8192 both call sites)
Severity: LOW
Priority: P2
Size: XS
Source: 2026-04-09 — cost review
Files: src/account-plan.ts (32768), src/account-intelligence.ts (16384 × 2 calls)
Description: account-plan.ts sets maxOutputTokens: 32768 — far above what a typical account plan needs. account-intelligence.ts sets 16384 and calls twice per customer. Gemini charges on actual output tokens but oversized caps bloat prompts and generated content length. Audit actual output sizes via gemini-cost-tracker and cap account-plan at 8192, account-intelligence at 8192.

### BKL-AI-03 | Add TTL to account intelligence cache
Status: ✅ DONE — 2026-04-10 (INTELLIGENCE_CACHE_TTL_DAYS env var, 7d default; skips regeneration if cachedAt < TTL; commit 9258ddb)
Severity: LOW
Priority: P2
Size: S
Source: 2026-04-09 — cost review
Files: src/account-intelligence.ts, src/cache-layer.ts
Description: Brief cache has a 24h TTL (ADR-007). Account intelligence has no TTL — it regenerates on every generate-all trigger. Add a 7-day TTL: skip regeneration if cachedAt is less than 7 days old and source data hash is unchanged. This prevents re-running expensive Gemini calls on stable accounts. Use the same hash-based staleness check already in cache-layer.ts.

### BKL-AI-04 | Skip intelligence pipeline for customers with no data
Status: ✅ DONE — 2026-04-10 (pre-flight gate in runIntelligencePipeline: skip if accountNumbers=0 && subscriptions=0; writes skipped:true stub; commit 9258ddb)
Severity: LOW
Priority: P2
Size: XS
Source: 2026-04-09 — cost review
Files: src/account-intelligence.ts, src/customer-product-intel.ts
Description: Customers with no account numbers, no cases, and no subscriptions get the full intelligence pipeline run, burning tokens for effectively empty output. Add a pre-flight gate: if accountNumbers.length === 0 && subscriptions.length === 0, skip AI generation and write a minimal stub cache entry. Log skipped customers for visibility.

### BKL-AI-05 | Rate-limit generate-all on bootstrap — don't run 72 customers at once
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: M
Source: 2026-04-09 — cost review
Files: src/bootstrap-orchestrator.ts, src/account-intelligence.ts
Description: generate-all auto-triggers for every newly bootstrapped customer. Bootstrapping 72 SW customers triggers 72 simultaneous intelligence pipeline runs — a spike cost event. Consider: (a) background queue with max concurrency of 5, or (b) making generate-all manual-only post-bootstrap with a UI trigger. Option (a) is lower friction. Either prevents the burst billing from large pod bootstraps.

## Calendar & Data Source Issues (2026-04-09)

### BKL-CAL-02 | Misleading "Synced just now" status for Calendar/CCSP/Pipeline
Status: ✅ DONE 2026-04-10 (Marcus commit 96bf595 — CCSP and Pipeline show record counts or 0-record warning instead of generic "Synced just now")
Severity: MEDIUM
Priority: P2
Size: S
Source: 2026-04-09 — Jason debugging session
Files: dashboard/src/components/ (status indicators), src/scraper-manager.ts
Description: UI shows "Synced just now" success status when the background queue accepts a scrape task, but the actual scrape may fail silently with 0 records. Status text should reflect actual data written (row count, timestamp of last successful write), not just queue acceptance. Users see green checkmarks on stale or empty data.

### BKL-CCSP-01 | No Tableau re-auth prompt on expired session
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: M
Source: 2026-04-09 — Jason debugging session
Files: src/ccsp-scraper.ts, dashboard/src/pages/ (admin or status UI)
Description: When Tableau session expires, CCSP scrape silently returns 0 rows and BKL-S17 guard prevents overwrite — so data stays stale but no error surfaces. No user-facing prompt to re-authenticate with Tableau. Should detect expired session (0-row result or auth error) and surface a warning in the UI so the user knows to re-login via VNC.

### BKL-CAL-03 | Calendar was fetching primary calendar only
Status: ✅ DONE 2026-04-09
Severity: MEDIUM
Priority: P2
Size: S
Source: 2026-04-09 — Jason debugging session
Files: src/calendar-routes.ts
Description: Calendar integration was only fetching events from the user's primary Google Calendar, missing events from shared/secondary calendars. Fixed 2026-04-09: now fetches all calendars and starts query window at midnight (was using current time, missing earlier events).
Decision: DONE — fetches all calendars, query starts at midnight. Verified with multi-calendar user.

### BKL-CAL-04 | Calendar title keyword false-matching on common words
Status: ✅ DONE 2026-04-09
Severity: MEDIUM
Priority: P2
Size: S
Source: 2026-04-09 — Jason debugging session
Files: src/calendar-routes.ts
Description: Customer names containing common English words like "office", "services", "systems" were matching unrelated calendar events (e.g., "Office Hours" matching a customer named "X Office Solutions"). Fixed 2026-04-09: added stopword list to exclude common words from title keyword matching, preventing false customer-event associations.
Decision: DONE — stopword list filters common words from customer name tokens before calendar event matching.

### BKL-CAL-05 | RH Cases sync shows blank spinner during active sync (no status text)
Status: ✅ DONE 2026-04-10 (verified by Marcus — SetupPage.tsx:2913-2921 already shows Syncing text with spinner)
Severity: LOW
Priority: P3
Size: XS
Source: 2026-04-10 — Jason reported
Files: dashboard/src/ (Admin/Setup data sources panel, RH Cases sync button/status)
Description: While RH Cases scrape is in progress, the sync status area shows only a spinning wheel with no text. After completion it correctly shows "Synced just now — 25". The missing state is the in-progress indicator — should show something like "Syncing..." or the last known status + spinner instead of a blank area.
Decision: OPEN — fix in-progress label so status is always visible during and after sync.

### BKL-DOM-01 | Domain inference uses static override file instead of automated lookup
Status: ✅ DONE 2026-04-10 (verified: domains.ts:97-119 uses Clearbit autocomplete API as web lookup source; also cross-references Gmail contacts + Google Calendar attendees for signal)
Severity: MEDIUM
Priority: P2
Size: M
Source: 2026-04-10 — Jason + research session
Files: src/setup-routes.ts (infer-domains endpoint)
Description: Bootstrap domain inference uses a one-pass AI guess that fails on legal entity names, rebrands (Musarubra→Trellix), mergers (PCM→Insight), typos (Freeeport, Mattell), and venue names (Caesars Palace→caesars.com). Currently requires manual intervention after each bootstrap. Goal: fully automated, self-maintaining, no static override file.
Fix: Implement waterfall in infer-domains endpoint: (1) Clearbit Autocomplete (free, no key, fast — ~65% hit rate), (2) LLM with web search fallback for misses (handles rebrands/mergers/typos — adds ~$0/run at PAI scale). Domain validation (HTTP check) after each step. Flag unresolvable for admin review. Expected: 95%+ automated accuracy, zero user intervention for new pods.
Decision: OPEN — implement waterfall approach. No API keys needed beyond what PAI already has.

### BKL-CCSP-02 | CCSP sheets all empty — Tableau browser scraper never populated data for new pod
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P1
Size: M
Source: 2026-04-10 — Jason reported 0 records; confirmed via logs
Files: src/ccsp-scraper.ts, data/cache/ccsp-data.json
Description: All 9 AE CCSP Google Sheets show `<2 rows` across every tab. The ccsp-read path (reads from Sheets → cache) returns 0 records because Tableau browser scraper has never written to these sheets for the SW pod. Error pattern in logs: `[ccsp-read] known sheet empty — searching AE Drive folder for alternative CCSP sheet → no alternative found`. The Tableau browser scrape needs to run in VNC to populate the sheets. Investigating whether Tableau session is valid, scraper is reaching the right workbook/views, and write path is correct.
Decision: DONE — ccsp-data.json verified 2026-04-10: 2,417 records present. Scraper ran successfully.

### BKL-SF-01 | SF Pipeline returning only 1 record — browser scraper not populating sheets for new pod
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P1
Size: M
Source: 2026-04-10 — Jason reported; pipeline-data.json confirms 1 record only
Files: src/sf-scraper.ts, src/pipeline.ts, src/scrape-api.ts
Root cause: Two bugs found and fixed:
  1. KEEP_COLS in sf-scraper.ts dropped "Opportunity Territory Name" before territory filter could read it — fell back to owner-name matching (functional but no territory routing).
  2. parsePipelineRows in pipeline.ts deduplicated by Opportunity Number — when oppNumber is empty (SF reports often omit it), all rows mapped to the same "" key; only the first row per file survived. 8 records returned from 1068 scraped rows.
Fix: (1) Added "Opportunity Territory Name" to both KEEP_COLS sets in sf-scraper.ts. (2) parsePipelineRows now uses oppId || oppNumber || accountName|oppName|closeDate as dedup key. SF scrape re-ran, 1068 rows written to 9 AE sheets, pipeline refresh returned 481 records (245 open, $28.1M ACV).
Decision: DONE — verified 2026-04-10. Run another SF scrape to populate territory column now that KEEP_COLS preserves it.

### BKL-CAL-06 | Calendar false-positive customer matches via single domain attendee
Status: ✅ DONE — 2026-04-10 (corroboration gate + TITLE_STOPWORDS expansion)
Severity: HIGH
Priority: P1
Size: S
Source: 2026-04-10 — Jason screenshot: "Virt Power 90" labeled Tucson Electric Power, "Upgrade troubleshooting" labeled U S Epson
Files: src/google.ts (fetchCalendar, matchedCustomers logic)
Root cause: Single domain attendee triggered full customer classification. Second fix round: TITLE_STOPWORDS was missing directional/generic words ("west", "east", "north", etc.) — "Insurance Of West" matched "West Corp ASA Team" via "west" keyword.
Fix: (1) Corroboration gate: domain match requires 2+ attendees OR title keyword from customer name. (2) Expanded TITLE_STOPWORDS to include directional words (west/east/north/south/central/mid/pacific/american/western/eastern/northern/southern) and generic terms (corp/enterprise/digital/data/cloud/net/connect). Deployed 2026-04-10.
Decision: DONE — monitoring for remaining false positives. See BKL-CAL-07 for follow-on bug.

### BKL-CAL-07 | Calendar auto-domain match fires on single-char first-word of customer name
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P1
Size: XS
Source: 2026-04-10 — Jason screenshot: "Illumio/Redhat Openshift cadence" still tagged as U S Epson after BKL-CAL-06 fix
Files: src/google.ts (fetchCalendar, matchedCustomers — auto-domain path)
Root cause: Auto-domain matching uses `co.includes(normAlpha(c.name.split(/[\s,]/)[0]))` — first word of "U S Epson" is "U", normalized to "u", which substring-matches inside "illumio". Any meeting with 2+ @illumio.com attendees triggers U S Epson via auto-domain + corroboration gate passes on attendee count.
Fix: Add `firstWord.length > 2` guard to auto-domain filter so single/double-char first-words (initials like "U", "A", "B") cannot trigger auto-domain matching. One-line fix in google.ts.
Decision: OPEN — needs Marcus, rebuild required.

### BKL-UX51 | Product filter (OCP/AAP/RHEL) causes dashboard to go black
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P1
Size: S
Source: 2026-04-10 — Jason reported: selecting a product filter from the top dashboard (OCP, AAP, or RHEL) causes the page to go black
Files: dashboard/src/ (top filter bar, product filter component, dependent data fetch)
Description: Selecting a product filter from the top dashboard navigation causes the entire page to render black/blank. All three product options (OCP, AAP, RHEL) trigger this. Likely a React rendering crash (unhandled error in component tree, missing null check on filtered data, or a useState/useEffect cycle that produces undefined/null state on filter change). Should surface an error boundary instead of a black screen.
Decision: OPEN — needs investigation. Check browser console for errors when filter is selected.

### BKL-SF-02 | AE "TBH" placeholder name — pipeline records will never match
Status: ✅ DONE — 2026-04-10 (by design: filterToAEs() primary path uses territory field not AE name; TERR01-tagged SF records pass through correctly; on hire, re-bootstrap replaces TBH with real name and both passes work)
Severity: MEDIUM
Priority: P2
Size: XS
Source: 2026-04-10 — Marcus SF investigation
Files: data/config/aes.json, src/scrape-api.ts (write-side AE filter), src/customer-routes.ts (filterToAEs)
Description: AE named "TBH" (placeholder — real name unknown) has 14 customers but will never receive pipeline records. The AE name filter (both write-side and read-side) matches by first name prefix — "TBH" doesn't match any real person's first name in SF opportunity owner fields. TBH's pipeline sheet will always be empty. Fix: update "TBH" to the actual AE's name in aes.json, or implement a territory-based fallback for the pipeline filter.
Decision: OPEN — requires knowing the real AE name for TERR01.

### BKL-TEST-03 | Quinn testing wiped production customers.json — test isolation guard needed
Status: ✅ DONE — 2026-04-10
Severity: CRITICAL
Priority: P0
Size: M
Source: 2026-04-10 — Quinn audit replaced customers.json with Acme Corp test fixture
Files: src/setup-routes.ts or server.ts (__test/snapshot endpoint), QUINN-STANDARD.md
Description: Quinn's full-system audit replaced customers.json with the Acme Corp test fixture, wiping 105 real customers. The snapshot/restore mechanism did not save state before testing. The __test/snapshot endpoint must be called BEFORE any test that modifies config state, and the restore must always run after. Additionally Quinn-standard must explicitly prohibit modifying customers.json or triggering any bootstrap/wipe flows during audits. Recovery required POST /api/admin/restore from Supportable sheets.
Decision: OPEN — add hard guard: if customers.json contains real data (>1 customer), __test/restore must require explicit confirmation. Update QUINN-STANDARD.md to prohibit config-destructive operations.

### BKL-CCSP-03 | CCSP shows stale AE data after customers.json wipe — cache not invalidated
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: S
Source: 2026-04-10 — Jason reported CCSP shows old AEs after disk wipe
Files: src/cache-layer.ts, src/customer-routes.ts, src/refresh-engine.ts, src/restore-routes.ts
Fix: Added isCCSPCacheStale(currentSheetIds) to cache-layer.ts — compares cached fileIds against current AE ccspSheetId values. Read-path endpoints (/api/ccsp, brief generation) now check staleness before serving. refreshCCSP bypasses stale-overwrite guard when AE set changed. POST /api/admin/restore invalidates stale cache file. Deployed 2026-04-10.
Decision: DONE.

### BKL-TEST-05 | Sync Now buttons untested against empty cache — cold-start validation needed
Status: ✅ DONE — 2026-04-10 (Quinn validated: cold-start sync works for CCSP and pipeline)
Severity: MEDIUM
Priority: P2
Size: S
Source: 2026-04-10 — Jason: "test each sync now can sync properly by erasing the cache for ccsp and pipeline"
Files: data/cache/ccsp-data.json, data/cache/pipeline-data.json, dashboard/src/pages/SetupPage.tsx
Description: "Sync Now" for CCSP and SF Pipeline have never been validated against a fully empty cache (cold-start). The pipeline parser had a dedup bug (BKL-SF-01 root cause) that was masked because the cache always had prior data. Test procedure: (1) backup cache files, (2) delete ccsp-data.json and pipeline-data.json, (3) click Sync Now for each and verify the dashboard populates correctly, (4) verify no blank-screen or zero-record states appear. Run this once the current CCSP/pipeline fixes are stable.
Decision: DONE — Quinn validated 2026-04-10. Pipeline: removed cache file, API correctly returned 0 records, triggered POST /api/scrape/salesforce, data arrived in ~42s (286 records, $32M ACV across 9 AEs). CCSP: removed cache file, server served from memory (resilient), triggered POST /api/scrape/ccsp, scraper ran end-to-end (Tableau connect, 9 AE sheets written, cookies saved), refresh skipped because source data unchanged (correct behavior). Both scrapers handle cold-start correctly. Production data restored from backups, verified intact (9 AEs, 245 pipeline records, 53 CCSP customers).

### BKL-BOOT-03 | Single-AE bootstrap regression check — verify one-at-a-time bootstrap still works
Status: 🟡 IN PROGRESS
Severity: HIGH
Priority: P1
Size: M
Source: 2026-04-10 — Jason: "we need to do a review to make sure if we go back to bootstrapping one ae at a time nothing has broken after doing all this work"
Files: src/bootstrap-orchestrator.ts, src/setup-routes.ts, src/scrape-api.ts, dashboard/src/pages/SetupPage.tsx (setup wizard)
Description: Significant changes have been made since the SW pod bootstrap (territory filter, domain waterfall, CCSP cache invalidation, pipeline parser, snapshot guard, CCSP re-auth prompt). Need to verify the full single-AE bootstrap flow still works end-to-end: (1) Setup Wizard creates AE entry + territory config, (2) Bootstrap wizard runs all 6 steps (Drive folder → customer folders → RH discovery/scrape → CCSP scrape → SF pipeline sync), (3) Post-bootstrap: domain inference, account intelligence batch, (4) Customer brief generates on first page view. Test against a real new AE or use a throwaway test AE. Compare against the runbook in CLAUDE.md "Adding a New AE" section.
Decision: OPEN — run Quinn on setup + bootstrap flow with a test AE. Block any new pod bootstrap until this is validated.

### BKL-UX54 | All customer health dots show amber — misleading
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P0
Size: XS
Source: 2026-04-10 — Jason: "all customer tiles show amber dot indicating unhealthy, this is misleading"
Files: src/health-score.ts
Root cause: `scoreMeetings()` and `scoreEmails()` always return score=50 (v1 placeholder — no real data). `scoreCases()` returns 50 when no account numbers. `scoreCloudSpend()` returns 50 when no CCSP cache. These "no data → 50" signals each had weights (0.15+0.15+0.25+0.10 = 0.65) dragging almost every customer's composite score into the 40–70 amber band. Even a perfectly healthy customer (no cases, good subscriptions, pipeline) scored ~75 — just barely green. Any customer with Sev3 cases or missing data landed at ~60, solidly amber.
Fix: Added `isNoData(signal)` check in `computeHealthScore`. Subscores whose signal text indicates missing/placeholder data (v1 markers, "No cloud spend data", "No subscription data", "cannot match cases") are excluded from the weighted average. Remaining subscores are renormalized (divided by their combined weight). Falls back to all signals if everything is no-data.
Decision: FIXED — 2026-04-10

### BKL-UX53 | Product filter crashes with "e.toLowerCase is not a function" on every product
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P0
Size: XS
Source: 2026-04-10 — Jason: selecting any product filter shows "Something went wrong — e.toLowerCase is not a function"
Files: dashboard/src/App.tsx, dashboard/src/components/KPICards.tsx
Root cause: `caseMatchesProducts` typed `caseProduct` as `string` and called `.toLowerCase()` on it directly. But the RH Portal API returns `case_product` as an array in 18/27+ cases — that array value flows through the cache file unchanged and arrives at the frontend as `string[]`, crashing `.toLowerCase()`.
Fix: Changed `caseMatchesProducts` signature to `string | string[]` and added `Array.isArray` normalization before `.toLowerCase()`. Updated matching prop type in KPICards.tsx.
Decision: FIXED — 2026-04-10

### BKL-UX59 | Demo + dev environment strategy — research first
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: L
Source: 2026-04-10 — Jason: "copy a working container to another port to use as test bed for big changes like the new ui work. once tested promote to current container. setup true test bed environment"
         Updated: Jason: "tag as research first — needs best practices on professional testing/dev env setup. goal: stable demo env accessible to others while we test on separate container"
Files: Makefile, .env, data/ volume
Description: Two distinct goals: (1) **Dev/test container** — isolated environment on port 7778 for testing big UI changes (e.g., BKL-UX52 multi-pod layout) before promoting to production on 7777; (2) **Demo environment** — stable, shareable container that external stakeholders can access while active development continues on a separate instance. Key research questions: (a) Should demo and dev share the same data volume or use separate snapshots? (b) What's the right image promotion workflow (tag-based? make target?)  (c) How do we keep demo data stable while production data syncs live? (d) Should demo be read-only? (e) Networking: is port-based isolation enough or do we need separate data dirs? Research before implementing — avoid baking in wrong assumptions.
Decision: DONE — GrokResearcher produced 3-container design; Marcus implemented Makefile targets: `make dev-snapshot`, `make dev-up/down`, `make demo-snapshot`, `make demo-up/down`. Uses rsync data snapshots; demo is pinned image with :ro data dir. Committed in f3fc814.

### BKL-UX58 | Collapse ASA/Product view toggle — always use ASA view
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P2
Size: XS
Source: 2026-04-10 — Jason: "collapse the two views product vs asa view, just make it all asa view but keep the product filters in place"
Files: dashboard/src/components/Sidebar.tsx, dashboard/src/App.tsx
Description: The ASA/Product toggle in the sidebar added a mode switch that showed different content. Jason wants a single unified view (ASA view always) with the product filter chips (AAP/OCP/RHEL) still functional. Removes cognitive overhead of switching modes.
Fix: Removed both expanded and collapsed toggle button blocks from Sidebar.tsx. Hardcoded `viewMode="asa"` in App.tsx Sidebar call. Removed `onViewModeChange` prop from Sidebar. MorningSummary now always renders (removed `viewMode === 'asa'` gate). The `DashboardViewMode` type and `viewMode` prop remain in Sidebar for backward compat but are no longer user-controllable.
Decision: FIXED — 2026-04-10

### BKL-UX57 | Product filter: pipeline section doesn't update when product selected
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: M
Source: 2026-04-10 — Jason screenshots showing pipeline data unchanged after selecting AAP
Files: dashboard/src/components/PipelineSection.tsx, dashboard/src/App.tsx, src/dashboard-routes.ts
Description: When a product chip (AAP, OCP, RHEL) is selected, the pipeline section (top opps, tech wins needed, by-stage breakdown) does not filter to show only pipeline opportunities that include the selected product. `PipelineOpp` type has `products: string[]` — client-side filtering is feasible. Need to: (1) pass `selectedProducts` to PipelineSection, (2) filter `topOpps`, `techWinsNeeded`, `byStage` in the component using the same `normalizeProductName` mapping used elsewhere.
Decision: OPEN — feasible client-side; requires PipelineSection refactor + normalizeProductName integration

### BKL-UX56 | Product filter: KPI tiles don't update for non-cases signals when product selected
Status: ✅ DONE — 2026-04-10 (partial: Sev1 + Tech Wins filtered; Meetings Today/This Week not filterable — meetings have no product tags)
Severity: MEDIUM
Priority: P2
Size: L
Source: 2026-04-10 — Jason screenshots showing Sev1=0, Meetings Today=0 unchanged with AAP selected
Files: src/dashboard-routes.ts (KPIs endpoint), dashboard/src/components/KPICards.tsx
Description: When AAP product chip is selected, only the "Open Cases" KPI shows a filtered count (3/10). All other KPI tiles (Sev1 Cases, Meetings Today, Meetings This Week, Tech Wins Needed) pull from the `/api/kpis` aggregate which has no product awareness. The "Expiring Within 30 Days" and "Renewals in 30-90 Days" KPIs DO filter correctly (they use client-side account filtering). To fix the remaining tiles: either add product-filtered KPI endpoints, or move computation client-side using the filtered accounts + filtered cases.
Decision: OPEN — needs scoping; Sev1 is feasible client-side from filtered cases; Meetings is not filterable by product (meetings don't have product tags)

### BKL-UX55 | Support cases modal shows "Unknown" for all customer names
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P1
Size: XS
Source: 2026-04-10 — Jason screenshot: Open Support Cases modal shows "Unknown" in Customer column for every case
Files: dashboard/src/components/KPICards.tsx
Root cause: `SupportCase.customerName` is never populated by the backend. The RH Portal case cache stores cases with account numbers but no customer name field. The modal fell back to `c.customerName ?? 'Unknown'` for every case.
Attempted fix: Added `enrichedCases` reverse-lookup in KPICards. FAILED — all 105 customers have `accountNumbers: []` (empty). Account number discovery was never stored during bootstrap, so the map has nothing to match against.
Root cause 1: `rh-scraper.ts` doesn't store `customerName` on case objects when it finds them per-customer. Requires scraper change (needs explicit Jason permission per CLAUDE.md).
Root cause 2: `customers.json` has `accountNumbers: []` for all 105 customers — account number discovery step was never populated. Needs investigation into why account numbers aren't stored.
Decision: BLOCKED — needs Jason's OK to modify rh-scraper.ts. Note the frontend enrichedCases code is harmless and stays in place for when account numbers are populated.

### BKL-UX52 | Multi-AE / multi-pod UX design review — council session needed
Status: 🟡 SPEC COMPLETE — implementation pending
Severity: MEDIUM
Priority: P2
Size: XL
Source: 2026-04-10 — Jason: "we need a top level UX layout that shows a professional dashboard that's easy to read and has relevant data for that many accounts / AEs"
Files: dashboard/src/ (multiple pages and components)
Description: With 9 AEs and 100+ customers, the current dashboard layout was designed for a smaller scale. As we approach 2-pod scale (~18 AEs, 200+ customers) the layout needs to be redesigned from the ground up for readability and professionalism.
Decision: SPEC DONE — council session completed 2026-04-10. Design spec at `docs/UX-SPEC-MULTI-POD.md`. Implementation requires 4 phases: (1) backend multi-pod schema migration, (2) frontend pod tabs + AE grouping, (3) health dot + tooltip, (4) pod/AE level KPI tiles. Critical-path blocker: `data-sources.json` multi-pod schema must ship first.

### BKL-TEST-05 | bootstrap-recovery.spec.ts — 6 stale tests after UI refactor
Status: ⛔ OBSOLETE — 2026-04-10 (test/bootstrap-recovery.spec.ts does not exist; item moot)
Severity: LOW
Priority: P3
Size: S
Source: 2026-04-10 Quinn QA scan
Files: test/bootstrap-recovery.spec.ts
Description: All 6 tests in bootstrap-recovery.spec.ts fail. The UI components were refactored (wizard steps, view structure) and the specs no longer match current UI selectors. Needs spec update to match current setup flow.

### BKL-A11Y-01 | Setup page color-contrast WCAG AA violation
Status: ✅ DONE 2026-04-10 (Marcus commit 7066522 — text-text-secondary/50 boosted to /70 and full on reset/remove buttons; WCAG AA contrast met)
Severity: LOW
Priority: P3
Size: XS
Source: 2026-04-10 Quinn accessibility scan
Files: dashboard/src/pages/SetupPage.tsx (or Tailwind config)
Description: Axe found 2 color-contrast violations on /dashboard/setup. Fix: check text color vs background on form labels or helper text; boost contrast to meet WCAG AA minimum (4.5:1).

### BKL-TEST-06 | intelligence-status returns 404 — route not registered
Status: ✅ DONE 2026-04-10 (route exists at customer-routes.ts:643, returns 200 — was a false positive from Quinn API scan)
Severity: MEDIUM
Priority: P2
Size: XS
Source: 2026-04-10 Quinn API scan
Files: server.ts or src/intelligence-routes.ts
Description: GET /api/intelligence/generate-all/status returns 404. Either the route was never wired or was removed during refactor. Verify route exists in server.ts and is correctly exported.

### BKL-RH-PERF-01 | RH scraper PR1 — negative cache + waitForSelector + persistSessionState fix
Status: ✅ DONE — 2026-04-10 (verified in code: negative cache in scraper-manager.ts:403-450, waitForSelector in rh-scraper.ts:1111-1119, persistSessionState logs via console.warn at rh-scraper.ts:320)
Severity: HIGH
Priority: P1
Size: M
Source: 2026-04-10 Council review — unanimous recommendation
Files: src/scraper-manager.ts, src/rh-scraper.ts, data/config/customers.json (schema)
Description: Three zero-risk fixes in one PR.
(1) **Negative cache (tombstoning):** After 3 consecutive discovery failures for a customer, write `discoveryStatus: "unresolvable"` + timestamp to that customer record in customers.json. Skip on future runs until 14-day TTL expires. Add admin UI to manually invalidate. This eliminates re-searching 77 dead names every 15-min heartbeat run — expected to cut repeat-run time from 13-34 min to under 2 min.
(2) **Replace fixed waits with element-readiness:** Replace `waitForTimeout(1500)` and `waitForTimeout(500)` in discoverAccountNumberByName with `waitForSelector` on the dropdown element appearing + explicit fallback timeout. Faster when dropdown renders quickly, more reliable when slow.
(3) **persistSessionState error propagation:** Current `catch { /* non-fatal */ }` silently drops disk write failures. A dropped session state cascades to false customer-not-found on next run, poisoning the negative cache before it starts. Log and surface these errors explicitly.
Constraint: SCRAPER-RULES.md — read before touching. 3-concurrent discovery is already sanctioned by rules. Sequential constraint applies to Supportable only.
Decision: Council unanimous. Jason authorized 2026-04-10 ("let's go for it").

### BKL-RH-PERF-02 | RH scraper PR2 — failure audit + batch HTTP-first + jitter
Status: 🔴 OPEN — PERF-01 shipped 2026-04-10. Waiting ~1 week for failure logging data before implementing. See description for timing.
Severity: MEDIUM
Priority: P2
Size: M
Source: 2026-04-10 Council review
Files: src/scraper-manager.ts, src/rh-scraper.ts
Description: Second PR, ships after PR1 instrumentation data is available (1 week).
(1) **Failure reason audit:** Add logging to classify each discovery failure as "no portal entry" vs "name mismatch" vs "timeout". This data determines whether to invest in normalization.
(2) **Batch HTTP-first Solr calls:** Currently fires one HTTP call per customer sequentially. Move all HTTP-first calls into a single `page.evaluate()` with `Promise.all` at 3 concurrent (already sanctioned by SCRAPER-RULES.md). Expected to cut HTTP-path portion from ~2min to ~20s.
(3) **Jitter between batches:** Add 200-800ms random delay between batch windows. Ships as toggleable infrastructure (off by default), activated on evidence of rate limiting.
(4) **Session validation bookends:** Validate session before and after each batch window to guard against stale-cookie silent success.
(5) **Name normalization** (only if failure audit shows name mismatches > missing accounts): Strip legal suffixes (LLC, Inc, Corp, Ltd) from search name before sidebar lookup. Expected recovery: 10-15% of current failures.
Decision: Council consensus. Blocked on PR1 shipping + 1 week of failure data.

---

## Data Enrichment

### BKL-ENRICH-01 | Industry/segment tags missing on all 106 customers — enrichment never ran on SW pod
Status: ✅ DONE 2026-04-11 — 102/106 populated; 4 missing (Rxlogix, Corelogic Systems, Hyundai Motor America, Pcm — data gap, no Drive folder); cache-fresh bug fixed + Strategy 4 Gemini fallback added
Severity: HIGH
Priority: P1
Size: S
Source: Jason 2026-04-10 — confirmed 0/106 customers have industry field despite BKL-AI01 being marked DONE
Files: src/account-intelligence.ts (identifyIndustry, cacheIndustryResult), data/config/customers.json
Description: BKL-AI01 (industry/segment detection via Gemini + Google Search) was marked DONE 2026-04-02 but that was on the NW pod test data. The SW pod has 106 customers and 0/106 have the `industry` field in customers.json. The code exists (identifyIndustry() at account-intelligence.ts:114, cacheIndustryResult() at line 156) but the enrichment batch has never run for this pod. Industry/segment is required for intelligence prompt templating (BKL-AI02, BKL-AI03) and will eventually power dashboard filtering.
Fix: Trigger POST /api/intelligence/generate-all or run identifyIndustry() in batch for all 106 customers. Verify customers.json has `industry` + `segment` fields after run. Check intelligenceEnabled flag in data-sources.json — may need to set to true first.
Decision: DONE — cache-fresh bug fixed (re-run identifyIndustry when customers.json missing industry despite fresh Drive cache). Strategy 4 Gemini fallback added (non-grounded structured call when grounded API returns pure prose). Final count: 102/106 populated. 4 remaining (Rxlogix, Corelogic Systems, Hyundai Motor America, Pcm) have no Drive folder — data gap, not code bug. JSON parse failures eliminated (was 27/106, now 0).

### BKL-INTEL-01 | Intelligence docs accumulate duplicates — always delete all + create fresh
Status: ✅ DONE 2026-04-11
Severity: HIGH
Priority: P1
Size: XS
Source: Jason 2026-04-10 — duplicate docs found in account intelligence folders
Files: src/account-intelligence.ts — upsertGoogleDoc() (~line 655)
Root cause: upsertGoogleDoc() queries Drive with pageSize: 1, finds ONE existing doc by name, updates it, and leaves any additional same-named docs untouched. On repeat runs, duplicates accumulate.
Fix: Replace upsert logic with delete-all-then-create: (1) query Drive with no pageSize limit to find ALL docs matching the name in the folder, (2) delete every match, (3) create a single fresh doc. This guarantees two clean docs per customer on every run regardless of prior state.
Decision: DONE — replaced pageSize:1 upsert with delete-all-then-create in upsertGoogleDoc(). Every call now produces exactly one doc per name in the intelligence subfolder.

### BKL-AI-AUDIT-01 | Gemini call audit — model, schedule/TTL, and token cap review across all AI calls
Status: ✅ DONE 2026-04-11 — Full audit at docs/GEMINI-AUDIT.md: 14 call sites, pricing table, cost estimates, optimization recommendations
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-10 — verify every Gemini call uses the right model, right frequency, and right output cap
Files: src/customer.ts, src/account-intelligence.ts, src/account-plan.ts, src/product-intelligence.ts, src/doc-extraction.ts, src/customer-product-intel.ts, src/product-release-radar.ts
Description: Audit every Gemini call in the codebase for: (1) correct model tier, (2) appropriate schedule/TTL/cache, (3) correct maxOutputTokens cap. Current known state from code:

| Call type | File | Model | maxOutputTokens | TTL / Trigger |
|---|---|---|---|---|
| brief-extract (structured) | customer.ts:895 | geminiModelLite (2.5-flash-lite) | 8192 | On-demand, 4h brief cache |
| brief-synthesize | customer.ts:473 | geminiModelLite (2.5-flash-lite) | 4096 | On-demand, 4h brief cache |
| PDF text extraction | customer.ts:398 | geminiModelLite (2.5-flash-lite) | 4096 | On-demand during brief gen |
| doc-classify | doc-extraction.ts:182 | geminiModelLite (2.5-flash-lite) | 8192 | On-demand during doc processing |
| product-query | product-intelligence.ts:48 | geminiModelLite (2.5-flash-lite) | 4096 | On-demand per product Q&A |
| account-plan-generation | account-plan.ts:233 | geminiModel (2.5-flash) | 8192 | On-demand |
| customer-product-intel | customer-product-intel.ts:349 | geminiModel (2.5-flash) | 8192 | On-demand |
| intelligence-industry | account-intelligence.ts:57 | geminiModel (2.5-flash) | not set | 7-day TTL |
| intelligence-company | account-intelligence.ts:57 | geminiModel (2.5-flash) | not set | 7-day TTL |
| intelligence-analysis | account-intelligence.ts:57 | geminiModel (2.5-flash) | not set | 7-day TTL |

Review questions for each call:
1. Is the model tier right? (Lite = high-volume cheap tasks; Standard = quality-sensitive tasks)
2. Is the TTL/cache interval appropriate for how often the underlying data changes?
3. Is maxOutputTokens set? If not, Gemini defaults may burn tokens silently.
4. Does intelligence-industry/company/analysis need an explicit maxOutputTokens?
5. Is brief-synthesize at 4096 enough for a full customer brief, or is it getting truncated?
Fix: For each call that has a wrong model, missing cap, or wrong TTL — make the surgical correction with a comment explaining the reasoning. Update this table when done.
Decision: OPEN — assign to Marcus for code review pass.

### BKL-OPS-02 | Dev/test/prod/demo environment strategy — research + implement team consistency standard
Status: ✅ DONE 2026-04-11
Severity: MEDIUM
Priority: P2
Size: Research → M implementation
Source: Jason 2026-04-10 — wants proper multi-env setup with tunnel demo access and team-consistency guardrails
Files: Makefile, CLAUDE.md, .github/workflows/, docs/
Context: BKL-UX59 shipped 3-container Makefile targets (dev-snapshot/dev-up, demo-snapshot/demo-up). BKL-OPS-01 shipped versioning, changelog, rollback, branch strategy. This item extends both with tunnel access and formal promotion pipeline.
Description: Research and implement the full environment strategy covering:

  (1) **Environment tiers** — define the 4 containers and their contracts:
    - `pai-dashboard` (prod, port 7777) — stable, only promoted builds, live data
    - `pai-dashboard-dev` (dev, port 7778) — frequent changes, dev data snapshot
    - `pai-dashboard-demo` (demo, port 7779) — pinned build, read-only data, shareable
    - `pai-dashboard-test` (test, ephemeral) — clean-slate per test run, synthetic data

  (2) **Promotion pipeline** — define the gate sequence for dev→prod promotion:
    - Feature branch → PR → CI runs Playwright API tests + Quinn smoke test → merge to main → `make rebuild`
    - No direct-to-prod code changes; all changes flow through dev first
    - Document in CLAUDE.md as a hard rule for all agents

  (3) **Tunnel access for demo** — research best option for giving stakeholders access to the demo container:
    - Cloudflare Tunnel (cloudflared) — free, stable subdomain, no port forwarding
    - ngrok — simpler setup, free tier has ephemeral URLs (Pro = stable subdomain)
    - Tailscale — best for internal Red Hat team access, no public internet exposure
    - Decision criteria: stability, auth/access control, ease of setup, Red Hat IT policy
    - Implement `make demo-tunnel` / `make demo-tunnel-stop` Makefile targets

  (4) **Team consistency guardrails** — so all agents and future contributors use the right environment:
    - CLAUDE.md rule: "never run make rebuild from dev — always promote to prod via gate sequence"
    - Add Makefile guard that fails if dev container has uncommitted changes when promoting
    - Document which container to test against for each task type
    - Add `make env-status` to show which containers are running and on what build

  (5) **CI integration** — tie GitHub Actions to the dev→prod gate:
    - On PR open: run `npx playwright test test/api/` automatically
    - On merge to main: trigger `make rebuild` via self-hosted runner or notify Jason to run it
    - Research: is a self-hosted GH Actions runner on the Mac worth it vs manual `make rebuild`?

Research questions before implementing: (a) What tunnel solution fits Red Hat IT constraints? (b) Is a self-hosted GH runner practical on this Mac? (c) Should demo data be a fixed snapshot (never syncs) or periodic sync from prod?
Decision: DONE 2026-04-11 — Implemented: (1) All 4 container tiers already in Makefile. (2) Promotion pipeline: `make pre-promote` gate (lint + real-data CI + destructive) exists; hard rule added to CLAUDE.md. (3) Tunnel: Cloudflare Tunnel chosen (outbound-only, RH IT compatible); `make demo-tunnel` + `make demo-tunnel-stop` added. (4) `make env-status` added; CLAUDE.md hard rule written. (5) CI self-hosted runner deferred (impractical overhead). Demo data strategy: fixed snapshot (never auto-syncs). Full docs at docs/DEMO-ENV.md.

### BKL-REG-01 | AccountIntelligencePanel "Generate Intelligence" button called wrong API endpoint
Status: ✅ FIXED 2026-04-10 (AccountIntelligencePanel.tsx updated to call correct endpoint)
Severity: HIGH
Priority: P1
Size: XS
Source: Jason 2026-04-10 — button showed "identifying industry..." then disappeared with no result
Files: dashboard/src/components/AccountIntelligencePanel.tsx
Root cause: handleGenerate() called POST /api/intelligence/run (non-existent) instead of POST /api/customer/:name/generate-intelligence. fetch() doesn't throw on 404 so failure was silent. Status set to 'running' then polling saw 'none' and reset.
Fix: Changed URL in handleGenerate() to correct path; added res.ok check to surface server errors.
Decision: FIXED — rebuild in progress as of 2026-04-10.

### BKL-REG-02 | Product Intelligence "Generate" buttons silently fail
Status: ✅ DONE
Severity: HIGH
Priority: P1
Size: S
Source: Jason 2026-04-10 — clicking Generate on any product in ProductIntelSection does nothing
Files: dashboard/src/components/ProductIntelSection.tsx, src/product-intel-routes.ts
Root cause: getCachedSummary(slug) returned null → 400 "No cached summary" → silent catch in handleRegenerate/handleGenerateAll swallowed all errors.
Fix: (1) Added error state with dismissible banner to ProductIntelSection. (2) handleRegenerate now calls POST /api/products/:slug/refresh before generate to ensure cache exists. (3) handleGenerateAll refreshes all product caches first via Promise.allSettled. (4) Seeded all 7 product summary caches via curl. Verified: POST /api/products/rhel/intel/radiology-partners/generate returns intel.
Decision: DONE — fixed 2026-04-10.

### BKL-REG-03 | Domain inference not re-runnable for existing customers — all SW pod domains empty
Status: ✅ DONE
Severity: HIGH
Priority: P1
Size: S
Source: Jason 2026-04-10 — domain column shows placeholder "acme.com" for all customers in Setup Wizard
Files: src/setup-routes.ts (POST /api/setup/infer-domains), dashboard/src/pages/AdminPage.tsx
Root cause: Domain inference runs automatically only during bootstrap wizard flow (bootstrap-orchestrator.ts:1358). After data wipe + restore, all customer domains are empty. No Admin button existed to re-trigger.
Fix: Added DomainInferenceSection component to AdminPage.tsx with "Run Now" button that calls POST /api/setup/infer-domains. Shows loading state, displays auto-saved count, need-review count, and total processed inline. Verified: endpoint returns domain inference results for all 105 customers.
Decision: DONE — fixed 2026-04-10.

### BKL-REG-08 | PodKPIHeader banner case count excludes name-matched cases
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P1
Size: XS
Source: Jason 2026-04-10 — banner showed ~30 cases while KPI showed 52; screenshot confirmed live discrepancy
Files: dashboard/src/components/PodKPIHeader.tsx
Root cause: `openCases` filter used `accountNumSet.has(c.accountNumber)` only. 39 customers with zero account numbers have cases matched by name (casesSource: 'name_match') which were excluded from banner count. KPI used server-computed `kpis.openCasesTotal` which included all cases.
Fix: Added `customerNameSet` from `accounts.map(a => a.name.toLowerCase())`. Filter now matches on EITHER account number OR customerName (case-insensitive). REG-013 in regression.spec.ts covers brief cache indirectly; UI consistency test should be added in a follow-up.
Decision: DONE — fixed 2026-04-10 in PodKPIHeader.tsx lines 21-31. Rebuild required.

### BKL-REG-10 | Account Intelligence panel shows only "Generate" button after container restart even when docs exist
Status: ✅ DONE 2026-04-10
Severity: MEDIUM
Priority: P1
Source: Jason observed docs visible in Google Drive but panel shows only "Generate Intelligence" button
Files: src/account-intelligence.ts
Root cause: The TTL cache-skip path (line 891) writes `{ status: 'complete', step: 'skipped (cache fresh)' }` with NO companyDocUrl/industryDocUrl. The per-customer intelligence cache JSON stored company/industry TEXT but not doc URLs. After container restart, skip path fires for all fresh-cache customers — job status has no URLs — panel hasDocs=false — shows only Generate button.
Fix: (1) Cache write at pipeline completion now includes companyDocUrl and industryDocUrl in the per-customer `{slug}.json`. (2) Cache-fresh skip path reads those URL fields from cache and passes them into the job status. Existing cache files (predating this fix) won't have URLs until next real generation — expected behavior.
Decision: DONE — no frontend or API changes needed; panel already renders links when URLs present.

### BKL-REG-09 | normalizeForQuery empty-string match causes U.S.-prefixed accounts to match every customer
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Source: Gate 2 pre-promote failure — U.S. Epson, Inc. returned results for all customer CCSP/pipeline queries
Files: src/customer-routes.ts (lines 392, 419)
Root cause: `normalizeForQuery` regex `u\.s\..*` strips everything from "u.s." to end of string. "U.S. Epson, Inc." → `''`. `anyString.includes('')` is always true, so empty-normalized names matched every query.
Fix: Added `hay.length === 0 ||` guard before both unguarded `includes` checks in the `/customer/:name/ccsp` loop (line 392) and `/customer/:name/pipeline` loop (line 419). Lines 354 and 363 already had this guard from a prior fix. `normalizeForQuery` itself left unchanged — regex behavior may be intentional elsewhere.
Decision: DONE — four call sites now all guard against empty hay. Gate 2 re-run required.

### BKL-UX52-P1 | Pod tab bar renders as static label, not interactive tabs
Status: 🟡 IN PROGRESS
Severity: LOW
Priority: P3
Size: XS
Source: Quinn BKL-UX52 validation 2026-04-10 — "Southwest Pod:" shows as static text, no clickable tabs
Files: dashboard/src/components/PodTabBar.tsx, dashboard/src/App.tsx
Finding: With only 1 pod configured, PodTabBar renders a label instead of an interactive tab control. When 2+ pods are configured the tab switching may work correctly — needs verification. The spec called for a tab bar; currently it's a label.
Fix needed: Verify tab switching works with 2 pods. If it does, this is just cosmetic — add a design clarification note.
Decision: OPEN — low priority until NW pod is added; tab bar with 1 tab has no functional value.

### BKL-UX52-P2 | Health dot reason chips shown inline instead of hover tooltip
Status: 🟡 IN PROGRESS
Severity: LOW
Priority: P3
Size: XS
Source: Quinn BKL-UX52 validation 2026-04-10 — chips visible inline, not behind hover trigger
Files: dashboard/src/components/HealthDot.tsx, dashboard/src/components/AEGroupedList.tsx
Finding: Reason chips ("Sev1 case open", "Pipeline $405K closes in 20d") are displayed inline next to every customer row. The spec called for hover tooltip. Quinn notes inline display is arguably better UX (always visible) but deviates from spec.
Fix needed: Design decision — either accept inline chips as the standard or implement hover popup. No functional impact.
Decision: OPEN — needs Jason design call. Inline chips may be preferred.

### BKL-TEST-07 | Complete test coverage assessment — silent-fail buttons + untested action flows
Status: 🟡 IN PROGRESS
Severity: HIGH
Priority: P1
Size: L
Source: Jason 2026-04-10 — BKL-REG-01/02 both had silent catch blocks hiding failures; entire class of bugs undetected
Files: dashboard/src/components/*.tsx, dashboard/src/pages/*.tsx, test/
Root cause pattern: 71 silent `catch(() => {})` blocks exist across frontend components. Any of these can hide wrong endpoints, server errors, or broken flows with zero user feedback. BKL-REG-01 (wrong endpoint) and BKL-REG-02 (missing cache) were both invisible because of this pattern.

Description: Two deliverables required:

  (1) **Silent catch audit** — sweep all 71 silent catch blocks in dashboard/src/:
    - Categorize each as: (a) load-only fetch where silence is OK, (b) action button where silence hides failures (must surface error), (c) polling fetch where silence is OK
    - For every (b): add visible error state to the component AND write a Playwright spec
    - Priority components with confirmed silent-fail action buttons:
      - AccountIntelligencePanel.tsx (generate intelligence) — BKL-REG-01, fixed
      - ProductIntelSection.tsx (generate/regenerate per product, generate all) — BKL-REG-02, fixed
      - AccountPlanPanel.tsx (generate account plan)
      - AdminPage.tsx (scrape triggers, backup, restore, notebook generate, domain inference)
      - ProductCard.tsx (refresh)
      - MorningSummary.tsx (refresh)

  (2) **Action flow test coverage** — for each action button that calls a mutating API endpoint, verify a Playwright spec exists that:
    - Clicks the button
    - Verifies the API call was made (check network or poll status endpoint)
    - Verifies the expected result (running state, then complete, or visible error on failure)
    - Does NOT require state mutation of customers.json or aes.json (snapshot/restore if it does)
    - Priority test specs to write:
      - test/ui/account-intelligence.spec.ts — generate button → job starts → status: running/complete
      - test/ui/product-intel.spec.ts — generate button → not silent on error → returns result
      - test/ui/account-plan.spec.ts — generate button → plan appears
      - test/api/intelligence.spec.ts — extend existing spec with per-customer endpoint test

  (3) **res.ok gate standard** — enforce that all action button fetch calls check res.ok before
    treating the response as success. Add to CLAUDE.md as a coding standard:
    "All action button fetch calls (POST/DELETE that trigger work) MUST check res.ok and surface
    an error state to the user. Never silently catch a non-ok response on an action button."

Decision: OPEN — assign to Marcus for audit + Quinn for test writing. Do audit first, then tests.

### BKL-STARTUP-01 | Product summary caches not seeded on startup — empty after every rebuild
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: S
Source: Jason 2026-04-10 — BKL-REG-02 root cause; product caches wiped on every rebuild with no auto-recovery
Files: server.ts or src/background-scheduler.ts, src/product-release-radar.ts
Description: Product summary cache files (`data/cache/product-intel/{slug}-summary.json`) are not committed to git and are wiped on every `make rebuild`. The weekly background scheduler (Sunday 6am ET) eventually re-seeds them, but between rebuild and next Sunday the Product Intelligence generate buttons silently fail.
Fix: On server startup, check if any configured product slugs are missing a summary cache. If missing, auto-trigger `refreshAllProducts()` in the background (non-blocking). This runs once per cold start and ensures the cache is always populated within minutes of a rebuild.
Decision: OPEN -- small addition to server startup sequence.

### BKL-TEST-08 | intelligence.spec.ts uses hardcoded "A10 Networks" not in customer dataset
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: XS
Source: 2026-04-10 Quinn regression session
Files: test/api/intelligence.spec.ts
Description: KNOWN_CUSTOMER is hardcoded to "A10 Networks" which does not exist in the current 106-customer dataset. Tests 23 and 33 fail with 404 because the customer lookup correctly rejects unknown names. Fix: use a customer name from the current dataset (e.g., "Acme Corp") or dynamically discover one via /api/accounts.

### BKL-TEST-09 | customers.spec.ts brief tests use AE name as customer name
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: XS
Source: 2026-04-10 Quinn regression session
Files: test/api/customers.spec.ts
Description: 5 brief-related tests use CAROLANNE_ENCODED ("Carolanne Farrell") which is an AE name, not a customer name. The /customer/:name/brief endpoint requires an exact customer name and returns 404 for AE names. CCSP and pipeline endpoints work with AE names via fuzzy matching, but brief does not. Fix: add a KNOWN_CUSTOMER constant to fixtures.ts with an actual customer name, and use it for brief tests.

### BKL-TEST-10 | customer-detail.spec.ts wrong assertion for nonexistent customer h1
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: XS
Source: 2026-04-10 Quinn regression session
Files: test/ui/customer-detail.spec.ts
Description: Test at line 261 expects h1 to show the fake customer name "__nonexistent__" but the page correctly renders "Customer not found". The UI behavior is better than the test expectation. Fix: change assertion to expect(h1).toHaveText("Customer not found").

---

## Testing Strategy (BKL-TEST-STRATEGY)

See `docs/BKL-TEST-STRATEGY.md` for the full enterprise testing strategy document.

### BKL-TEST-11 | Customer-count production guard on destructive endpoints
Status: ✅ DONE — 2026-04-10
Severity: CRITICAL
Priority: P0
Size: XS (30 min)
Source: Architect testing strategy 2026-04-10 — 4 production wipes in 10 days
Files: src/setup-routes.ts
Description: `POST /api/setup/reset` and `POST /api/__test/restore` (without snapshot) now return 403 when `customers.length > 5` unless `ALLOW_RESET=true` is set in env. Production always has 50-150 customers; test fixtures have 1-3. This single guard would have prevented all 4 production wipes. The override env var is never set in the production container.
Decision: DONE — Guard added to both endpoints. Reset blocked with descriptive error message including customer count. Restore blocked when no snapshot exists AND customer count exceeds threshold.

### BKL-TEST-12 | Quinn endpoint allowlist in Playwright fixtures
Status: ✅ DONE (2026-04-10)
Severity: HIGH
Priority: P0
Size: S (1-2h)
Source: Architect testing strategy 2026-04-10
Files: test/fixtures.ts
Description: Quinn agent tests must only call endpoints from a curated allowlist. Destructive endpoints (`/api/setup/reset`, `/api/__test/restore`, `/api/bootstrap/auto`, `/api/bootstrap/pod`) are excluded unless the test explicitly opts in with `DESTRUCTIVE_TEST=true`. Implement via Playwright `globalSetup` wrapping `page.route()` to intercept and block non-allowlisted POST calls. Log warnings for blocked calls.
Decision: DONE — Extended QUINN_BLOCKED_POSTS in test/fixtures.ts to all 4 required endpoints. Added `quinnTest` export with `quinnPage` fixture that installs page.route() interceptors responding 403 when QUINN_MODE=true. When QUINN_MODE is not set, quinnPage is a plain page passthrough. Activate: QUINN_MODE=true npx playwright test --grep @quinn.

### BKL-TEST-13 | ESLint/grep empty-catch ban in CI
Status: ✅ DONE (2026-04-10)
Severity: HIGH
Priority: P1
Size: XS (30 min)
Source: Architect testing strategy 2026-04-10 — 20+ `catch(() => {})` patterns found in dashboard/src/
Files: Makefile or CI config, dashboard/src/**/*.tsx
Description: Add a CI gate that fails the build if `catch(() => {})` or `catch(()=>{})` patterns exist in `dashboard/src/`. Implementation: `grep -rn '.catch(() *=> *{})' dashboard/src/ && exit 1` in the lint or build step. This prevents silent failures from being introduced. Existing instances must be migrated to proper error handling (see BKL-TEST-14) before enabling.
Decision: DONE — `scripts/check-empty-catches.sh` added; `make lint` runs it; `package.json` `"lint"` script wired. Fails build on any `.catch(() => {})` in `dashboard/src/`.

### BKL-TEST-14 | useAction hook to replace silent-fail fetch patterns
Status: ✅ DONE (2026-04-10) — useAction hook created; ProductDetailPage + SetupPage 5 silent catches fixed; AdminPage/CustomerDetailPage partial
Severity: HIGH
Priority: P1
Size: M (4-6h)
Source: Architect testing strategy 2026-04-10 — 20+ action buttons swallow errors
Files: dashboard/src/hooks/useAction.ts (new), dashboard/src/pages/AdminPage.tsx, dashboard/src/pages/CustomerDetailPage.tsx, dashboard/src/pages/ProductDetailPage.tsx
Description: Create a `useAction` hook that wraps `fetch()` calls with loading state, error state, and automatic error surfacing. Replace all 20+ `fetch().then(...).catch(() => {})` patterns across action buttons (Generate Intelligence, Refresh Product, Run Scraper, etc.). Each button gets: loading spinner while running, red error text on failure, success feedback on completion. Migration order: AdminPage (scraper controls) first, then CustomerDetailPage (intelligence), then ProductDetailPage (refresh).

### BKL-TEST-15 | Unit test foundation with Bun test runner + Hono app.request()
Status: ✅ DONE (2026-04-10) — foundation complete; route handler coverage is BKL-TEST-21
Severity: MEDIUM
Priority: P2
Size: L (8-12h)
Source: Architect testing strategy 2026-04-10 — test pyramid is 0% unit tests
Files: test/unit/ (new directory), bunfig.toml or package.json test config
Description: Create unit test infrastructure using Bun's native test runner with Hono's `app.request()` pattern. Start with the 10 highest-risk route handlers: (1) POST /api/setup/reset, (2) POST /api/__test/snapshot, (3) POST /api/__test/restore, (4) POST /api/aes, (5) POST /api/setup/infer-domains, (6) GET /api/accounts, (7) GET /api/kpis, (8) GET /api/customer/:name, (9) GET /api/products, (10) POST /api/products/:slug/refresh. Target: 60% of test coverage from unit tests within 4 weeks. No live server, no browser, sub-millisecond per test.
Decision: DONE — `test/unit/` created with 4 files: `slug.test.ts`, `sanitize.test.ts`, `account-numbers.test.ts`, `setup-validation.test.ts`. 27 pure-function tests pass via `bun test test/unit/`. Route handler coverage (Hono app.request()) tracked in BKL-TEST-21.

### BKL-TEST-16 | Docker volume for cache persistence across rebuilds
Status: ✅ DONE (partial, 2026-04-10) — test container cache bind-mounted; production cache volume not yet mounted
Severity: MEDIUM
Priority: P1
Size: XS (30 min)
Source: Architect testing strategy 2026-04-10 — caches wiped on every `make rebuild`
Files: Makefile, Dockerfile (or docker-compose.yml)
Description: Mount `data/cache/` as a named Docker volume (`pai-dashboard-cache`) so product intelligence caches, brief caches, and sheet data caches survive `make rebuild`. Currently every rebuild wipes all caches, causing product intelligence silent failures until the weekly scheduler re-seeds on Sunday. The volume mount is a one-line Makefile change in the `docker run` command. Verify: after `make rebuild`, product cache files should still exist in the container.
Decision: PARTIAL — test container (`pai-dashboard-test`) mounts `data-test/cache/` as bind-mount, reseeded by `make seed`. Production container (`pai-dashboard`) cache-volume persistence not yet implemented — caches still wiped on `make rebuild`. Full production fix is a follow-on task.

### BKL-TEST-17 | Seed script for isolated test data (make seed)
Status: ✅ DONE (2026-04-10)
Severity: MEDIUM
Priority: P2
Size: M (4-6h)
Source: Architect testing strategy 2026-04-10 — tests mutate live data because no alternative exists
Files: scripts/seed.ts (new), Makefile (new target)
Description: Create a `make seed` command that generates a minimal test dataset: 1 AE ("Test AE"), 3 customers ("Acme Corp", "Beta Inc", "Gamma LLC") with fake account numbers, fake sheet IDs, and pre-populated cache files. Writes to `data/test-config/` (NOT `data/config/`). Tests can point at this directory via `CONFIG_DIR=data/test-config/` env var. This eliminates the need for tests to ever touch production config files. Include: aes.json, customers.json, data-sources.json, and minimal cache stubs for briefs/sheets.
Decision: DONE — `scripts/seed-data/` canonical fixture source (2 AEs, 5 fake customers: Acme Corp, Globex Industries, Wayne Enterprises, Initech, Stark Industries; account numbers 990000x). `make seed` copies to `data-test/`. `data-test/` is gitignored. Test container reads from `data-test/` via bind-mount.

### BKL-TEST-18 | Snapshot delta guard — refuse restore with >50% customer count change
Status: ✅ DONE — 2026-04-10
Severity: MEDIUM
Priority: P2
Size: XS (30 min)
Source: Architect testing strategy 2026-04-10 — defense-in-depth for snapshot/restore
Files: src/setup-routes.ts (restore endpoint)
Description: Add a delta guard to the restore endpoint: if the snapshot's customer count differs from the current in-memory customer count by more than 50%, refuse the restore with a descriptive error. Example: snapshot has 2 customers, current state has 105 — the delta is 98%, far exceeding the 50% threshold. This catches the scenario where a test creates a snapshot with minimal data and then tries to restore it over production. Override: `force:true` in the request body bypasses the delta guard.

### BKL-TEST-19 | Stale fixture detection — verify test/fixtures.ts IDs match live data
Status: ✅ DONE — 2026-04-10
Severity: LOW
Priority: P3
Size: S (1-2h)
Source: Architect testing strategy 2026-04-10 — hardcoded Google Drive/Sheet IDs drift
Files: test/fixtures.ts, test/playwright.config.ts (globalSetup)
Description: `test/fixtures.ts` contains hardcoded Google Drive folder IDs and Sheet IDs that drift from live data as AEs are re-bootstrapped. Add a Playwright globalSetup check: before running tests, fetch `/api/aes` and compare the first AE's sheet IDs against the fixture values. If they differ, log a warning (not a failure — tests should still run, but the operator knows fixtures are stale). Long-term: fixtures should dynamically discover IDs from the live API instead of hardcoding them.

### BKL-TEST-20 | setup.spec.ts snapshot wrapper — prevent reset from wiping production
Status: ✅ DONE — 2026-04-10
Severity: HIGH
Priority: P0
Size: S (1h)
Source: Architect testing strategy 2026-04-10 — test auditor found setup.spec.ts calls reset with no snapshot
Files: test/api/setup.spec.ts
Description: `api/setup.spec.ts` calls `POST /api/setup/reset?confirm=true` with NO snapshot/restore wrapper. If this test runs against a server with production data loaded, it permanently wipes everything. Fix: wrap the entire spec in beforeAll snapshot + afterAll restore (same pattern as lifecycle.spec.ts). The customer-count guard (BKL-TEST-11) provides a second layer of defense, but the test itself should be self-contained.

### BKL-TEST-21 | Complete unit test coverage — route handlers via app.request()
Status: ✅ DONE (2026-04-10) — initial pattern established; full coverage is follow-on
Severity: MEDIUM
Priority: P2
Size: L (8-12h)
Source: BKL-TEST-15 completion 2026-04-10 — pure-function foundation done; route handler coverage not yet started
Files: test/api/routes.spec.ts (new), test/unit/ (existing)
Description: Extend unit test coverage beyond pure functions to route handlers using Hono's `app.request()` pattern (no live server, no browser). Priority targets: (1) POST /api/setup/reset — verify guard fires at >5 customers, (2) POST /api/setup/save-customers — verify guard fires, (3) POST /api/__test/restore — verify requires snapshot, (4) GET /api/accounts — verify shape, (5) POST /api/aes — verify validation. Target: all setup-routes.ts handlers covered. Prerequisite: BKL-TEST-15 done (foundation in place).
Decision: DONE (pattern) — server.ts has launch-time side effects (Playwright browser spawn, scraper timers) making direct Hono app.request() import unsafe. Used API-level tests in test/api/routes.spec.ts instead (same fetch()-against-live-server pattern as test/api/*.spec.ts). 5 tests added: (1) POST /api/setup/reset → 400 without confirm, (2) POST /api/setup/reset → 403 at >5 customers (tagged @destructive), (3) GET /api/accounts → 200 + customers[], (4) customer entry shape check, (5) POST /api/aes with empty name → 400, (6) POST /api/aes non-array → 400. Full Hono app.request() coverage (without live server) remains a longer-term goal requiring server refactor to extract app from side effects.

### BKL-TEST-22 | Add @destructive tags to setup.spec.ts and lifecycle.spec.ts
Status: ✅ DONE 2026-04-10 — tagged reset/save-customers/infer-domains/save-domains/lifecycle; ci project grepInvert excludes @destructive; 88 ci tests pass against production
Severity: MEDIUM
Priority: P1
Size: S (1-2h)
Source: Playwright config updated 2026-04-10 — test project targeting port 7776 added but specs not yet tagged
Files: test/api/setup.spec.ts, test/lifecycle.spec.ts, test/playwright.config.ts
Description: The Playwright config now has a `test` project targeting port 7776 for `@destructive` tests, and `postJSONDestructive()` in fixtures.ts routes calls to `TEST_BASE`. However, `setup.spec.ts` and `lifecycle.spec.ts` do not yet have `@destructive` tags on their test cases. Add `@destructive` annotation to all tests in those two files so they are automatically routed to port 7776. Verify: `npx playwright test --project=test` runs only the tagged tests against the test container and passes.

### BKL-REG-11 | Product intel only works for RHEL — other products return empty or fail silently
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Size: M (2-3h)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/ProductIntelSection.tsx
Description: Two compounding bugs: (1) `handleRegenerate` called `POST /api/products/${slug}/refresh` before generate, which does live web scraping (15-90s timeouts per URL). If the refresh timed out or failed for any product, generation was silently skipped with an error banner that disappeared. (2) Products with `relevanceScore === 'NONE'` (either subscription-skip or genuine no-match) were filtered out of both `visibleSlugs` and `uncachedSlugs`, causing them to silently disappear from the UI after generation. Users could not see the result or regenerate.
Decision: DONE — (1) Removed mandatory refresh-before-generate from `handleRegenerate` and `handleGenerateAll`; intel generation now calls generate directly using cached product summary. Added fallback: if generate fails with "No cached summary", refresh is attempted once then generate retries. (2) `visibleSlugs` now includes all non-null intel (including NONE-scored); header badge counts only non-NONE results. Added NONE to `RELEVANCE_STYLES` with muted styling. All 7 products now show their generated state after intel generation.

### BKL-UX-morning-min | Morning summary starts fully expanded — should start minimized when signals > 3
Status: ✅ DONE 2026-04-10
Severity: LOW
Priority: P1
Size: XS (30m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/MorningSummary.tsx
Description: `collapsed` state was initialized to `false` (expanded). On busy mornings with many signals, the morning summary dominated the viewport immediately on page load.
Decision: DONE — `collapsed` now initializes to `true` (collapsed). After data loads, auto-expands only when `signals.length <= 3`. Heuristic: > 3 signals = stay collapsed (user can expand). The existing collapsed view shows a compact bullet outline (BKL-PVIEW-08) so information is still accessible.

### BKL-UX-sidebar-scroll | Sidebar disappears on scroll — not sticky
Status: ✅ DONE 2026-04-10
Severity: MEDIUM
Priority: P2
Size: XS (15m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/Sidebar.tsx
Description: Sidebar `<aside>` used `position: relative` and `min-h-screen` inside a `flex min-h-screen` layout container. Main content scrolling moved the sidebar out of view because it was in normal document flow.
Decision: DONE — Changed `relative` to `sticky top-0 self-start` and `min-h-screen` to `h-screen`. The `overflow-y-auto` on the inner `<nav>` ensures sidebar content itself can scroll independently when the nav items are tall. Sidebar now stays fixed at the top of the viewport as main content scrolls.

### BKL-BOOT-AI | Bootstrap does not pre-generate briefs for new customers after completion
Status: ✅ DONE 2026-04-10
Severity: LOW
Priority: P3
Size: S (1h)
Source: Jason — 2026-04-10 testing session
Files: src/customer-routes.ts, src/bootstrap-orchestrator.ts
Description: After bootstrap, `POST /api/intelligence/generate-all` was triggered (BKL-AI07) but there was no equivalent trigger for brief pre-generation. Newly bootstrapped customers had no cached brief until a user navigated to their detail page. The background scheduler's startup pregen ran only once at server start, missing customers added post-startup.
Decision: DONE — Added `POST /api/briefs/pregen-all` endpoint in customer-routes.ts. Uses same pattern as background-scheduler.ts brief-pregen: skips customers with existing cache, 10s gap between customers, fire-and-forget. Added non-blocking trigger in bootstrap-orchestrator.ts after the intelligence batch trigger. Always safe to call — the endpoint is idempotent (no-ops for cached customers).

### BKL-REG-12 | Admin page missing from sidebar — no Admin nav item, Settings navigated to AdminPage
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Size: S (1h)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/Sidebar.tsx
Description: Sidebar had no "Admin" nav item. The "Settings" item was navigating to `/dashboard/admin` (AdminPage) via `navigate()`, while also calling `onActiveChange('Settings')`, causing the Dashboard to show the inline Settings panel. This made AdminPage unreachable from the sidebar. Route `/dashboard/admin` was correctly registered in App.tsx but the sidebar link was mislabeled and conflicted with the inline panel.
Decision: DONE — Added dedicated "Admin" nav item with ShieldCheck icon that navigates to `/dashboard/admin` without calling `onActiveChange`. Settings button now only triggers the inline settings panel (button onClick only, no navigate). Admin item highlights when pathname is `/dashboard/admin`.

### BKL-REG-13 | Account plan shows "Failed to start generation" — swallows actual server error
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Size: XS (30m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/AccountPlanPanel.tsx
Description: The catch block in `handleGenerate()` used a hardcoded generic message "Failed to start generation" for ALL error paths — network failures, non-JSON responses (HTML error pages from 503s), and JSON parse failures. The actual server error (e.g. missing config files, Drive auth failures) was invisible to the user.
Decision: DONE — Split error handling into three specific paths: (1) non-JSON response shows HTTP status + statusText, (2) server JSON error shows actual `data.error` message (was already handled, kept as-is), (3) network/thrown exceptions show the actual error message. All three paths surface diagnostic information without requiring log access.

### BKL-REG-14 | Product Intelligence section collapses after generating a NONE-scored product
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Size: XS (30m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/components/ProductIntelSection.tsx
Description: NONE-scored product intel from the API may return objects with missing array fields (roadmapRelevance, expansionOpportunities, caseAlignment as undefined instead of []). ProductCard accessed `.length` directly on these fields without optional chaining, causing a React render crash. With no error boundary, the entire Product Intelligence section unmounted silently. BKL-REG-11 added NONE to visibleSlugs correctly but did not guard the array access.
Decision: DONE — All four array fields (roadmapRelevance, expansionOpportunities, caseAlignment, featureTalkingPoints) now use `?? []` fallback in both the guard condition and the .map() call. Component no longer crashes on sparse NONE results.

### BKL-REG-15 | Segment field hidden on customer detail page — no fallback for missing data
Status: ✅ DONE 2026-04-10
Severity: MEDIUM
Priority: P1
Size: XS (15m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: The segment badge was rendered only when `meta?.segment` was truthy. Since 104/106 customers have no `segment` field populated in customers.json (enrichment batch BKL-ENRICH-01 not yet run), the badge was never visible. The industry field was not in the Customer data model or SSE meta event at all. Users had no way to see that the field exists but lacks data.
Decision: DONE — Segment badge now renders whenever `meta` loads (not null), with accent styling when populated and muted '—' when empty. This makes the data gap explicit and visible. Industry field deferred — not in Customer type or SSE meta; requires BKL-ENRICH-01 to add field to data model before UI can display it.

### BKL-REG-16 | Search bar / filter / by-AE / list header missing above Account Portfolio
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P0
Size: XS (15m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/App.tsx
Description: BKL-UX52 replaced AccountPortfolioGrid with AEGroupedList in the section-accounts section. AEGroupedList has no search bar, triage filter, by-AE toggle, list view toggle, or Account Portfolio section header. All those controls existed inside AccountPortfolioGrid and were lost in the replacement.
Decision: DONE — Restored AccountPortfolioGrid in section-accounts, passing filteredAccounts, cases, events, loading, selectedProducts, aeList, aeFilterSelected, and allAccounts. AEGroupedList remains imported but is no longer used at the top-level render path. All controls restored.

### BKL-REG-17 | Segment badge shows grey no-data state on customer detail page
Status: ✅ DONE 2026-04-10
Severity: MEDIUM
Priority: P1
Size: XS (10m)
Source: Jason — 2026-04-10 testing session
Files: dashboard/src/pages/CustomerDetailPage.tsx
Description: BKL-REG-15 added a fallback rendering the segment badge with a grey muted style and "—" when segment is null/empty. This looked broken — a ghost badge with no real data. 104/106 customers have no segment populated so the grey badge appeared on nearly every customer detail page.
Decision: DONE — Segment badge now only renders when meta.segment is populated (truthy). When segment is null/empty, the badge is hidden entirely. No grey ghost badge.

### BKL-REG-18 | Pipeline (Salesforce) sync status disappears after Sync Now completes
Status: ✅ DONE 2026-04-10
Severity: HIGH
Priority: P1
Size: XS (15m)
Source: Jason — recurring regression, 2026-04-10
Files: dashboard/src/pages/SetupPage.tsx
Description: After clicking "Sync Now" on the Pipeline (Salesforce) data source card, the status line showed "Syncing…" then disappeared instead of showing "✓ Synced X rows". Root cause: in `handleSfSync`, the `fetch('/api/auth/salesforce/status')` call inside the poll's `!s.running` branch was fire-and-forget — `resolve()` fired before the fetch settled, so `setSfSyncing(false)` ran in `finally` before `setSfStatus` updated. During that window `sfStatus.lastSync` was still stale/null, so the conditional render showed "Pipeline data" fallback. Additionally, the status block had duplicate renderings (lines 3028-3029 and 3033-3036 both rendering sync result).
Decision: DONE — Restructured poll resolution: `resolve()` now fires inside `.then()` after `setSfStatus(data)` completes, eliminating the race condition. Added "Syncing…" indicator while `sfSyncing || scraperRunning.salesforce` is true. Consolidated duplicate status render into single conditional with clear "✓ Synced X rows" / age-based display.

### BKL-DATA-02 | Many customers show "acme.com" domain placeholder — domain inference incomplete
Status: ✅ DONE 2026-04-11
Severity: MEDIUM
Priority: P2
Size: XS (trigger only)
Source: Jason — Setup wizard screenshot, 2026-04-10
Files: data/config/customers.json, src/domain-inferrer.ts
Description: Approximately half of customers in the Setup wizard show "acme.com" as their domain. Domain inference either did not run for all customers during initial bootstrap, or ran but left some as placeholder when no domain could be resolved. This is a data gap, not a code bug — the inference logic exists and the Admin page "Run Now" button triggers it.
Fix: Admin page → Domain Inference → Run Now (or POST /api/setup/infer-domains). No code change needed. After running, customers with resolvable company names will have real domains; edge cases may need manual override in customers.json.
Decision: DONE 2026-04-11 — Domain inference ran via POST /api/setup/infer-domains. Result: 72/106 customers now have real domains (Clearbit or Gemini-inferred). 34 customers have no resolvable domain — these are companies where no domain could be verified (subsidiaries, entities with ambiguous names). acme.com placeholder is gone except for "Acme Corp" test customer where it is correct. Manual override available via customers.json for the 34.

### BKL-INTEL-02 | Account Intelligence docs open blank in Drive
Status: ✅ DONE — 2026-04-10
Priority: P1 | Type: Bug
Source: Jason — 2026-04-11
Files: src/account-intelligence.ts
Description: When clicking "Open" on Company or Industry intelligence doc links in the AccountIntelligencePanel, the Google Doc opens but is blank. The Drive doc is created successfully (URL is valid, doc exists), but the generated content is not being written into the doc body. Confirmed on Applied Medical Resources — doc links present in UI, content empty.
Fix needed: Investigate writeIntelligenceToDoc() or equivalent in account-intelligence.ts — likely the Docs API write call is failing silently or writing to the wrong location within the doc.

### BKL-REG-19 | Per-customer case count in list view uses accountNumbers only — name-matched customers show 0
Status: ✅ DONE 2026-04-11 — getCasesForAccountFromMap() with name-match fallback applied to AccountPortfolioGrid.tsx
Priority: P0 | Type: Bug
Source: Jason screenshot — 2026-04-11
Files: dashboard/src/components/AccountPortfolioGrid.tsx, src/customer-routes.ts (health score / cases per customer)
Description: The Cases column in Account Portfolio list view shows 0 for most customers despite the pod banner showing 52 open cases. Same root cause as BKL-REG-08 — per-customer case count filters by accountNumbers only, not by customer name match. 39 customers have no accountNumbers and all show 0. The name-match fix applied to PodKPIHeader.tsx was not applied to the per-customer case count used in the portfolio list and health score.
Fix: Apply the same nameSet match logic (customer name toLowerCase comparison) to wherever per-customer openCaseCount is computed — likely health-score.ts or the cases-per-customer endpoint feeding AccountPortfolioGrid.

### BKL-INTEL-03 | Validate intelligence doc content length — auto-regenerate if empty or < 5 lines
Status: ✅ DONE 2026-04-11
Priority: P1 | Type: Feature
Source: Jason — 2026-04-11
Files: src/account-intelligence.ts, dashboard/src/pages/AdminPage.tsx
Description: Intelligence docs are being created in Drive but content is not written (BKL-INTEL-02). Need a validation step that reads each customer's company/industry doc from Drive, checks line count, and flags or auto-regenerates any doc with fewer than 5 lines of content.
Implementation options:
  1. Post-generation validation — after writeIntelligenceToDoc(), read the doc back and verify content length. If < 5 lines, mark as failed and re-queue.
  2. Batch validation endpoint — POST /api/intelligence/validate-all — scans all cached intelligence docs, fetches Drive doc content, re-queues any with < 5 lines.
  3. Admin page button — "Validate & Repair Intelligence Docs" — runs batch validation with progress display.
Recommended: Option 1 (post-generation check) as the permanent fix + Option 3 (Admin button) for repairing existing empty docs.

Decision (2026-04-11): Intelligence docs should be generated once at bootstrap and only regenerated on explicit manual trigger or when doc is detected as empty. No automatic scheduled regeneration. TTL guard (7d) already prevents unnecessary regeneration. Validation (BKL-INTEL-03) should only re-queue if doc content < 5 lines — not on any recurring schedule.

### BKL-INTEL-04 | identifyIndustry skipped for no-account customers — fixed
Status: ✅ DONE 2026-04-11
Priority: P1 | Type: Bug Fix
Source: DA — 2026-04-11
Files: src/account-intelligence.ts
Description: The BKL-AI-04 no-data early-exit guard skipped the entire intelligence pipeline for customers with no account numbers and no subscriptions. This was correct for Drive doc generation (which needs subscription data), but incorrectly also skipped `identifyIndustry()` which only needs the customer name. Result: 36 customers never got industry/segment populated.
Fix: Added `identifyIndustry()` call inside the no-data guard path, before writing the stub cache. Runs for any customer missing industry data regardless of account/subscription state. Industry result is also written into the stub cache JSON.
Decision: Minimal surgical fix — identifyIndustry runs in the no-data path before the stub write and early return. No restructuring of the async pipeline block.

### BKL-INTEL-05 | Intelligence pipeline skips Drive doc generation for customers without account numbers
Status: ✅ DONE 2026-04-27
Priority: P1 | Type: Bug Fix
Source: Jason — 2026-04-27 (McAfee: "create intelligence docs does nothing")
Files: src/account-intelligence.ts, test/regression.spec.ts
Description: The no-data early-return block at line 1357 gated the full pipeline (company intelligence + industry analysis + Drive doc writes) on `accountNumbers.length === 0 && subscriptions.length === 0`. None of the generation steps actually use account numbers or subscriptions — they only need `customerName` and `industry`. Result: any customer imported from SF bookings without RH Portal scraping would never get Drive docs created.
Fix: Removed the entire early-return guard block (lines 1353–1397). All customers now flow into the full pipeline. Added REG-INTEL-NO-ACCT-01 regression test.

### BKL-INTEL-DRIVE-FOLDER | Intelligence pipeline fails entirely when customer Drive folder not found
Status: 🔵 OPEN
Priority: P1 | Type: Bug Fix
Source: Quinn — 2026-04-27 (Musarubra Us / Trellix fail with "No Drive folder found under AE Peter Niklaus")
Files: src/account-intelligence.ts (findCustomerDriveFolder ~line 756, writeIntelligenceDocs call ~line 1426)
Description: Steps 1–3 (identifyIndustry, generateCompanyIntelligence, generateIndustryAnalysis) succeed and produce content. Step 4 (writeIntelligenceDocs) calls findCustomerDriveFolder which throws if no driveFolderId and no matching subfolder under the AE's Drive. This causes the entire pipeline job to error even though intelligence content was already generated. Any customer with `ae` set to an AE who lacks a Drive folder (or whose subfolder doesn't fuzzy-match the customer name) will fail permanently.
Fix: Wrap the Drive write step — if findCustomerDriveFolder throws, cache intelligence content locally without docUrls and mark job as "complete (no Drive folder)" rather than error. Intelligence content is still usable for briefs; Drive doc creation can be retried later when folder is created.

### BKL-GEMINI-TIMEOUT-COMPOUND | gemini-fetch.ts timeout retry compounds to ~14min wall time under Vertex outage
Status: 🔵 OPEN
Priority: P2 | Type: Reliability
Source: Rook — 2026-04-27
Files: src/gemini-fetch.ts
Description: The TimeoutError/AbortError retry loop (up to 2 extra tries × 120s each = 360s) precedes the 429 exponential backoff loop (4 retries × ~30s). Timeout errors on the 429 retry fetches escape the handler and propagate as raw DOMException. Worst-case per-call: ~870s (~14min) holding a fetch socket + AbortSignal + closure. Under batch intelligence (many customers in parallel), a Vertex outage can starve the event loop.
Fix: (1) Cap timeout retries to 1 for grounded calls (120s× 2 is enough). (2) Wrap the 429 retry fetch in the same `isTimeoutError` guard or add an overall call deadline (~5min). (3) Add concurrency cap upstream in runIntelligencePipeline.

### BKL-SF-ADOPT-RACE | sf-auth.ts context can leak if adoptScrapeContext throws after activeContext=null
Status: 🔵 OPEN
Priority: P2 | Type: Reliability
Source: Rook — 2026-04-27
Files: src/sf-auth.ts
Description: In both login completion paths (happy + fallback), `activeContext = null` is set BEFORE the four `adopt*` calls. If any adopt call throws, the catch block at line 266 runs `cleanupBrowser()` which is now a no-op (activeContext is null). The context the scraper just adopted is alive but untracked.
Fix: Move `activeContext = null` to AFTER all adopt* calls succeed, or wrap the adopt block in a try/catch that runs `cleanupBrowser(ctx)` directly on the local ctx variable.

### BKL-PRODINTEL-01 | Product Intelligence NONE state — use account intelligence context for expansion analysis
Status: ✅ DONE
Priority: P1 | Type: Feature Enhancement
Source: Jason — 2026-04-11
Files: src/customer-product-intel.ts
Description: When a customer has no matching subscription for a product (currently shows "NONE — Analysis skipped — no matching subscriptions"), the system should instead use account intelligence context (company profile, industry description, technology landscape from Drive docs) to assess whether the product could be relevant. This enables proactive expansion conversations rather than just validating existing subscriptions.
Example: Customer has no RHOAI subscription → current: skip. Desired: use company intelligence to check AI/ML initiatives, industry trends, tech stack → show "No current subscription — potential fit: [reason based on intelligence docs]"
Implementation: In customer-product-intel.ts, when no subscriptions match, fall back to reading the customer's intelligence cache (data/cache/intelligence/<slug>.json) and using industry/company context in the Gemini prompt to assess product fit. Return a structured "expansion opportunity" result instead of NONE.
Test: Product intel for a customer with no RHOAI subscription should return an expansion analysis, not empty NONE result.

### BKL-KPI-01 | KPI renewalRows includes expired subscriptions
Status: ✅ DONE 2026-04-10
Priority: P1 | Type: Bug
Source: Agent-detected
Files: dashboard/src/components/KPICards.tsx
Description: renewalRows and allRenewalRows useMemo blocks used `daysLeft <= 90` without a lower bound, causing already-expired subscriptions (negative daysLeft) to be counted in the "Expiring within 30/90 Days" KPI cards.
Fix: Added `daysLeft >= 0` guard to both useMemo blocks (lines 192 and 225). Comment: BKL-KPI-01.
Test: REG-022 added to test/regression.spec.ts — verifies fixedCount (daysLeft >= 0 && daysLeft <= 90) is <= buggyCount (daysLeft <= 90 only).

---

### BKL-PRODINTEL-02 | Product intelligence should include goal/initiative alignment for ALL products
Status: ✅ DONE 2026-05-02 — Backend: initiativeAlignment field + Gemini prompt complete (2026-04-11). UI: "How this helps" section added to ProductIntelSection.tsx:437-450 (2026-05-02). Interface updated at line 36. Renders 1-3 bullet items per product card when AI returns initiative alignment data.
Priority: P1 | Type: Feature Enhancement
Source: Jason — 2026-04-11
Files: src/customer-product-intel.ts, dashboard/src/components/ProductIntelSection.tsx
Decision: Backend-only pass completed 2026-04-10. Added `initiativeAlignment?: string[]` to `CustomerProductIntelligence` interface. Updated system prompt to instruct Gemini to generate 1-3 initiative-specific alignment statements from company/industry context. Added `initiativeAlignment` to output schema and captured from parsed Gemini JSON with `[]` fallback. `loadAccountIntelligence()` already loaded the intelligence cache — no new file loading needed. UI "How this helps" section (ProductIntelSection.tsx) deferred to separate session.

Description: BKL-PRODINTEL-01 added EXPANSION analysis when a customer has NO subscription. This item extends product intelligence to be goal/initiative-driven for ALL products — both subscribed and unsubscribed:

1. **Subscribed products**: Use subscription data + product intelligence context. Pull company goals/initiatives from the intelligence cache (industry analysis, company profile from Drive docs). Generate "How [Product] helps [Customer]" — maps product capabilities to their specific context and goals. Subscription data confirms they own it; intelligence explains HOW they could/should use it more.

2. **Unsubscribed products**: Already done via BKL-PRODINTEL-01 (EXPANSION badge). Extend: also check Drive docs directly if intelligence cache is thin. If Drive docs mention initiatives that align to this product, surface them.

3. **Drive doc cross-reference**: When a customer has Drive documents cached (`data/cache/intelligence/<slug>.json` or raw docs), extract initiative/goal keywords and align them to specific product features. Example: doc mentions "migrating to cloud" → flag OpenShift; doc mentions "cost reduction" → flag RHEL + AAP.

4. **"How this helps" section**: Add a new UI section in ProductIntelSection.tsx — "How [Product] helps [Customer]" — a 2-3 bullet AI-generated summary that maps product capabilities to the customer's specific context.

Implementation approach:
- Enhance `generateProductIntel()` in customer-product-intel.ts to always run a goal-alignment pass using the intelligence cache, regardless of subscription status
- The prompt should include: product description, customer company/industry/goals from cache, any available Drive doc excerpts
- Keep using gemini-2.5-flash-lite for cost optimization
- Cache the result with the same TTL as existing product intel

Decision: Separate from BKL-PRODINTEL-01 which only handled NONE state. This upgrades ALL product intel to be context-aware.

---

### BKL-PRODINTEL-03 | Generate button visible for all products, including NONE-scored cached results
Status: ✅ DONE
Priority: P1 | Type: UI Bug
Source: Jason screenshot — 2026-04-10
Files: dashboard/src/components/ProductIntelSection.tsx

Description: Unsubscribed products with a cached NONE result showed no Generate button — the result was permanent with no way to re-trigger without expanding the card and clicking Regenerate in the footer.

Fix: Converted the ProductCard header from a single full-width button to a flex row containing (1) an inner button covering the collapsible area and (2) a small secondary "Re-analyze" button (✦ icon, text-text-secondary styling) that appears only when relevanceScore === 'NONE'. The NONE badge remains visible alongside the new button. Non-NONE scores and the uncached stub rows are unchanged.

---

### BKL-PRODINTEL-04 | Expansion Opportunities — cross-product recommendations block on Customer Detail
Status: ✅ DONE 2026-04-11
Priority: P1 | Type: Feature
Source: Jason — 2026-04-11
Files: src/expansion-opportunities.ts (new), src/customer-routes.ts, dashboard/src/components/ProductIntelSection.tsx, test/regression.spec.ts (REG-026)

Description: New "Expansion Opportunities" block at the top of the Product Intelligence section on Customer Detail page. Gemini cross-references all available signals (intelligence cache, subscriptions, cases, Drive docs, feature caches) to recommend up to 3 Red Hat products the customer does not currently subscribe to. Each recommendation includes: product name, why sentence citing specific signal evidence, 2–3 feature chips, confidence badge (HIGH/MEDIUM/LOW).

API:
- GET /api/customer/:name/expansion-opportunities — returns cached result or null
- POST /api/customer/:name/expansion-opportunities — generates and caches

Cache: data/cache/intelligence/{slug}-expansion.json

Decision: Implemented as standalone module + two new routes + new UI block at top of Product Intel section. Generate/Regenerate button per customer. "Generate All" also triggers expansion. Empty state handled gracefully. REG-026 validates endpoint shape.

QA: Quinn Torres — PASS 2026-04-11. All 5 criteria validated. Recommendations include real signal grounding (CEO quotes, hiring data, IT strategy). Visual distinction from per-product rows confirmed.

---

### BKL-DATA-03 | Customer Drive folder IDs not stored — fuzzy name match fails for some customers
Status: ✅ DONE 2026-04-11
Priority: P1 | Type: Bug
Source: Jason — 2026-04-11
Files: src/bootstrap-orchestrator.ts (or equivalent), src/account-intelligence.ts, data/config/customers.json

Description: Drive folders are created at bootstrap time using customer names from the territory sheet. Customer names in customers.json come from Salesforce (legal names), which can differ from folder names. The fuzzy match (threshold 0.5) fails for ~6 customers where names differ significantly (e.g., "First American Home Buyers Prot." vs "First American Home Buyers Protection").

Root cause: Bootstrap creates the Drive folder but doesn't store the folder ID back into customers.json per-customer `driveFolderId` field. The lookup code already checks `customer.driveFolderId` first (line 569 of account-intelligence.ts) — if populated, fuzzy match is bypassed entirely.

Fix: During bootstrap step where customer Drive folders are created (or immediately after), write the returned folder ID into `customers[i].driveFolderId` in customers.json. This is a one-time write per customer that eliminates name-matching fragility permanently.

Also: For existing customers missing `driveFolderId`, an Admin page "Repair folder IDs" button could run the fuzzy match once, find whatever it can, and persist the IDs found — so future runs skip matching.

Decision: DONE — added persistCustomerFolderId() helper to account-intelligence.ts (follows cacheIndustryResult pattern: readFileSync fresh → set driveFolderId → atomic tmp+rename → update in-memory array → log). Called after both shallow and deep fuzzy matches in findCustomerDriveFolder(). Confirmed bootstrap-orchestrator.ts already writes driveFolderId to customers.json at step 2 (BKL-DATA-03 comment added). Fast path (customer.driveFolderId check) will now be hit on all subsequent intelligence runs.

---

### BKL-PRELOAD-01 | Pre-seed intelligence cache via PAI skill at bootstrap — eliminate per-request Gemini costs
Status: ⏸ DEFERRED 2026-04-11 — blocked on API access
Priority: P2 | Type: Feature / Cost Optimization
Source: Jason — 2026-04-11
Blocked: aistudio.google.com not accessible with Red Hat SSO. gemini.google.com/app is accessible but is a web interface only (no API key available from there). Existing Vertex AI API key in .env works for current runtime costs. Alternative pre-seeding strategy: export/import of cache files (data/cache/intelligence/*.json) when deploying to new environments — no additional API key needed. Revisit if a free Gemini API key becomes available, or when deploying to a new environment requires seeding costs upfront.
Decision: DEFERRED — existing Vertex AI key handles all runtime calls. Cache files can be bundled for new deployments. API key path from RH-accessible tools is blocked.

Description: Instead of generating account intelligence and product intelligence on-demand via Gemini API (costs per call), run a one-time pre-seed batch at bootstrap using a PAI CLI skill (Claude) that:

1. Generates account intelligence (company profile, industry analysis) for all customers
2. Generates product intelligence for each customer × product combination
3. Writes results to local cache files (`data/cache/intelligence/*.json`, `data/cache/product-intel/*.json`)
4. Writes Drive docs (company brief, industry analysis) — same as current `writeIntelligenceDocs()`
5. Marks cache with a `seededAt` timestamp and `seededBy: 'pai-cli'`

Runtime behavior stays the same: dashboard reads from cache first. Gemini calls only fire if cache is expired (>7d) or missing. Pre-seeded cache has the same TTL — so Gemini is still the refresh engine, Claude is just the initial seeder.

Implementation:
- New PAI skill: `~/.claude/PAI/Skills/SeedIntelligence.ts` (or a bun script at `scripts/seed-intelligence.ts`)
- Takes the same prompts as `callGeminiGroundedStructured()` but routes through `bun Tools/Inference.ts smart` (Claude Opus/Sonnet)
- Outputs must match the existing cache JSON schema exactly so the dashboard reads them transparently
- Bootstrap orchestrator calls this as step 7 (after domain inference, before RH cases)
- Admin page: "Re-seed All Intelligence" button triggers it on demand

Cost model: ~$0 marginal (PAI CLI already running) vs ~$3.25 Gemini for 106 customers. After initial seed, Gemini only fires on 7-day expiry refreshes.

Consideration: Grounded search (Google Search API) is only available via Gemini — Claude cannot web-search. Product intel summaries and company profiles that rely on current web data would have lower accuracy without grounding. Hybrid approach possible: use Claude for structure/reasoning, Gemini only for the web-search-dependent calls.

Decision: Research before implementing — evaluate quality tradeoff and whether ungrounded Claude output is acceptable for initial seeding.

### BKL-UX63 | Setup page Step 3 vs Step 5 show conflicting RH Portal connection state
- Status: OPEN
- Priority: P3
- Source: Jason caught 2026-04-11 — Step 3 shows "Connected", Step 5 shows "Not connected" for same expired session
- Description: `RedHatPortalSection` (Step 3) shows "Connected" when `hasSession=true` regardless of `sessionExpired` (per BKL-UX60 intent). Data Sources panel (Step 5) uses `hasSession && !sessionExpired` — stricter. When session expires, both show at same time, confusing the user about true state. Fix: align Step 3 to show "Session expired — reconnect" state when `sessionExpired:true`, or reconcile logic so both panels agree.

### BKL-UX65 | Step 5 Data Sources header stays "Checking..." forever — never resolves
- Status: OPEN
- Priority: P2
- Source: Quinn audit 2026-04-11
- Description: The Step 5 "Data Sources" accordion header badge shows "Checking..." indefinitely and never flips to a resolved state (e.g., "2 of 4 connected" or "Ready"). Tableau connection card inside also stays "Checking..." permanently. Nielsen #1 violation — user cannot get a quick at-a-glance read on data source status. The `dataSourcesHealth` state may never transition from 'loading' if any individual connection check hangs (Tableau in particular since it requires CCSP + session data).

### BKL-UX66 | "Analysis skipped" entries appear in Top Priority Actions on Products page
- Status: DONE (fixed this session)
- Priority: P2
- Source: Code review 2026-04-11 — filter only excluded 'Analysis unavailable', not 'Analysis skipped' variants
- Fix: Added `!intel.priorityAction.startsWith('Analysis skipped')` guard in product-intel-routes.ts territory-summary endpoint
- Test: REG-025 in regression.spec.ts

### BKL-UX64 | Settings sections show blank while loading — no loading indicator
- Status: ✅ DONE 2026-04-11
- Priority: P2
- Source: Jason caught 2026-04-11 — accordion opens to blank content while API fetch in-flight
- Fix: Added Loader2 spinner to AiIntelligenceSettings, AutomationSettings, RefreshTimerSettings while draft=null
- Files: `dashboard/src/components/AiIntelligenceSettings.tsx`, `AutomationSettings.tsx`, `RefreshTimerSettings.tsx`

---

### BKL-INGEST-04 | Add DISALLOW_LIVE_SCRAPE env guard to scrapers
Status: ✅ DONE — 2026-05-02. Guard already fully implemented: rh-scraper.ts:520-521, rh-scraper.ts:1050-1051, sf-scraper.ts:457-458, sf-scraper.ts:957-958, ccsp-scraper.ts:537-538, ccsp-scraper.ts:670-671. All 19 tests in test/unit/ingest-04-disallow-live-scrape.test.ts pass.
Priority: P3
Size: S
Source: Worktree test cleanup 2026-04-24 — test/unit/ingest-04-disallow-live-scrape.test.ts existed in worktree but guard was never implemented
Files: src/rh-scraper.ts, src/ccsp-scraper.ts, src/sf-scraper.ts
Description: test/unit/ingest-04-disallow-live-scrape.test.ts was a worktree-only test for a `DISALLOW_LIVE_SCRAPE=true` env guard that prevents live scraper runs (useful for CI/testing). The guard was never implemented in the scrapers. Feature would allow CI to run without hitting real portals.

---

### BKL-AI-FP01 | Add DISALLOW_GEMINI env guard to brief generation
Status: ✅ DONE — already implemented. customer.ts:566 (callLLM) and :1017 (callLLMStructured) both check DISALLOW_GEMINI=true and return fixture responses. BKL-AI-FP-01 comment present in code.
Priority: P3
Size: S
Source: Worktree test cleanup 2026-04-24 — test/unit/ai-03-disallow-gemini.test.ts existed in worktree but guard was never implemented
Files: src/customer.ts, src/account-intelligence.ts
Description: test/unit/ai-03-disallow-gemini.test.ts was a worktree-only test for a `DISALLOW_GEMINI=true` env guard that prevents live Gemini API calls (useful for offline testing). The guard was never implemented. Feature would allow testing brief generation flows without hitting Vertex AI.

---

### BKL-INGEST-06 | Implement scheduleRetry in background-scheduler.ts
Status: ✅ DONE — verified 2026-05-02. scheduleRetry already implemented at background-scheduler.ts:194 and used at lines 550, 860. Test file ingest-06-scheduler-retry.test.ts passes (12/12 across both INGEST-06 + INGEST-10).
Priority: P3
Size: S
Source: Worktree test cleanup 2026-04-24 — test/unit/ingest-06-scheduler-retry.test.ts tested an export that was never added
Files: src/background-scheduler.ts
Description: test/unit/ingest-06-scheduler-retry.test.ts tested a `scheduleRetry(job, delay)` export from background-scheduler.ts that would allow manual retry scheduling of failed scrape jobs. The export was never implemented. Currently failed jobs have no retry path.

---

### BKL-INGEST-10 | Add L1 TTL short-circuit to refresh-engine
Status: ✅ DONE — verified 2026-05-02. refresh-engine.ts exists; L1 TTL short-circuit implemented and tested. ingest-10-refresh-l1-ttl.test.ts passes (12/12 across both INGEST-06 + INGEST-10).

---

### BKL-SEC-VERTEX-01 | Fix vertex-429 P0-04b mock boundary in callLLM tests
Status: ✅ DONE 2026-05-02 — Added 4 tests to test/unit/vertex-429.test.ts (new describe block lines 210-258). callLLM + callLLMStructured both throw on all-429 and retry ≥2x. 9/9 pass.
Priority: P2
Size: M
Source: Worktree test cleanup 2026-04-24 — BKL-TEST-P0-04b blocks removed as untestable
Files: src/customer.ts (callLLM, callLLMStructured), test/ (new regression when fixed)
Description: BKL-TEST-P0-04b blocks (removed in this session) tested retry behavior of `callLLM`/`callLLMStructured` but mocked `getGeminiToken` at the wrong layer — `callLLM` uses google.auth.JWT directly, so the mock never intercepted. The fix requires either (a) injecting a token-getter into callLLM for testability, or (b) refactoring callLLM to use `fetchGeminiWithRetry`. P0-04b blocks were removed as untestable until this is resolved.

---

### BKL-SEC-DOM-01 | Apply tier2 domain regex to tier1 Clearbit output in domain-waterfall
Status: ✅ DONE 2026-05-02 — Added `/^[a-z0-9]([a-z0-9\-._]{0,251}[a-z0-9])?$/` guard to tier1Clearbit() before return (domain-waterfall.ts:49). Matches tier2LLM validation at line 86.
Priority: P2
Size: XS
Source: Rook finding — worktree review 2026-04-24
Files: src/domain-waterfall.ts (~line 45)
Description: Rook finding: src/domain-waterfall.ts line ~45 — tier1 Clearbit domain output passes straight through without applying the tier2 sanitization regex. A malformed Clearbit response could yield an invalid domain. Fix: apply the same domain validation regex used in tier2 to tier1 output before returning.

---

### BKL-E2E-01 | Stabilize E2E test suite — 54 pre-existing failures
Status: 🟡 IN PROGRESS
Priority: P2
Size: L
Source: 2026-04-25 — E2E job became reachable for the first time when unit test gate was fixed
Files: test/wizard.spec.ts, test/ui/*.spec.ts, test/accessibility.spec.ts, test/bootstrap-recovery.spec.ts, test/smoke-prod.spec.ts, test/regression.spec.ts, test/navigation-regression.spec.ts, playwright.config.ts
Description: 54 pre-existing E2E test failures surfaced when the Integration & E2E job became reachable (previously always blocked by unit test failures). Root causes include: (1) UI selector mismatches — wizard, bootstrap-recovery, and dashboard-empty-state tests look for elements that no longer exist at the expected selectors; (2) axe/WCAG violations on /dashboard and /dashboard/setup; (3) xfail tests using test.fail() counted as failures; (4) smoke-prod hitting /customers endpoint on dev server (7778) and getting empty response; (5) React "Something went wrong" crash on nonexistent customer page. CI has continue-on-error while this is addressed. Fix requires: auditing each failing spec against current UI, updating selectors, fixing the axe violations, and ensuring seed data correctly populates /customers on dev server.
Stopped at: continue-on-error added 2026-04-25; next step is systematic triage of failing specs with Quinn
Additional stale regressions found 2026-04-29 during release gate work: REG-BOOT-06 asserts rh-cases IS enqueued from bootstrap (intentionally removed in BKL-BOOT-SCRAPE-ORDER-01); REG-079 checks retired Supportable timeout code; setup.spec.ts pod-config non-destructive tests fail due to file-level beforeAll/afterAll snapshot interference on prod. Release gate scoped to test/api/ + test/contracts/ only until these are fixed.

---

### BKL-SEC-RETRY-01 | Migrate callLLM/callLLMStructured to fetchGeminiWithRetry
Status: ✅ DONE — verified 2026-04-26. Both callLLM (line 609) and callLLMStructured (line 1076) already use fetchGeminiWithRetry. Migrated in a prior session.
Priority: P2
Size: S
Source: Rook audit 2026-04-25 — consistency gap with new retry infrastructure
Files: src/customer.ts (callLLM ~line 474, callLLMStructured ~line 896)
Description: callLLM and callLLMStructured use raw fetch() with no retry logic and no Bearer redaction on error. Unlike callGeminiGrounded (which was migrated this session), these two functions silently fail on 429 and have inconsistent error sanitization vs fetchGeminiWithRetry guarantees. Migrate both to fetchGeminiWithRetry to ensure consistent retry behavior and token redaction.

---

### BKL-SEC-SAKEY-01 | Add try/catch around SA key parse in callLLM/callLLMStructured
Status: ✅ DONE 2026-04-26 — MOOT: GEMINI_SERVICE_ACCOUNT_KEY removed from .env (BKL-SEC-SAKEY-VERIFY-01). SA key parse path is never reached. Fallback code in gemini-auth.ts + customer.ts remains for non-redhat.com users only.
Priority: P2
Size: XS
Source: Rook audit 2026-04-25 — partial key material could appear in logs on malformed env var
Files: src/customer.ts (callLLM ~line 484, callLLMStructured ~line 904)
Description: JSON.parse(Buffer.from(saKeyB64, 'base64').toString()) throws raw JS errors with no sanitization if GEMINI_SERVICE_ACCOUNT_KEY is malformed. Error could expose partial key material in server logs. Wrap in try/catch with a safe "invalid service account key format" message, consistent with gemini-auth.ts pattern.

---

### BKL-UX-OAUTH-SCOPE-01 | Wizard: prompt re-auth when cloud-platform scope missing from token
Status: ✅ DONE 2026-04-26
Priority: P2
Size: XS
Source: Algorithm learn phase reflection 2026-04-25 — Quinn detected scopeLevel:"bootstrap" on existing tokens
Files: dashboard/src/pages/SetupPage.tsx, src/routes/auth-routes.ts
Description: Existing users who authenticated before the cloud-platform scope was added to NORMAL_SCOPES have tokens without Vertex AI access. The dashboard loads normally but live Gemini calls fail silently. Fix: on /dashboard/setup load, check if the current token's scopes include 'https://www.googleapis.com/auth/cloud-platform'. If missing, surface a banner: "Your Google sign-in needs to be updated to enable AI briefs — sign out and sign back in." This prevents silent Vertex AI failures for pre-scope users.

---

### BKL-SEC-SUPPORTABLE-01 | Supportable API routes still registered in scrape-api.ts
Status: ✅ DONE 2026-04-26 (partial — see BKL-SEC-SUPPORTABLE-02 for remaining SetupPage cleanup)
Priority: P1
Size: S
Source: Rook security scan 2026-04-25 — recovered code from mini.local retained Supportable routes
Files: src/scrape-api.ts, dashboard/src/pages/SetupPage.tsx, dashboard/src/App.tsx
Description: HTTP routes for /api/scrape/supportable were already absent. Removed: SUPPORTABLE_DISABLED dead constant, _supportableReachableCache VPN fetch, supportableReachable field from scraper-status response, Retry Supportable button from SetupPage.tsx, dead type field from App.tsx. Verified: Quinn (dead button absent, zero console errors), Rook (no orphaned endpoint calls in removed scope).
Decision: Remaining SetupPage.tsx Supportable connection panel (state, polling, /api/scrape/supportable/status fetch) deferred to BKL-SEC-SUPPORTABLE-02 — requires SetupPage routing fix first so Quinn can verify.

---

### BKL-SEC-SUPPORTABLE-02 | SetupPage.tsx Supportable connection panel still live
Status: ✅ DONE 2026-05-02 — Verified in source: supportableStatus, supportableReachable, handleSupportableConnect, and all connection panel state/calls already removed from SetupPage.tsx. Only legacy data fields remain (supportableSheetId, supportableName) which are intentional AE form fields. Remaining: /api/auth/supportable/check endpoint still in scraper-manager.ts (dead route, protected file — see BKL-SCRAPER-DEAD-01).
Priority: P2
Size: M
Source: Rook scan 2026-04-26 during BKL-SEC-SUPPORTABLE-01 pass
Files: dashboard/src/pages/SetupPage.tsx (lines ~2655, 2689, 2708-2719, 2746, 2753-2851, 3159, 3230-3238), src/scraper-manager.ts (line 895)
Description: SetupPage.tsx still has a full Supportable connection panel: supportableStatus state polling /api/scrape/supportable/status (returns 404), supportableReachable state calling /api/auth/supportable/check, handleSupportableConnect function, derived supportableConnected/Running/Errored values, and a poll timer. The /api/auth/supportable/check endpoint still exists in scraper-manager.ts (protected file). Cannot test cleanup until SetupPage routing bug is fixed (BKL-UI-SETUP-ROUTING-01) — page doesn't render at /setup.
Blocked by: BKL-UI-SETUP-ROUTING-01

---

### BKL-ONBOARD-10 | Implement /api/wizard/setup-region + /api/wizard/seed-sheets
Status: 🟡 IN PROGRESS
Priority: P2
Size: M
Source: Marcus review 2026-04-25 — integration tests reference these endpoints, neither exists on local or mini.local
Files: src/server.ts (or new src/wizard-routes.ts), test/integration/wizard-setup-region.spec.ts
Description: Integration tests expect POST /api/wizard/setup-region (regionId persistence, idempotency), POST /api/wizard/seed-sheets (returns seed URLs), GET /api/settings/regions. None of these exist on the codebase (confirmed on both local and mini.local). This is a feature gap — needs design brief before implementation: where regions persist (settings.json?), what regionId derives from, canonical seed sheet list.

---

### BKL-TEST-WIZARD-01 | wizard.spec.ts section header drift vs actual SetupPage accordion
Status: ✅ DONE — confirmed resolved in prior session. Marcus verified test/wizard.spec.ts already uses "Step N of 5 —" headers matching current SetupPage. No code change needed 2026-04-27.
Priority: P2
Size: XS
Source: Marcus review 2026-04-25 — tests expect "Red Hat Portal" + "POD Bootstrap" headers, actual SetupPage uses "Step N of 5 — …" accordion titles
Files: test/ui/wizard.spec.ts, dashboard/src/pages/SetupPage.tsx
Description: Tests look for headers "Red Hat Portal" and "POD Bootstrap" that don't exist on either local or mini.local SetupPage. The current accordion uses "Step 3 of 5 — Connections", no "POD Bootstrap" section. Either update tests to match current titles, or add the missing section headers (product call needed). Failing tests silently mark as stale until this is resolved.

---

### BKL-PERF-01 | Thundering herd — SF report scraped N times per POD bootstrap
Status: ✅ DONE
Priority: P1
Size: M
Source: Algorithm session 2026-04-24 — thundering herd: each AE triggers its own SF scrape in parallel
Files: src/bootstrap-orchestrator.ts
Description: module-level `podSfDataCache` with 30-min TTL added. Single SF report scrape per POD bootstrap; AEs 2+ read from cache. Confirmed present in recovery from mini.local.
Decision: DONE — podSfDataCache implemented in bootstrap-orchestrator.ts. Confirmed in 2026-04-25 recovery.

---

### BKL-PERF-02 | Thundering herd — Tableau CCSP CSV downloaded N times per POD bootstrap
Status: ✅ DONE
Priority: P1
Size: M
Source: Algorithm session 2026-04-24 — parallel AE bootstraps each download the full POD Tableau CSV
Files: src/ccsp-scraper.ts
Description: module-level `_podCsvCache` added to cache Tableau CSV download per POD per session. Confirmed present in recovery from mini.local.
Decision: DONE — _podCsvCache implemented in ccsp-scraper.ts. Confirmed in 2026-04-25 recovery.

---

### BKL-INGEST-BUG04 | ingest-bug04-bearer-records-success test pre-existing failure
Status: 🟡 KNOWN-FAILURE
Priority: P3
Size: S
Source: Pre-existing failure discovered during 2026-04-25 recovery; ISC-39 documentation requirement
Files: test/unit/ingest-04-disallow-live-scrape.test.ts (or similar), src/settings-api.ts
Description: Unit test `ingest-bug04-bearer-records-success` fails with `SyntaxError: Export named 'recordSessionEstablished' not found in module 'src/settings-api.ts'`. The `recordSessionEstablished` function is imported by a test but not exported from settings-api.ts. This was present before the April 11-23 filter-repo incident — it is not a recovery regression. Fix: either export `recordSessionEstablished` from settings-api.ts, or update the test import to the correct location.

---

### BKL-SETTINGS-01 | recordSessionEstablished missing export from settings-api.ts
Status: 🟡 KNOWN-FAILURE
Priority: P3
Size: XS
Source: Pre-existing gap discovered 2026-04-25; ISC-40 documentation requirement
Files: src/settings-api.ts, test/unit/
Description: `recordSessionEstablished` is referenced in unit tests but not exported from `src/settings-api.ts`. Causes 1 pre-existing unit test failure (220/221 pass). Does not affect production — the function either doesn't exist or exists under a different name/module. Fix: grep for the function definition, find the correct export location, update the test import.

---

### BKL-ADMIN-SUPPORTABLE-01 | Admin page still renders Supportable in 4 places
Status: 🔴 IN PROGRESS (Marcus fixing 2026-04-25)
Priority: P1
Size: S
Source: Quinn audit 2026-04-25 — ISC-25 FAIL
Files: dashboard/src/pages/AdminPage.tsx
Description: Admin page renders Supportable in 4 locations despite Supportable being permanently disabled: (1) Health card row, (2) Manual Scrape Triggers "Supportable Discovery + Sync" button, (3) Initial Load "Supportable Full Bootstrap" entry, (4) Scheduler Config checkbox + label. All 4 must be removed. SessionHealthPanel was already cleaned by Marcus in earlier pass (REG-041) but AdminPage was out of scope.

---

### BKL-UX-STALE-HEALTH-01 | Stale Supportable entry appears in Session Health Panel on first load
Status: 🟡 OPEN
Priority: P2
Size: XS
Source: Quinn audit 2026-04-25 — transient observation
Files: src/scraper-status-store.ts or similar health cache
Description: On first dashboard load after production rebuild, Session Health Panel briefly showed a stale Supportable entry (from 7:26 AM sync, before Supportable was disabled). After live data refreshed, the entry disappeared. Root cause: health/scrape status cache on disk still has a Supportable entry from when it was active. Fix: on server start or after Supportable disable, evict the Supportable key from the scraper-status store so it cannot be served to clients.

---

### BKL-UI-TITLE-01 | Clicking "By AE" filter sets page title to "Pipeline" while on /dashboard
Status: 🟡 OPEN
Priority: P3
Size: XS
Source: Quinn audit 2026-04-25 — cosmetic observation
Files: dashboard/src/App.tsx or dashboard/src/components/PipelineSection.tsx
Description: Clicking the "By AE" button in AccountPortfolioGrid causes `document.title` to change to "Pipeline | ASA Command Center" while the URL stays at /dashboard. A PipelineSection useEffect is likely setting the title regardless of whether it's the active view. Fix: only set title in useEffect when the component is the primary visible view, or move title management to a route-level effect.

---

## Fresh-Install / Bootstrap Data Integrity (2026-04-25)

### BKL-WIZ-SF-SYNC-01 | SF Pipeline "Sync Now" shows no success/row-count feedback
Status: ✅ DONE 2026-04-25
Priority: P2
Size: S
Source: Jason review 2026-04-25
Files: dashboard/src/pages/SetupPage.tsx
Description: Clicking "Sync Now" for Salesforce Pipeline in the setup wizard triggers the scrape but never displays a green success message or row count. The user has no indication the sync completed or how many rows were synced. Compare to other sync buttons that show "Synced N rows." Fix: wire the POST /api/scrape/salesforce response into a success banner showing row count.
Can we test: YES — Playwright test that clicks Sync Now, waits for success text matching /\d+ rows/ or similar.
Decision: DONE — added sfSyncSuccess state to SetupPage.tsx; success banner "✓ Sync complete — N rows" renders under SF Pipeline card, auto-clears after 8s. REG-WIZ-SF-SYNC-01 passes. Commit 1515e77.

### BKL-CACHE-STALE-01 | Dashboard shows stale cached data after customer config changes
Status: ✅ DONE 2026-04-25
Priority: P1
Size: M
Source: Jason review 2026-04-25
Files: src/customer-routes.ts
Description: When customers.json is changed (reset, re-bootstrap, wipe), stale L1 disk cache from the previous customer set bleeds through to the dashboard. Root cause: /api/cases/all pulled cases from disk cache without filtering against current in-memory customers. Fix: filter /api/cases/all to only return cases whose accountNumber belongs to a current customer.
Decision: DONE — /api/cases/all in customer-routes.ts now builds account-number set from in-memory customers store and filters results. /api/accounts and morning-summary already iterated in-memory customers — no change needed. REG-CACHE-STALE-01 passes. Commit 1515e77.

### BKL-BRIEF-STALE-01 | Morning brief shows customers from previous config (stale intelligence cache)
Status: ✅ DONE 2026-04-25
Priority: P1
Size: M
Source: Jason review 2026-04-25
Files: src/customer-routes.ts
Description: Morning brief signal list included customers no longer in customers.json. Root cause: same as BKL-CACHE-STALE-01 — stale case data fed morning-summary for removed customers.
Decision: DONE — morning-summary already iterates in-memory customers (no stale bleed from that path). Cases filter fix (BKL-CACHE-STALE-01) resolved the remaining stale signal source. REG-BRIEF-STALE-01 passes. Commit 1515e77.

### BKL-BOOTSTRAP-ACCOUNTS-01 | Accounts don't appear in account list after AE bootstrap
Status: ✅ DONE 2026-04-25 (fixed-by existing code)
Priority: P1
Size: M
Source: Jason review 2026-04-25
Files: src/customer.ts, POST /api/accounts, bootstrap flow
Description: After bootstrapping, account list showed stale data from previous config. Root cause was BKL-CACHE-STALE-01 (cases filter). /api/accounts already reads in-memory customers; bootstrap-orchestrator.ts already mutates in-memory store on completion.
Decision: DONE — no code change needed. BKL-CACHE-STALE-01 fix resolved the stale bleed. REG-BOOTSTRAP-ACCOUNTS-01 passes. Commit 1515e77.

### BKL-UX-SPARKLINE-01 | Dashboard sparkline polyline NaN console error on empty data series
Status: ✅ DONE 2026-05-02 — Added Number.isFinite filter to InlineSparkline.tsx and SparklineKPI.tsx before polyline point calculation. 10 unit tests in test/unit/sparkline-nan.test.ts (10/10 pass).
Priority: P3
Size: XS
Source: Quinn audit 2026-04-25 (Phase 1 gate)
Files: dashboard/src/components/ — whichever component renders sparklines (likely KPI tiles)
Description: Console error "<polyline> attribute points: Expected number, '0.0,NaN 40.0,NaN'" appears when a sparkline series has no data points. Cosmetic only — no user-visible breakage — but pollutes console. Fix: guard sparkline rendering against empty/NaN series — render a flat line or skip polyline when series is empty.
Can we test: YES — unit test that renders sparkline with empty data array, verifies no NaN in rendered points attribute.

### BKL-UI-CUSTOMER-CRASH-01 | Customer detail page crashes with TypeError on seed data
Status: ✅ DONE
Priority: P1
Size: XS
Source: Quinn audit 2026-04-25 (Phase 3 re-audit)
Files: dashboard/src/components/SubscriptionsSection.tsx:80
Description: `p.quantity.toLocaleString()` crashed when seed customers have `quantity: undefined` in subscription data. Fix: `(p.quantity ?? 0).toLocaleString()`. One-line fix. Quinn re-audit confirmed page renders cleanly. Commit 93ca1e0.

### BKL-TEST-SF-SYNC-BANNER-01 | SF Sync Now success banner not testable on seed container (no SF creds)
Status: 🟡 IN PROGRESS
Priority: P2
Size: S
Source: Quinn audit 2026-04-25 (Phase 1 gate)
Files: test/regression.spec.ts or new test/wizard-sf-sync.spec.ts
Description: The SF Pipeline "Sync Now" success banner (data-testid="sf-sync-success") cannot be exercised on the test container because the button is disabled without SF credentials. REG-WIZ-SF-SYNC-01 cannot exercise the success path. Fix: write a Playwright test that mocks POST /api/scrape/salesforce to return {ok:true,rowCount:47}, asserts data-testid="sf-sync-success" appears with "✓ Sync complete — 47 rows", and disappears within 8s.
Can we test: YES — via page.route() mock for the SF scrape endpoint.

### BKL-TEST-SEED-SMOKE-01 | Customer detail page not covered by seed smoke suite
Status: ✅ DONE 2026-04-27 — @smoke customer-detail test added to smoke-prod.spec.ts. GET-only, dynamic customer name, asserts no AppErrorBoundary + H1 present + zero pageerrors. 7/7 smoke pass on prod. Quinn+Rook: CLEAN.
Priority: P2
Size: S
Source: LEARN phase reflection 2026-04-25 (Phase 3 re-audit found crash on seed data)
Files: test/regression.spec.ts or test/smoke-seed.spec.ts
Description: The pre-Quinn gate on 7776 seed data does not include a customer detail page load test. Quinn's Phase 3 audit found BKL-UI-CUSTOMER-CRASH-01 on first visit to /dashboard/customer/Acme%20Corp. A basic smoke test that navigates to a seed customer detail page and asserts it renders without AppErrorBoundary would have caught this before Quinn's cycle. Fix: add a smoke test that loads /dashboard/customer/Acme%20Corp on 7776 and asserts the page renders (no "Something went wrong" text, H1 contains customer name).
Can we test: This IS the test.

### BKL-CONN-BEARER-01 | RH Portal card shows "Not connected" when bearer token configured + no browser context
Status: ✅ DONE 2026-04-25
Priority: P1
Size: XS
Source: Council review 2026-04-25 — Step 3 Connections stability investigation
Files: server.ts:286, test/regression.spec.ts (REG-CONN-BEARER-01)
Description: `/api/auth/redhat/status` returned `hasSession: false` when `getScrapeContext() === null` even when bearer transport was configured (`RH_CASES_TRANSPORT=bearer` default, `REDHAT_OFFLINE_TOKEN` set). Bearer transport does not need a browser context for RH cases — the check was overly strict.
Decision: DONE — `hasSession` now transport-aware: bearer = `!!(REDHAT_OFFLINE_TOKEN)`, browser = file + live context. Regression test REG-CONN-BEARER-01 added. Deployed in same build as BKL-CONN-PREWARM-01.

### BKL-CONN-PREWARM-01 | Supportable pre-warm runs after RH Portal login causing 32s VNC instability
Status: ✅ DONE 2026-04-25
Priority: P1
Size: XS
Source: Council review 2026-04-25 — Step 3 Connections stability investigation
Files: server.ts — onComplete callback in POST /api/auth/redhat/start
Description: After every successful RH Portal VNC login, server.ts onComplete navigated to `supportable.corp.redhat.com:4443` and waited up to 32s for SSO. Supportable has been permanently disabled since 2026-04-08 (SUPPORTABLE_DISABLED=true). The pre-warm made VNC show Supportable pages for 32s after login, then blank — creating the impression of a failed or flaky auth flow.
Decision: DONE — pre-warm block removed. VNC now goes blank immediately after login success (BKL-UX94 behavior preserved). No Supportable references remain in onComplete.

### BKL-CONN-SF-REPORT-01 | Wizard Step 3 shows "SF Report ID required" with no wizard step to fix it
Status: ✅ DONE
Priority: P2
Size: S
Source: Council review 2026-04-25 — Jason reported Salesforce "Expired" + "SF Report ID required"
Files: dashboard/src/components/BootstrapConfigBlock.tsx, dashboard/src/hooks/useBootstrapConfig.ts, dashboard/src/pages/SetupPage.tsx
Description: sfReportId field now editable in BootstrapConfigBlock when no POD map entry exists. `onSfReportIdChange` callback prop added. Step 3 message updated to "Enter your SF Report ID above, or contact ops if you don't have one." — removes dead-end copy.
Decision: DONE — shipped 2026-04-26 (connections-stability-council). Regression test REG-CONN-SFREPORT-01 added.

### BKL-WIZ-04 | Wizard "Set Up AE" 409 race — AE silently not saved when second AE started while first runs
Status: ✅ DONE 2026-04-26
Priority: P0
Size: M
Source: Jason reported Elmer Alvarez not appearing after wizard setup; council investigation 2026-04-26
Files: dashboard/src/pages/SetupPage.tsx, test/regression.spec.ts, test/regression/ux.spec.ts
Description: startBootstrap() posted to /api/bootstrap/auto without checking server status first. When user navigated away and back during an active bootstrap (React state reset per BKL-UX110), the form appeared fresh. User filled AE2 and clicked "Set Up AE" — server returned 409 because AE1 was still running. Tiny text-xs error appeared briefly, got lost on navigation. saveAes never reached for AE2. AE2 not persisted.
Fix: (1) startBootstrap() now fetches /api/bootstrap/auto/status before posting — if running, shows clear error with AE name and returns. (2) Persistent 5s-poll banner renders when liveBootstrapRunning && !local running. (3) Error display upgraded from text-xs to text-sm styled alert with ⚠ icon.
Tests: REG-WIZ-01 through REG-WIZ-07, REG-POD-01/02 (regression.spec.ts); REG-UX110-01 through REG-UX110-06 (test/regression/ux.spec.ts).
Decision: DONE — fix shipped 2026-04-26 commit 7965235. Quinn PASS (81 tests passing). Rook clean.

### BKL-DEV-01 | Rook security scans should review working-directory diff, not clean worktree
Status: 🟡 IN PROGRESS
Priority: P3
Size: XS
Source: Learning reflection 2026-04-26 — Rook got isolation:worktree, reviewed clean tree, missed uncommitted changes
Files: CLAUDE.md — delegation matrix, Rook briefing template
Description: When Rook is spawned with isolation:worktree, it gets a fresh copy of main without uncommitted changes. For pre-commit security reviews, Rook should be given explicit file paths and line ranges from the main working directory, not a worktree. The current pattern causes Rook to report "not found" on changes that DO exist.
Can we test: YES — Rook source audit should grep for the specific new variables/functions added in the changes.
Decision: OPEN — update CLAUDE.md Rook briefing guidance to pass explicit file paths + diff context when changes are uncommitted.

### BKL-CONN-02 | sf-auth.ts login-complete path still uses fire-and-forget about:blank
Status: ✅ DONE
Priority: P3
Size: XS
Source: Learning reflection 2026-04-26 — Rook noted pre-existing inconsistency during connection council audit
Files: src/sf-auth.ts — login-complete path (lines ~180 and ~205)
Description: Fire-and-forget `ctx.newPage().then(p => p.goto('about:blank')).catch(() => {})` replaced with awaited try/catch + bringToFront at both completion paths (full success and SF-only). Matches rh-auth.ts pattern.
Decision: DONE — shipped 2026-04-26 (connections-stability-council). Regression tests REG-CONN-BLANK-01, REG-CONN-BLANK-02 added.

### BKL-CONN-03 | RH Portal drops permanently when SF login is started (no recovery on timeout)
Status: ✅ DONE
Priority: P1
Size: M
Source: Council investigation 2026-04-26 — Jason observed RH Portal going unconnected after SF login attempt
Files: src/sf-auth.ts, src/rh-scraper.ts
Description: `reopenScrapeContextFromAuth(profileDir)` added as public wrapper around `_autoRecover` in rh-scraper.ts. Wired into all 4 failure paths in sf-auth.ts: timeout, cancel, browser-closed catch, SF-only completion path.
Decision: DONE — shipped 2026-04-26 (connections-stability-council). Regression tests REG-CONN-RECOVERY-01–04 added.

### BKL-CONN-04 | 1/3 connected counter requires lastScraped — freshly reconnected RH doesn't count immediately
Status: ✅ DONE
Priority: P2
Size: S
Source: Council investigation 2026-04-26 — counter shows lower count than card indicators immediately after reconnect
Files: dashboard/src/lib/connection-state.ts, dashboard/src/pages/SetupPage.tsx
Description: computeConnected() required lastScraped != null for RH to count. Fixed via two-axis state model: counter now counts `sessionState ∈ {active, aging}` via `countsAsConnected` field — data freshness does not gate the counter.
Decision: DONE — shipped 2026-04-26 as part of unified connection architecture redesign.

---

### BKL-SEC-CONN-01 | failureCounts reset on server restart — expiry grace period amnesiac
Status: ✅ DONE 2026-04-26
Priority: P2
Size: S
Source: Rook security scan 2026-04-26 (MEDIUM-1) — connection architecture redesign audit
Files: src/connections/scrape-outcome.ts — failureCounts (in-memory map)
Description: `failureCounts` is an in-memory object in scrape-outcome.ts. On server restart, all counts reset to 0. A connection with 1 failure before restart gets a full grace period reset — a real auth expiry can be suppressed across restart boundaries if the server restarts between failures.
Fix: Added `FAILURE_COUNTS_PATH`, `loadFailureCountsFromDisk()` (reads at startup with 10-min TTL), `persistFailureCounts()` (fire-and-forget writeFile). Hooked into recordScrapeFailure, recordScrapeSuccess, __resetFailureCountsForTests.
Test: REG-CONN-FAILURE-PERSIST-01 added — confirms persistence functions and call sites present in source.
Decision: DONE — failureCounts now survives server restarts with 10-min TTL.

### BKL-SEC-CONN-02 | Tableau session-status 5-min TTL cache can mask expiry
Status: ✅ DONE 2026-04-26
Priority: P2
Size: S
Source: Rook security scan 2026-04-26 (MEDIUM-2) — connection architecture redesign audit
Files: src/bootstrap-orchestrator.ts — TABLEAU_STATUS_TTL_MS constant
Description: The `/api/bootstrap/tableau/session-status` endpoint caches responses with a 5-minute TTL. If a Tableau session expires within the TTL window, `sessionValid: true` is returned from cache — Tableau card shows "Connected" until TTL expires. User may not be prompted to re-auth for up to 5 minutes after actual expiry.
Fix: `TABLEAU_STATUS_TTL_MS` reduced from `5 * 60 * 1000` (300s) to `60 * 1000` (60s).
Test: REG-CONN-TABLEAU-TTL-01 added — asserts TTL constant ≤ 60000ms.
Decision: DONE — Tableau session expiry now surfaces within 60s.

### BKL-UX-GRID-01 | Connections grid declares 4 columns at ≥1440px but only 3 cards exist
Status: ✅ DONE 2026-04-26
Priority: P3
Size: XS
Source: Quinn QA pass 2 2026-04-26 — visual review of Step 3 card layout
Files: dashboard/src/pages/SetupPage.tsx — Connections section grid class
Description: The card container uses `min-[1440px]:grid-cols-4` but only 3 connection cards exist (RH Portal, Salesforce, Tableau). On wide displays (≥1440px) the grid renders 4 columns with an empty 4th slot — likely a remnant from when a Supportable card existed.
Fix: Changed `min-[1440px]:grid-cols-4` to `min-[1440px]:grid-cols-3`.
Test: REG-UX-GRID-01 added — confirms grid-cols-3 present and grid-cols-4 absent in SetupPage source.
Decision: DONE — connections grid correctly sized for 3 cards.

### BKL-CONN-STARTUP-SCRAPE-01 | SF startup scrape sets sessionExpired=true seconds after fresh login
Status: ✅ DONE
Priority: P0
Size: S
Source: Jason report 2026-04-26 — "session expired" immediately after successful SF login
Files: src/scraper-manager.ts — runSfSyncForAes(), test/regression/ux.spec.ts
Description: Container startup queues an SF scrape before any session exists. The scraper opened its own headless persistent context, navigated to the SF report URL, got stuck at the SF login page, and waited 120s for `lightning.force.com`. When the user logged in via the headed browser, `adoptSfContext` switched the module-level `_context` but the in-flight headless page kept waiting. After 120s, it threw `SfSessionExpiredError` → `_sfSessionExpired = true`, overwriting the successful login. The `resetAllCircuitBreakers` fix (#BKL-CONN-VNC-CLOSE-01) cleared `_sfSessionExpired = false` at login time, but the in-flight scrape set it back to `true` seconds later.
Fix: Guard at top of `runSfSyncForAes`: `if (!getSfContext()) return` — skips SF sync immediately when no session, preventing the startup scrape from ever attempting navigation without a live context.
Test: REG-CONN-NO-SESSION-GUARD-01 added — confirms guard is present before `_sfSyncRunning` check.
Decision: DONE — one guard added, regression test added, both test and production rebuilt.

### BKL-CONN-VNC-CLOSE-01 | SF VNC popup never closes after successful login
Status: ✅ DONE
Priority: P0
Size: XS
Source: Jason report 2026-04-26 — VNC still open after SF SSO completes
Files: src/scraper-manager.ts — resetAllCircuitBreakers(), test/regression/ux.spec.ts
Description: `_sfSessionExpired` in scraper-manager.ts is set true on scrape failure. `resetAllCircuitBreakers()` (called by sf-auth.ts after auth completes) only reset circuit breaker objects — NOT `_sfSessionExpired`. The `/api/auth/salesforce/status` endpoint spreads `getSfAuthStatus()` then OVERRIDES `sessionExpired` with `_sfSessionExpired`. Frontend condition `hasSession && !sessionExpired` evaluates false, so VNC close never fires.
Fix: Added `_sfSessionExpired = false` inside `resetAllCircuitBreakers()`.
Test: REG-CONN-RESET-EXPIRED-01 added to test/regression/ux.spec.ts — confirms `_sfSessionExpired = false` present in function body.
Decision: DONE — one-line fix, regression test added, rebuilt.

### BKL-CONN-DATA-RESET-01 | SF shows "Session expired" immediately after data-only reset
Status: ✅ DONE 2026-04-26
Priority: P1
Size: S
Source: Jason report 2026-04-26 — data-only wipe causes SF tile to show "Session expired" even though browser session is still valid
Files: src/scraper-manager.ts — /api/auth/salesforce/status handler
Description: After a data-only reset, `sf-session.json` is deleted → `hasSession: false`. But `_sfSessionExpired` is still `true` from a prior scrape failure (in-memory). The status endpoint unconditionally overrode `sessionExpired` with `_sfSessionExpired`, so the UI showed "Session expired" even when no session existed to expire. Root cause: the `sessionExpired` field is only semantically meaningful when a session exists (`hasSession: true`).
Fix: Captured `getSfAuthStatus()` result before spread; gated `sessionExpired` on `sfAuthStatus.hasSession ? _sfSessionExpired : false`. When `hasSession: false`, always returns `sessionExpired: false` → UI shows "Not connected" + "Connect" button, not misleading "Session expired."
Test: REG-CONN-DATA-RESET-01 added — asserts conditional sessionExpired pattern in scraper-manager source.
Decision: DONE — surgical status endpoint fix. The deeper sf-scraper misclassification (SfSessionExpiredError on non-login-page failures) is a separate P2 item to address in a future pass.

### BKL-CONN-VNC-TABLEAU-01 | Tableau VNC shows black screen when Connect clicked
Status: ✅ DONE 2026-04-26
Priority: P0
Size: XS
Source: Jason report 2026-04-26 — VNC black screen during Tableau SSO redirect chain
Files: src/bootstrap-orchestrator.ts (open-login handler), test/regression/ux.spec.ts
Description: `POST /api/bootstrap/tableau/open-login` called `page.bringToFront()` and the about:blank cleanup loop AFTER `page.goto()`. With `waitUntil: 'domcontentloaded'` the goto waited for the full SSO redirect chain before returning (~30s+), leaving VNC black the entire time. When goto timed out, the catch block fired and `bringToFront()` was never called.
Fix: Moved `bringToFront()` + about:blank cleanup to BEFORE `page.goto()`. Changed `waitUntil` from `'domcontentloaded'` to `'commit'` — fires on first response bytes, returning immediately when Tableau starts loading without waiting for the full SSO chain.
Test: REG-CONN-VNC-TABLEAU-01 added to test/regression/ux.spec.ts — asserts `bringToFront()` index < `page.goto(` index in source and `waitUntil: 'commit'` is present.
Decision: DONE — fix confirmed by Jason (Tableau loaded directly to CCSP page). All 66 REG-CONN tests pass.

### BKL-CONN-SF-CLASSIFY-01 | SfSessionExpiredError thrown on non-login-page failures
Status: ✅ DONE 2026-04-26
Priority: P1
Size: S
Source: Serena council audit 2026-04-26 — connection stability pass
Files: src/sf-scraper.ts — SfSessionExpiredError throw site (lines 462–475)
Description: `SfSessionExpiredError` was thrown whenever the scraper failed to reach `lightning.force.com` after a 120s wait — regardless of what page the browser was actually on. This bypassed scrape-outcome.ts's 2-failure grace period (isAuthError → shouldExpire immediately). Network timeouts, profile locks, and redirect-chain hangs were misclassified as session expiry.
Fix: Before throwing, checks `page.url()` for login-page indicators. `my.salesforce.com` or `sso.redhat.com` → genuine session expiry → `SfSessionExpiredError`. Any other URL → transient failure → generic `Error` (triggers grace-period path via failureCounts++).
Test: REG-CONN-SF-CLASSIFY-01 added — asserts login-page URL check exists before SfSessionExpiredError throw, and that a non-SessionExpired else branch exists.
Decision: DONE — 76/76 REG-CONN tests pass. Grace period now correctly absorbs transient navigation failures.

### BKL-CONN-SF-CLASSIFY-02 | SfSessionExpiredError URL check missing login.salesforce.com domain
Status: ✅ DONE 2026-04-26
Priority: P3
Size: XS
Source: Serena council audit 2026-04-26 — edge case from BKL-CONN-SF-CLASSIFY-01 fix
Files: src/sf-scraper.ts — classifySfNavOutcome URL check
Description: The URL-discriminating block at sf-scraper.ts:~467 checks for `my.salesforce.com` and `sso.redhat.com`. It does not cover `login.salesforce.com` (generic SF login domain used as fallback if the MyDomain redirect fails) or custom login subdomains. An SSO error page hosted on `redhat.com` (not `sso.redhat.com`) would also be treated as a transient failure rather than session expiry. Low probability, but worth closing.
Fix: Add `login.salesforce.com` to the isLoginPage check. Consider extracting a `classifySfNavOutcome(url)` pure function so the allowlist is testable without Playwright.

### BKL-TEST-PRODUCTS-HUB-01 | No regression tests for Product Hub page (/dashboard/products)
Status: ✅ DONE 2026-04-26
Priority: P3
Size: S
Source: Session 2026-04-26 — discovered during test env verification after data wipe
Files: test/ui/ — new spec needed
Description: The Product Hub page (`ProductsPage.tsx`) has no Playwright tests. We test per-customer intel stubs (`product-intel.spec.ts`) and the product filter chips on the main dashboard (`product-filter-coverage.spec.ts`), but nothing verifies that `/dashboard/products` renders the 7 TerritoryRadarCards, handles the empty-features state correctly, or shows the correct loading skeleton. A test covering the populated vs. empty state would catch rendering regressions after data wipes.
Fix: Add `test/ui/product-hub.spec.ts` with mocked `/api/products` (7 products) + `/api/products/features` (empty and populated) asserting: (a) 7 cards visible, (b) empty features shows correct empty state per card, (c) territory summaries fetch fires for each product slug.

### BKL-FEAT-STARTUP-SEED-01 | Product feature caches not seeded at startup — hub empty on fresh install
Status: ✅ DONE 2026-04-26
Priority: P2
Size: S
Source: Session 2026-04-26 — post-wipe test env investigation
Files: src/background-scheduler.ts (~line 1492) — startup seeder
Description: The startup seeder (15s after boot) runs `refreshAllProducts()` to seed missing product summaries, but never runs `refreshAllFeatures()`. Feature caches (`data/cache/product-intel/{slug}-features.json`) are only populated by: (1) manual Refresh button click, (2) slide ingest auto-trigger, or (3) Sunday 6am ET weekly schedule. A brand new user after bootstrapping AEs always has an empty Product Hub feature radar until Sunday or manual intervention.
Fix: After `refreshAllProducts()` completes in the startup seeder, check if feature caches are missing for any product. If so, fire `refreshAllFeatures()` for those products as a follow-on fire-and-forget task. Feature extraction requires Gemini + GOOGLE_CLOUD_PROJECT to be set — guard with the same env check already in `product-feature-radar.ts:347`. Target: feature radar populated within ~5 minutes of first boot. Note: BKL-UX-PRODUCT-FOLDER-CONFIG-01 is a dependency — feature extraction is richer when the slide corpus is present; seed features AFTER corpus auto-ingest check completes.

### BKL-UX-PRODUCT-FOLDER-CONFIG-01 | Product intel corpus folders should live under existing POD parentFolderId — no separate config needed
Status: ✅ DONE 2026-04-26
Priority: P2
Size: M
Source: Session 2026-04-26 — product hub folder flow investigation
Files: src/product-intel-routes.ts, src/product-release-radar.ts, data/config/product-intel-config.json, src/bootstrap-orchestrator.ts
Description: The product intel slide corpus currently stores a separate `driveParentFolderId` in `product-intel-config.json` that is completely independent of the AE bootstrap `parentFolderId`. This is wrong — the product intel subfolders (rhel/, ocp/, aap/, etc.) should live directly under the same `parentFolderId` that is validated when the first AE/POD is set up in the wizard. That folder is already known and shared by all AEs in the POD. Having a second, separately-configured parent folder is unnecessary complexity and breaks the "one folder to manage" mental model.
Additionally: file pickup is currently manual-only (user must click "Refresh Slides"). When files are added or modified in a product subfolder, the system should auto-detect the change at startup (compare Drive file modifiedTime against cached corpus timestamp) and re-ingest without user intervention.
The slide corpus serves TWO purposes — both degrade without it: (1) feature radar extraction (GA/Tech Preview/Roadmap items), and (2) per-customer product intel generation where slidesText is literally labeled "primary source" in the Gemini prompt for relevance scores, talking points, and expansion opportunities.
Fix: (a) Remove `driveParentFolderId` from `product-intel-config.json`. Replace with a read from POD config `parentFolderId` (already persisted). Bootstrap pre-flight and `setup-drive-folders` route both source from there. (b) At startup, after product summary seeding, check each product's Drive folder modifiedTime against the cached corpus — if any file is newer, re-ingest automatically (fire-and-forget). (c) No UI field needed — the folder is already configured by the AE wizard step.

### BKL-UX-FOLDER-LOCK-01 | Parent Drive Folder should lock after first bootstrap — not re-asked per AE or per POD run
Status: ✅ DONE 2026-04-26
Priority: P1
Size: S
Source: Jason 2026-04-26 — bootstrapping AEs one at a time (or adding single AEs after a POD bootstrap) re-asks for folder each time, creating split-config risk
Files: dashboard/src/components/BootstrapConfigBlock.tsx, dashboard/src/pages/SetupPage.tsx
Description: `BootstrapConfigBlock` always starts with an empty folder input (intentional — BKL-UX84 prevents settings.json from silently pre-filling). But `defaultParentFolderId`, derived from existing AE server records, is a known-good validated source — not settings.json. When AEs already exist with a `parentFolderId`, the component still shows an editable blank input. If the user pastes a different folder URL for AE #2 it validates fine (any accessible Drive folder passes), saves to settings.json, and creates AE #2's Drive folder under a different parent than AE #1. Result: split config — AEs pointing to different Drive trees with no warning.
Rule (first-wins, applies to both tabs): First bootstrap — whether a single AE or a full POD — validates and locks the `parentFolderId` permanently. All subsequent bootstraps (single AEs added later, additional POD runs) use that same folder without asking. Order does not matter: POD first → single AEs added later inherit the POD folder. Single AE first → full POD bootstrap later uses that AE's folder.
Fix: When `defaultParentFolderId` is non-empty (sourced from existing AE records, not settings.json), render the folder field locked/read-only showing the folder name + a Drive link. Auto-fire `onParentFolderChange(defaultParentFolderId)` immediately so the parent's `podBookingsFolderId` and `podFolderValidated` are set without a manual Validate click — applies to both the single-AE tab and the full-POD tab. Add an explicit "Change folder" escape hatch (warning: "Changing this will create new AE folders under a different parent — existing AEs will be unaffected but the config will be inconsistent") for the rare genuine change case. When no AEs exist (fresh install), show the editable input as-is — BKL-UX84 still applies to the very first bootstrap.

## Drive Folder Scaffolding (2026-04-26)

### BKL-DRIVE-SCAFFOLD-01 | `Config/` and `Products/` not created during initial bootstrap scaffolding
Status: ✅ DONE 2026-04-26 — ensureConfigAndProductsScaffold() added to bootstrap-orchestrator.ts. Idempotent find-or-create for Config/, Products/, and 7 product slug subfolders. Called from bootstrapPOD and per-AE /api/bootstrap/auto. Verified on 7776 live Drive: configFolderId=1vx7C6Wm... productsFolderId=1KJPo9Dg... 37/37 tests pass.
Priority: P2
Size: S
Source: Jason 2026-04-26 — Drive architecture review
Files: src/bootstrap-orchestrator.ts, src/setup-drive-folders (route)
Description: Per the agreed CommandCenter Drive architecture (ARCHITECTURE.md §8), `Config/` and `Products/` (with the seven product slug subfolders: aap, rhel, ocp, ocp-virt, rhel-ai, rh-ai-inference, rhoai) should be created as initial bootstrap scaffolding under `parentFolderId`. Currently neither is created on first AE bootstrap. Bootstrap should create both folders idempotently — detect by name, skip if present, create if missing. Applies to both single-AE and full-POD bootstrap paths.
Fix: Add a pre-flight scaffolding step before Step 1 (AE folder creation) that idempotently ensures `Config/` and `Products/{aap,rhel,ocp,ocp-virt,rhel-ai,rh-ai-inference,rhoai}/` exist under `parentFolderId`. Re-runs must reuse existing folder IDs.

### BKL-DRIVE-APPBACKUP-01 | `appBackup` written to wrong Drive folder (Subscription Data instead of `Config/`)
Status: ✅ DONE 2026-04-27 — `createBackupSheet` now targets `scaffoldResult.configFolderId` (Config/ subfolder) with fallback to `parentFolderId`. tsc clean, 38/38 tests pass on 7776, Quinn PASS, Rook PASS-WITH-NOTES (no security issues). `POST /api/admin/backup` returns 200 ok:true on prod.
Priority: P2
Size: S
Source: Jason 2026-04-26 — Drive architecture review
Files: src/bootstrap-orchestrator.ts (or wherever appBackup is created)
Description: The `appBackup` spreadsheet is currently created in the Subscription Data folder (`podBookingsFolderId`), which is the shared L3 data root. Per the agreed architecture it belongs in `Config/` under CommandCenter (`parentFolderId`) — the per-install root. The Subscription Data folder is shared across all installs and should only hold L3 SF Bookings sheets, CCSP CSVs, and Pipeline CSVs. Requires migrating existing `appBackup` for current installs (or one-time move + ID rewrite in settings).
Fix: Change `appBackup` creation target to `Config/` under `parentFolderId` (depends on BKL-DRIVE-SCAFFOLD-01 creating `Config/`). For existing installs, detect old `appBackup` in Subscription Data folder and either move it or recreate in `Config/` and update the stored ID.

### BKL-DRIVE-PRODUCTS-ROOT-01 | Product slug folders created at CommandCenter root instead of under `Products/`
Status: ✅ DONE 2026-04-27 — bootstrap pre-flight uses slugParentId (productsFolderId from perAeScaffold, falls back to parentId). setup-drive-folders route finds/creates Products/ subfolder first, uses productsFolderId for all slug lookups/creates. Quinn confirmed: POST returns 7 Drive IDs all created:false (idempotent lookup under Products/). Rook: PASS-WITH-NOTES (no security issues). REG-PRODUCTS-SLUG-PARENT-01 source assertion added.
Priority: P2
Size: S
Source: Jason 2026-04-26 — Drive architecture review
Files: src/setup-drive-folders (route), src/bootstrap-orchestrator.ts pre-flight, src/product-intel-config.ts (or equivalent)
Description: Product slug folders (`aap/`, `rhel/`, `ocp/`, `ocp-virt/`, `rhel-ai/`, `rh-ai-inference/`, `rhoai/`) are currently created directly under CommandCenter root (`parentFolderId`). Per the agreed architecture they belong under a `Products/` parent folder. `setup-drive-folders` and the bootstrap pre-flight need updating to create/look up product folders under `Products/{slug}/`. Existing installs need a migration path (move folders or update stored IDs).
Fix: Update `setup-drive-folders` and bootstrap pre-flight to (1) ensure `Products/` exists (BKL-DRIVE-SCAFFOLD-01), (2) create/look up each product slug folder under `Products/`, (3) migrate existing root-level slug folders by moving them into `Products/` and updating any stored folder IDs.

### BKL-DRIVE-BACKUP-API-01 | No backup/restore APIs for `Config/settings.json`
Status: OPEN
Priority: P3
Size: M
Source: Jason 2026-04-26 — Drive architecture review
Files: server.ts (new routes), src/bootstrap-orchestrator.ts (Config folder access)
Description: The agreed architecture has `Config/settings.json` as a config snapshot for backup/restore inside CommandCenter's `Config/` folder, but no APIs exist to read or write it. The app should expose `POST /api/config/backup` (snapshot current settings.json into `Config/settings.json` on Drive) and `POST /api/config/restore` (read `Config/settings.json` from Drive and apply it locally). Enables disaster recovery and config portability between installs that share a CommandCenter.
Fix: (1) Add `POST /api/config/backup` — reads local settings.json and writes to `Config/settings.json` on Drive with timestamp metadata. (2) Add `POST /api/config/restore` — reads `Config/settings.json` from Drive and applies to local settings.json (with confirmation/safety guard). (3) Both endpoints depend on BKL-DRIVE-SCAFFOLD-01 ensuring `Config/` exists. (4) Document in docs/SECRETS-GUIDE.md or new docs/CONFIG-BACKUP.md.

### BKL-SEC-FILEMODE-01 | writeFileSync mode flag only applies on file create, not overwrite
Status: ✅ DONE 2026-04-27 — Added chmodSync(path, 0o600) after both writeFileSync calls in product-feature-radar.ts (lines 471, 639). tsc clean.
Priority: P3
Size: XS
Source: Rook 2026-04-26 — security scan of product-feature-radar.ts
Files: src/product-feature-radar.ts (lines 471, 638)
Description: `writeFileSync(path, data, { mode: 0o600 })` only sets permissions when the file is created. On subsequent overwrites the existing inode keeps its prior mode. Add `fs.chmodSync(p, 0o600)` after each write to enforce 0o600 on every update.

### BKL-SEC-DRIVEID-VALIDATE-01 | Bootstrap pre-flight doesn't validate parentId via isValidDriveFolderId before Drive API call
Status: ✅ DONE 2026-04-27 — Added isValidDriveFolderId(parentId) check before product intel pre-flight loop in bootstrap-orchestrator.ts. 1-line surgical fix. Matches product-intel-routes.ts pattern.
Priority: P3
Size: XS
Source: Rook 2026-04-26 — security scan of bootstrap-orchestrator.ts
Files: src/bootstrap-orchestrator.ts (line ~1583)
Description: `product-intel-routes.ts` gates `parentFolderId` through `isValidDriveFolderId()` before Drive calls; bootstrap orchestrator's pre-flight uses the same helper output but skips the validation. Add `if (!isValidDriveFolderId(parentId)) { skip }` before the loop for defense-in-depth.

### BKL-SEC-SF-URL-01 | SF session classifier uses substring URL match — vulnerable to subdomain bypass
Status: ✅ DONE 2026-04-26 — classifySfNavUrl() added to sf-scraper.ts using new URL().hostname exact/endsWith matching. 10 unit tests added in sf-scraper.test.ts. Rook: CLEAN, bypass confirmed blocked.
Priority: P2
Size: XS
Source: Rook scan 2026-04-26 — identified during BKL-CONN-SF-CLASSIFY-02 review
Files: src/sf-scraper.ts ~line 469
Description: The `isLoginPage` URL check uses `String.includes()` which matches anywhere in the URL string. A URL like `https://login.salesforce.com.attacker.com/` would falsely match `login.salesforce.com` and trigger `SfSessionExpiredError` unnecessarily. Same weakness exists for `my.salesforce.com` and `sso.redhat.com` checks added in BKL-CONN-SF-CLASSIFY-01. Direction of the false-match is conservative (unnecessary re-auth, not bypass), but it should be tightened.
Fix: Replace `url.includes('x.com')` with `new URL(currentUrl).hostname` based checks: `hostname === 'login.salesforce.com'`, `hostname.endsWith('.my.salesforce.com')`, `hostname === 'sso.redhat.com'`. Extract to a pure `classifySfNavOutcome(url: string)` function so it's testable without Playwright. Add unit test asserting `login.salesforce.com.evil.com` classifies as transient (not expired).

### BKL-SEC-SAKEY-VERIFY-01 | Verify SA key no longer needed — remove from .env and confirm Gemini works via OAuth only
Status: ✅ DONE 2026-04-26 — GEMINI_SERVICE_ACCOUNT_KEY removed from .env via Edit (no Write tool). Container restarted via make up. Gemini calls confirmed succeeding via OAuth: "Company intelligence generated for Big Ten Network Services (20644 chars)" with zero auth errors. BKL-SEC-SAKEY-01 closed as moot.
Priority: P2
Size: XS
Source: Jason 2026-04-26 — audit determined SA key not needed for @redhat.com users; .env still has key set
Files: .env, src/gemini-auth.ts, src/customer.ts
Description: The April 25 audit (commit 1515e7714) removed GEMINI_SERVICE_ACCOUNT_KEY from CI and default builds. Vertex AI auth flows through the @redhat.com OAuth token (cloud-platform scope) via domain IAM binding on jhorn-pai project. However .env still contains GEMINI_SERVICE_ACCOUNT_KEY, so the instance is still using SA key auth in practice. BKL-SEC-SAKEY-01 (try/catch hardening on SA key parse) may also be moot if SA key is fully removed.
Fix: (1) Remove GEMINI_SERVICE_ACCOUNT_KEY from .env. (2) Restart container. (3) Trigger a customer brief generation and confirm Gemini calls succeed via OAuth token. (4) If confirmed: close BKL-SEC-SAKEY-01 as moot, update docs/SECRETS-GUIDE.md. (5) The fallback code in gemini-auth.ts + customer.ts can remain for non-redhat.com users — just not exercised in this install.

---

### BKL-SEC-ADMINPAGE-SUPPORTABLE-01 | AdminPage.tsx retains Supportable state plumbing for a disabled scraper
Status: ✅ DONE 2026-04-27 — Removed supportable from AllScrapeStatus type, SchedulerCfg, defaults, SERVICE_LABELS, status mapping, queue mapping. AdminPage.tsx has 0 supportable refs. 37/37 tests pass. Quinn: no Supportable text in Admin DOM. Rook: PASS-WITH-NOTES.
Priority: P3
Size: S
Source: Rook council scan 2026-04-27
Files: dashboard/src/pages/AdminPage.tsx (lines ~26, 55, 59, 64, 88, 263-265, 855, 871, 993-996, 1081)
Description: AdminPage still has supportable: ScrapeStatus in state type, supportableEnabled/supportableTime/supportableLastRun in default config, supportable label in the scraper label map, and status aggregation code pulling scrapers['supportable']?.state. Supportable is permanently disabled (CLAUDE.md). This is dead state that creates a false impression the scraper is active and adds surface area for future confusion. Not an active vulnerability in a single-user localhost app.
Fix: Remove supportable field from AdminPage state type, default config, label map, and status aggregation. Mirror the cleanup already done in SetupPage.tsx.

---

### BKL-SEC-CIRCUIT-BREAKER-SUPPORTABLE-01 | Dormant Supportable circuit breaker entry in scraper-status API
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Quinn council audit 2026-04-27
Files: src/scraper-manager.ts (circuit breaker registry), src/scraper-manager.test.ts
Description: GET /api/scraper-status returns circuitBreakers.supportable: {state:"closed", failures:0, lastFailure:null}. The UI hides it correctly but the API key remains, which will confuse future agents grepping for Supportable residue. Note: scraper-manager.ts is a protected scraper file — requires explicit Jason confirmation before modifying.
Fix: Remove 'supportable' entry from the circuit-breaker registry in scraper-manager.ts after getting explicit sign-off. Do not touch any other scraper logic.
Decision: DONE — removed `supportable` from circuitBreakers object, getCircuitBreakerStates(), and resetCircuitBreaker type union. Updated scraper-manager.test.ts to assert supportable is absent. Rook: clean PASS (type-safe, no injection vectors). Quinn: PASS on scope — circuitBreakers API shows only rh/ccsp/salesforce. Residual supportable in /api/status/scrapes top-level is pre-existing status telemetry from a prior session (not this item's scope).

---

### BKL-DATA-AE-SUPPORTABLE-SHEET-ID-01 | supportableSheetId field — rename to subscriptionSheetId
Status: 🔴 OPEN (scope updated 2026-04-27 — field is ACTIVE, not dead)
Priority: P3
Size: M
Source: Quinn council audit 2026-04-27
Files: src/types.ts, src/bootstrap-orchestrator.ts (~8 references), src/scrape-api.ts (~4 references), src/background-scheduler.ts (~2 references), data/config/aes.json
Description: `supportableSheetId` is NOT dead config. It stores the subscription data sheet ID used by sf-bookings-sync (`writeSupportableSheet`) and is read in bootstrap orchestrator, scrape-api, and background-scheduler to persist and access SF bookings data. The name is a legacy — it used to point to a Supportable sheet, now it holds the per-AE subscription data sheet. The field should be RENAMED (not removed) to `subscriptionSheetId` across all usages.
Fix: Rename supportableSheetId→subscriptionSheetId in: AeConfig type (types.ts), all patchAe() callers, all readers in bootstrap-orchestrator.ts/scrape-api.ts/background-scheduler.ts. Also rename writeSupportableSheet→writeSubscriptionSheet in supportable-scraper.ts. Requires: data migration in aes.json (rename key) and careful scraper-file changes (protected — needs Jason sign-off for scraper changes).

---

### BKL-TEST-FIXTURE-DRIFT-01 | Fixture AE "Carolanne Farrell" not in current AE roster
Status: ✅ DONE 2026-04-27 — CAROLANNE→TBH in fixtures.ts + globalSetup.ts. e2e-carolanne.spec.ts assertions derive from constant (no hardcoded strings). FIXTURE DRIFT warning gone on prod.
Priority: P3
Size: XS
Source: Quinn council audit 2026-04-27 — globalSetup logs FIXTURE DRIFT warning
Files: test/fixtures.ts (CAROLANNE constant), playwright.config.ts (globalSetup)
Description: The CAROLANNE fixture constant references "Carolanne Farrell" who is no longer in the current 9-AE roster (TBH, Peter Niklaus, Oren Shaolian, Sherry Gayo, Amanda Mejia, Alex Smith, Beena Patel, O'Neil Hopson, Cameron Floyd). globalSetup logs a FIXTURE DRIFT warning on every test run. Update the fixture to use a current AE name, or make the globalSetup warning non-fatal with a better error message.
Fix: Update CAROLANNE (or rename) to reference a current AE name that has full bootstrap data.

---

### BKL-TEST-STALE-SUPPORTABLE-01 | Stale Supportable assertions in auth.spec.ts + bootstrap.spec.ts produce permanent red noise
Status: ✅ DONE 2026-05-02 — Removed `supportable` key assertion from auth.spec.ts:84; removed GET /api/scrape/supportable/status describe block from bootstrap.spec.ts:65-74. Deleted, not skipped.
Priority: P2
Size: XS
Source: Quinn QA BKL-ARCH-03 gate 2026-05-01
Files: test/api/auth.spec.ts (line 84), test/api/bootstrap.spec.ts (line 66)
Description: Two test assertions reference Supportable endpoints that were intentionally removed. auth.spec.ts:84 expects a `supportable` key in a status response. bootstrap.spec.ts:66 calls GET /api/scrape/supportable/status and expects 200 (gets 404). Both fail on every ci run, masking real failures. Quinn flagged during BKL-ARCH-03 regression gate — 103/107 pass, these 2 are permanent noise.
Fix: Delete the supportable assertions in both files. Do NOT add `skip` — the tests are wrong, not flaky.

---

### BKL-SEC-SUP-RESIDUE-API-01 | Supportable branch still active in `/api/scrape/all` + dead imports in scrape-api.ts
Status: ✅ DONE 2026-04-27 — Removed supportable step from /api/scrape/all, dropped runSupportableScrape/supportableScrapeRunning/supportableScrapeStartedAt/SupportableCustomer imports, narrowed ScrapeResult.scraper to 'rh'|'ccsp'|'salesforce'. writeSupportableSheet kept (active in sf-bookings-sync). REG-SUP-DEAD-01 regression test added. 37/37 pass. Rook: PASS-WITH-NOTES.
Priority: P2
Size: S
Source: Rook security scan 2026-04-27 (build cycle: BKL-DRIVE-APPBACKUP-01)
Files: src/scrape-api.ts
Description: Despite Supportable being permanently disabled, `scrape-api.ts` still imports `runSupportableScrape`, `writeSupportableSheet`, `supportableScrapeRunning`, `supportableScrapeStartedAt`, `SupportableCustomer` and runs a full Supportable step inside `/api/scrape/all`. The `ScrapeResult.scraper` union type includes `'supportable'`. Rook flag: violates CLAUDE.md "Supportable permanently disabled — zero exceptions." Note: `writeSupportableSheet` is also used by sf-bookings-sync for subscription data — confirm whether that usage should be renamed or kept.
Fix: Remove `supportable` branch from `/api/scrape/all`, drop dead imports. Narrow `ScrapeResult.scraper` type to `'rh' | 'ccsp' | 'salesforce'`. If `writeSupportableSheet` serves sf-bookings-sync, rename it (e.g. `writeSubscriptionSheet`) to make intent clear. Read SCRAPER-RULES.md before modifying — scraper files are protected.
Can we test: YES — regression test asserting `POST /api/scrape/all` response never includes `scraper:'supportable'` in results.

---

### BKL-UI-SUP-RESIDUE-SETUP-01 | SetupPage.tsx still references supportableSheetId and Supportable copy
Status: ✅ DONE 2026-04-27 — Removed supportableSheetId from matchedAeIsBootstrapped gate (now uses ccspSheetId+pipelineSheetId+driveFolderId). Replaced user-facing "Supportable" copy: unmatched msg and "names must match" hint. supportableName kept (server-side setup-routes.ts:541 consumes it). Quinn: 0 "Supportable" text in SetupPage DOM. Bundle grep confirms phrases removed. Rook: PASS-WITH-NOTES.
Priority: P2
Size: S
Source: Rook security scan 2026-04-27 (build cycle: BKL-DRIVE-APPBACKUP-01)
Files: dashboard/src/pages/SetupPage.tsx
Description: After the Supportable panel removal, SetupPage.tsx still references `supportableSheetId` in the AE form object (lines 55, 467, 1280, 1391, 1697, 1826), `supportableName` per-customer field (lines 65, 455, 1706, 1846), "had no Supportable matches" user-facing copy (lines 809-816), and "names must match Supportable exactly" hint (line 1375). Critical: `matchedAeIsBootstrapped` gate (line 1280) requires `supportableSheetId` to be non-empty — freshly bootstrapped AEs without a Supportable sheet ID may be flagged as not-bootstrapped, which is a UX regression.
Fix: Remove `supportableSheetId` from `matchedAeIsBootstrapped` gate. Scrub all user-facing "Supportable" copy. Drop `supportableName` field from submit payload unless sf-bookings matching still requires it.
Can we test: YES — regression test asserting setup page renders without any "Supportable" text content visible to user.

---

### BKL-DRIVE-SCAFFOLD-CACHE-01 | Persist configFolderId and productsFolderId to config instead of re-discovering on every call
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Serena council review 2026-04-27 (post-BKL-DRIVE-PRODUCTS-ROOT-01 ship)
Files: src/bootstrap-orchestrator.ts (lines 76-123, 869, 1651), src/product-intel-routes.ts (lines 144-164), data/config/ (new drive-scaffold.json or extend data-sources.json)
Description: ensureConfigAndProductsScaffold re-runs drive.files.list for Config/, Products/, and 7 product slugs on every invocation. The POD bootstrap calls it once at line 869 then again per-AE at line 1651 — for a 30-AE POD, roughly 270 redundant Drive API calls just to confirm folders that were already confirmed once. The setup-drive-folders route also re-discovers Products/ on every call. This is a quota, latency, and failure-surface cost. Config files ARE the persistence layer for this app — discovered Drive IDs should be cached the same way podConfig, backupSheetId, and AE driveFolderId already are.
Fix: (1) Extend data-sources.json or add data/config/drive-scaffold.json with { configFolderId, productsFolderId, productSlugFolderIds } keyed by parentFolderId. (2) Modify ensureConfigAndProductsScaffold to read cached IDs first; do single cheap files.get verify; fall back to list-or-create and update cache on 404 or miss. (3) Apply cache-first pattern in setup-drive-folders for productsFolderId. (4) For 30-AE POD, reduces scaffold Drive calls from ~270 to ~9.
Can we test: YES — unit test asserting ensureConfigAndProductsScaffold reads from cache file on second call without making Drive API calls.

---

### BKL-DRIVE-SCAFFOLD-SLUGS-01 | SCAFFOLD_PRODUCT_SLUGS hardcoded constant duplicated products.json
Status: ✅ DONE 2026-04-27 — Replaced SCAFFOLD_PRODUCT_SLUGS const with loadProductIntelConfig().products.map(p => p.slug) inside ensureConfigAndProductsScaffold. Single source of truth. tsc clean.
Priority: P3
Size: XS
Source: Serena council review 2026-04-27
Files: src/bootstrap-orchestrator.ts (line 74)
Description: SCAFFOLD_PRODUCT_SLUGS was a parallel const list duplicating the canonical slug list from products.json. If a new product was added to products.json, the scaffolder would not create its folder.
Fix: Derive slugs from loadProductIntelConfig().products.map(p => p.slug).

---

### BKL-PRODINTEL-05 | Product intel cache not auto-refreshed after first AE bootstrap
Status: ✅ DONE — already implemented (BKL-STARTUP-01)
Priority: P2
Size: S
Source: Jason 2026-04-27 (observed during post-wipe bootstrap test)
Files: src/background-scheduler.ts lines 1487-1527
Decision: WONTFIX / ALREADY DONE — BKL-STARTUP-01 in background-scheduler.ts already handles this. On every container start, 15s after startup, the scheduler checks for missing product intel summary and feature caches and seeds them automatically (fire-and-forget, non-blocking). A fresh wipe → container restart → product intel populates in background before user finishes bootstrap. No additional trigger needed.

---

### BKL-SEC-SLUG-VALIDATE-01 | Product slugs in product-intel-config.json not validated at load time
Status: ✅ DONE 2026-05-02 — Added /^[a-z0-9-]{1,64}$/ guard + dedup to ensureConfigAndProductsScaffold in bootstrap-orchestrator.ts. Invalid slugs log a warning and are skipped. 10 unit tests in test/unit/slug-validate.test.ts (10/10 pass).
Priority: P3
Size: XS
Source: Rook scan 2026-04-27 (BKL-DRIVE-SCAFFOLD-SLUGS-01 review)
Files: src/bootstrap-orchestrator.ts (ensureConfigAndProductsScaffold), data/config/product-intel-config.json
Description: Since BKL-DRIVE-SCAFFOLD-SLUGS-01, scaffold slug names come from product-intel-config.json at runtime. The slug values are passed unsanitized to the Drive folder name field (via findOrCreateFolder). If a malformed config slug contained /, control chars, or 1000+ chars, it would propagate to Drive. Also, duplicate slugs would cause extra findOrCreateFolder calls (idempotent but wasteful). Not exploitable today (config is admin-written), but defense in depth is warranted.
Fix: Add slug shape validator (/^[a-z0-9-]{1,64}$/) at product config load time (or inside ensureConfigAndProductsScaffold before the loop). Deduplicate slugs before iteration.
Can we test: YES — unit test that malformed slug in product-intel-config.json is rejected/skipped without crashing the scaffolder.

---

### BKL-CONN-TABLEAU-CTX-01 | Tableau VNC connect corrupts shared browser context — breaks CCSP + SF bootstrap
Status: ✅ DONE 2026-04-27
Priority: P1
Size: M
Source: Jason 2026-04-27 (reproduced twice in same session)
Files: src/bootstrap-orchestrator.ts (open-login, wait-for-login routes), src/ccsp-scraper.ts, src/sf-scraper.ts, src/interactive-auth-page.ts (new), src/rh-scraper.ts (additive), test/regression.spec.ts
Description: After connecting to Tableau via the VNC flow (open-login + wait-for-login), the shared Playwright browser context is left in a closed/unresponsive state. Any subsequent scraper or bootstrap step that calls newPage() fails with "Browser context is closed or unresponsive (newPage() timed out after 30s)". This silently kills CCSP sheet creation and SF bookings scrape during bootstrap — both fail mid-step, leaving the AE partially bootstrapped with empty sheets. browserDegraded flag stays false so the UI gives no warning. Root cause: the Tableau VNC flow navigates the live page through a cross-domain SSO redirect chain (Tableau → auth.redhat.com → back), which destabilizes the shared context.
Fix (Interactive Auth Page / IAP pattern):
  1. New module src/interactive-auth-page.ts — manages a dedicated ephemeral Page used exclusively for headed auth flows. SSO cookies are Context-level, so they still flow back to the shared scrape context after IAP closes.
  2. open-login route now calls acquireIap(ctx, TABLEAU_URL) instead of reusing _livePage. _tableauOpenLoginPage tracker removed; getIap() replaces it. setLivePageBusy(true) no longer needed on this path.
  3. wait-for-login wraps the entire body in try { ... } finally { await releaseIap() }. Auto-closes the IAP on success, error, or timeout — clears the VNC viewer for free (replaces the BKL-UX94 manual blank-tab open).
  4. session-status gate broadened to (isIapAlive() || isLivePageBusy()) so the probe correctly defers while interactive auth is in flight.
  5. rh-scraper.ts: additive only — exports isLivePageHealthy() probe (Promise.race with 2s deadline). No scraper logic, _livePage, adoptScrapeContext, keep-alive, or bearer-token logic touched.
Tests added (test/regression.spec.ts):
  - REG-CONN-TABLEAU-CTX-01: source — interactive-auth-page module exposes acquireIap/getIap/releaseIap/isIapAlive
  - REG-CONN-TABLEAU-CTX-02: source — bootstrap-orchestrator imports IAP API, _tableauOpenLoginPage gone, wait-for-login wraps body in try/finally with releaseIap
  - REG-CONN-TABLEAU-CTX-03: source — rh-scraper exposes isLivePageHealthy probe
  - REG-CONN-TABLEAU-CTX-01-live: API — browserDegraded remains false (skips when /api/status/scrapes unreachable)
Stopped at: implementation complete on worktree branch worktree-agent-a599d1b2. Next: DA reviews diff, runs `make test-up` then full Playwright suite on 7776, then `make rebuild`. SF re-auth path (sf-auth.ts) intentionally NOT changed — it already launches a dedicated chromium.launchPersistentContext for the headed flow and only adopts the context post-login, so the IAP corruption pathway does not apply there.
Can we test: YES — covered by REG-CONN-TABLEAU-CTX-01 / -02 / -03 (source-level) + -01-live (API).
Related: BKL-SFCACHE-02 (SF L3 write-back regression log assertion) remains 🔴 OPEN — separate concern, not addressed here.

---

### BKL-BOOT-07 | CCSP step 4 bootstrap timeout too short for L4 Tableau scrape
Status: ✅ DONE 2026-04-28
Priority: P1
Size: S
Source: Jason 2026-04-28
Files: src/bootstrap-orchestrator.ts
Description: Bootstrap step 4 (Create CCSP Sheet) had a 90s watchdog timeout via STEP_TIMEOUT_MS=90_000. When the CCSP cache hierarchy falls through to L4 (fresh Tableau scrape), the scrape takes 2-3 minutes and the 90s timeout fires, marking the step as error and cancelling the rest of bootstrap. This happens when: (a) no in-memory L1 cache, (b) no existing AE sheet (L2), and (c) no same-day POD CSV in Drive (L3). Fix: added optional timeoutMs param to makeStepTimeout(); CCSP step now passes 300_000 (5 minutes).
Can we test: YES — delete AE Drive folders so L4 is triggered, run bootstrap, verify CCSP step completes without timeout.

---

### BKL-BOOTSTRAP-CANCEL-01 | Bootstrap cancel button unresponsive when step is hung
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Jason 2026-04-27
Files: dashboard/src/pages/SetupPage.tsx, src/bootstrap-orchestrator.ts
Description: When bootstrap hangs mid-step (e.g. waiting for browser context that never responds), the UI cancel button does nothing. The cancel endpoint returns {"ok":true} but the bootstrap loop is blocked inside an await that never resolves. The API cancel flag is set but the running loop never checks it because it's stuck. Fix: add AbortController or per-step timeout wrapping every await in the bootstrap loop so cancellation signals can interrupt a hung step within a few seconds. Also: the cancel button should disable itself and show a spinner when clicked — currently it looks broken (nothing happens visually).
Can we test: YES — trigger a bootstrap step that intentionally hangs, click cancel, assert bootstrap.running becomes false within 10s.

---

### BKL-CONN-TABLEAU-CTX-02 | Update BKL-CONN-TABLEAU-CTX-01 status — isolated context implemented
Status: ✅ DONE 2026-04-27
Priority: P0
Size: L
Source: Serena council audit 2026-04-27 (post-implementation verification)
Files: src/tableau-auth.ts (NEW), src/bootstrap-orchestrator.ts, src/sf-auth.ts, test/regression.spec.ts
Description: Full implementation of isolated `launchPersistentContext` Tableau auth (BKL-CONN-TABLEAU-CTX-01 root fix). IAP approach was Page-level isolation only — insufficient because BrowserContext is one OS renderer partition. Real fix: separate Chromium process via `launchPersistentContext(TABLEAU_AUTH_PROFILE_DIR)` in new module `tableau-auth.ts`. All 3 orchestrator routes migrated (session-status → cookie freshness + HEAD probe, open-login → startTableauLoginBrowser, wait-for-login → waitForTableauLogin with 90s timeout). SF double-blank-tab bug also fixed. Two medium follow-ups logged as BKL-CONN-TABLEAU-REACHABLE-01 and BKL-CONN-TABLEAU-IDLE-01.
Decision: DONE — all 6 ISC audit criteria pass (Serena second audit). Ready for Quinn E2E gate.

---

### BKL-CONN-TABLEAU-REACHABLE-01 | session-status always returns reachable=true (VPN-down UX regression)
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Serena post-implementation audit 2026-04-27 (Issue B)
Files: src/bootstrap-orchestrator.ts (session-status route)
Description: Replacing browser probe with cookie-only check lost the reachability distinction (VPN down vs session expired). Users off VPN see "Connect to Tableau" CTA but clicking it opens a blank Chromium window with no useful error. Fix applied same session: added Node-side HEAD probe to `https://10ay.online.tableau.com` with 3s AbortSignal.timeout. Sets `reachable` from fetch result; `sessionValid` from cookie freshness. Preserves three-state UX without browser coupling.
Decision: DONE — fixed in same commit as BKL-CONN-TABLEAU-CTX-02.

---

### BKL-CONN-TABLEAU-IDLE-01 | wait-for-login hangs up to 5min; Bun idleTimeout=120s kills it at 2min
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Serena post-implementation audit 2026-04-27 (Issue C)
Files: src/bootstrap-orchestrator.ts (wait-for-login route), server.ts (idleTimeout: 120)
Description: waitForTableauLogin() default was 5min; Bun server.ts idleTimeout is 120s. Long-poll connection would be killed silently at 120s. Fixed by passing 90_000ms (90s) explicitly to waitForTableauLogin() in the route — safely under the 120s idle timeout with 30s margin. Client-side: if wait-for-login returns sessionValid:false after 90s, user can retry via Connect button.
Decision: DONE — one-line fix in same commit as BKL-CONN-TABLEAU-CTX-02.

---

### BKL-TABLEAU-HARDENING-01 | tableau-auth.ts hardening backlog (6 low-severity findings)
Status: ✅ DONE 2026-04-27
Priority: P3
Size: M
Source: Serena post-implementation audit 2026-04-27 (Findings 1-6)
Files: src/tableau-auth.ts
Description: Six low-severity hardening items from Serena's second audit:
  1. _closeContext flag mutation — split loginInProgress reset from context close to prevent brittle re-set pattern
  2. Stale-PID detection — check for lingering Chromium on TABLEAU_AUTH_PROFILE_DIR at container startup
  3. Env-configurable TABLEAU_COOKIE_AGE_MS — 8h hardcoded; should be env var with docs
  4. Parent dir permission assertion — RH_PROFILE_DIR should not be world-readable
  5. Structured harvest telemetry — replace console.log with structured log object (cookie count, domains, age)
  6. Zero-cookie harvest as login failure — currently returns true with no cookies; should surface error
Can we test: YES — items 1/3/6 testable via unit tests; items 2/4/5 need container-level validation.
Resolution (2026-04-27 Wave 3): Shipped 6 surgical fixes in `src/tableau-auth.ts`:
  1. Env-overridable cookie age: `parseInt(process.env.TABLEAU_COOKIE_AGE_MS ?? '') || 8h`.
  2. `_closeContext` returns `Promise<boolean>` — `true` on >0 cookies harvested, `false` on 0 cookies (with warn).
  3. `waitForTableauLogin` checks the boolean — returns `false` immediately on zero-cookie harvest instead of falsely claiming success.
  4. Profile dir created with `mkdirSync(TABLEAU_AUTH_PROFILE_DIR, { recursive: true })` before `launchPersistentContext`.
  5. Stale lock detection emits `console.warn('[tableau-auth] stale lock file removed')` when `SingletonLock` is unlinked.
  6. Structured harvest telemetry: `console.info` with cookie count + comma-joined unique domains on success.
Regressions: `REG-TABLEAU-HARDENING-01` (env reads), `REG-TABLEAU-HARDENING-02` (zero-cookie returns false).

### BKL-DOM-CLEARBIT-01 | Clearbit nameMatchesClearbit too permissive — maps Uber Technologies → ub3r.host
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Jason observed 2026-04-27 (Elmer bootstrap domain inference)
Files: src/domain-waterfall.ts (nameMatchesClearbit)
Description: Clearbit autocomplete returned a hit for "Uber Technologies" → "ub3r.host" (a startup, not Uber). The `nameMatchesClearbit` function uses word-overlap which passes because both share the word "uber" (case-insensitive). This corrupts the auto-saved domain for the customer. Similar false positives likely exist for other short brand names.
Can we test: YES — unit test with "Uber Technologies" input asserting no match on ub3r.host.
Fix approach: Tighten match — require first substantive word of the query to be at least 5 chars, OR require Levenshtein distance < threshold between stripped company name and Clearbit result name.
Decision: DONE 2026-04-27 — nameMatchesClearbit tightened to first-token anchor (qWords[0] in rWords or rWords[0] in qWords). REG-DOM-01/03 verify. Commit 2be13e647.

### BKL-DOM-INFER-RACE-01 | Domain inference IIFE — 7 race conditions and correctness bugs (Rook audit 2026-04-27)
Status: ✅ DONE 2026-04-27
Priority: P1
Size: L
Source: Rook Blackburn audit 2026-04-27 triggered by Jason observing missing inference results for Elmer
Files: src/bootstrap-orchestrator.ts (domain inference IIFE ~2263-2315, state reset ~1580, POD loop ~1047-1193), src/domain-waterfall.ts
Description: Rook audited the full domain inference system. 7 findings:
  1. [Critical] IIFE writes to next AE's state via reassigned `let autoBootstrapState` binding. AE1's IIFE fires non-blocking, then Elmer's bootstrap reassigns autoBootstrapState. When AE1's IIFE writes at line 2312, it goes to Elmer's state object — AE1's domains appear under Elmer, Elmer's results lost.
  2. [High] customers.json write race: IIFE mutates `customers` in-memory and writes JSON while next AE's bootstrap may be reading it. Lost-update risk + partial snapshot writes.
  3. [High] highConfidenceSaves domain auto-save not scoped by AE — `customers.find(cx => cx.name === name)` has no ae filter. If two AEs share a customer name, wrong AE gets the domain. Fix: add `&& cx.ae === aeName` to line 2301.
  4. [Medium] Awaiting the IIFE (the fix for #1) lengthens running=true window by ~30-90s/AE. Should wrap IIFE in Promise.race with 120s ceiling to prevent hung inference blocking bootstrap completion.
  5. [Medium] 409 bootstrap-start gate only checks running flag — not inference-in-flight. A fresh bootstrap can be accepted during the IIFE race window.
  6. [Low] Silent .catch at lines 2277, 2289 masks inference failures — no log, no surfaced error in state.
  7. [Low] Clearbit nameMatchesClearbit false positives beyond Uber: any shared 3-char word passes (Apple Federal CU → apple.com, United Health Services → united.com). Needs Jaccard threshold or first-token-must-match.
Can we test: YES — unit tests for findings 3, 7; integration tests for 1, 2, 5 via multi-AE POD bootstrap.
Fix order: 3 → 1 (await IIFE + captureRef) → 4 (120s ceiling) → 5 (update 409 gate) → 2 (mutex on write) → 6 (warn logging) → 7 (tighten nameMatch).
Decision: DONE 2026-04-27 — All 7 findings implemented. Two audit passes (council + Rook). Rook pass-3 GREEN on all 7 verification points. REG-DOM-01 through REG-DOM-04 passing. Committed 2be13e647. Residuals tracked as BKL-DOM-INF-02 (AbortController) and BKL-DOM-INF-05 (UI surfacing).

### BKL-DOM-INFER-DISPLAY-01 | Domain inference results not shown in bootstrap UI for Elmer (second POD AE)
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Jason observed 2026-04-27 (Elmer bootstrap)
Files: src/bootstrap-orchestrator.ts (domain inference IIFE), dashboard/src/pages/SetupPage.tsx (bootstrap polling)
Description: Domain inference runs correctly (confirmed in logs — 10 domains auto-saved for Elmer's 12 customers). However results are not visible in the UI because: (1) domain inference IIFE is non-blocking — fires then immediately sets running=false; (2) UI polls, sees running=false, captures state, stops polling; (3) inference IIFE hasn't written results yet. Fix: await the inference IIFE before setting running=false (makes inference blocking, adds ~30-60s per AE). Audit first — there may be a wider race condition with autoBootstrapState resets between AEs.
Can we test: YES — after bootstrap, check that autoBootstrapState.resources.domainInference is populated before running=false is set.
Resolution (2026-04-27 BKL-DOM-INF-01): DONE — awaiting the IIFE before running=false is set. UI now sees inference results before polling stops.

### BKL-DOM-INF-02 | AbortController for waterfall/signal inference — abort orphan on 120s timeout
Status: 🟡 IN PROGRESS
Priority: P2
Size: M
Source: Rook+Council second audit 2026-04-27 (residual from BKL-DOM-INF-01 fix)
Issue: hornjason/asaCommandCenter#20
Files: src/bootstrap-orchestrator.ts (inference IIFE), src/domain-waterfall.ts (tier1/tier2/tier3 fetches)
Description: Promise.race timeout resolves the race but does NOT abort the in-flight IIFE. Orphan inference continues running, can still write customers.json via _customerWriteLock and write capturedState.resources.domainInference after inferenceRunning=false flips. Proper fix: thread an AbortController into waterfallInferDomain/inferCustomerDomain fetch calls, abort it when timeout fires. The 15s AbortSignal.timeout per-call in domain-waterfall.ts covers individual calls but there's no parent abort for the whole IIFE.
Can we test: YES — unit test that verifies inferenceRunning=false only after all writes complete (or after abort).

### BKL-DOM-INF-03 | try/finally around inferenceRunning flag — already implemented
Status: ✅ DONE 2026-04-27
Priority: P2
Size: XS
Source: Rook+Council second audit 2026-04-27
Files: src/bootstrap-orchestrator.ts
Description: No try/finally around inferenceRunning=true/await/false — if anything between the flag set and await throws synchronously, inferenceRunning stays true forever and permanently blocks bootstraps. Fixed in second Marcus pass (2026-04-27): wrapped in try/finally.
Resolution: try { await Promise.race } finally { inferenceRunning = false } implemented.

### BKL-DOM-INF-04 | Timeout-win warning log + gate capturedState write
Status: ✅ DONE 2026-04-27
Priority: P2
Size: XS
Source: Council second audit 2026-04-27
Files: src/bootstrap-orchestrator.ts
Description: When 120s timeout wins the race, no log is emitted and capturedState.resources.domainInference is never written (orphan may write it later). Should log warning when timeout fires and skip the late write. Fixed in second Marcus pass with timedOut flag.
Resolution: timedOut flag gates the capturedState write; console.warn fires when timeout wins.

### BKL-CONN-VNC-POPUP-TIMEOUT-01 | SF VNC popup not closed when 120s frontend timeout fires
Status: ✅ DONE 2026-04-27
Priority: P2
Size: XS
Source: Jason report 2026-04-27 — popup stayed open after second SSO (RH session expired during SF login)
Files: dashboard/src/pages/SetupPage.tsx
Description: The 120s safety timeout in handleSfConnect cleared the poll interval and set sfConnecting=false but never called sfVncRef.current?.close(). Result: if login + RH portal re-auth took >120s, the VNC popup remained open showing a black screen after the backend completed. User saw it as "stuck hanging."
Can we test: NO — requires 120s real wait; would slow CI unacceptably. Pattern verified by code inspection against existing close calls at lines 2876, 2888, 2905.
Resolution: Added sfVncRef.current?.close() + sfVncRef.current = null to the 120s timeout callback.

### BKL-CONN-UNMOUNT-VNC-01 | sfVncRef and tableauVncRef not closed on SetupPage unmount
Status: ✅ DONE 2026-04-27
Priority: P2
Size: S
Source: Rook council audit 2026-04-27 (finding #5, HIGH)
Files: dashboard/src/pages/SetupPage.tsx
Description: The unmount cleanup useEffect (~line 2806) closes rhVncRef but not sfVncRef or tableauVncRef. If user navigates away from SetupPage while SF or Tableau login is in progress, the VNC popup stays open (orphaned), sfPollRef is cleared so polling stops, and server-side loginInProgress stays true until the 5-minute sf-auth.ts timeout expires. Same class of bug as BKL-CONN-VNC-POPUP-TIMEOUT-01.
Can we test: YES — mount SetupPage, trigger SF connect, navigate away, verify no orphaned VNC window (Playwright navigation test).
Fix direction: Add sfVncRef.current?.close(); sfVncRef.current = null; and tableauVncRef equivalent to the unmount return function.

### BKL-CONN-DOUBLE-SSO-UX-01 | Double-SSO during SF login not surfaced to UI
Status: ✅ DONE 2026-04-27
Priority: P3
Size: S
Source: Rook council audit 2026-04-27 (finding #3, MEDIUM)
Files: src/sf-auth.ts, dashboard/src/pages/SetupPage.tsx
Description: When RH session expires during SF login, sf-auth.ts navigates to RH portal which triggers a second SSO in the VNC browser. User sees VNC "restart" from an RH SSO page with no explanation. The loginInProgress flag stays true throughout so no server hang, but UX is confusing. No log or status signal distinguishes "waiting for RH SSO" from "waiting for SF SSO."
Can we test: Hard to test without a real expired RH session. Suggest log-level check in CI.
Fix direction: Add a rhPortalSsoRequired signal to sf-auth.ts status; log [sf-auth] RH SSO required — second login prompt in VNC before opening rhPage.

### BKL-CONN-CANCEL-REOPEN-01 | cancelSfLoginBrowser always calls reopenScrapeContextFromAuth even when no login was in progress
Status: ✅ DONE 2026-04-27
Priority: P2
Size: XS
Source: Rook second audit 2026-04-27 (LOW)
Files: src/sf-auth.ts, dashboard/src/pages/SetupPage.tsx
Description: cancelSfLoginBrowser unconditionally calls reopenScrapeContextFromAuth regardless of whether a login was active. The unmount cleanup now calls DELETE /api/auth/salesforce/session on every SetupPage exit — even when no SF auth is in flight — causing a spurious headless Chromium launch each time the user navigates away from the Connections page.
Fix direction: In cancelSfLoginBrowser, capture whether loginInProgress was true before resetting flags; only call reopenScrapeContextFromAuth if it was.
Can we test: YES — call DELETE /api/auth/salesforce/session with no login in progress; verify no new browser process spawned (check process count or logs).

### BKL-CONN-CANCEL-RESET-01 | sfTimeoutFiredRef not reset in handleSfCancel
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook second audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleSfCancel does not reset sfTimeoutFiredRef.current = false. If the 120s timer fires during a cancel, a subsequent Connect click would find the ref still true and the poll callback would exit immediately on every tick. handleSfConnect resets it at the start, so the window is only the 120s-fires-during-cancel race, but it should be cleared in cancel for correctness.
Can we test: Code inspection confirms the fix.

### BKL-CONN-UNMOUNT-RH-NULL-01 | rhVncRef not nulled after close in unmount cleanup
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook second audit 2026-04-27 (SUGGESTION)
Files: dashboard/src/pages/SetupPage.tsx
Description: rhVncRef.current?.close() is called in unmount but rhVncRef.current = null is not set, inconsistent with sfVncRef and tableauVncRef cleanup pattern. No functional leak on unmount.
Can we test: Code inspection only.

### BKL-CONN-TABLEAU-TIMEOUT-REF-01 | Tableau 120s login timeout not stored in ref — cannot clear on unmount
Status: ✅ DONE 2026-04-27
Priority: P3
Size: S
Source: Rook second audit 2026-04-27 (SUGGESTION)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleTableauConnect sets setTimeout(() => resolveLogin(false), 120_000) but the timer ID is not stored. If user navigates away before 120s, the timer fires in a dead component closure. Benign (resolves a Promise only) but unclean. Fix: store timer ID in a tableauTimeoutRef and clear it in the unmount effect.
Can we test: Code inspection only.

### BKL-CONN-RH-TIMEOUT-REF-01 | handleRhConnect 120s timeout uses bare setTimeout — not clearable on unmount
Status: ✅ DONE 2026-04-27
Priority: P2
Size: XS
Source: Rook third audit 2026-04-27 (MEDIUM)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleRhConnect sets a 120s bare setTimeout at line ~2991 with no ref storage. If SetupPage unmounts while RH VNC login is in progress, rhConnectPollRef and rhVncRef are cleaned up but the timeout fires in a detached closure and calls setRhConnecting(false) on an unmounted component. Same pattern fixed for Tableau (BKL-CONN-TABLEAU-TIMEOUT-REF-01) and SF (Finding 2). Fix: add rhTimeoutRef = useRef, store timer ID, clear in unmount.
Can we test: Code inspection confirms the pattern.

### BKL-CONN-TABLEAU-REENTRY-01 | handleTableauConnect has no re-entry guard — rapid double-click creates orphaned poll/timeout
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook third audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleTableauConnect has no guard at entry (unlike handleSfConnect which checks `if (sfPollRef.current) return`). A rapid double-click creates two concurrent resolveLogin closures sharing the same refs; the second call overwrites tableauPollRef.current and tableauVncRef.current, orphaning the first call's poll and timeout. Fix: add `if (tableauPollRef.current) return` at the top of handleTableauConnect.
Can we test: Code inspection confirms the fix.

### BKL-CONN-SF-TIMEOUT-REF-01 | handleSfConnect 120s timer not stored in ref — Cancel then re-Connect can disrupt second session
Status: ✅ DONE 2026-04-27
Priority: P3
Size: S
Source: Rook third audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: The 120s setTimeout in handleSfConnect is not stored in a ref. If user clicks Cancel then re-clicks Connect within 120s, the first timer fires and closes the VNC window and calls DELETE /api/auth/salesforce/session mid-session. Same pattern fixed for Tableau. Fix: add sfTimeoutRef = useRef, store timer ID, clear in handleSfCancel and unmount.
Can we test: Code inspection confirms the fix.

### BKL-CONN-TABLEAU-CANCEL-TIMEOUT-01 | handleTableauCancel does not clear tableauTimeoutRef
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook fourth audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleTableauCancel clears tableauPollRef and closes tableauVncRef but does not clear tableauTimeoutRef. The 120s timeout continues running after cancel and fires resolveLogin(false) redundantly — no resource leak, but adds a stale setState call after cancel.
Fix: Add tableauTimeoutRef clear to handleTableauCancel.
Can we test: Code inspection only.

### BKL-CONN-SYNC-POLL-UNMOUNT-01 | handleRhSync/handleSfSync/handleRunCcspScrape inner intervals not cleared on unmount
Status: ✅ DONE 2026-04-27
Priority: P3
Size: S
Source: Rook fourth audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: The progress-poll intervals inside handleRhSync, handleSfSync, handleRunCcspScrape are local variables not registered to component-level refs. If SetupPage unmounts while a sync is in progress, these intervals keep firing setState on the unmounted component. Bounded by scraper runtime (30–120s). React 18 suppresses the warning, no crash.
Fix: Promote inner iv vars to component-level refs (rhSyncPollRef, sfSyncPollRef, ccspSyncPollRef), clear in unmount.
Can we test: Code inspection confirms the pattern.

### BKL-CONN-SF-SUCCESS-TIMEOUT-01 | SF sync success hide setTimeout not stored in ref
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook fourth audit 2026-04-27 (SUGGESTION)
Files: dashboard/src/pages/SetupPage.tsx
Description: An 8s setTimeout that calls setSfSyncSuccess(null) is not stored in a ref. If component unmounts during those 8s, the callback fires setState on an unmounted component. React 18 no-crash but generates a warning.
Fix: Store in sfSuccessTimeoutRef, clear in unmount.
Can we test: Code inspection only.

### BKL-CONN-RH-CANCEL-TIMEOUT-01 | handleRhCancel does not clear rhTimeoutRef
Status: ✅ DONE 2026-04-27
Priority: P3
Size: XS
Source: Rook fifth audit 2026-04-27 (LOW)
Files: dashboard/src/pages/SetupPage.tsx
Description: handleRhCancel cleared rhConnectPollRef and rhVncRef but not rhTimeoutRef. The 120s hard timeout kept running after cancel, firing setRhConnecting(false) redundantly. Asymmetric with handleSfCancel (which clears sfTimeoutRef) and handleTableauCancel (which clears tableauTimeoutRef).
Resolution: Added rhTimeoutRef clear to handleRhCancel inline.

### BKL-DOM-INF-05 | Surface inference errors in autoBootstrapState for UI visibility
Status: ✅ DONE 2026-05-03
Priority: P3
Size: S
Source: Rook second audit 2026-04-27
Issue: hornjason/asaCommandCenter#23
Files: src/bootstrap-state.ts, src/bootstrap-orchestrator.ts, dashboard/src/pages/SetupPage.tsx
Commit: fa173eee3
Description: Added `inferenceWarning?: string` to AutoBootstrapResources. Populated in inference IIFE when customers remain domain-null after all tiers. SetupPage renders warning below domain inference results. 5 unit tests added (451 total pass).

### BKL-DOM-INF-06 | Domain inference batch: serial processing (concurrency=1)
Status: ⏸ SUPERSEDED by BKL-DOM-BATCH-01
Priority: P1
Source: Council investigation 2026-04-27 — superseded by batch approach 2026-04-27

### BKL-DOM-INF-07 | Clearbit: scan top-3 hits, not just hits[0]
Status: ⏸ DEFERRED — Clearbit is now a fallback-only tier; top-3 scan lower priority
Priority: P3
Source: Council investigation 2026-04-27

### BKL-DOM-INF-08 | tier3Validate: redirect:follow — SSRF hardening
Status: ⏸ SUPERSEDED by BKL-DOM-BATCH-01 (Rook's simpler two-fix approach: isPublicDomain filter + redirect:manual)
Priority: P2
Source: Rook audit 2026-04-27 — simplified scope confirmed 2026-04-27

### BKL-DOM-INF-09 | Don't save domain if tier3Validate returns false
Status: ⏸ DEFERRED — tier3Validate skipped in auto-bootstrap path per design decision 2026-04-27
Priority: P3
Source: Council 2026-04-27

### BKL-DOM-INF-10 | Fire-and-forget domain inference
Status: ⏸ DEFERRED — batch inference completes in ~2s; blocking is correct at this speed. Decision 2026-04-27.
Priority: P3
Source: Council 2026-04-27

### BKL-DOM-INF-11 | Add Wikidata tier
Status: ⏸ DEFERRED — Gemini Flash-Lite batch resolves 96% without Wikidata. Revisit if coverage degrades.
Priority: P3
Source: Council 2026-04-27

### BKL-DOM-INF-12 | Add Wikipedia infobox fallback
Status: ⏸ DEFERRED — depends on Wikidata (INF-11); not needed at current coverage levels.
Priority: P3
Source: Council 2026-04-27

### BKL-DOM-INF-13 | Surface unresolvable domains as "needs manual entry" in UI
Status: 🟡 IN PROGRESS
Priority: P3
Size: M
Source: Council investigation 2026-04-27 (Serena + user request)
Issue: hornjason/asaCommandCenter#25
Files: src/bootstrap-orchestrator.ts, src/customers-routes.ts, dashboard/src/pages/SetupPage.tsx, dashboard/src/pages/HomePage.tsx
Description: Companies like Condor Bidco are shell entities with no web presence — genuinely unresolvable by any tier. Currently these silently get no domain with no UI feedback. Fix: (1) add `needs_manual_domain: true` field to customer record when all tiers miss and domain remains null after inference; (2) show a badge on affected customer cards in HomePage ("Domain needed"); (3) link badge to Setup wizard domain field pre-focused on that customer. Condor Bidco is the known test case.
Can we test: YES — mock all tiers returning null, verify needs_manual_domain=true written; verify badge renders.

### BKL-DOM-BATCH-01 | Batch domain inference — Gemini Flash-Lite per-AE batch with fallback chain
Status: ✅ DONE 2026-04-27
Priority: P1
Size: M
Source: Council investigation + live testing 2026-04-27 (validated 22/23 in ~2.5s)
Files: src/domain-waterfall.ts (new batchInferDomains function), src/bootstrap-orchestrator.ts (lines 2285-2363)
Description: Replace the current per-company waterfall loop with a batch Gemini Flash-Lite approach. Tested and validated: 22/23 customers resolved in ~2.5s total across 2 AEs.

Architecture:
1. One Gemini Flash-Lite batch call per AE — all customer names in one prompt → JSON map {name: domain|null}. Chunk at 20 names per call if AE has >20 customers.
2. Gemini retry — for any nulls from step 1, retry with a second batch call containing only the unresolved names. Second shot at hard cases (division names, legal entities).
3. Clearbit fallback — for any still-null after retry, call tier1Clearbit per company.
4. Signal fallback (last ditch) — for any still-null after Clearbit, run inferCustomerDomain (Gmail/Calendar). Last resort only.
5. All 4 steps wrapped in a 60s outer Promise.race cap per AE — whatever resolves saves, the rest drops and bootstrap moves on.

Security (Rook — YELLOW→GREEN fixes):
- Add isPublicDomain() filter before any domain is used: rejects private IPs (10.x/172.16-31.x/192.168.x/127.x/169.254.x), localhost variants, and malformed strings.
- Change tier3Validate redirect:'follow' → redirect:'manual' (tier3Validate is not called in auto-bootstrap path but fix applies for any manual validation path).
- tier3Validate NOT called during auto-bootstrap — skip liveness check; bad domains fixable in Setup wizard.

Other changes:
- batchInferDomains() added to domain-waterfall.ts (exported, reusable)
- Revert Marcus's fire-and-forget changes: autoBootstrapState.running=false goes back to AFTER inference completes
- Filter !cx.domain upfront before building batch prompt — skip already-resolved customers
- Timeout cap lowered from 120s → 60s
- Structured log per AE: input count, resolved, source breakdown (gemini/clearbit/signal), total ms
- Model: getGeminiModelLite() (Flash-Lite), not getGeminiModel()
- JSON parse robustness: strip markdown fences, validate each entry is string|null, drop malformed entries to null

Regression tests required (per CLAUDE.md rule):
- REG-DOM-BATCH-01: batch resolves known companies correctly (REI, Taylor Fresh Foods, Intrado, Uber)
- REG-DOM-BATCH-02: Gemini failure falls through to Clearbit-only path
- REG-DOM-BATCH-03: partial JSON response treats missing entries as null and retries them
- REG-DOM-BATCH-04: already-resolved customers (cu.domain set) are skipped in batch prompt
- REG-DOM-BATCH-05: 60s cap fires correctly; running=false only after inference completes

Can we test: YES — all 5 regression tests above; bootstrap Elmer+Carolanne on 7776 and verify domains.

### BKL-CONN-SF-AUTO-01 | SF + CCSP don't auto-recover after shared browser context crash/recycle
Status: ✅ DONE 2026-04-27
Decision: Implementation council-reviewed 4/4 PASS 2026-04-27. All 8 regression tests (REG-CONN-SF-AUTO-01-04 + REG-DOM-BATCH-01-04) green under ci project. Promoted to prod.
Priority: P1
Size: M
Source: Council investigation 2026-04-27 (Serena + Marcus + Quinn + full arch review)
Files: src/scraper-manager.ts (callback registration), src/sf-scraper.ts (lazy self-heal), src/rh-scraper.ts (recycle path notification)
Description: When the shared Chromium browser context crashes or is recycled (every 50 scrapes), SF and CCSP lose their sessions and do not auto-recover. RH Portal auto-recovers via its own disconnect handler; Tableau uses an isolated profile + disk cookies (unaffected). SF requires manual VNC re-login each time.

Root cause: Three compounding gaps —
1. setContextRecoveryCallback in rh-scraper.ts is exported but never called anywhere. _onContextRecovered fires into a void on every crash/recovery.
2. sf-scraper.ts holds a cached _context reference set once at adoptSfContext time and never refreshes it — unlike ccsp-scraper.ts which lazily calls getScrapeContext() at every scrape entry (lines 763-768).
3. Context recycle path (rh-scraper.ts:943-980) silently closes and relaunches context without firing the recovery callback to siblings.
Additionally: SF keep-alive failing on dead context fires _onSessionExpired → 4-hour circuit breaker pin → forces manual VNC re-login even for a self-recoverable dead reference.

Three surgical changes (no scraper logic changes, wiring only):
A. background-scheduler.ts (init, ~6 lines): Register setContextRecoveryCallback to call adoptSfContext + adoptCcspContext on every RH context recovery event.
B. sf-scraper.ts (keepAlive + scrape entry, ~5 lines): At top of keepAlive() and scrapeSfReport, refresh from getScrapeContext() if cached _context is null or closed. Mirrors ccsp-scraper.ts:763-768 exactly.
C. rh-scraper.ts (~3 lines at line 975): After context recycle relaunch, fire _onContextRecovered so siblings are notified same as crash-recovery path.

Guards to add in adoptSfContext:
- Skip if incoming ctx is same reference already held (no-op)
- Skip if loginInProgress === true (don't stomp in-flight VNC login)
- Reset SF circuit breaker on successful re-adoption

Important: Do NOT gate auto-adoption on .sf-session.json existence. SSO session lives in Chromium profile dir cookies, not the marker file.

Optional follow-ups (separate items, do not bundle):
- Drop 4h SF circuit breaker pin to ~5min for dead-context failures vs true SSO expiry
- Single connection status source of truth (eliminate UI flicker from split status sources)
- Browser-level liveness probe (_context.browser()?.isConnected())

Regression tests required:
- REG-CONN-SF-AUTO-01: after RH context restored, getSfAuthStatus.hasSession === true without SF login flow
- REG-CONN-SF-AUTO-02: no adoption when getSfContext() already non-null (no-op / same ref)
- REG-CONN-SF-AUTO-03: no crash/adoption when loginInProgress === true
- Post-edit: verify existing TABLEAU-CTX grep tests still pass after new SF imports in rh-scraper.ts scope

Can we test: YES — simulate disconnect, assert SF context restored without VNC. Live test: 7776 bootstrap then kill context, verify auto-recovery.


### BKL-CASES-MATCH-01 | REG-021 failing: cases not matching accounts by accountNumber or name
Status: 🟡 IN PROGRESS
Priority: P2
Size: S
Source: CI regression run 2026-04-27 (post BKL-CONN-SF-AUTO-01 + BKL-DOM-BATCH-01 promote)
Files: src/routes/cases.ts or cases cache, /api/accounts response
Description: REG-021 checks that all cases from /api/cases/all match at least one account from /api/accounts by accountNumber or customerName. Currently 32 cases present (real account numbers: 5856163, 1530865, 1025778) but /api/accounts returns 10 customers with empty accountNumbers arrays (A10 Networks [], Dropbox []). matchedIds.size = 0.
Root cause: accountNumbers empty on accounts — either not populated from CCSP scrape or mapping lost.
Pre-existing: Not introduced by CONN-SF-AUTO or DOM-BATCH changes (those don't touch cases/accounts pipeline).

Can we test: YES — REG-021 is already the test. Fix requires populating accountNumbers in /api/accounts response.

### BKL-INTEL-TIMEOUT-01 | Account intelligence pipeline stalls on Vertex AI slow-latency days
Status: ✅ DONE 2026-05-02 — Reduced timeoutMs from 120_000 to 60_000 in account-intelligence.ts callGeminiGrounded. Worst-case per-call: 3 attempts × 60s = 180s (was 360s). Worst-case pipeline: 3 calls × 180s = 9 min (was 18 min). No test change needed; gemini-fetch.test.ts covers the retry path.
Priority: P2
Size: S
Source: Live observation 2026-04-28 — A10 Networks intelligence took 6+ min (still running)
Files: src/account-intelligence.ts (lines 164-174), src/gemini-fetch.ts (retry logic)
Description: Each of the 3 Gemini grounded calls in the intelligence pipeline uses a 120s per-attempt timeout with up to 2 retries (fetchGeminiWithRetry). On a Vertex slow-latency day, worst case is 3 calls × 3 attempts × 120s = ~18 min wall time per customer. No outer cap on the full pipeline exists.

Observed: Company intelligence generated (20409 chars) successfully on attempt 1, then timeout on attempt 2 — the second of 3 calls — causing the pipeline to stall visibly for 6+ min.

Options to evaluate:
1. Reduce per-attempt timeout: 120s → 60s for grounded calls (Flash is fast enough; 120s was conservative)
2. Add outer Promise.race cap on the full generateAccountIntelligence call (e.g. 3-4 min hard ceiling)
3. Reduce retry count from 2 → 1 for timeout errors (saves one 120s burn per slow call)
4. Combination: 60s timeout + 1 retry + 4 min outer cap

Can we test: YES — unit test that fetchGeminiWithRetry respects reduced timeout; integration observation on next bootstrap.

### BKL-CCSP-STATUS-01 | CCSP shows "connected" and closes VNC before user can log in to Tableau
Status: ✅ DONE 2026-04-28
Priority: P1
Size: M
Source: Live observation 2026-04-28 — 0 CCSP records after bootstrap, status shows connected, VNC closes before username can be entered
Files: src/ccsp-scraper.ts (lines 31, 36, 546-554), src/scraper-manager.ts (lines 940-956)
Description: Two compounding problems:

Problem 1 — VNC window closes immediately on SSO detection:
When CCSP navigates to 10ay.online.tableau.com and hits the Tableau SSO login page (sso.online.tableau.com/public/idp/SSO), it throws "Tableau session required" immediately, which closes the page and the VNC window. User cannot type their username before it disappears. SSO flow: user enters username → Red Hat SSO completes → lands on 10ay.online.tableau.com. But scraper never gives the user time to complete that flow.

Problem 2 — Connection status shows "connected" when session is dead:
_tableauSessionExpired is set but scraper-manager never reads it. Circuit breaker doesn't trip because scraper exits cleanly. Dashboard shows green "connected" with 0 records.

Fix for Problem 1 (core fix): When SSO page is detected, instead of throwing immediately — keep the page open and poll for successful redirect to 10ay.online.tableau.com for up to 5 minutes. Emit a log/status signal so the UI can show "waiting for Tableau login via VNC." Once the URL changes to 10ay.online.tableau.com (user completed SSO), save the new cookies, continue the scrape.

Fix for Problem 2 (status fix): Wire consumeTableauSessionExpired() (line 146) into scraper-manager CCSP status block as sessionExpired field. Frontend shows auth-needed state when true.

Can we test: YES — regression test that scraper-manager CCSP status surfaces sessionExpired; manual VNC flow test on 7776 after fix.

### BKL-CCSP-STATUS-03 | dataSourcesConnected counter state computed but not consumed in SetupPage JSX
Status: 🔵 DEFERRED
Priority: P3
Size: S
Source: Quinn audit 2026-05-02 — `dataSourcesConnected` state and `dataSourcesHealth` are computed by `computeConnected()` and polled every 10s, but no JSX consumes them (no "X/3 connected" header indicator in DOM). Comment at SetupPage.tsx:2693-2697 references DataSourcesSection which was deleted in #12.
Fix: Either (a) wire `dataSourcesConnected` into a visible header counter/badge, or (b) remove the dormant state and polling entirely. If keeping the counter, the SetupPage accordion badge area (Step 1 header region) is the natural home.

### BKL-CCSP-STATUS-02 | CCSP "connected" badge ignores tableauSessionExpired and 0 recordCount
Status: ✅ DONE 2026-05-02
Priority: P1
Size: S
Source: Live observation 2026-04-28 — test container shows CCSP green after 0-record scrape
Files: dashboard/src/lib/connection-state.ts, dashboard/src/pages/SetupPage.tsx
Decision: DataSourcesSection (original bug location) was deleted in #12 as dead code. Remaining fix: computeConnected() in SetupPage.tsx now fetches /api/status/scrapes as 4th parallel fetch and gates tableauConnected on !ccsp.tableauSessionExpired and recordCount > 0 (null guard preserves first-install behavior). CcspRawStatus interface extended with tableauSessionExpired and recordCount. hasVerifiedDownload in deriveTableauCard also fixed. 3 regression tests added to connection-state.spec.ts. All 20 unit tests pass.

### BKL-CCSP-SHARED-CTX-01 | Tableau SSO must complete in the shared scrape context — isolated login + cookie bridge fails
Status: 🔵 HELD — pending L4 design session (after all open issues closed)
Priority: P0
Size: M
Source: Architectural review 2026-04-28 — Serena Blackwood + Rayford
Files: src/tableau-auth.ts, src/ccsp-scraper.ts, docs/adr/ADR-015-tableau-sso-shared-context.md
Description: The current architecture has Tableau SSO login completing in an isolated persistent Chromium context (TABLEAU_AUTH_PROFILE_DIR), then bridging cookies via a JSON file to the shared scrape context. This bridge is fundamentally broken: Tableau Cloud's VizQL session is bound to the originating browser's JS environment (localStorage, IndexedDB, tabid, sessionId). Re-injecting cookies into a different Chromium profile produces a session that passes the URL check but fails on CSV requests — the shared context re-triggers SSO.

This is the root cause of CCSP returning 0 records after a successful VNC login.

Architectural truth from CLAUDE.md/ADR-001: "Shared browser context is intentional — isolation breaks Tableau SSO."

Fix (per ADR-015): Move Tableau SSO login to complete in the shared context. Open a new page on the shared context, navigate to TABLEAU_URL, wait for user to complete SSO in VNC. On success, the shared context has the correct Okta tokens and VizQL session state for CCSP scraping.

Cookie seeding workaround (short-term): Copy prod tableau-session.json → data-test/rh-profile/tableau-session.json to seed test container after wipe. This restores the cookie age check to "valid" but does NOT fix the underlying VizQL session issue.

Can we test: YES — after Option B is implemented, trigger CCSP scrape on 7776 and verify csv_ok (non-zero rows) appears in container logs.

AUTONOMOUS WORK DONE (2026-04-28 while Jason sleeping):
- Added CSV response classifier (auth_redirect/csv_empty/csv_summary_view/csv_ok) to ccsp-scraper.ts at both CSV fetch paths — now we can distinguish auth failure from filter failure
- Added REG-CCSP-SSO-03/04/05 regression tests (all green)
- Added ADR-015 documenting Option B decision for Jason's sign-off
- Containerignore fix: data-dev/ data-test/ data-snapshots/ were being copied into image (1.1GB), causing build disk errors — excluded from .containerignore
- VNC stability fixes: 5s stability window (was 500ms), close restored persistent context pages on login launch

NEXT: Jason approves ADR-015 → Marcus implements Option B → Quinn validates VNC flow on 7776 → single end-to-end CCSP scrape confirms csv_ok

### BKL-CONN-TABLEAU-TIMEOUT-VNC-01 | Tableau VNC closes at 90s — too short for full SAML chain
Status: ✅ DONE 2026-04-28
Priority: P1
Size: S
Source: Session 2026-04-28 (Jason empirical SSO testing)
Files: dashboard/src/pages/SetupPage.tsx
Decision: Converted single wait-for-login fetch to while(!loginResolved) re-poll loop. {sessionValid:false} from server now triggers re-poll, not resolveLogin(false). Hard cap raised 120s→300s. Commit f93a08ec7.

### BKL-CONN-TABLEAU-EMAIL-AUTOFILL-01 | Tableau login requires manual email entry — should auto-fill
Status: ✅ DONE 2026-04-28
Priority: P2
Size: S
Source: Session 2026-04-28
Files: src/tableau-auth.ts
Decision: TABLEAU_USER_EMAIL env var. waitForTableauLogin fills email input + clicks submit when on email entry page (URL lacks /site/+/views/). Non-fatal — skipped gracefully if unset. Commit f93a08ec7.

### BKL-ARCH-LEADER-FLAG-01 | Leader flag: one instance does L4 scrapes, all others read Drive only
Status: ✅ DONE 2026-04-28
Priority: P1
Size: L
Source: Session 2026-04-28 (Jason architecture decision)
Files: src/ccsp-scraper.ts, src/sf-scraper.ts, .env, .env.example
Decision: IS_LEADER=true env var. Guards added at exact L4 entry points: `scrapeOneAe` (line ~525), `scrapePodCcspRaw` (line ~958), `scrapeSfReport` (line ~459), `listSfReports` (line ~961). Default unset = non-leader (fail-closed). Rook verified no coercion risk. L4 tested end-to-end — Carolanne hit live Tableau scrape (7714 rows), Elmer hit L1 cache (310 rows). BKL-SEC-IS-LEADER-CASE-01 logged for case-sensitivity follow-up.

### BKL-ARCH-HEARTBEAT-01 | Session heartbeat: periodic lightweight navigation to keep sessions alive overnight
Status: 🟡 IN PROGRESS
Priority: P1
Size: M
Source: Session 2026-04-28 (Serena council review)
Description: Tableau and SF sessions expire in ~2h of idle. Leader instance needs periodic lightweight page navigation (not full scrape) to reset the server-side idle timeout. Fixed 90-minute interval per Serena recommendation (cookie expires=-1, adaptive scheduling impossible). Each heartbeat navigates to the service URL and asserts on an auth marker (DOM element only present when authenticated). Uses SessionMutex to avoid racing active scrapes. Logs every heartbeat outcome.
Acceptance: Sessions survive overnight without manual re-login on leader instance. Heartbeat logs visible in admin panel. Full scrape still succeeds after overnight heartbeat-kept sessions.

### BKL-CONN-TABLEAU-SSO-SHARE-01 | Investigate why auth.redhat.com session not auto-satisfying Tableau SAML after SF login
Status: 🟡 IN PROGRESS
Priority: P1
Size: S
Source: Session 2026-04-28 (empirical testing — SSO credential prompt appeared despite recent auth.redhat.com login)
Description: After SF login establishes shared context (which includes auth.redhat.com session), Tableau's SAML redirect to auth.redhat.com should auto-authenticate without credential prompt. Today's test showed credential prompt still appearing. Need to confirm: (1) auth.redhat.com session IS present in shared context at time of Tableau SAML redirect, (2) the session is being sent in the SAML request, (3) Tableau's SSO realm matches the one established by SF login. May be a session TTL issue (2h expired) or a cookie domain issue.
Acceptance: After SF login completes, Tableau SAML redirect auto-authenticates without credential prompt. User only needs to type Tableau email, then lands on dashboard.

### BKL-CONN-TABLEAU-SSO-TAB-LOOP-01 | Tableau SSO new tab loop causes wait-for-login to always time out
Status: ✅ DONE 2026-04-28
Priority: P0
Size: S
Source: Session 2026-04-28 (Serena council diagnosis)
Files: src/tableau-auth.ts
Description: `sharedCtx.on('page')` handler redirected every new SSO popup back to TABLEAU_URL, triggering another SSO redirect → another tab → loop × 3. Each iteration mutated `activePage`. `waitForTableauLogin`'s `activePage !== page` guard always failed on the stale reference, so 300s timeout fired every time even after successful login.
Decision: Handler now closes any popup tab (with 500ms delay) instead of redirecting. `_activeSsoPopupHandler` stored at module level for cleanup. `ctx.off('page', handler)` called in `_closeContext`. Stale-reference guard `activePage !== page` removed — only `!loginInProgress` checked. Serena architecture review confirmed: Red Hat SSO is redirect-based, not popup-driven; closing popups preserves the original tab's SSO flow.

### BKL-SEC-IS-LEADER-CASE-01 | IS_LEADER env var case-sensitive — 'True'/'TRUE'/'1' silently treated as non-leader
Status: ✅ DONE 2026-05-02 — Added _parseRole() to node-role.ts with strict equality + console.warn on mis-cased NODE_ROLE. 6 new tests in node-role.test.ts (17/17 pass). Closes BKL-SEC-IS-LEADER-CASE-01.
Priority: P1
Size: S
Source: Rook scan 2026-04-28 (post tableau-auth SSO fix)
Files: src/ccsp-scraper.ts, src/sf-scraper.ts
Description: `process.env.IS_LEADER !== 'true'` is strict string equality. Any mis-cased value ('True', 'TRUE', '1', 'yes') causes the node to silently behave as a non-leader — L4 scrapes are blocked with no error surfaced. Can cause a correctly-provisioned leader to appear non-functional with no diagnostic output. Fix: normalize to lowercase at read time, log a warning if IS_LEADER is set to anything other than 'true' or empty.
Acceptance: Setting IS_LEADER=True or IS_LEADER=1 logs a clear warning and treats as non-leader (no silent wrong behavior). Only IS_LEADER=true enables L4. Doc updated in .env.example.
Can we test: YES — unit test that verifies IS_LEADER='True' guard logs warning and returns non-leader result.

### BKL-BOOT-SCRAPE-ORDER-01 | Bootstrap scrape discipline — auth-only Step 3, sequential bootstrap, suppress background scrapers until first AE done
Status: ✅ DONE 2026-04-29 (extended fix)
Commit: 92b2113ff + 2026-04-29 (heartbeat + post-auth flush AE guard)
Priority: P0
Size: M
Source: Session 2026-04-29 (Jason architecture review — browser contention root cause)
Files: server.ts, src/bootstrap-orchestrator.ts, src/scraper-manager.ts (or background-scheduler.ts)
Description: Step 3 (Connections) triggers scraping immediately on auth — SF onComplete fires runSfSyncForAes, startup catch-up fires CCSP/pipeline/RH cases before any AE exists. This causes shared Chromium contention (newPage() 30s timeout) on fresh containers. Correct design: (1) Step 3 = auth only, zero scraping; (2) catch-up suppressed until at least one AE has bootstrapComplete:true; (3) bootstrap drives SF → CCSP sequentially, each step waits for L3 write before proceeding; (4) CCSP checks for today's CCSP Drive CSV before doing L4; (5) RH Cases not run during initial bootstrap.
Acceptance: Fresh container: connect RH Portal + SF → no scraping fires. Start bootstrap → SF runs → writes L3 → CCSP runs (L3 hit skips L4, L3 miss does L4) → writes L3 → done. RH Cases not triggered. No browser contention. CCSP does not call newPage() while SF is using the browser.
Can we test: YES — regression test that (a) SF onComplete does NOT call runSfSyncForAes, (b) catch-up skipped when aes.json empty, (c) bootstrap CCSP step checks today's Drive CSV before L4.

### BKL-HERO-01 | Hero Install Wizard — L3-only setup flow (Step 0 + Step 3 + isL3Only gating)
Status: ✅ DONE 2026-05-01
Priority: P1
Size: L
Source: Session 2026-04-29 (design signed off by Jason)
Files: dashboard/src/pages/SetupPage.tsx, dashboard/src/components/BootstrapConfigBlock.tsx, src/settings-api.ts, src/server-state.ts
Description: Implement the hero install wizard design per docs/HERO-INSTALL.md. Five net-new items:
  1. Step 0 — first-boot region/pod selector screen; writes enabledRegions + enabledPods to settings.json; skipped on subsequent boots; editable from Admin › Region Access
  2. Step 3 — RH API Token UI; paste REDHAT_OFFLINE_TOKEN in form field; app validates (getToken()) + writes to .env; replaces current Connections step for L3
  3. isL3Only flag — server exposes NODE_ROLE !== 'primary'; frontend conditionally hides Data Sources, Refresh Timer, Automation sections
  4. Step 4 filter — Region/POD dropdowns pre-filtered to enabledRegions/enabledPods from settings.json
  5. "Open Dashboard" button relocation — move from Refresh Timer section to end of Step 4 (since Refresh Timer hidden on L3)
Acceptance:
  - First boot on fresh container with no NODE_ROLE shows Step 0 region/pod picker
  - Step 0 skipped on subsequent boots; Edit link in Admin re-shows it
  - Step 3 token field validates and writes REDHAT_OFFLINE_TOKEN to .env
  - Step 4 POD dropdown shows only pods matching enabledPods
  - Data Sources, Refresh Timer, Automation sections absent from wizard on L3 install
  - Primary (NODE_ROLE=primary) sees full 5-step wizard unchanged
  - East regions show as Coming Soon (not selectable) until sfReportId + podBookingsFolderId configured
Can we test: YES — Playwright spec: (1) fresh container, NODE_ROLE unset → Step 0 visible; (2) after save, reload → Step 0 absent; (3) NODE_ROLE=primary → Step 0 absent, Data Sources visible

Council corrections (Serena 2026-04-29):
  - Token storage: data-sources.json via existing saveOfflineToken() path, NOT .env (prior .env write incident documented)
  - Step 3 replaces entire Connections card body for L3 (confirmed by Jason)
  - AI Settings kept visible on L3 (Gemini brief generation works on hero installs)
  - Admin › Region Access deferred to BKL-HERO-02

Naming conventions (confirmed 2026-04-29):
  - enabledPods format: ${regionId}.${podKey} (e.g. west-commercial.WEST_COMM_CORP_NORTHWEST)
  - SF reports named: DBD - {Region Label} - {Pod Label}
  - Subscription Data Drive folder: {Region Label} - Subscription Data

Decision: DONE — All 5 phases shipped 2026-04-30 to 2026-05-01. Phase 0 (backend), Phase 1 (Step 0 region picker), Phase 2 (isL3Only gating), Phase 3 (RH token form + validateOfflineToken), Phase 4 (POD dropdown filter), Phase 5 (Open Dashboard hero button). 28 Playwright tests added across 5 spec files. Quinn 28/28 PASS. Rook: no Critical/High findings; BKL-SEC-10 (sanitizeErr HTML-strip) patched same session; BKL-SEC-09 and BKL-SEC-11 logged as open. Pre-existing failures: REG-001 (seed data mismatch, pre-existing) and REG-BOOT-03 (@live test requires primary role).

### BKL-HERO-02 | Hero Install — Admin › Region Access edit screen
Status: ✅ DONE 2026-05-01
Priority: P2
Size: S
Source: Session 2026-04-29 (deferred from BKL-HERO-01 to control scope)
Files: dashboard/src/pages/AdminPage.tsx, dashboard/src/components/Step0RegionAccess.tsx (after BKL-HERO-01 ships)
Description: Add an "Edit Regions" screen under Admin that re-mounts the Step0RegionAccess component, allowing users to change their enabled regions/pods without a full wizard reset. Depends on BKL-HERO-01 shipping first (component must exist).
Acceptance:
  - Admin page has a "Region Access" section
  - Clicking Edit opens the Step0RegionAccess component pre-populated with current selections
  - Saving updates enabledRegions/enabledPods in settings.json
  - No wizard reset required
Can we test: YES — Playwright: navigate to Admin, click Edit Regions, change selection, save, reload AEs section → POD dropdown reflects new selection
Decision: DONE — RegionAccessSection function component added to AdminPage.tsx. Fetches GET /api/regions/access on mount, mounts Step0RegionAccess pre-populated. 3 Playwright tests passing. Quinn + Rook gates run in same session.

### BKL-HERO-03 | Test spec gap — NODE_ROLE=primary suppresses rh-token-input
Status: ✅ OBSOLETE (2026-05-01) — HeroStep3Connections is now unconditional in SetupPage.tsx; NODE_ROLE=primary no longer suppresses it; nothing to test
Priority: P3
Size: S
Source: Quinn scan 2026-05-01 BKL-HERO-01 Phase 3
Files: test/ui/setup-l3-gating.spec.ts (or hero-step3.spec.ts)
Description: No assertion verifies that `data-testid="rh-token-input"` is absent when NODE_ROLE=primary. The L3-only gating logic is tested from the positive path (NODE_ROLE unset → component renders) but not the negative path (NODE_ROLE=primary → component absent). Add one assertion to cover suppression.

### BKL-HERO-04 | Fixture drift — TBH AE data stale in test fixtures
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Quinn scan 2026-05-01 BKL-HERO-01 Phase 3
Files: test/fixtures.ts
Description: TBH AE entry in test fixtures is out of sync with current data shape. Non-blocking but causes intermittent fixture mismatch warnings in CI. Update TBH fixture data to match current aes.json schema.


### BKL-HERO-05 | L3 hero: RH Portal "Connect" banner shows at top of dashboard
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/App.tsx:99-117
Description: Amber warning banner "Red Hat Portal not connected — cases last synced Xd ago" with [Connect] button renders on dashboard for L3 hero installs. Clicking [Connect] opens VNC popup for RH Portal login — a flow L3 installs cannot and should not use. RH data on L3 comes from Drive cache written by the L4 leader. Gate the entire RHSessionBanner component behind !isL3Only.
Acceptance: On L3 (NODE_ROLE unset), RHSessionBanner is absent from the DOM. On L4 (NODE_ROLE=primary), banner renders normally.
Can we test: YES — Playwright test mocking /api/node-role asserts banner absent on L3 and present on L4.

### BKL-HERO-06 | L3 hero: KPI Cards shows "Connect Red Hat Portal in Settings" hint
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/components/KPICards.tsx:423-425
Description: Below the Cases KPI card, hint text "Connect Red Hat Portal in Settings to sync support cases" is visible on L3 installs. The Settings page on L3 uses HeroStep3Connections (token-only) and has no RH Portal connect flow. The hint sends users to a setting that doesn't exist. Gate behind !isL3Only (or !rhHasSession && !isL3Only).
Acceptance: Hint text absent on L3. Hint still visible on L4 when RH is disconnected.
Can we test: YES — Playwright test on L3 asserts hint text has count 0.

### BKL-HERO-07 | L3 hero: Cloud Spend (CCSP) panel renders with no data
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/components/CloudSpendSection.tsx
Description: CCSP panel renders on the main dashboard for L3 installs. CCSP scraper does not run on L3 — panel will be permanently empty in production. Empty state is worse than no state because user wonders why it's empty. Hide entire panel when isL3Only.
Acceptance: CloudSpendSection absent on L3. Still renders on L4.
Can we test: YES — Playwright test on L3 asserts CCSP section absent.

### BKL-HERO-08 | L3 hero: Pipeline (Tableau) panel — gate Tableau-derived sub-metrics
Status: ✅ OBSOLETE (2026-05-01) — Pipeline data (including techWinsNeeded) comes from SF bookings Drive sheets via sf-bookings-reader.ts, not Tableau scraping. Panel is fully L3-compatible; no gating needed.
Priority: P2
Size: M
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/components/ (Pipeline/Tableau section)
Description: Pipeline panel visible on dashboard. SF bookings data (which syncs on L3) is fine; Tableau-derived metrics will not populate. Verify data source for each sub-panel and gate Tableau-only content behind !isL3Only or hasTableau.
Acceptance: SF-derived pipeline metrics still visible on L3. Tableau-specific sections hidden.
Can we test: YES — after implementation, Playwright test on L3 verifies SF metrics present, Tableau metrics absent.

### BKL-HERO-09 | L3 hero: Admin top "Manual scrape requires active feed session" warning banner
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (top warning banner)
Description: Red warning banner at top of Admin page warns about manual scrape triggers needing "an active feed like Portal session" — a concept that doesn't apply to L3. Misleading context. Gate behind !isL3Only.
Acceptance: Warning banner absent on Admin page on L3. Present on L4.
Can we test: YES — Playwright on L3 asserts banner text absent.

### BKL-HERO-10 | L3 hero: Admin Data Source Health tiles show RH Portal + Tableau as permanently red
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (DATA SOURCE HEALTH section)
Description: Three health tiles: RH Portal, Tableau, Salesforce. On L3, RH Portal and Tableau tiles are permanently red — they are not wired on L3 nodes. This creates a permanent false alarm. Salesforce tile is appropriate (SF bookings sync on L3). Per-tile gate: render RH Portal and Tableau tiles only when !isL3Only. Salesforce stays.
Acceptance: On L3, only Salesforce health tile visible. On L4, all three tiles visible.
Can we test: YES — Playwright on L3 asserts RH Portal and Tableau health tiles absent.

### BKL-HERO-11 | L3 hero: Admin Manual Scrape Triggers shows RH Cases + CCSP [Run Now] buttons
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (MANUAL SCRAPE TRIGGERS section)
Description: Admin page shows [Run Now] buttons for RH Cases, CCSP, and SF Pipeline. RH Cases and CCSP do not run on L3 — triggering them will fail or produce incorrect behavior. SF Pipeline is appropriate. Per-tile gate: hide RH Cases and CCSP trigger tiles on L3, keep SF Pipeline.
Acceptance: On L3, only SF Pipeline trigger visible in MANUAL SCRAPE TRIGGERS. On L4, all three visible.
Can we test: YES — Playwright on L3 asserts RH Cases and CCSP trigger buttons absent.

### BKL-HERO-12 | L3 hero: Admin Browser Sessions section shows "Save Content RH Session" control
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (BROWSER SESSIONS section)
Description: Admin page shows Browser Sessions section with "Save Content RH Session" button. L3 has no browser session — no Chrome profile, no VNC scraper. Button is dead and misleading. Gate entire BROWSER SESSIONS section behind !isL3Only.
Acceptance: Browser Sessions section absent on Admin page on L3.
Can we test: YES — Playwright on L3 asserts browser sessions section absent.

### BKL-HERO-13 | L3 hero: Admin Scheduler Limits shows CCSP + RH Cases rows
Status: ✅ DONE (2026-05-01)
Priority: P2
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (SCHEDULER LIMITS section)
Description: Scheduler Limits section shows rows for CCSP, Territory, SF Pipeline, and RH Cases — each with enable toggle and cadence. On L3, CCSP and RH Cases schedulers do not run. Showing them implies they do. Gate CCSP and RH Cases rows behind !isL3Only. SF Pipeline and Territory stay visible.
Acceptance: On L3, only SF Pipeline and Territory scheduler rows visible.
Can we test: YES — Playwright on L3 asserts CCSP and RH Cases scheduler rows absent.

### BKL-HERO-14 | L3 hero: Admin Run Domain Inference — verify L3 compatibility before gating
Status: ✅ OBSOLETE (2026-05-01) — Domain inference calls /api/setup/infer-domains which uses Clearbit + public HTTP lookups only; no browser, no Tableau. Fully L3 compatible, no gating needed.
Priority: P3
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (DOMAIN INFERENCE section)
Description: "Run Domain Inference" button on Admin. Domain inference may only use LLM + Drive data (fine on L3) or may depend on L4 scrape data. Verify dependency before deciding whether to gate. If LLM-only: keep on L3. If L4-data-dependent: gate behind !isL3Only.
Acceptance: Decision made and implemented.
Can we test: YES after decision.

### BKL-HERO-15 | L3 hero: Admin NotebookLM controls likely leader-only
Status: 🔵 COSMETIC (2026-05-01) — Already gated by NOTEBOOKLM_ENABLED env var (shows "disabled" when unset). Not a node role issue. No functional fix needed; label clarification only if desired.
Priority: P4
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (NOTEBOOKLM section)
Description: NotebookLM section with [Create All Notebooks] button may be inappropriate on L3 — if it writes to Drive folders shared by all nodes, running it from every L3 hero install could create duplicate notebooks. Treat as leader-only (gate behind !isL3Only) unless confirmed safe to run from L3.
Acceptance: NotebookLM section absent on L3. Visible on L4.
Can we test: YES — Playwright on L3 asserts section absent.

### BKL-HERO-16 | L3 hero: Admin Generate All Account Intelligence — architectural decision needed
Status: ✅ OBSOLETE (2026-05-01) — Account intelligence generation calls Gemini/Claude APIs (pure HTTP). Fully L3 compatible on hero installs; no architectural decision needed, no gating required.
Priority: P2
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (ACCOUNT INTELLIGENCE section)
Description: "Generate All Account Intelligence" [Generate All] button — intelligence pipeline writes briefs to Drive. Architectural question: should this run from every L3 hero install, or only from the L4 leader? If all nodes generate their own briefs, keep. If leader-only, gate behind !isL3Only. Decision needed before implementation.
Acceptance: Decision made and implemented. If leader-only: section absent on L3.
Can we test: YES after decision.

### BKL-HERO-17 | L3 hero: Admin Gemini Usage panel — clarify "this node" vs fleet
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Quinn L3 hero audit 2026-05-01
Files: dashboard/src/pages/AdminPage.tsx (GEMINI API USAGE section)
Description: Gemini API Usage panel shows today/this-month token counters. On L3, counters reflect local-node usage only. User may expect fleet aggregate. Keep the panel but add label "this node" to make scope clear, or hide if L3 brief generation doesn't happen locally.
Acceptance: Panel label clearly indicates node-local usage.
Can we test: YES — text assertion.

### BKL-HERO-18 | L3 hero: Customer detail page audit pending test data
Status: ✅ DONE 2026-05-03
Priority: P2
Size: S
Source: Quinn L3 hero audit 2026-05-01
Issue: hornjason/asaCommandCenter#26
Files: dashboard/src/pages/CustomerDetailPage.tsx, test/ui/hero-l3-gating-customer-detail.spec.ts
Commit: 3234bc504
Description: Quinn audit confirmed 6 ungated L4 elements (CloudSpendCard, PipelineCard, CasesSection, Cases/Cloud$/Pipeline header StatBadges). Added isL3Only hook + gates to all 6 elements. 7 regression tests (T1-T7) — T7 mocks SSE to fire the sse.meta !== null condition. All 7 pass.

### BKL-HERO-19 | useNodeRole() shared hook — eliminate duplicate /api/node-role fetches
Status: ✅ DONE (2026-05-01)
Priority: P1
Size: S
Source: Quinn L3 hero audit 2026-05-01 (implementation recommendation)
Files: dashboard/src/hooks/useNodeRole.ts (new), dashboard/src/pages/SetupPage.tsx, dashboard/src/App.tsx, dashboard/src/components/KPICards.tsx, dashboard/src/pages/AdminPage.tsx
Description: SetupPage already fetches /api/node-role on mount and stores isL3Only in state. App.tsx, KPICards, AdminPage all need the same value for P1 gating. Create useNodeRole() hook that fetches once (or reads a module-level cache to avoid duplicate fetches) so all consumers share the same value without duplicating the fetch.
Acceptance: Single /api/node-role fetch per page load (not per component). All P1 gate consumers use useNodeRole().
Can we test: YES — network tab assertion (1 /api/node-role call per page), unit test for hook.

### BKL-HERO-20 | Hero purity: missing Playwright assertions that L4 UI is absent
Status: ✅ DONE 2026-05-02
Priority: P1
Size: S
Source: Issue #7 post-mortem 2026-05-01 — worktree merge restored CCSP/Browser Sessions; Quinn gate caught it but CI did not
Files: test/ui-regression.spec.ts (new assertions), dashboard/src/pages/AdminPage.tsx, dashboard/src/pages/SetupPage.tsx
Description: No Playwright test asserts that L4 UI sections are absent from the hero image. Worktree merges twice restored CCSP ScrapeSection and Browser Sessions to AdminPage — only caught by Quinn human gate, not by CI. Need negative assertions: Setup page must not contain "Data Sources", "Refresh Timer & Settings", "Automation & Limits"; Admin page must not contain "CCSP", "Browser Sessions", "Salesforce Pipeline". These are the purity gate tests referenced in issue #8 CI pipeline.
Acceptance: test/ui-regression.spec.ts contains assertions that L4 sections are absent from 7776 (hero image); tests pass in CI. Any future worktree merge that restores L4 content causes CI failure before Quinn gate.
Can we test: YES — Playwright negative assertions against 7776.

### BKL-CONN-SF-ADOPT-01 | SF re-login breaks RH Portal session — context not re-adopted
Status: ✅ DONE 2026-05-02 — Identity guard added to _attachDisconnectedHandler in rh-scraper.ts. Stale handlers skip recovery when _context !== attachedCtx. Regression test: test/unit/bkl-conn-sf-adopt-01.test.ts (2/0). Quinn + Rook pending.
Priority: P0
Size: M
Source: Session 2026-04-28 (empirical testing — RH portal dropped to not-connected after SF login)
Issue: hornjason/asaCommandCenter#19
Files: src/sf-auth.ts, src/rh-scraper.ts
Description: After SF login completes and logs "RH portal confirmed — adopting shared context", the rh-scraper and sf-scraper adoption logs do NOT appear. The RH Portal session drops to hasSession:false and the shared context is lost. Root cause unknown — adoptScrapeContext appears to be called but the rh-scraper adoption log is absent, and no exception surfaces. Hypothesis: sfPage.close() or the blank tab navigation is invalidating ctx before adoptScrapeContext runs, OR a disconnect handler is firing immediately on context adoption clearing it.
Acceptance: After SF login success, RH Portal remains hasSession:true, sf-scraper shows adopted log, Tableau connect still works without re-logging into RH Portal.
Can we test: YES — regression test that after startSfLoginBrowser completes, getScrapeContext() is non-null and getSfContext() is non-null.

### BKL-HERO-21 | POST /api/browser/open-tableau-login unguarded on hero nodes (advisory)
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook security scan 2026-05-02 — issue #7 L4 removal
Files: src/scrape-api.ts (or server.ts — wherever the /api/browser/open-tableau-login route is registered)
Description: POST /api/browser/open-tableau-login is available on hero nodes (no NODE_ROLE guard). On hero, calling it will attempt to Bun.spawn a Chromium binary that doesn't exist, fail with file-not-found, and return { ok: false }. No exploit path. Advisory only: adding a NODE_ROLE=primary guard makes the architectural intent explicit and removes the dead code path.
Acceptance: /api/browser/open-tableau-login returns 404 on hero nodes; route only registered when NODE_ROLE=primary.
Can we test: YES — regression test asserting 404 from 7776 on POST /api/browser/open-tableau-login.

### BKL-UX-WIPE-CONN-RESET-01 | Wipe does not reset connection status UI — user sees stale "Connected" state
Status: ✅ DONE 2026-05-02 (partial — RH + SF session files cleared; Tableau gap tracked in BKL-UX-WIPE-CONN-RESET-02)
Priority: P1
Size: S
Source: Session 2026-04-29 (Jason observed SF "not connected" after wipe despite UI showing connected)
Files: src/scraper-manager.ts (clearSessionFiles() added), src/setup-routes.ts (reset handler calls clearSessionFiles())
Description: After a data wipe (POST /api/setup/reset), the shared browser context is destroyed but the UI connection indicators (RH Portal, SF, Tableau) remain showing their pre-wipe state.
Fix: clearSessionFiles() exported from scraper-manager.ts deletes RH_SESSION_PATH and SF_SESSION_PATH; called from reset handler after resetBootstrapStates(). SF was already correct (requires live context AND session file). Tableau session file cleanup deferred to BKL-UX-WIPE-CONN-RESET-02.
Commit: 6746e3258 (SEC batch) + follow-on commit.

---

### BKL-UX-WIPE-CONN-RESET-02 | Tableau + content-RH session files not cleared on wipe — stale Tableau "Connected" state
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Rook scan 2026-05-02 (BKL-UX-WIPE-CONN-RESET-01 pattern sibling)
Files: src/scraper-manager.ts (clearSessionFiles), src/ccsp-scraper.ts (TABLEAU_SESSION_PATH), src/product-release-radar.ts (CONTENT_RH_SESSION_PATH), src/bootstrap-orchestrator.ts (_tableauStatusCache)
Description: BKL-UX-WIPE-CONN-RESET-01 fixed RH/SF session files. Two sibling session files are not cleaned: (1) tableau-session.json (written by ccsp-scraper.ts:44, read by bootstrap-orchestrator.ts:1754 /api/bootstrap/tableau/session-status which drives a UI indicator); (2) content-rh-session.json (written by product-release-radar.ts, used for auth short-circuit). After wipe, /api/bootstrap/tableau/session-status will still report sessionValid:true until cookies fail at next probe. The _tableauStatusCache in bootstrap-orchestrator.ts also needs invalidation.
Solution: Extend clearSessionFiles() to also unlink TABLEAU_SESSION_PATH and CONTENT_RH_SESSION_PATH (pass their paths through initScraperManager or read from env). Invalidate _tableauStatusCache on reset (export a resetTableauStatusCache() from bootstrap-orchestrator.ts or add a reset hook).
Can we test: YES — after POST /api/setup/reset, GET /api/bootstrap/tableau/session-status should not return sessionValid:true from stale cache.


### BKL-UX-WIPE-CONN-RESET-03 | clearSessionFiles() silently swallows unlink errors — failed session reset undetectable
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook MED-02 scan 2026-05-02
Files: src/scraper-manager.ts (clearSessionFiles)
Description: Both `try { unlinkSync(...) } catch {}` calls use empty catch — EACCES, EBUSY, EROFS all swallowed silently. If unlink fails after a wipe, the connection status reset fails invisibly (user sees "wiped" but session lingers). Not exploitable but masks correctness-relevant failures.
Solution: Log on failure: `catch (e) { console.warn('[clearSessionFiles] failed to unlink RH session:', sanitizeErr(e)) }`. Optionally surface in the wipe API response.
Can we test: YES — inject a non-existent path constant and verify no throw; harder to test EACCES without mock.

### BKL-SYNC-L3-01 | L3 sync daemon — long-running headless pod data sync for primary Mac Mini
Status: ✅ DONE — 2026-04-30
Priority: P0
Size: M
Source: Session 2026-04-30 (Jason — primary should be headless sync daemon, no server needed; revised 2026-04-30 after Serena council review — ephemeral cron model rejected due to SSO TTL; revised to long-running daemon with internal scheduler)
Files: scripts/sync-l3-daemon.ts (new entrypoint ~120 lines), scripts/sync-pod-l3.ts (new per-run sync loop ~80 lines), src/sf-scraper.ts (runSfPodSync wrapper ~20 lines), Makefile (sync-up/sync-down/sync-logs/sync-status targets)
Description: Long-running daemon container (no HTTP server, no AEs, no GUI) that holds a warm Playwright browser context and runs two internal timers:
  Timer 1 — SSO keepalive every 2h: visits Tableau dashboard URL + SF report URL to prevent RH SSO cookie expiry (4–10h idle TTL makes ephemeral cron unworkable).
  Timer 2 — Daily sync at 5:30am ET: calls sync-pod-l3.ts logic, iterates all regions/pods, checks pod readiness (sfReportId set + Bookings GSheet present in podBookingsFolderId), scrapes CCSP via scrapePodCcspRaw(['{podKey}_TERR01'], folderId) and SF Pipeline via runSfPodSync(reportId, podKey, folderId). Writes sync-status.json to Drive after each run. Sends summary email to jhorn@redhat.com via existing email-sender.ts (Gmail API) with row counts per pod — one email per run regardless of outcome (success or failure, per-pod try/catch).
  Role-as-entrypoint: container CMD is `bun scripts/sync-l3-daemon.ts` — NODE_ROLE=primary stays as defense-in-depth guard inside per-scraper functions only.
  Volume: data-sync/ (separate from data/ and data-demo/) — holds Chromium profile, settings.json (regions/pods only, no AEs), OAuth token, sync-status staging, logs.
  Makefile targets: sync-up (long-running, restart=unless-stopped), sync-down, sync-logs, sync-status.
Acceptance: Daemon starts, keepalive pings Tableau every 2h without errors, sync runs at 5:30am ET and writes CCSP-{podKey}-{date}.csv + SF-PIPELINE-{id}-{podKey}-{date}.csv to Drive, sync-status.json updated, email received with row counts.
Can we test: YES — dry-run with DISALLOW_LIVE_SCRAPE=1 to verify settings.json iteration + readiness check logic; keepalive test by inspecting Tableau page visits in logs; integration test by checking Drive folder for today's files after a real run.
Depends on: BKL-SYNC-L3-02 shipped; Tableau + SF sessions active (BKL-SYNC-L3-04 for initial SSO setup); Google Drive auth present.
Decision: DONE — scripts/sync-l3-daemon.ts, scripts/sync-pod-l3.ts, runSfPodSync in sf-scraper.ts, Makefile sync-up/down/logs/status/up-vnc targets all shipped. Unit test bkl-sync-l3-01-daemon.test.ts: 15/15 pass. SYNC_NOW=true dry-run completed without crash, summary email sent. tsc clean on touched files.

### BKL-SYNC-L3-02 | Gate L4 schedulers at initBackgroundScheduler() startup + role-as-entrypoint
Status: ✅ DONE — 2026-04-30
Priority: P1
Size: S
Source: Session 2026-04-30 (hero installs must never start L4 scrape schedulers; revised 2026-04-30 after Serena council review — gate at scheduler startup not per-scraper, plus late-startup catch-up block)
Files: src/background-scheduler.ts, server.ts
Description: Gate all L4 scheduler paths at initBackgroundScheduler() startup using a single isPrimary predicate — not scattered per-scraper. Two changes:
  1. L3 reader paths (RH cases heartbeat, subs refresh, CCSP heartbeat, Drive watcher, KPI snapshot, email delivery) register only when !isPrimary (hero installs).
  2. L4 writer paths (territory sync, pipeline scheduled sync, CCSP scheduled sync) register only when isPrimary — transitional only until SYNC-L3-01 ships and is verified stable ≥1 week.
  3. Late-startup catch-up block (background-scheduler.ts lines 1198–1255) must also be gated behind isPrimary — currently fires pipeline catch-ups on every hero startup and throws.
  4. Per-scraper NODE_ROLE guards in ccsp-scraper.ts and sf-scraper.ts stay untouched as defense-in-depth.
  Note: In the new daemon model, the primary never calls initBackgroundScheduler() at all (its CMD is sync-l3-daemon.ts, not server.ts). The gate in server.ts is still needed for the transitional period and as future protection.
Acceptance: Hero install starts with zero L4 scheduler registrations and zero catch-up attempts. Late-startup catch-up block never fires on hero. Primary (if running server.ts) still registers L4 paths. Unit test verifies both branches.
Can we test: YES — unit test both isPrimary branches; grep confirms catch-up block is gated; Playwright smoke confirms hero starts cleanly without L4 errors in logs.
Depends on: None. Ship first.

### BKL-SYNC-L3-03 | Remove L4 schedulers + Refresh Timer from app (deferred)
Status: 🔄 DEFERRED
Priority: P2
Size: M
Source: Session 2026-04-30 (after sync script stable, clean up server)
Files: src/background-scheduler.ts, server.ts, dashboard/src/pages/SetupPage.tsx
Description: After BKL-SYNC-L3-01 has run in production for ≥1 week without issues: remove scheduleCcspSync, schedulePipelineSync from the server entirely; remove the Refresh Timer & Settings section from SetupPage.tsx (not just hide — delete). This is the final cleanup phase once the standalone script is the canonical L3 write path.
Acceptance: No L4 scrape schedulers in server. Refresh Timer section gone from all installs. No regressions in L3 read path.
Can we test: YES — grep confirms no scheduleCcspSync/schedulePipelineSync calls remain; Playwright confirms Refresh Timer section absent.
Depends on: BKL-SYNC-L3-01 stable in production ≥1 week.

### BKL-SYNC-L3-04 | One-time SSO setup playbook for primary sync daemon
Status: 🟡 IN PROGRESS
Priority: P1
Size: S
Source: Session 2026-04-30 (Serena council review — Mac Mini needs documented initial auth sequence before daemon can run autonomously)
Files: docs/HERO-INSTALL.md (new section), Makefile (sync-up-vnc target for one-time auth mode)
Description: Document and implement the one-time SSO bootstrap sequence for the Mac Mini sync daemon:
  1. Start sync container with VNC port exposed: make sync-up-vnc (adds -p 127.0.0.1:6082:6080 to sync-up)
  2. Open VNC at http://mini.local:6082
  3. Navigate to Tableau dashboard URL — complete RH SSO login (email autofill handles email field)
  4. Navigate to SF Lightning report URL — complete OAuth flow
  5. Verify keepalive log shows successful ping within 2h
  6. Redeploy without VNC: make sync-down && make sync-up
  Recovery path (when keepalive emails about SSO expiry): same sequence, step 1–4 only.
  Add HERO-INSTALL.md section: "Primary Node — Initial Auth Setup" with step-by-step runbook.
Acceptance: After following runbook, daemon runs keepalive without SSO errors for 24h. Recovery path documented and tested once.
Can we test: YES — keepalive logs show Tableau + SF URL visits succeeding for 24h without redirect to login page.
Depends on: BKL-SYNC-L3-01 shipped and running on Mac Mini.

### BKL-SYNC-L3-05 | Split container image: server (no Chromium) vs sync (with Chromium)
Status: 🔄 DEFERRED
Priority: P2
Size: L
Source: Session 2026-04-30 (Serena council review — hero installs need zero Playwright/Chromium; image split is the architectural payoff)
Files: Containerfile (or Dockerfile), Makefile, CI release pipeline
Description: Since hero installs run zero L4 scrapes and need no browser, the full ~1.4GB image (Chromium included) is wasteful. Split into two images:
  daily-brief-dashboard:server — no Chromium, no Playwright, ~600MB. Default for hero installs.
  daily-brief-dashboard:sync — full image with Chromium, ~1.4GB. Used only by Mac Mini sync daemon.
  Both built from same base; sync image adds Chromium layer on top.
  Most users never download Chromium. CI publishes both tags.
Acceptance: `make demo-up` and hero installs pull :server. `make sync-up` pulls :sync. Both function correctly. CI publishes both on release.
Can we test: YES — image size diff confirms Chromium absent from :server; scraper smoke tests confirm :sync can reach Tableau.
Depends on: BKL-SYNC-L3-03 shipped (L4 code removed from server) + SYNC-L3-01 stable ≥1 week.

### BKL-SYNC-L3-06 | checkBookingsGSheetExists pod key vs label naming mismatch — FIXED 2026-04-30
Status: ✅ DONE
Priority: P2
Size: S
Completed: 2026-04-30
Source: SYNC_NOW test run — all pods skipped despite subscription GSheets existing in Drive
Files: scripts/sync-pod-l3.ts — checkBookingsGSheetExists
Description: GSheet readiness check matched pod key (e.g. WEST_COMM_CORP_NORTHWEST) against sheet names, but real Drive sheets use human labels (e.g. "Northwest POD - Subscriptions"). All 5 pods skipped during SYNC_NOW test despite sheets existing. Fixed by also matching against pod label words (>3 chars) so "Northwest Corp" → "northwest" matches "Northwest POD - Subscriptions".
Fix: Updated checkBookingsGSheetExists to accept optional podLabel; added label-word fallback match at call site (pod.label passed).
Can we test: YES — updated bkl-sync-l3-01-daemon.test.ts unit tests cover this path.

---

## Architecture Deepening — Serena Audit 2026-05-01

Source: /improve-codebase-architecture explore run. Serena walked the full src/ and dashboard/src/ codebase. Candidates ordered by friction severity. None touch protected patterns (shared _ctx, no-auth, in-memory mutex, runtime config, sync daemon profile lock).

---

### BKL-ARCH-01 | Customer-name / folder-matching logic — replicated 5 times\nStatus: 🔵 IN PROGRESS
Priority: P1
Size: L
Source: Serena architecture audit 2026-05-01
Files: src/customer.ts, src/account-intelligence.ts, src/account-plan.ts, src/bootstrap-orchestrator.ts, src/sheets.ts::normalizeForMatch, src/customer-routes.ts
Description: Five normalizers and three near-identical fuzzyFindFolder/folderMatchScore/normalizeFolderName triplets. Each caller carries its own scoring and traversal. Comments like "differs from normalizeForMatch by..." document divergence rather than resolve it. A folder-matching bug must be patched in 3-4 places.
Solution: Extract a single CustomerFolderResolver module (one normalizer, one scorer, one BFS traverser) into src/lib/customer-name.ts. Collapses ~150 lines of duplicate logic.

---

### BKL-SEC-12 | customer-folder.ts throw messages include customer name/AE — leak risk
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (BKL-ARCH-01 session)
Files: src/lib/customer-folder.ts
Description: Two throw paths in findCustomerDriveFolder embed customer.name and customer.ae in the message text. Currently these errors are caught internally and never reach HTTP responses. But as a shared public export, any future caller that passes the error directly to c.json() without sanitizeErr would leak customer identity in a 500 response.
Solution: Replace customer.name/ae in throw messages with generic text, or add JSDoc warning that callers must wrap errors with sanitizeErr before returning to clients.

---

### BKL-SEC-13 | account-intelligence.ts intelligence cache slug uses strip-only pattern — missing throw guard
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (BKL-ARCH-01 session)
Files: src/account-intelligence.ts
Description: Intelligence cache path construction uses inline strip regex (not throw guard). Path traversal is blocked by the strip. But the pattern deviates from the Security Baseline (BKL-SEC-02 established that cache path functions must use resolve() + throw guard). An empty customerName would produce an empty slug and a malformed path like /cache/intelligence/.json — caught at FS layer but not explicitly.
Solution: Extract intelligenceCachePath(slug) function following the same guard pattern as briefCachePath in cache-layer.ts. Throw on empty or unsafe slug before constructing the path. Closes BKL-SEC-02 for this module.

---

### BKL-OPS-SMOKE-01 | make rebuild smoke check false-fails on healthy container — timing issue
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Rayford observation 2026-05-01 (fired on BKL-ARCH-06, BKL-ARCH-07, BKL-ARCH-01)
Files: Makefile
Description: The smoke check in make rebuild times out and exits 1 even when the container is healthy. Direct curl to /health returns {status: ok} within seconds of the smoke failure. Has fired 3 consecutive sessions. The health check likely needs a longer timeout or a retry loop.
Solution: Increase smoke check timeout or add retry loop (e.g. wait-for-it style: curl with --retry 10 --retry-delay 2). Confirm the fix by running make rebuild and verifying smoke passes cleanly.

---

### BKL-ARCH-02 | Scraper status — split across disk store + in-memory module variables
Status: ✅ DONE 2026-05-03
Priority: P1
Size: M
Source: Serena architecture audit 2026-05-01
Issue: hornjason/asaCommandCenter#18
Files: src/scraper-registry.ts (new), src/scraper-status-store.ts, src/rh-auth.ts, src/sf-auth.ts, src/ccsp-scraper.ts, src/supportable-scraper.ts, src/sf-scraper.ts, src/scraper-manager.ts, src/scrape-api.ts
Phase 1a commit: 6f8fb5cad — ScraperRegistry + UnifiedScraperStatus + all scraper registrations + adoption migrated to ScraperRegistry.adoptAll()
Phase 1b commit: 055ea8de1 — scraper-manager + scrape-api callers migrated to getUnifiedStatus(); 25 API tests pass, JSON byte-identical

---

### BKL-ARCH-03 | server.ts — 1,704 lines despite M02-M05 route extractions (ADR-005 violation)
Status: ✅ DONE 2026-05-01
Priority: P1
Size: M
Source: Serena architecture audit 2026-05-01
Files: server.ts (42 endpoints remain), all *-routes.ts files (flat registerXRoutes(app) pattern)
Description: ADR-005 prescribed sub-routers mounted via app.route(). Actual extraction used registerXRoutes(app) — flat registration against root app. server.ts still owns 42 endpoints across 5+ domains. Nothing constrains what URL prefix a module owns.
Solution: Convert all 16 *-routes.ts exports from registerXRoutes(app): void to createXRouter(): Hono factories. Mount via app.route('/', createXRouter()) — route paths inside modules unchanged. Two dep cases: createSettingsRouter({ rescheduleRefreshTimers }) and createRegionAccessRouter({ settingsPath }). init* functions stay separate. GitHub Issue: hornjason/asaCommandCenter#4
Commit: 398d840b0 — 16 modules converted, Quinn 103/107 pass, Rook PASS no new findings.

---

### BKL-ARCH-09 | Extract auth routes (RH + SF) from server.ts → auth-routes.ts
Status: ✅ DONE 2026-05-02 — src/auth-routes.ts created (221 lines). server.ts: 1712→1559 lines (−153). 25/25 Playwright pass, 7/7 smoke. Commit: 2a223ab1c.
Priority: P2
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Files: server.ts (lines ~260–636: 5 inline routes), new src/auth-routes.ts
Description: 5 auth routes remain inline in server.ts: GET/POST/DELETE /api/auth/redhat/* and POST/DELETE /api/auth/salesforce/*. All carry non-trivial handlers (60–250 lines each). Extracting to auth-routes.ts gives the auth domain a testable seam. Depends on BKL-ARCH-03 (sub-router pattern) being done first.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-10 | Extract AE management routes from server.ts → ae-routes.ts
Status: ✅ DONE 2026-05-02 — src/ae-routes.ts created (322 lines). server.ts: 1559→1061 (−498 total across 3 extractions). 25/1 Playwright pass. Quinn + Rook pending.
Priority: P2
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Issue: hornjason/asaCommandCenter#21
Files: server.ts (lines ~695–897: 3 inline routes), new src/ae-routes.ts
Description: GET /api/aes, POST /api/aes (100-line handler), POST /api/aes/validate-folder (98-line handler) remain inline. AE management is a distinct domain. Extraction gives it a testable seam. Depends on BKL-ARCH-03.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-11 | Consolidate settings/config inline routes into settings-api.ts
Status: ✅ DONE 2026-05-02 — 6 routes added to existing createSettingsRouter(). settings-api.ts: 556→728 lines (+172). 25/1 Playwright pass. Quinn + Rook pending.
Priority: P2
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Issue: hornjason/asaCommandCenter#22
Files: server.ts (lines ~898–1212: 6 inline routes), src/settings-api.ts
Description: 6 inline routes scattered through server.ts belong in settings-api.ts: /api/settings/from-drive, /api/config, /api/config/test, /api/env/gemini-model, GET+PUT /api/settings/email. These are already semantically owned by the settings domain — consolidation eliminates the split. Depends on BKL-ARCH-03.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-12 | Extract admin/monitoring/drive inline routes → admin-routes.ts
Status: ✅ DONE 2026-05-02 — src/admin-routes.ts created (127 lines). 8 routes extracted. 25/1 Playwright pass. Quinn + Rook pending.
Priority: P2
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Issue: hornjason/asaCommandCenter#24
Files: server.ts (8 inline routes), new src/admin-routes.ts
Description: 8 inline routes with no natural home: /api/status/telemetry, /api/status/telemetry/history, /api/admin/gemini-usage, /api/version, /api/drive-watcher/status, /api/drive-watcher/rebuild, /api/drive/ls/:folderId, /debug/sheet-tabs/:fileId. Grouping into admin-routes.ts clears ~200 lines of inline handlers from server.ts. Depends on BKL-ARCH-03.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-13 | Extract territory/pods/accounts inline routes → territory-routes.ts
Status: 🟡 IN PROGRESS
Priority: P3
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Files: server.ts (3 inline routes), new src/territory-routes.ts
Description: /api/territory/notifications, /api/pods, /api/accounts remain inline. Territory is already a concept in the domain (PODs, region access, AE config). Depends on BKL-ARCH-03.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-14 | Extract SSE/events inline routes → events-routes.ts
Status: 🟡 IN PROGRESS
Priority: P2
Size: S
Source: BKL-ARCH-03 grilling — Job B inline extraction 2026-05-01
Files: server.ts (lines ~1275–1337+: 3 SSE routes), new src/events-routes.ts
Description: /events, /api/ingest/events, /api/ai/events are all SSE (server-sent events) streams with large inline handlers. Extracting to events-routes.ts isolates the SSE pattern, gives it a seam, and removes ~200 lines from server.ts. Depends on BKL-ARCH-03.
Depends on: BKL-ARCH-03

---

### BKL-ARCH-04 | SetupPage.tsx — 4,171-line wizard with embedded sub-components and polling
Status: 🟡 IN PROGRESS
Priority: P2
Size: XL
Source: Serena architecture audit 2026-05-01
Files: dashboard/src/pages/SetupPage.tsx (4,171 lines)
Description: Six wizard steps, four polling hooks, AutoBootstrapForm, AEsCustomersSection, DataSourcesSection — all in one file. Components defined here have no test surface; they cannot be rendered without the full Setup context.
Solution: Extract each step (Step0–Step6, DataSources, AE/Customer config) to its own component file with explicit props. Each becomes individually testable. Quinn can audit one step at a time.

---

### BKL-ARCH-05 | Polling lifecycle — hand-rolled in 5 components, no usePolledStatus seam
Status: ✅ DONE 2026-05-01
Priority: P2
Size: M
Source: Serena architecture audit 2026-05-01
Files: dashboard/src/components/AccountIntelligencePanel.tsx, AccountPlanPanel.tsx, SessionHealthPanel.tsx, dashboard/src/pages/AdminPage.tsx, SetupPage.tsx
Description: Each component hand-rolls the same lifecycle: useRef<setInterval>, fetch-on-mount, start-on-running, stop-on-terminal, clear-on-unmount, abort controller. The cleanup bug (pollRef.current = null forgotten) exists in at least one copy.
Solution: Extract usePolledStatus(url, { intervalMs, until }) hook. Absorbs all five. Lifecycle bug fixed once, everywhere.

---

### BKL-ARCH-06 | Atomic file write — tmp + renameSync pattern replicated ~20 times
Status: 🟡 IN PROGRESS
Priority: P1
Size: S
Source: Serena architecture audit 2026-05-01
Files: src/account-intelligence.ts, src/backup-config.ts, src/bootstrap-history.ts, src/background-scheduler.ts, src/bootstrap-orchestrator.ts, src/customer-routes.ts, src/drive-sources.ts, src/kpi-history.ts, src/region-access-routes.ts, src/restore-routes.ts (only site with named helper), src/server-state.ts, src/sync-state.ts
Description: ADR-002 mandates .tmp + atomic rename for all config writes. 20 call sites hand-roll it. Only restore-routes.ts::atomicWriteJSON extracts it but doesn't export it. Variants drift: some set mode: 0o600, some don't; some catch errors, some don't.
Solution: Export atomicWriteJson(path, data, { mode }) from src/lib/atomic-write.ts. Makes ADR-002 a type-level guarantee. New config files can't accidentally skip the .tmp step.

---

### BKL-ARCH-07 | Drive folder traversal — 5 hand-rolled BFS implementations
Status: ✅ DONE 2026-05-01
Priority: P1
Size: L
Source: Serena architecture audit 2026-05-01
Files: src/sheets.ts, src/account-intelligence.ts, src/account-plan.ts, src/bootstrap-orchestrator.ts, src/sf-bookings-reader.ts
Description: Every Drive operation reimplements drive.files.list with q=..., page-size handling, optional shortcut following, optional descent, optional TTL cache. Some honor supportsAllDrives: true, some don't. The inconsistency is the class of bug that causes Drive discovery gaps.
Decision: DONE — src/lib/drive-client.ts created with 5-method singleton (findDescendantFolder, ensureChildFolder, listSpreadsheetsUnder, listFilesUnder, findSheetByName). 5 callers migrated. ADR-0016 enforced (supportsAllDrives always-on). Pagination handled internally. 14 unit tests. customer.ts not migrated — see BKL-ARCH-07b. GitHub issue #2 closed.

### BKL-ARCH-07b | customer.ts BFS — followFolderShortcuts not yet in DriveFolderClient
Status: 🟡 IN PROGRESS
Priority: P2
Size: S
Source: Marcus BKL-ARCH-07 implementation 2026-05-01
Files: src/customer.ts (BFS file collection), src/lib/drive-client.ts (listFilesUnder)
Description: customer.ts BFS (account intelligence file collection) follows folder-shortcuts — when a shortcut pointing to a folder is found, its target is enqueued at the same depth as a real subfolder (BKL-DRIVE-01). listFilesUnder in drive-client.ts does not yet support this. Migrating customer.ts without this option would silently drop files reachable only via folder-shortcuts.
Solution: Add followFolderShortcuts option to listFilesUnder (default false). Then migrate customer.ts BFS to driveClient.listFilesUnder({ followFolderShortcuts: true, maxFiles, modifiedAfter, maxDepth }).

### BKL-ARCH-07c | account-intelligence + account-plan doc upsert Drive calls not migrated
Status: 🟡 IN PROGRESS
Priority: P3
Size: S
Source: Marcus BKL-ARCH-07 implementation 2026-05-01
Files: src/account-intelligence.ts (findIntelligenceSubfolder, upsertIntelligenceDoc), src/account-plan.ts (upsertAccountPlanDoc)
Description: Several Drive call sites in account-intelligence and account-plan handle Doc creation/upsert, not folder traversal. They were out of scope for BKL-ARCH-07 but are candidates for follow-up consolidation into drive-client.ts (e.g. findDocByName, upsertDoc methods).
Solution: Evaluate whether Doc upsert operations are common enough to warrant module methods. Low priority — these use supportsAllDrives correctly already.

---

### BKL-ARCH-08 | bootstrap-orchestrator.ts — 2,695 lines holding 4 orthogonal concerns
Status: ✅ DONE 2026-05-01
Priority: P2
Size: XL
Source: Serena architecture audit 2026-05-01
Files: src/bootstrap-orchestrator.ts, src/bootstrap-state.ts (NEW), src/lib/cache-hierarchy.ts (NEW)
Description: One file holds: bootstrap state machine, step-by-step orchestration (Steps 1-6), Drive cache hierarchy (L1/L2/L3 freshness), SF/CCSP per-AE pipeline writes, Tableau session login, settings.json scaffolding, and re-implementations of helpers that exist elsewhere. ADR-005's 500-line cap is violated 5x. No isolated test surface.
Solution: Split into bootstrap-state.ts (state machine + shared types) and cache-hierarchy.ts (L1/L2/L3 freshness). Option B (container-object mutation) resolved TypeScript export let reassignment constraint. 13 unit tests, Playwright API 25/0 on 7776.

### BKL-SEC-CACHE-HIER-LOG-01 | cache-hierarchy.ts logs raw Sheet ID in catch block
Status: 🔵 OPEN
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (BKL-ARCH-08 review)
Files: src/lib/cache-hierarchy.ts:229
Description: catch block logs raw `supportableSheetId` (a Drive capability token). Low severity — localhost-only app, no external log sink. But deviates from project log hygiene pattern.
Solution: Truncate to last 6 chars: `...${supportableSheetId.slice(-6)}` for consistency with sanitizeErr usage pattern.

---

### BKL-CCSP-RETRY-01 | CCSP scraper retry logic with exponential backoff
Status: 🟡 IN PROGRESS
Priority: P1
Size: M
Source: Council debate 2026-05-01 (Serena + Marcus + Ava)
Files: scripts/sync-pod-l3.ts (lines 312-320 — CCSP call site), src/ccsp-scraper.ts (peekTableauSessionExpired export)
Description: CCSP scrape fails silently on transient Tableau viz-not-ready and on auth expiry with no retry. Today's sync: all 5 PODs failed with "CSV download failed: Timeout 60000ms exceeded". Last good CCSP data Apr 29.
Solution (council-designed):
  - Add withCcspRetry() wrapper in sync-pod-l3.ts wrapping scrapePodCcspRaw() call
  - 3 retries max, exponential backoff: 120s / 300s / 600s
  - Tear down + rebuild browser context on every retry attempt
  - On each failure: check peekTableauSessionExpired() → if true, throw typed AUTH_EXPIRED error immediately (no retry)
  - AUTH_EXPIRED caught at sync-pod-l3 loop → emit dashboard notification → break (halt all remaining PODs — auth is shared session state)
  - Transient failures retry independently per POD (POD-isolated)
  - Suppress failure email on intermediate retries; fire only after full exhaustion
  - AUTH_EXPIRED fires immediate email/notification (requires manual re-auth)
  - Write retry_in_progress { attempt, next_retry_at } to sync-status.json during retries
  - On success after retry: write recovered: true to sync-status.json for audit trail
  - viz-ready gate (waitForVizReady) stays inside scrapePodCcspRaw — already covered, no change needed

---

### BKL-CCSP-RETRY-02 | Keepalive too shallow — home page nav doesn't prove viz session works
Status: 🟡 IN PROGRESS
Priority: P1
Size: S
Source: Diagnosis 2026-05-01
Files: scripts/sync-l3-daemon.ts (doKeepalive function ~line 62)
Description: doKeepalive() navigates to Tableau home page and checks the final URL for signin/auth redirect. But Tableau can serve the home page with stale cookies without redirecting — the MFA wall only appears when accessing viz endpoints. So keepalive passes while scraping fails. Need to check for login form presence on the page after navigation.
Solution: After navigating to Tableau in doKeepalive(), check for login form (input[type=password], input#username) — same check scrapeOneAe uses. If found, throw with auth-expired message so the keepalive failure email fires with a clear "Tableau auth expired" subject.

---

### BKL-CCSP-RETRY-03 | Viz timeout bypasses auth detection — CSV download timeout doesn't set _tableauSessionExpired
Status: 🟡 IN PROGRESS
Priority: P1
Size: S
Source: Diagnosis 2026-05-01
Files: src/ccsp-scraper.ts (scrapePodCcspRaw ~line 1155)
Description: In the POD pre-scrape path, when the viz doesn't load in 45s and the CSV download times out, the code logs a warning and returns 0 rows. The _tableauSessionExpired flag is never checked or set on this code path. The login detection only runs in scrapeOneAe (the per-AE path), not in scrapePodCcspRaw. So a timeout caused by auth expiry is invisible to the retry wrapper's auth check.
Solution: After CSV download fails in scrapePodCcspRaw, check the current page URL and login form presence. If login form detected, call the internal setter to mark _tableauSessionExpired = true before throwing. The withCcspRetry wrapper in sync-pod-l3.ts will then catch it as AUTH_EXPIRED.

---

### BKL-ARCH-21 | wizard-e2e test-13 pre-existing failure — "Red Hat Connection" accordion not visible
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Marcus #12 — confirmed via git stash pre/post; Quinn confirmed on prod 2026-05-02
Files: test/wizard-e2e.spec.ts (test-13), dashboard/src/pages/SetupPage.tsx
Description: wizard-e2e test-13 "expanding Connections shows Red Hat Connection section" fails on main. The test clicks the Step 3 accordion button and expects `page.locator('[data-testid="hero-step3-summary"]')` to be visible. The accordion button may not be rendering as expected in the test environment, or the test ID is mismatched. Fails identically before and after the DataSourcesSection deletion — not caused by recent changes. Causes 16 downstream wizard-e2e tests to be skipped due to serial cascade.
Solution: Read the current Step 3 accordion markup in SetupPage.tsx, confirm the data-testid attribute exists on the expected element, update the test selector if it drifted. Run wizard-e2e against 7776 to confirm fix.
Decision: Root cause was threefold — (1) test assertion checked for "Red Hat Connection" text but summary-mode renders "Red Hat Token Configured"; (2) the 7778 seeded server was running from a stale agent worktree with April 28 bundle (before HeroStep3Connections was added); (3) stale visual baseline snapshots. Fix: updated test 13 to use data-testid CSS selector covering both form and summary states; rebuilt dashboard bundle and restarted 7778 from project root with seed config; updated visual baselines. All 29 wizard-e2e tests now pass.

---

### BKL-ARCH-18 | cache-layer.ts — invalidateBriefCaches is unexported dead function
Status: OPEN
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (issue #13 cleanup)
Files: src/cache-layer.ts
Description: invalidateBriefCaches export was removed in issue #13 (zero callers). The function body was left in place as an unexported dead function. drive-watcher.ts referenced it in comments only, never imported it. Should be deleted entirely.
Solution: Delete the invalidateBriefCaches function body from cache-layer.ts. Confirm zero callers with grep before deleting.

---

### BKL-ARCH-19 | REG-TOKEN-10 stale anchor — app.post vs router.post
Status: ✅ DONE 2026-05-02 — Updated anchor string + nextRoute delimiter from `app.` to `router.`; 23/3 e2e-tier pass (3 failures pre-existing).
Priority: P3
Size: XS
Source: Marcus #14 investigation 2026-05-02
Files: test/regression/cache.spec.ts (~line 359)
Description: REG-TOKEN-10 searches for `app.post('/api/bootstrap/auto'` but the source uses `router.post('/api/bootstrap/auto'` since the Hono route extraction (BKL-ARCH-03). Test has been failing since that refactor.
Solution: Update the anchor string from `app.post(` to `router.post(` in the REG-TOKEN-10 test block.

---

### BKL-ARCH-20 | AutoBootstrapStep status union missing 'cancelled'
Status: ✅ DONE 2026-05-02 — Added 'cancelled' to union in src/bootstrap-state.ts:29.
Priority: P2
Size: XS
Source: Marcus #14 investigation 2026-05-02
Files: src/bootstrap-orchestrator.ts (~line 1338)
Description: Cancel path sets `step.status = 'cancelled'` but the `AutoBootstrapStep['status']` union type does not include `'cancelled'`. TS2322 type error. Possibly intentional per BKL-WIZ-02 but union must be widened to match runtime behavior.
Solution: Add `'cancelled'` to the AutoBootstrapStep status union type in its definition.

### BKL-ARCH-13 | Pre-existing tsc errors (42) in unrelated files masking new breakage
Status: OPEN
Priority: P3
Size: M
Source: Marcus #15 step-1 investigation 2026-05-02
Files: src/settings-api.ts (Partial<T>|{} index errors), src/setup-routes.ts (unsafe Customer cast ~line 546), src/sheet-import.ts (Record→typed assignment ~line 45), src/supportable-scraper.ts (GaxiosResponse→void ~line 1252+)
Description: 42 pre-existing TypeScript errors exist across 4 unrelated files. These mask any new tsc breakage introduced by PRs. `npx tsc --noEmit` is unreliable as a gate until these are cleared.
Solution: Fix each file independently; aim to get tsc clean so it can be a real CI gate.

### BKL-ARCH-14 | filterCcspRowsForAe (line ~1268) missing quarter filter; candidate for delegation to filterRowsForAe
Status: OPEN
Priority: P3
Size: XS
Source: Marcus #15 step-1 investigation 2026-05-02
Files: src/ccsp-scraper.ts (~line 1268)
Description: The exported `filterCcspRowsForAe` convenience wrapper does territory filtering only — no quarter filter. Used externally (likely from scrapePodCcspRaw callers). Once step-4 of #15 ships and filterRowsForAe is stable, this wrapper can optionally take a `quarters` param and delegate. Out of scope for #15.
Solution: Evaluate after #15 completes; may be a 3-line update.

### BKL-ARCH-15 | test/unit/ingest-bug04-bearer-records-success.test.ts — intermittent failure in full suite
Status: OPEN
Priority: P3
Size: S
Source: Marcus #15 step-1 investigation 2026-05-02
Files: test/unit/ingest-bug04-bearer-records-success.test.ts
Description: Test fails with "Export named 'recordSessionEstablished' not found in module 'src/settings-api.ts'" when run as part of `bun test test/unit/` — passes in isolation. Likely a Bun module cache + file-load-order interaction with settings-api.ts re-exports.
Solution: Investigate module resolution order; may need a re-export fix in settings-api.ts or test isolation.

### BKL-ARCH-17 | scrapePodCcspRaw duplicates URL-build/navigation/CSV logic now in ccsp-tableau-fetch.ts
Status: OPEN
Priority: P3
Size: S
Source: Marcus #15 step-3 investigation 2026-05-02
Files: src/ccsp-scraper.ts (scrapePodCcspRaw function), src/ccsp-tableau-fetch.ts (fetchPodCsv)
Description: `scrapePodCcspRaw` (out of scope for #15) still contains the original URL-build, page.goto, viz-wait, and CSV-download logic that is now also in `fetchPodCsv`. Also duplicates `findEl`, `waitForVizReady`, `dumpDom` helpers. Out of scope for #15 per brief.
Solution: Route `scrapePodCcspRaw` through `fetchPodCsv` to eliminate duplicate helpers and URL-build code. Dependent on #15 step-4 completion.

### BKL-ARCH-16 | regression.spec.ts test-ordering pollution — REG-001 and REG-024 fail in full suite, pass in isolation
Status: OPEN
Priority: P2
Size: M
Source: DA #15 step-1 Playwright gate 2026-05-02
Files: test/regression.spec.ts (REG-001 line 82, REG-024 line 814)
Description: REG-001 ("tableauTerritories preserved after round-trip save") and REG-024 ("identifyIndustry for no-account customers") both pass in isolation but fail when the full regression suite runs concurrently (2 workers). Earlier @destructive tests corrupt AE/customer state before these tests execute. Confirmed pre-existing on main (before any #15 changes).
Solution: Add snapshot/restore guards to REG-001 and REG-024, or run them in a serial group. REG-001 is straightforward — it just needs its own beforeEach snapshot. REG-024 is a @live test that triggers a long intelligence pipeline; may need its own dedicated suite file with serial execution.

---

### BKL-ARCH-L4-SPLIT-FOLLOWUP-01 | SetupPage.tsx — Tableau URL/territory inputs still render in AE config form
Status: ✅ DONE 2026-05-02
Priority: P1
Size: S
Source: Quinn gate 2026-05-01 (post-rebuild for issue #7)
Files: dashboard/src/pages/SetupPage.tsx (lines 2014, 2153, 2293–2314)
Description: Marcus removed Tableau from the bootstrap progress UI but not from the AE config step. Still rendering unconditionally: (1) "Tableau is not connected" warning (line 2014), (2) Tableau URL input (line 2153), (3) Tableau territory input (lines 2293–2314). Hero install wizard must show zero Tableau content.
Solution: Remove or gate behind isPrimary. Acceptance: wizard-e2e Tableau-zero assertion passes (0 occurrences in rendered DOM).
Can we test: YES — test/wizard-e2e.spec.ts line 287 asserts toBe(0).
Decision: Verified via code grep and passing wizard-e2e test 22 — no visible "Tableau" text in current SetupPage.tsx JSX. The tableauUrl field exists in AE form state but the label says "Territory (optional)" not "Tableau". Items that Quinn logged in May 2026-05-01 were already resolved by issue #7 — the stale 7778 server (running April 28 bundle) was causing false positives.

---

### BKL-ARCH-L4-SPLIT-FOLLOWUP-02 | SetupPage.tsx — VNC popup buttons still render in wizard
Status: ✅ DONE 2026-05-02
Priority: P1
Size: S
Source: Quinn gate 2026-05-01 (post-rebuild for issue #7)
Files: dashboard/src/pages/SetupPage.tsx (lines 2532, 2540, 2840)
Description: "Open VNC" and "Open VNC Login" buttons still rendered; window.open(..., 'rh-vnc'/'sf-vnc'/'tableau-vnc') calls present. Hero install must not surface VNC.
Solution: Remove or gate behind isPrimary. Acceptance: wizard-e2e VNC-zero assertion passes.
Can we test: YES — test/wizard-e2e.spec.ts line 310 asserts toBe(0).
Decision: Verified via code grep and passing wizard-e2e test 23 — no visible "VNC" text in current wizard DOM. VNC references in SetupPage.tsx are inside handler functions and comments, not rendered as button labels. The stale 7778 server (April 28 bundle) had old DataSourcesSection with VNC content — fixed by rebuilding and restarting 7778.

---

### BKL-ARCH-L4-SPLIT-FOLLOWUP-03 | Prod container running NODE_ROLE=primary — should be unset for hero install
Status: ✅ DONE 2026-05-02
Priority: P2
Size: S
Source: Quinn gate 2026-05-01
Files: .env (line 18 removed)
Description: pai-dashboard prod container had NODE_ROLE=primary in .env, routing it to L4 leader behavior.
Decision: Commented out NODE_ROLE=primary from .env; container now starts with NODE_ROLE unset (hero install).
Verified: /api/node-role returns {"isL3Only":true} on local prod after restart.

---

### BKL-WIZARD-E2E-01 | wizard-e2e.spec.ts ships unconditional failing assertions while issue #7 is incomplete
Status: ✅ DONE 2026-05-02
Priority: P1
Size: S
Source: Quinn gate 2026-05-01
Files: test/wizard-e2e.spec.ts (lines 281–310)
Description: Spec has a comment noting Tableau/VNC removal is blocked on issue #7, but assertions (expect(tableauCount).toBe(0), expect(vncCount).toBe(0)) are NOT skipped. CI wizard-e2e job will fail on push with current bundle.
Solution: Ship FOLLOWUP-01+02 first (preferred). Alternatively add test.skip() until they land. Keep CI honest.
Can we test: YES — npx playwright test test/wizard-e2e.spec.ts --project=wizard-e2e against 7776.
Decision: All 29 wizard-e2e tests now pass. Tests 22-24 (Tableau/VNC zero guards) pass — they were blocked by the BKL-ARCH-09 cascade (serial mode). Fixed by resolving BKL-ARCH-09 and rebuilding the 7778 seeded server with current bundle.

---

### BKL-SEC-14 | l3-bootstrap.ts — aeName and customerNames not validated before Drive folder creation
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (issue #7 review)
Files: src/l3-bootstrap.ts:102
Description: bootstrapAe() passes aeName and customerNames directly into driveClient.createFolder with no length/control-char guard. Today's only caller derives these from validated AE config — not currently exploitable. Defense-in-depth guard needed for future callers.
Solution: Guard inside bootstrapAe: if (!aeName || aeName.length > 200 || /[\x00-\x1f]/.test(aeName)) throw. Same for customerNames[i].
Can we test: YES — unit test in test/unit/l3-bootstrap.test.ts.

---

### BKL-SEC-15 | setup-routes.ts — OAuth token write missing mkdirSync guard on parent directory
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (issue #7 review)
Files: src/setup-routes.ts:218-220
Description: /oauth/callback handler writes token with correct 0o600 mode but assumes parent dir exists. Unlike upload-oauth-keys handler (line 332-333) which calls mkdirSync first, callback path could fail silently on fresh install or after full reset that wipes /data/config.
Solution: Add mkdirSync(dirname(GOOGLE_UNIFIED_TOKEN_PATH), { recursive: true }) before the write. Mirror pattern on line 332.
Can we test: YES — unit test simulating missing parent dir.

---

### BKL-SEC-16 | ci.yml — github.token interpolated into shell command line rather than env-var pattern
Status: ✅ DONE 2026-05-02
Priority: P3
Size: S
Source: Rook scan 2026-05-01 (issue #8 review)
Files: .github/workflows/ci.yml:98,125
Description: Token interpolated directly into shell command line. Low risk (GitHub masks it), but inconsistent with release.yml:114 which already uses the safer env: DEPLOY_TOKEN pattern.
Solution: env: GH_TOKEN: ${{ github.token }} then echo "$GH_TOKEN" | podman login.
Can we test: YES — CI run shows no token in logs.

---

### BKL-SEC-17 | setup-routes.ts — SNAPSHOT_PATH write lacks mkdirSync guard
Status: ✅ DONE 2026-05-02
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (BKL-SEC-16 pattern sibling)
Files: src/setup-routes.ts:580
Description: writeFileSyncRaw(SNAPSHOT_PATH, ...) at line 580 has no mkdirSync guard. SNAPSHOT_PATH = resolve(dirname(AES_PATH), '__test_snapshot.json') — relies on dirname(AES_PATH) existing. In a fresh container or wiped config dir this would throw ENOENT. Same defect class as BKL-SEC-15 (now fixed).
Solution: Add mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true }) before the write, same pattern as line 220.
Can we test: YES — unit test simulating missing parent dir.

---

### BKL-SEC-18 | bootstrap-orchestrator.ts — OAUTH_STATE_PATH write lacks mkdirSync guard
Status: ✅ DONE 2026-05-02
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (BKL-SEC-16 pattern sibling)
Files: src/bootstrap-orchestrator.ts:950
Description: writeFileSync(OAUTH_STATE_PATH, ...) at line 950 lacks a preceding mkdirSync guard. OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json'). Same defect class as BKL-SEC-15.
Solution: Add mkdirSync(dirname(OAUTH_STATE_PATH), { recursive: true }) before the write.
Can we test: YES — unit test simulating missing parent dir.

---

### BKL-ARCH-22 | Issue #16 — Bootstrap orchestrator split (territory-sheet, sf-cache, bootstrap-routes)
Status: ✅ DONE 2026-05-02
Priority: P1
Size: M
Source: Issue #16 (hornjason/asaCommandCenter)
Files: src/bootstrap/territory-sheet.ts (new, 225 lines), src/bootstrap/sf-cache.ts (new, 120 lines), src/bootstrap-routes.ts (new, 11-line re-export), src/bootstrap-orchestrator.ts (2306→2021 lines), test/unit/territory-sheet.spec.ts (new)
Description: Split 2306-line bootstrap-orchestrator.ts (ADR-005 500-line cap violation) into focused modules. Extracted: synthesizeSfReportFromPipelineRecords, podKeyFromTerritoryCode, readAEsFromTerritorySheet → territory-sheet.ts; writeSfDriveCache, readSfDriveCache → sf-cache.ts; createBootstrapRouter re-exported via bootstrap-routes.ts.
Decision: createBootstrapRouter body (1258 lines) could not be extracted without major refactor due to closure captures — thin re-export shim used for bootstrap-routes.ts. Remaining orchestrator body still 2021 lines; full route extraction deferred to follow-on issue.
Tests: bun test test/unit/territory-sheet.spec.ts — 4/4 pass. Playwright 115/125 (10 pre-existing failures, 0 regressions).

---

### BKL-SCRAPER-DEAD-01 | Dead endpoint /api/auth/supportable/check in scraper-manager.ts
Status: 🟡 IN PROGRESS
Priority: P3
Size: XS
Source: BKL-SEC-SUPPORTABLE-02 cleanup 2026-05-02
Files: src/scraper-manager.ts (line 913)
Description: /api/auth/supportable/check is a dead route — no frontend code calls it. VPN reachability probe that was used by the old Supportable connection panel (removed). The endpoint itself is in the protected scraper-manager.ts file.
Solution: Remove the route handler at scraper-manager.ts:912-930 (approx). Requires explicit Jason sign-off before touching scraper-manager.ts per SCRAPER-RULES.md.
Can we test: YES — verify endpoint returns 404 after removal.

---

### BKL-BUILD-WORKTREE-PRUNE-01 | Stale git worktrees accumulate node_modules blocking container builds
Status: ✅ DONE 2026-05-02
Priority: P2
Size: XS
Source: 2026-05-02 — make build failed with "no space left on device" writing worktree node_modules to container overlay
Files: Makefile (build target), Dockerfile.hero.dockerignore (new)
Description: Git worktrees from prior agent runs accumulate at .claude/worktrees/ with full node_modules (1GB+). When podman copies these into the container overlay during `COPY . .`, the overlay layer fills up and the build fails. Two fixes applied: (1) created Dockerfile.hero.dockerignore matching .dockerignore to ensure podman excludes .claude/ when -f Dockerfile.hero is specified; (2) manually pruned 20 stale worktrees. But the root issue recurs if worktrees accumulate again. Fix: add `git worktree prune` or force-remove stale worktrees to Makefile `build` target pre-check. Or add periodic worktree cleanup script.
Can we test: YES — verify make build succeeds after worktrees exceed 500MB.

### BKL-SEC-19 | bootstrap-orchestrator.ts — writeScaffoldCache missing isValidDriveFolderId guard
Status: 🟡 IN PROGRESS
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (BKL-DRIVE-SCAFFOLD-CACHE-01 post-ship review)
Issue: hornjason/asaCommandCenter#9 (XS — stays in BACKLOG.md, not promoted)
Files: src/bootstrap-orchestrator.ts (writeScaffoldCache, readScaffoldCache)
Description: writeScaffoldCache(parentFolderId, entry) writes parentFolderId directly as a JSON key without validation. isValidDriveFolderId() already exists in utils.ts. Add guard at function entry. Also validate entry.configFolderId and entry.productsFolderId with the same helper. readScaffoldCache lookup should similarly validate the key before returning entry.
Can we test: YES — unit test: writeScaffoldCache with invalid parentFolderId should silently skip write; readScaffoldCache with invalid key should return undefined.

### BKL-SEC-20 | admin-routes.ts — /api/drive/ls/:folderId accepts unvalidated path parameter
Status: 🟡 IN PROGRESS
Priority: P2
Size: XS
Source: Rook scan 2026-05-02 (BKL-ARCH-12 post-ship review)
Files: src/admin-routes.ts:90-106
Description: `folderId` from c.req.param('folderId') is interpolated into the Drive API query `q: \`'${folderId}' in parents...\`` with no validation. `isValidDriveFolderId()` exists in utils.ts and is used elsewhere but not here. A caller could inject Drive query operators. Bounded by single-user localhost architecture. Carry-over from server.ts — extraction did not introduce the gap.
Solution: Add `if (!isValidDriveFolderId(folderId)) return c.json({ error: 'Invalid folder ID' }, 400)` at handler entry. Import `isValidDriveFolderId` from `./utils.ts`.
Can we test: YES — regression test: GET /api/drive/ls/invalid!folder returns 400.

### BKL-SEC-21 | admin-routes.ts — /api/drive-watcher/rebuild lacks NODE_ROLE guard (advisory)
Status: 🟡 IN PROGRESS
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (BKL-ARCH-12 post-ship review)
Files: src/admin-routes.ts:79-87
Description: POST /api/drive-watcher/rebuild is available on hero nodes (NODE_ROLE unset). On hero, calling it attempts to rebuild the in-memory folder map — no destructive write, but architecturally inconsistent with other L4-writer surfaces that guard behind NODE_ROLE=primary. Advisory — requires product decision before adding guard.
Solution: If hero nodes should not trigger Drive folder rebuilds: add `if (process.env.NODE_ROLE !== 'primary') return c.json({ error: 'Not available on hero nodes' }, 404)`. Decision required.
Can we test: YES after decision — regression test that 7776 (hero image) returns 404 on POST /api/drive-watcher/rebuild.

### BKL-SEC-22 | settings-api.ts — /api/settings/email PUT recipientEmail lacks length cap
Status: 🟡 IN PROGRESS
Priority: P3
Size: XS
Source: Rook scan 2026-05-02 (BKL-ARCH-11 post-ship review)
Files: src/settings-api.ts (~line 702)
Description: Email validation regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` has no length bound. A caller could store a multi-MB string in email-settings.json. RFC 5321 §4.5.3.1.3 caps email address at 254 chars.
Solution: Add `if (body.recipientEmail.length > 254) return c.json({ error: 'Email exceeds RFC 5321 maximum (254 chars)' }, 400)` before regex test.
Can we test: YES — regression test: PUT /api/settings/email with 255-char email returns 400.

### BKL-PROCESS-01 | Child issue promotion at parent issue close — external traceability
Status: ✅ DONE 2026-05-02
Priority: P2
Size: M
Source: Jason design discussion 2026-05-02 — closing the loop between GitHub issues and mid-implementation BKL discoveries
Files: ~/.claude/skills/dev-loop/SKILL.md, ~/.claude/CLAUDE.md
Description: When working a GitHub issue, mid-implementation discoveries (Rook findings, debt, spin-off work) land in BACKLOG.md only. The parent GitHub issue has no visibility into what it spawned. Fix: add a close-gate step to the dev loop — before closing a parent issue, sort open BKL items tagged with `Issue: #N` by size: XS stays in BACKLOG.md with a reference, S+ gets promoted to a child GitHub issue via /triage with a full agent brief (including context from the parent thread). Parent issue closes with a findings comment listing child issue numbers and any XS BACKLOG.md references. Child issues include `Parent: #N` in body so GitHub creates the "mentioned in" graph. Adds `Issue: #N` as a standard BACKLOG.md field convention for items that originate from GitHub issue work.

Acceptance criteria:
- [x] `Issue: #N` field added as a convention in BACKLOG.md item template — all 9 promoted items updated 2026-05-02
- [x] dev-loop SKILL.md updated with close-gate step (Step 12) — scan for open BKL items with `Issue: #N`, sort XS vs S+, promote S+ via /triage 2026-05-02
- [x] /triage agent brief template updated with `Parent issue context` section — ~/.claude/skills/triage/AGENT-BRIEF.md updated 2026-05-02
- [x] Parent issue close comment format documented and used — first run on issue #9 (2026-05-02): 8 child issues created (#18–#26 except #19), findings comment posted, BACKLOG.md entries updated with Issue: #N fields
- [x] At least one real close cycle tested end-to-end — issue #9 first run complete 2026-05-02

Can we test: YES — close a real parent issue with mixed XS/S+ spin-offs and verify child issues appear in GitHub with correct agent briefs and parent links.

---

### BKL-ARCH-23 | Brief pipeline — decompose buildXmlSources into per-source signal modules
Status: ✅ DONE 2026-05-03
Priority: P1
Size: M
Source: GitHub issue #11 — child of #9 (architecture deepening)
Issue: hornjason/asaCommandCenter#11
Files: src/customer.ts (modified -560 lines net), src/customer/signals/{types,xml-utils,cases,pipeline,ccsp,meetings,emails,docs,subscriptions,failed-sources,extras}.ts (new), src/customer/docs-fetcher.ts (new)
Commit: 3234bc504
Description: buildXmlSources decomposed from 296-line monolith to ~108-line composition. SignalBundle discriminated union, collect()+render() pattern per source. Golden-file test guarantees byte-identical XML output. 41 new unit tests pass. docs-fetcher extracted with 9 unit tests on pure folder-matching helpers.
