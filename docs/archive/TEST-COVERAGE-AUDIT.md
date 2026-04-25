<!-- Status: Operational | Last validated: 2026-04-18 | Trigger: BKL-TEST-P2-03 close -->

# Test Coverage Audit — DailyBriefDashboard

**Generated:** 2026-04-18  
**Trigger:** BKL-TEST-P2-03 (council audit after BKL-RH-03 Phase 2 ship)  
**Auditor:** Explore agent + DA synthesis

---

## Coverage Summary

| Category | Total Endpoints | Well Tested | Partial | Untested |
|---|---|---|---|---|
| Core API (health, AEs, customers) | ~30 | 22 | 5 | 3 |
| Auth (RH, SF, Tableau) | ~15 | 8 | 4 | 3 |
| Scrape triggers | ~10 | 4 | 2 | 4 |
| Admin (backup, restore, reset) | ~8 | 6 | 1 | 1 |
| Bootstrap (auto, pod, steps) | ~12 | 3 | 4 | 5 |
| Product Intelligence | ~18 | 10 | 3 | 5 |
| Settings (email, data sources) | ~8 | 2 | 2 | 4 |
| Customer detail routes | ~15 | 7 | 4 | 4 |
| **Total** | **~116** | **62 (53%)** | **25 (22%)** | **29 (25%)** |

---

## P0 Gaps (Data Loss Risk)

### BOOT-CANCEL — Bootstrap cancellation leaves corrupted customer list
- Endpoint: `POST /api/bootstrap/auto/cancel`
- Risk: Interrupted bootstrap leaves partial customers.json with no rollback
- No test asserts cancel returns customers to pre-bootstrap state
- Backlog: BKL-TEST-P2-04

### SF-SYNC — Salesforce pipeline sync has zero end-to-end coverage
- Endpoints: `POST /api/scrape/salesforce`, `GET /api/auth/salesforce/status`
- Risk: Silent pipeline data loss; pipeline tab shows stale data indefinitely
- Backlog: BKL-TEST-P2-05

### SHEETS-IMPORT — Customer import from sheets has no duplicate guard test
- Endpoint: `POST /api/setup/save-customers`
- Risk: Duplicate import inflates customer list silently
- Backlog: BKL-TEST-P2-06

---

## P1 Gaps (Silent Failure Risk)

### CCSP-REFRESH — CCSP territory data never re-scraped after bootstrap
- Endpoint: `POST /api/refresh/ccsp`
- Risk: Territory data stays at bootstrap state forever; no staleness test
- Backlog: BKL-TEST-P2-07

### INTEL-BATCH — Intelligence batch endpoint partial failure undetected
- Endpoint: `POST /api/intelligence/generate-all-customers`
- Risk: Batch errors[] field not asserted in any test
- Backlog: BKL-TEST-P2-08

### PRODUCT-REFRESH — Feature refresh for all customers untested
- Endpoint: `POST /api/products/features/refresh-all`
- Risk: Gemini budget burned on stale products; no contract test
- Note: Per-customer refresh IS tested (REG-PROD-INTEL-08); batch is not
- Backlog: BKL-TEST-P2-09

### SETTINGS-EMAIL — Email settings persistence untested
- Endpoint: `GET/PUT /api/settings/email`
- Risk: Email delivery silently disabled after container restart
- Backlog: BKL-TEST-P2-10

---

## P2 Gaps (Degraded UX)

| Gap | Endpoint | Risk |
|---|---|---|
| Drive folder validation | `POST /api/aes/validate-folder` | Wrong folder accepted at setup |
| POD filter | `GET /api/accounts?pod=X` | Wrong AE's customers shown |
| Priority action display | `GET /api/customer/:name/priority-action` | Action items invisible |
| Temporal delta | `GET /api/customer/:name/temporal-delta` | "Last updated" wrong |
| Regional bootstrap | `POST /api/bootstrap/pod` (EMEA/APAC) | Non-NW regions fail silently |

---

## Fixture Coverage Gaps

**Current fixtures** (`test/fixtures.ts`):
- AEs: 2 (Carolanne Farrell only used in CI)
- Regions: Northwest only
- No EMEA, APAC, Central, or TOLA AE fixtures

**Impact:** Bootstrap tests only validate NW pod flow. Multi-pod and multi-region scenarios are untested.

---

## Bootstrap Step Coverage

| Step | Tested | Failure Modes Tested |
|---|---|---|
| 1. Drive folder creation | ✅ (REG-BOOT-03) | None |
| 2. AE sheet population | ✅ | None |
| 3. SF bookings import | ✅ (REG-035) | None |
| 4. Domain inference | ✅ | None |
| 5. Account matching | ✅ | None |
| 6. Completion detection | ✅ | None |

**Missing:** Network interruption recovery, invalid SF report ID validation, Drive quota exceeded, Tableau login timeout.

---

## Already Addressed (do not re-create)

- Backup/restore: REG-BACKUP-01/02/03, REG-RESTORE-01 (BKL-TEST-P1-04, 2026-04-18)
- Product intelligence mutations: REG-PROD-INTEL-01 through -10 (BKL-TEST-P2-02, 2026-04-18)
- Bearer transport: T1-T10 in `test/rh-bearer-phase2.spec.ts` (BKL-RH-03, 2026-04-18)

---

## Definition of "Complete" Test Suite

A test suite is adequate when:
1. Every API endpoint has ≥1 HTTP contract test (status code + response shape)
2. Every mutation endpoint has a failure-path test (invalid input → 4xx)
3. Every silent-failure risk has a success-state assertion (not just "no error")
4. P0 data-path tests run against the test container (7776), not mocked
5. UI regression catches any component that shows connection/scrape state
