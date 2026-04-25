# Test Coverage Reference
*Last validated: 2026-04-17 | Owner: DA | Trigger: new test files added/removed, major feature changes*

## Quick Reference

| File | Project | Target | Mode | Tests |
|------|---------|--------|------|-------|
| `test/bootstrap-onboarding.spec.ts` | test | 7776 | Serial | 36 |
| `test/bootstrap-e2e.spec.ts` | test | 7776 | Serial | ~10 |
| `test/lifecycle.spec.ts` | test | 7776 | Serial | ~8 |
| `test/regression.spec.ts` | ci + test | 7777 / 7776 | Parallel | 32+ |
| `test/navigation-regression.spec.ts` | ci | 7777 | Parallel | ~10 |
| `test/wizard.spec.ts` | ci | 7777 | Parallel | ~25 |
| `test/api/customers.spec.ts` | ci | 7777 | Parallel | ~20 |
| `test/api/intelligence.spec.ts` | ci | 7777 | Parallel | ~18 |
| `test/api/error-paths.spec.ts` | ci | 7777 | Parallel | ~16 |
| `test/api/setup.spec.ts` | test + ci | 7776 / 7777 | Mixed | ~20 |
| `test/ui/customer-detail.spec.ts` | ci | 7777 | Parallel | 5 |
| `test/ui/bootstrap-config-block.spec.ts` | ci | 7777 | Parallel | 7 |

**Total: ~175 tests** | Run command reference: `docs/TESTING-RUNBOOK.md`

---

## Coverage by Product Area

### 1. Bootstrap Pipeline — Single AE
| What | Where | Depth |
|------|-------|-------|
| Bootstrap starts without error (POST /api/bootstrap/auto) | bootstrap-onboarding Ph2, bootstrap-e2e | ✅ Full |
| All 6 steps complete (Drive folder, customer folders, SF bookings, subscriptions, CCSP, pipeline) | bootstrap-onboarding Ph2 | ✅ Full |
| AE record has all 4 sheet IDs in aes.json | bootstrap-onboarding Ph2 | ✅ Full |
| Customer count is correct and Drive folders created | bootstrap-onboarding Ph2 | ✅ Full |
| CCSP cache populated after bootstrap | bootstrap-onboarding Ph2 | ✅ Full |
| Brief generates for at least one customer | bootstrap-onboarding Ph2 | ✅ Full |
| Sequential second AE has distinct IDs (no collision) | bootstrap-onboarding Ph3 | ✅ Full |
| CCSP cache handoff — second AE uses existing cache | bootstrap-onboarding Ph3 | ✅ Full |
| Total customer count spans both AEs | bootstrap-onboarding Ph3 | ✅ Full |
| Step timing logged per-step | bootstrap-onboarding Ph2/3 | ✅ Informational |

### 2. Bootstrap Pipeline — Full POD
| What | Where | Depth |
|------|-------|-------|
| POST /api/bootstrap/pod starts without error | bootstrap-onboarding Ph5 | ✅ Full |
| All 10 AEs complete with status 'ok' | bootstrap-onboarding Ph5 | ✅ Full |
| AE count guard — ≤12 AEs (catches wrong podTabTitle scope) | bootstrap-onboarding Ph5 | ✅ Full |
| All AEs have complete sheet IDs in aes.json | bootstrap-onboarding Ph5 | ✅ Full |
| 124 customers distributed across 10 AEs | bootstrap-onboarding Ph5 | ✅ Full |
| POD bootstrap button lifecycle (UI) | wizard | ✅ Full |
| podTabTitle scoping (Northwest Corp = ~10 AEs, not 35) | test-fixtures.json guard | ✅ Full |

### 3. Reset / Wipe
| What | Where | Depth |
|------|-------|-------|
| Reset clears AEs and customers | bootstrap-onboarding Ph1/4, setup | ✅ Full |
| Reset blocked without ?confirm=true | setup | ✅ Full |
| Reset blocked when >5 customers (production guard) | setup | ✅ Full |
| Reset blocked while scraper running (409) | setup | ✅ Full |
| OAuth / connection tokens survive reset | bootstrap-onboarding Ph1/4 | ✅ Full |
| Bootstrap form UI retains stale results after reset | ⚠️ Not yet — BKL-UX110 open | ❌ Gap |

### 4. Intelligence Pipeline
| What | Where | Depth |
|------|-------|-------|
| Intelligence batch starts after POD bootstrap | bootstrap-onboarding Ph5 | ✅ Spot-check |
| Spot-check: 10+ customers complete, error rate <50% | bootstrap-onboarding Ph5 | ✅ Spot-check |
| Per-customer intelligence-status endpoint shape | intelligence, regression | ✅ Full |
| Industry analysis dedup cache (shared across customers) | regression REG-028 | ✅ Source-level |
| Intelligence TTL tiering (company 14d, industry 30d) | regression | ✅ Source-level |
| identifyIndustry runs for no-account customers | regression REG-024 | ✅ @live |
| Intelligence doc URLs persist after restart | regression REG-017 | ✅ Full |
| validate-all endpoint shape | regression REG-023 | ✅ Full |
| Full 124-customer intelligence completion | ⚠️ Not tested (spot-check only) | 🟡 Partial |
| Drive discovery fallback populates panel from cache (no Gemini) | regression REG-073-A | ✅ @live |
| Drive discovery staleness gate (7d threshold) | regression REG-073-B | ✅ Source-level |
| Auto-generate fires on Drive miss, no duplicate trigger | regression REG-073-C/D | ✅ Source-level |

### 5. Data Persistence & Cache
| What | Where | Depth |
|------|-------|-------|
| Brief cache fromCache field always present | customers, regression REG-005 | ✅ Full |
| Brief cache honors stored ttlMs | regression REG-029 | ✅ Source-level |
| Brief returns fromCache:true on second call | customers | ✅ Full |
| CCSP cache populated for all POD AEs | bootstrap-onboarding Ph5/6 | ✅ Full |
| CCSP/pipeline hash guard (content-identical writes don't bump cachedAt) | regression REG-004 area | ✅ Source-level |
| Pipeline data populated (openCount, totalAcv) | bootstrap-onboarding Ph5 | ✅ Full |

### 6. API Contracts
| What | Where | Depth |
|------|-------|-------|
| GET /customer/:name/ccsp shape (totalAcv, byQuarter, byPartner) | customers | ✅ Full |
| GET /customer/:name/pipeline shape (totalAcv, openCount, opps, closedOpps) | customers, intelligence | ✅ Full |
| GET /customer/:name/brief shape (text, fromCache) | customers | ✅ Full |
| GET /customers — industry + segment fields present | customers | ✅ Full |
| GET /api/pipeline byOwner shape and data | intelligence | ✅ Full (@live) |
| GET /api/ccsp shape | intelligence | ✅ Full |
| GET /api/aes schema | regression REG-003 | ✅ Full |
| Input validation — territory-lookup, territory-names | error-paths | ✅ Full |
| Input validation — data-sources/add-folder | error-paths | ✅ Full |
| Input validation — settings/refresh, settings/weather | error-paths | ✅ Full |
| Input validation — setup/save-customers | setup | ✅ Full |
| HTML injection blocked in AE names and customer names | regression REG-004, setup | ✅ Full |

### 7. UI — Dashboard
| What | Where | Depth |
|------|-------|-------|
| Dashboard loads with 10 AE chips visible | bootstrap-onboarding Ph6 | ✅ Full |
| 0 console errors on dashboard load | bootstrap-onboarding Ph6 | ✅ Full |
| 0 network errors on dashboard load | bootstrap-onboarding Ph6 | ✅ Full |
| CCSP tile shows dollar amounts | bootstrap-onboarding Ph6 | ✅ Full |
| Pipeline tile shows no error state | bootstrap-onboarding Ph6 | ✅ Full |
| All 4 circuit breakers are closed | bootstrap-onboarding Ph6 | ✅ Full |
| Sidebar navigation between sections | navigation-regression | ✅ Full |
| Active nav item accent class | navigation-regression | ✅ Full |
| Product filter (OCP/AAP/RHEL) | regression REG area | ✅ Source-level |

### 8. UI — Account Portfolio
| What | Where | Depth |
|------|-------|-------|
| Portfolio page loads with customer cards | bootstrap-onboarding Ph6 | ⚠️ Selector needs Quinn validation |
| Industry badges appear on customer cards | bootstrap-onboarding Ph6 | ⚠️ Selector needs Quinn validation |
| Customer search/filter | ⚠️ Not yet covered | ❌ Gap |
| Triage grouping mode | ⚠️ Not yet covered | ❌ Gap |
| Compact/table view | ⚠️ Not yet covered | ❌ Gap |

### 9. UI — Account Detail Page
| What | Where | Depth |
|------|-------|-------|
| Account detail page loads for real customer | bootstrap-onboarding Ph6 | ✅ Full |
| Case modal opens on row click | customer-detail | ✅ Full |
| Case modal comment loads | customer-detail | ✅ Full |
| Case modal closes on backdrop click | customer-detail | ✅ Full |
| Case modal closes on Escape key | customer-detail | ✅ Full |
| Nonexistent customer renders without crash | customer-detail | ✅ Full |
| Intelligence doc link visible | bootstrap-onboarding Ph6 | ⚠️ companyDocUrl not in API — gap |
| Cases badge count matches popout content | ⚠️ Not yet — BKL-UI-05 open | ❌ Gap |

### 10. UI — Setup / Bootstrap Wizard
| What | Where | Depth |
|------|-------|-------|
| All 5 accordion sections visible | wizard | ✅ Full |
| OAuth Keys section — save button state, validation | wizard | ✅ Full |
| Google Auth section — connect button visible | wizard | ✅ Full |
| RH Portal connect — button states, firing POST, cancel | wizard | ✅ Full |
| Salesforce connect button lifecycle | wizard | ✅ Full |
| Tableau connect button lifecycle | wizard | ✅ Full |
| POD bootstrap button fires POST /api/bootstrap/pod | wizard | ✅ Full |
| Territory sheet selector + external link | bootstrap-config-block | ✅ Full |
| POD dropdown — 4 named options, auto-fill SF Report ID | bootstrap-config-block | ✅ Full |
| SF Report ID is read-only | bootstrap-config-block | ✅ Full |
| Stale results persist after navigating back | ⚠️ Not yet — BKL-UX110 open | ❌ Gap |
| VPN copy removed from info boxes | ⚠️ Not yet — BKL-UX111 open | ❌ Gap |

### 11. Connection / Auth
| What | Where | Depth |
|------|-------|-------|
| Google OAuth scope verified (bootstrap) | bootstrap-onboarding Ph0 | ✅ Full |
| RH Portal session active pre-flight | bootstrap-onboarding Ph0 | ✅ Full |
| Salesforce session active pre-flight | bootstrap-onboarding Ph0 | ✅ Full |
| Tableau reachable + session valid pre-flight | bootstrap-onboarding Ph0 | ✅ Full |
| All connections survive full reset | bootstrap-onboarding Ph1/4 | ✅ Full |
| RH Portal login-in-progress guard ordering | regression REG-031 | ✅ Source-level |
| Supportable permanently disabled | regression REG-027 | ✅ Source-level |

### 12. Regressions (selected notable ones)
| BKL | What | Where |
|-----|------|-------|
| REG-001 | tableauTerritories survive AE save round-trip | regression |
| REG-004 | HTML injection blocked in AE names | regression |
| REG-007 | Pipeline data flows to both AEs (Elmer Alvarez fix) | regression @live |
| REG-009 | Domain inference re-runnable | regression |
| REG-014 | normalizeForQuery empty string guard | regression |
| REG-021 | List-view case sum matches KPI total | regression |
| REG-025 | "Analysis skipped" excluded from top priority actions | regression |
| REG-028 | Zero-subscription gate skips Gemini | regression |
| REG-029 | Brief cache honors stored ttlMs | regression |

---

## Known Gaps (open backlog items)

| Gap | Backlog Item | Priority |
|-----|-------------|----------|
| Cases badge count matches modal content | BKL-UI-05 | P2 |
| Bootstrap form clears stale results on navigate-back | BKL-UX110 | P2 |
| VPN copy removed from bootstrap info boxes | BKL-UX111 | P2 |
| Customer portfolio card selector needs Quinn validation | bootstrap-onboarding Ph6 warning | P2 |
| Industry badge selector needs Quinn validation | bootstrap-onboarding Ph6 warning | P2 |
| Intelligence doc link (companyDocUrl not in customers API) | bootstrap-onboarding Ph6 note | P3 |
| Full 124-customer intelligence completion verified | spot-check only | P3 |
| Account portfolio — search, triage, compact view | not yet written | P3 |

---

## What `make onboarding-check` Verifies End-to-End

Run time: ~33 minutes | Command: `make onboarding-check` | Target: 7776 only

```
Phase 0  Pre-flight: Google OAuth (bootstrap scope) + RH Portal + Salesforce + Tableau
Phase 1  Wipe: reset clears AEs/customers; tokens survive
Phase 2  AE #1 (Carolanne): 6 steps, 4 sheet IDs, 11 customers, 9 Drive folders, CCSP cache, brief
Phase 3  AE #2 (Cail): distinct sheet IDs, AE #1 data unchanged, CCSP cache updated, 27 total customers
Phase 4  Wipe: reset clears both AEs; connections survive
Phase 5  POD: 10 AEs (≤12 guard), 124 customers, intelligence spot-check, 261 opps/$34.7M ACV, CCSP, pipeline
Phase 6  UI: 10 AE chips, dollar amounts render, circuit breakers closed, customer detail loads, 0 errors
```
