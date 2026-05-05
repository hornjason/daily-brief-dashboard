---
doc-type: architecture
status: active
owner: jason
updated: 2026-05-05
---

# BKL-HERO-01 — Architecture Brief

<!-- doc-type: implementation-brief | status: ready-for-marcus | owner: serena | reviewed: 2026-04-30 | parent-spec: docs/HERO-INSTALL.md -->

> **Purpose:** File-level implementation plan for BKL-HERO-01. Council decisions in HERO-INSTALL.md are the authority on *what*; this brief specifies *where, in what order, with what test gate*. Marcus executes from this directly.

---

## 1. Decision summary (3 bullets)

- **Reuse, don't duplicate.** `saveOfflineToken()`, the `/api/settings/offline-token` route, the startup token hydration block, and the `NODE_ROLE` defense-in-depth scraper guards already exist in production. Token persistence (Phase 3) is largely a UI wire-up, not new backend work. Step 0 region selection and `isL3Only` gating are the only genuinely new surfaces.
- **`isL3Only` flows server → frontend via a single read-only endpoint, defaults `false`.** New `GET /api/node-role` reads `process.env.NODE_ROLE` and returns `{ isL3Only: NODE_ROLE !== 'primary' }`. Frontend initializes `isL3Only: false` in state, fetches once on `SetupPage` mount, and conditionally renders. Default-false keeps the primary install path safe for the entire fetch window — primary installs never reach the wizard anyway, so the request is best-effort.
- **`enabledRegions`/`enabledPods` are top-level optional arrays on `settings.json`.** They sit alongside `regions[]`, not inside it. `normalizeSettings()` already preserves unknown top-level keys via `{ ...src, regions }` — no changes to `region-config.ts`. Filter activation requires `Array.isArray(x) && x.length > 0`; `undefined`/`null`/`[]` all mean "no filter" — this is the backward-compat guarantee for every existing primary install.

---

## 2. The five hard-constraint checks

| # | Constraint | Approach satisfies? |
|---|---|---|
| 1 | `BootstrapConfigBlock.tsx` ZERO changes | Yes — filtering happens in `SetupPage.tsx` before passing `podOptions` prop. The component already accepts a filtered list. |
| 2 | Primary installs unaffected | Yes — `isL3Only` defaults `false`; `NODE_ROLE=primary` runs `sync-l3-daemon.ts`, not the server, so the wizard route is never hit. The new endpoint and Step 0 are dead code on primary. |
| 3 | `settings.json` backward-compat | Yes — `enabledRegions`/`enabledPods` are optional top-level arrays. Empty-list guard at every call site. `normalizeSettings()` preserves them via spread; legacy installs read identically. |
| 4 | Container-only, Bun, localhost-only | Yes — all changes are inside the existing container build. No new ports, no auth, no host tooling. |
| 5 | No `REDHAT_OFFLINE_TOKEN` to `.env` | Yes — Phase 3 reuses `saveOfflineToken()` (writes to `data-sources.json`, mode 0o600, atomic tmp+rename). The existing startup hydrator in `server.ts:95–104` loads it into `process.env` on container boot. |

**No constraint violations.** No re-opening of ADRs needed.

---

## 3. Wire-up sequence — what calls what, in what order

### Server-side request flow (Step 0 save)

```
Step0RegionAccess.tsx — "Save & Next"
  POST /api/regions/access  { enabledRegions: string[], enabledPods: string[] }
    → src/region-access-routes.ts (NEW)
    → validateAgainstCatalog(enabledRegions, enabledPods, normalizedSettings)
        rejects any region without (territorySheetUrl && podBookingsFolderId && ≥1 pod with sfReportId)
        rejects any pod whose qualified key is not in catalog
    → atomic write: read settings.json fresh → spread { ...raw, enabledRegions, enabledPods } → tmp + renameSync
    → 200 { ok: true }
  GET /api/regions/catalog  (called on Step 0 mount)
    → reads SETTINGS_PATH → normalizeSettings()
    → for each region: selectable = territorySheetUrl && podBookingsFolderId && Object.values(pods).some(p => p.sfReportId)
    → returns [{ id, label, selectable, comingSoonReason?, pods: [{ key, label, qualifiedKey: `${id}.${key}` }] }]
```

### Server-side token flow (Step 3 — already wired)

```
HeroStep3Connections.tsx — "Validate & Save"
  POST /api/settings/offline-token  { token }   ← already exists, src/settings-api.ts:259
    → saveOfflineToken(token)   ← already exists, src/settings-api.ts:230
    → process.env.REDHAT_OFFLINE_TOKEN = token  ← already done in route
  Optional pre-validate: POST a "dry-run" — call getToken(token) before saving, return 400 on failure.
  Recommendation: ADD validation BEFORE saveOfflineToken — fail loud at paste time. One new helper in src/redhat.ts: validateOfflineToken(candidate): Promise<{ ok: boolean; error?: string }>.
```

### Server-side role flow (Phase 0)

```
SetupPage.tsx — useEffect on mount
  GET /api/node-role
    → src/node-role-routes.ts (NEW, ~10 lines)
    → returns { isL3Only: process.env.NODE_ROLE !== 'primary' }
  Frontend state initial: { isL3Only: false }   ← safe default, primary path
  After fetch resolves: setIsL3Only(response.isL3Only)
```

### Frontend conditional rendering (Phase 2)

```typescript
// In SetupPage.tsx, around the existing section blocks:
{!isL3Only && <DataSourcesSection ... />}
{!isL3Only && <RefreshTimerSection ... />}
{!isL3Only && <AutomationLimitsSection ... />}
<AISettingsSection ... />              {/* always visible */}
{isL3Only && <HeroStep3Connections ... />}
<AEsAndCustomersSection
  podOptions={isL3Only ? filteredPodOptions : podOptions}
  ...
/>
{isL3Only && aeCount > 0 && <OpenDashboardButton />}
```

---

## 4. Backward-compatibility strategy for `settings.json`

**Schema additions (top-level, optional):**

```jsonc
{
  "regions": [ /* unchanged */ ],
  "podBookingsFolderId": "...",
  "refreshIntervalHours": 4,
  "enabledRegions": ["west-commercial"],          // NEW — optional
  "enabledPods": ["west-commercial.WEST_COMM_CORP_NORTHWEST"]   // NEW — optional
}
```

**Read-side contract — single rule everywhere:**

```typescript
function isPodFilterActive(enabledPods: unknown): enabledPods is string[] {
  return Array.isArray(enabledPods) && enabledPods.length > 0
}
```

- `undefined` → no filter (legacy installs, every primary install today)
- `null` → no filter
- `[]` → no filter (deliberately empty also means "show all" — protects against accidental wipe)
- `["..."]` → filter active

**This rule lives in ONE place.** Add it to `src/region-config.ts` as `isPodFilterActive(value)` and import everywhere. Do not inline-check at call sites — it drifts.

**Write-side contract:**

`POST /api/regions/access` reads fresh from disk, validates, then writes via tmp+rename — exact pattern from `server.ts:840–850` (validate-folder route). This satisfies ADR-002 because:
- The handler is synchronous between read and write (no `await` between them — `readFileSync` then `writeFileSync` then `renameSync`).
- No in-memory `aes`/`customers` array is involved. ADR-002 specifically governs the `aes`/`customers` arrays. `settings.json` is a separate file with its own atomic-write pattern already in use.
- We do NOT call `saveAes`/`patchAe` — orthogonal write paths.

**ADR-002 compliance check:** PASS. The constraint is "no `aes.map(...)` after an `await`." This route doesn't touch `aes` at all.

---

## 5. Token persistence path — verify-and-confirm

| Question | Answer | Evidence |
|---|---|---|
| Where is the token stored? | `data-sources.json` field `redhatOfflineToken` (string) | `src/settings-api.ts:230` |
| File mode? | `0o600` | `src/settings-api.ts:234` |
| Write pattern? | Atomic tmp + renameSync | `src/settings-api.ts:233–235` |
| How is it loaded on restart? | Startup block reads `data-sources.json` and sets `process.env.REDHAT_OFFLINE_TOKEN` | `server.ts:95–104` |
| Does it survive container restart? | Yes — `data-sources.json` is in `/data/config/` volume mount | `server.ts:79–81` resolves via `process.env.CONFIG_DIR` |
| Does the existing route validate the token before saving? | NO — it only sanity-checks length/newlines | `src/settings-api.ts:259–283` |

**Gap to close in Phase 3:** The existing route saves blindly. The spec says "App validates (exchanges for a short-lived Bearer JWT via `redhat.ts::getToken()`)". Marcus must add a validate call BEFORE `saveOfflineToken` so paste-time failure is loud, not 4 hours later.

**Recommended new helper:** `src/redhat.ts::validateOfflineToken(candidate: string): Promise<void>` — calls the SSO token-exchange endpoint with the candidate, throws on 4xx. Route wraps in try/catch and returns 400 with sanitized error on failure.

---

## 6. Phase sequencing — five phases, one test gate per phase

Each phase ships independently. Do not start Phase N+1 until the gate for Phase N closes.

### Phase 0 — Foundation (read-only endpoints + schema)

**Files modified:**
- `server.ts` — register two new route modules
- `src/node-role-routes.ts` (NEW, ~15 lines) — `GET /api/node-role`
- `src/region-access-routes.ts` (NEW, ~120 lines) — `GET /api/regions/catalog`, `POST /api/regions/access`
- `src/region-config.ts` — add `isPodFilterActive(value)` helper export
- `data/config/settings.json` — no manual edit; the POST route writes it. The seed/test/demo settings stay unchanged (backward-compat verifies).

**Test gate (Phase 0):**
- `bun test test/unit/region-config.test.ts` — `isPodFilterActive` returns false for `undefined`, `null`, `[]`; true for `['x']`
- `npx playwright test test/api/region-access.spec.ts --project=test` (against 7776) — covers:
  - `GET /api/node-role` returns `{ isL3Only: true }` when NODE_ROLE unset (default for hero/dev)
  - `GET /api/regions/catalog` returns West + TOLA selectable, no Coming Soon (current settings.json has no East)
  - `POST /api/regions/access` with valid payload writes `enabledRegions`/`enabledPods` to settings.json
  - `POST /api/regions/access` with a region missing `sfReportId` rejects 400
  - `POST /api/regions/access` with an unknown qualified pod key rejects 400
  - After save: `GET /api/regions/catalog` returns same as before — write didn't corrupt other fields
- Existing test suite still passes (no regressions in `regions[]` reads from primary install paths)

### Phase 1 — Step 0 component (UI for the Phase 0 backend)

**Files modified:**
- `dashboard/src/components/Step0RegionAccess.tsx` (NEW, ~250 lines)
  - Mounts on first boot when `enabledRegions` is undefined OR empty AND no AEs configured yet
  - Fetches `GET /api/regions/catalog`
  - Region checkbox with collapsible pod list
  - Coming Soon regions render disabled with reason
  - TOLA: single pod auto-selected when region checked, no sub-UI
  - "Save & Next" calls `POST /api/regions/access`
  - On 200, calls `onSave(enabledRegions, enabledPods)` and collapses to summary line `Region: pod1, pod2 [Edit]`
- `dashboard/src/pages/SetupPage.tsx` — render `<Step0RegionAccess>` at top of wizard, before Step 1 (Google OAuth Keys), conditional on first-boot

**Test gate (Phase 1):**
- `npx playwright test test/ui/step0-region-access.spec.ts --project=test`:
  - Renders region list with West selectable, East not (when seed config has no East)
  - Checking West expands pods, individual pod checkboxes work
  - "Save & Next" disables until ≥1 pod selected
  - Summary line renders after save
  - "Edit" link reopens Step 0
- Quinn smoke audit on 7776: visual review of Step 0, confirms it doesn't break existing wizard
- Verify primary install path on 7776 with `NODE_ROLE=primary` env: Step 0 does NOT render (primary doesn't load the wizard at all — verify by `make sync-up` doesn't surface the page)

### Phase 2 — `isL3Only` gating (hide L4-only sections)

**Files modified:**
- `dashboard/src/pages/SetupPage.tsx`:
  - Add state `const [isL3Only, setIsL3Only] = useState(false)` — safe default
  - Add `useEffect` to fetch `GET /api/node-role` on mount
  - Wrap Data Sources, Refresh Timer, Automation & Limits sections with `{!isL3Only && (…)}`
  - AI Settings section: NO change — stays visible
  - The existing primary-install path (`isL3Only=false`) renders identically to today

**Test gate (Phase 2):**
- `npx playwright test test/ui/setup-l3-gating.spec.ts --project=test`:
  - With NODE_ROLE unset (default test env): Data Sources/Refresh/Automation hidden
  - With NODE_ROLE=primary (set via test container env override): all three visible
  - AI Settings always visible
- Manual verify on 7776: page renders without console errors, layout doesn't collapse

### Phase 3 — Hero Step 3 connections (RH offline token)

**Files modified:**
- `src/redhat.ts` — add `validateOfflineToken(candidate)` helper
- `src/settings-api.ts` — modify `POST /api/settings/offline-token` to call `validateOfflineToken` BEFORE `saveOfflineToken`. Sanitize error messages.
- `dashboard/src/components/HeroStep3Connections.tsx` (NEW, ~120 lines)
  - Single textarea for token paste
  - "Validate & Save" button — POST to `/api/settings/offline-token`
  - Renders success ✓ or sanitized error
  - Shows the help link to sso.redhat.com
- `dashboard/src/pages/SetupPage.tsx` — render `<HeroStep3Connections>` only when `isL3Only` AND in the position that the existing Data Sources section occupied for the L4 wizard

**Test gate (Phase 3):**
- `npx playwright test test/api/offline-token.spec.ts --project=test`:
  - POST with bad token returns 400 with sanitized error
  - POST with mock-valid token succeeds; data-sources.json contains token; mode 0o600
- `npx playwright test test/ui/hero-step3.spec.ts --project=test`:
  - Component renders only when `isL3Only=true`
  - Bad token shows error, no save
  - On save success, persists across page reload (token marker `configured: true`)
- Container restart test: `make test-down && make test-up` after a save → verify token survives. The existing startup hydration block does this work; the test just confirms it.

### Phase 4 — Step 4 POD filtering (the BootstrapConfigBlock-untouched part)

**Files modified:**
- `dashboard/src/pages/SetupPage.tsx`:
  - Add state to hold `enabledPods` (loaded from settings.json or Step 0 save)
  - Compute `filteredPodOptions = isPodFilterActive(enabledPods) ? podOptions.filter(o => enabledPods.includes(qualifiedKeyFor(o))) : podOptions`
  - Pass `filteredPodOptions` (NOT `podOptions`) to `<BootstrapConfigBlock>` and to the AE/POD dropdown
  - The qualified key function: `qualifiedKey(regionId, podKey) → ${regionId}.${podKey}` — add to `dashboard/src/utils/regionFilter.ts` (NEW)
- `BootstrapConfigBlock.tsx` — **ZERO CHANGES**. It already takes `podOptions` as a prop.

**Test gate (Phase 4):**
- `npx playwright test test/ui/setup-pod-filter.spec.ts --project=test`:
  - With `enabledPods=['west-commercial.WEST_COMM_CORP_NORTHWEST']`: AE dropdown shows only Northwest pod
  - With `enabledPods=[]`: dropdown shows all pods (empty-list guard)
  - With `enabledPods=undefined`: dropdown shows all pods (legacy install simulation)
- Diff check: `git diff dashboard/src/components/BootstrapConfigBlock.tsx` returns empty. Mandatory hard gate — Marcus must surface this in his report.

### Phase 5 — "Open Dashboard" button placement

**Files modified:**
- `dashboard/src/pages/SetupPage.tsx`:
  - Render the "Open Dashboard" button after the AEs section when `isL3Only && aeCount > 0`
  - The existing primary "Open Dashboard" button at line ~4040 stays unchanged (only renders for L4 path; L3 path uses the new placement)

**Test gate (Phase 5):**
- `npx playwright test test/ui/setup-open-dashboard.spec.ts --project=test`:
  - L3 + 0 AEs: button hidden
  - L3 + 1 AE: button visible after AEs section
  - L4 (NODE_ROLE=primary): existing button at original position visible; new placement hidden
- Quinn full visual audit: confirms layout, button styling matches existing primary
- Final regression: `npx playwright test --project=test` (full suite) on 7776 — must pass before promoting to 7777

---

## 7. Test surface summary

| Phase | New unit tests | New API tests | New UI tests | Manual gate |
|---|---|---|---|---|
| 0 | `region-config.test.ts` (isPodFilterActive) | `region-access.spec.ts` | — | curl smoke |
| 1 | — | — | `step0-region-access.spec.ts` | Quinn smoke |
| 2 | — | — | `setup-l3-gating.spec.ts` | Manual |
| 3 | — | `offline-token.spec.ts` | `hero-step3.spec.ts` | Container-restart token-survives |
| 4 | — | — | `setup-pod-filter.spec.ts` | `git diff BootstrapConfigBlock` empty |
| 5 | — | — | `setup-open-dashboard.spec.ts` | Quinn full audit + full suite |

All Playwright tests run with `--project=test` (port 7776) per CLAUDE.md hard rule. After Phase 5 passes, promote to 7777 via `make rebuild`.

---

## 8. Patterns to follow (existing code)

| Pattern | Where | Use for |
|---|---|---|
| `readFileSync` + spread + `writeFileSync(tmp)` + `renameSync` | `server.ts:840–850` | All `settings.json` writes |
| `mode: 0o600` on credential files | `src/settings-api.ts:234` | Any file with secret data |
| `normalizeSettings()` + spread to preserve unknown top-level keys | `src/region-config.ts:50` | Reading settings.json |
| `if (process.env.NODE_ROLE !== 'primary') return` defense-in-depth | `src/ccsp-scraper.ts:584, 889, 1022`; `src/sf-scraper.ts:459, 961` | Already in place — DO NOT TOUCH |
| Route module pattern: export a register function called from `server.ts` | `src/settings-api.ts::registerSettingsRoutes` | New route files |
| Sanitize errors before returning to client | `sanitizeErr(e)` used throughout `settings-api.ts` | All new route error paths |
| Atomic write of cache files | `src/restore-routes.ts:109::atomicWriteJSON` | If a generic helper would be cleaner |

---

## 9. Patterns to avoid

| Anti-pattern | Why |
|---|---|
| Mutating `regions[]` to add `enabled: boolean` per region | Couples filter state to catalog. `enabledRegions` list at top-level keeps catalog read-only and filter independently writable. |
| Caching `isL3Only` server-side | Spec is explicit: read-only, no caching. The env var doesn't change at runtime. |
| Reading `process.env.NODE_ROLE` directly in components | All access via `/api/node-role`. Keeps the frontend server-state-only. |
| Adding new fields inside `RegionConfig` | Spec hard constraint. New fields go on `NormalizedSettings` or a new top-level object. |
| Using `aes.map(...)` or `saveAes(...)` in the new write path | ADR-002 governs that array. New write path is `settings.json`-only — keep them separate. |
| Saving the offline token to `.env` | Documented corruption incident. Use `saveOfflineToken()`. |
| Skipping Phase 0 schema work and shipping Phase 1 first | Step 0 component will have no backend to call. Strict ordering. |
| Modifying `BootstrapConfigBlock.tsx` | Spec hard constraint. Do all filtering in the parent. |

---

## 10. Files manifest

### New files

| Path | Approx LOC | Phase |
|---|---|---|
| `src/node-role-routes.ts` | 15 | 0 |
| `src/region-access-routes.ts` | 120 | 0 |
| `dashboard/src/components/Step0RegionAccess.tsx` | 250 | 1 |
| `dashboard/src/components/HeroStep3Connections.tsx` | 120 | 3 |
| `dashboard/src/utils/regionFilter.ts` | 30 | 4 |
| `test/api/region-access.spec.ts` | 100 | 0 |
| `test/api/offline-token.spec.ts` | 60 | 3 |
| `test/ui/step0-region-access.spec.ts` | 80 | 1 |
| `test/ui/setup-l3-gating.spec.ts` | 50 | 2 |
| `test/ui/hero-step3.spec.ts` | 60 | 3 |
| `test/ui/setup-pod-filter.spec.ts` | 60 | 4 |
| `test/ui/setup-open-dashboard.spec.ts` | 40 | 5 |
| `test/unit/region-config.test.ts` (or extend existing) | 30 | 0 |

### Modified files

| Path | Change | Phase |
|---|---|---|
| `server.ts` | Register two new route modules | 0 |
| `src/region-config.ts` | Add `isPodFilterActive` export | 0 |
| `src/redhat.ts` | Add `validateOfflineToken(candidate)` | 3 |
| `src/settings-api.ts` | Wire `validateOfflineToken` into existing `POST /api/settings/offline-token` | 3 |
| `dashboard/src/pages/SetupPage.tsx` | Mount Step 0; gate sections by `isL3Only`; filter `podOptions`; add hero Open Dashboard button | 1, 2, 3, 4, 5 |

### Untouched (explicitly)

- `dashboard/src/components/BootstrapConfigBlock.tsx` — spec hard constraint
- `scripts/sync-l3-daemon.ts`, `scripts/sync-pod-l3.ts` — separate item BKL-SYNC-L3-*
- `src/ccsp-scraper.ts`, `src/sf-scraper.ts`, `src/rh-scraper.ts` — defense-in-depth guards already in place
- `src/background-scheduler.ts` — separate item BKL-SYNC-L3-02

---

## 11. Recommended next step for Marcus

Start Phase 0 only. Read these files first, in this order:

1. `docs/HERO-INSTALL.md` — full spec
2. `docs/HERO-01-ARCHITECTURE-BRIEF.md` (this file)
3. `src/region-config.ts` — understand `normalizeSettings` and `RegionConfig`
4. `src/settings-api.ts` — match the pattern for `registerSettingsRoutes`
5. `server.ts:79–135` — see how route modules are wired in
6. `server.ts:816–893` — exact tmp+rename pattern for writing `settings.json`

Then build:
- `src/node-role-routes.ts`
- `src/region-access-routes.ts`
- `src/region-config.ts` (add `isPodFilterActive`)
- `test/api/region-access.spec.ts`
- `test/unit/region-config.test.ts`

Stop at Phase 0 gate, run `bun test` + `npx playwright test test/api/region-access.spec.ts --project=test`. Report results to DA. Do NOT start Phase 1 until DA signs off.

---

## 12. Open questions for Jason

None blocking. Two items to confirm at Phase 1 boundary, not now:

1. **First-boot detection rule.** Spec says "shown once on first boot only." Concrete trigger: `(enabledRegions === undefined || enabledRegions.length === 0) && aes.length === 0`? Or strictly the first condition? If a hero install adds an AE then later wants to change region access, BKL-HERO-02 (Admin › Region Access) handles it. So Step 0 only fires when truly fresh. **Proposal:** trigger when `enabledRegions === undefined`. Empty array means "user explicitly cleared" — leave them in BKL-HERO-02 territory.

2. **Token validate-before-save.** Spec says "App validates (exchanges for a short-lived Bearer JWT)." The existing route does NOT validate. Adding validation is a small UX upgrade with one network call. **Proposal:** add it as part of Phase 3 (cheap, fail-loud-at-paste-time benefit is real).

If Jason confirms both proposals, this brief is final. Otherwise adjust Phase 1 trigger and Phase 3 validation scope.
