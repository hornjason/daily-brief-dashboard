---
doc-type: reference
status: active
owner: jason
updated: 2026-05-05
---

# DailyBriefDashboard — Execution Plan

**Generated:** 2026-04-01
**Based on:** ROADMAP.md (5 tracks, 78 open items verified)
**Purpose:** Ordered execution sequence with dependencies respected. Not a re-hash of ROADMAP — this is "do this, then this."

---

## ⚠️ Open Decision — Required Before Wave 5 Phase 3

**BKL-M36: Supportable automated scrape at 200 customers**
*Jason's decision needed before Data Freshness Phase 3 can start.*

| Option | Approach | Runtime | Max Staleness |
|---|---|---|---|
| **A — Incremental** | Only scrape customers with data older than N days | ~20-30 min/day | Configurable threshold |
| **B — Batch rotation** | 3 groups × 67 customers, rotate daily | ~65 min/day | 3 days max |

Recommendation from Marcus + Serena: **Option B** (predictable, simpler, no stale-customer blindspot). See DATA-FRESHNESS.md §Scale Flag for full analysis.

---

## Critical Path

The sequence that unblocks the most work:

```
Wave 0 (decisions) → Wave 1+2 (quick wins) → Wave 3 (bug fixes) → Wave 4 (Admin page)
     → Wave 5 (data freshness, unlocked by Admin page)
     → Wave 6 (Scale UX, independent)
     → Wave 7 (session hardening, parallel with Wave 6)
```

**Admin page (Wave 4) is the structural linchpin** — it unlocks M41 (Sync Now change), M44 (initial load job), M38 (configurable intervals), and M40 (break-glass triggers).

---

## Wave 0 — Decide Before Starting Wave 5

| Decision | Blocks | Action |
|---|---|---|
| BKL-M36: Option A vs B | Data Freshness Phase 3 | Jason decides |

---

## Wave 1 — Immediate Starts (XS, zero prerequisites, run in parallel)

Effort: XS each (~15-30 min). All unblocked. Assign to Marcus.

| Item | What | Size |
|---|---|---|
| **BKL-S18** | Raw `e.message` in sfSyncError + ccspScrapeError catch blocks (SetupPage.tsx) | XS |
| **BKL-S14** | sfSyncError raw at assignment in sf-scraper.ts | XS |
| **BKL-UX28** | "Last synced: just now" always shows current time — fix to use actual cachedAt | XS |
| **BKL-M37** | Lower RH Cases default interval 240 min → 90 min; add 30 min server-side floor | XS |
| **BKL-S13** | Session state files (session-state.json, sf-session-state.json) missing `mode: 0o600` | XS |
| **BKL-S15** | Gate `dumpDom()` in supportable-scraper behind `SUPPORTABLE_DEBUG=true` (same pattern as CCSP) | XS |
| **BKL-S16** | Validate `AE_PARENT_FOLDER_IDS` env var with `/^[a-zA-Z0-9_-]{10,}$/` before Drive query in pipeline.ts | XS |

**Security note:** S13/S15/S16 are Rook's open findings — close these to clear the security gate.

---

## Wave 2 — Quick Wins (S-size, no prerequisites)

Effort: S each (~1-2h). Run after Wave 1 or in parallel.

| Item | What | Size |
|---|---|---|
| **BKL-M19** | Subscriptions + CCSP refresh timers: convert from raw `setInterval` to 15-min heartbeat tick pattern (same as Timer 3, per ADR-007) | S |
| **BKL-M26** | Orphaned cache file cleanup when AE or customer removed | S |
| **BKL-UX36** | Bootstrap "Save AE" button: fix hooks violation (useState in IIFE), fix catch that marks success on API failure | S |
| **BKL-F04** | Tableau VNC window doesn't auto-close after login — fix `sessionValid` check on post-login URL | S |
| **BKL-M42** | App version number: define semver in package.json, expose via `GET /api/version`, display in Setup footer | S |

---

## Wave 3 — Bug Fixes (HIGH severity — fix before onboarding more customers)

These corrupt data or cause bootstrap failures. Fix before growing the customer list.

| Item | What | Severity | Size |
|---|---|---|---|
| **BKL-F06** | Territory sheet imports junk customer names (deal rows, billing rows, other AEs' accounts). Add validation — filter against expected customer format before accepting names from territory sheet | High | M |
| **BKL-F05** | Domain inference must run automatically after bootstrap, not manually. Also: add customer-override mechanism for `workday.com` (tool domain but Workday Inc is a customer) | High | M |
| **BKL-S12** | RH login browser hides to `about:blank` before Supportable SSO pre-warm completes — causes bootstrap failure for Supportable. Fix: delay `about:blank` navigation until pre-warm confirms SSO or times out | High | M |

---

## Wave 4 — Admin Page Epic (structural dependency)

Build in dependency order. Each item unlocks the next.

| Step | Item | What | Size | Unlocks |
|---|---|---|---|---|
| 4a | **BKL-M42** | *(already in Wave 2)* — version number in footer | S | BKL-M43 |
| 4b | **BKL-M43** | Triple-click version → navigate to `/admin` (hidden entry point) | XS | Admin access |
| 4c | **BKL-M40** | Admin page `/admin`: manual source scrape triggers with live status polling + background scheduler config (times, intervals, enable/disable per source) | M | M41, M44, M38 |
| 4d | **BKL-M41** | Setup Data Sources "Sync Now" → change to cache sync only (GSheet→cache). Source scrapes move to Admin page | S | Cleaner UX |
| 4e | **BKL-M44** | Initial load bootstrap job: crash-safe, resume-capable, sequential Supportable run — Admin-triggered, no time-box, incremental writes | L | Scale onboarding |

---

## Wave 5 — Data Freshness Phases (after Admin page exists)

Phases in priority order. Phase 3 blocked until BKL-M36 decided.

| Phase | Item | What | Size | Blocker |
|---|---|---|---|---|
| **Phase 1** | BKL-M33 | SF Pipeline: extend 2am timer to call `runSfSyncForAes()` before `refreshPipeline()` | XS | None |
| **Phase 2** | BKL-M33 | CCSP: add 6:30am daily source scrape (self-rescheduling setTimeout, Tableau session pre-flight) | S | None |
| **Phase 4** | BKL-M34 | Territory sheet 1:45am sync: read GSheet → diff → auto-add new customers → flag removals → mini-bootstrap for new customers | M | None |
| **Phase 4** | BKL-M32 | Territory drift fix: auto-add new customers, flag removals for review (closed by Phase 4) | — | Depends on M34 |
| **Phase 4** | BKL-M15 | Territory lookup TTL cache (1h, bypass Drive API per wizard open) | S | None |
| **Phase 3** | BKL-M33 | Supportable: 7am daily source scrape | M | ⚠️ **BKL-M36 decision required** |
| **Phase 6** | BKL-M38 | Configurable source scrape intervals on Admin page with server-side floors | S | BKL-M40 |
| **Phase 7** | BKL-M39 | Dashboard freshness UX: per-section `lastSourceSync` timestamps, staleness badges (yellow 2x, red 4x) | M | Phase 6 |
| **Phase 7** | BKL-M35 | CCSP trend diff: store delta between pulls, surface in dashboard | M | Phase 2 |

---

## Wave 6 — Scale UX Epic (independent of Waves 4-5, can start any time)

Aditi Sharma's recommended sequence. **Must follow this order — each step depends on the previous.**

| Step | Item | What | Size | Note |
|---|---|---|---|---|
| 6a | **BKL-UX40** | Convert sidebar from `scrollIntoView` to route-based navigation (`/dashboard`, `/accounts`, etc.) | L | Everything else depends on stable routes |
| 6b | **BKL-UX39** | Account Portfolio: pagination + virtualization + collapsible AE groups | L | Core grid fix |
| 6b | **BKL-UX43** | Account Portfolio: compact List view (table rows, ~40px each) | M | Run with 6b |
| 6c | **BKL-UX44** | Extensible KPI container system (replaces 7 hardcoded cards + 434-line monolith) | L | Enables new KPIs |
| 6d | **BKL-UX41** | Triage mode (Critical expanded, Healthy collapsed, sorted by case count) | M | Run with 6d |
| 6d | **BKL-UX42** | KPI modals: per-AE breakdown | M | Run with 6d |
| 6e | **BKL-UX48** | Sidebar: AE sub-navigation (expandable AE list with filtered account views) | M | After routing (6a) |
| 6f | **BKL-UX02** | Customer detail header redesign (two-row: breadcrumb + hero name + stat badges) | M | Can land any time |
| 6g | **BKL-UX30** | Customer detail page: SSE progress bar during load | M | — |
| 6g | **BKL-UX24** | Account Portfolio: customer search/filter input | S | — |
| 6h | **BKL-UX45** | KPI preferences persistence (visible KPIs, order) | M | After BKL-UX44 |
| 6h | **BKL-UX46** | Extract KPI detail modals into standalone components | M | After BKL-UX44 |

---

## Wave 7 — Session & Testing Hardening (parallel with Wave 6)

These are related — batch together as a dedicated hardening sprint.

| Item | What | Size |
|---|---|---|
| **BKL-T04** | All 4 session connection cards: replace flag-reads with live health probes | M |
| **BKL-T05** | E2E pre-flight: add re-check at scrape time, not just T=0 | M |
| **BKL-T06** | SF pre-flight: verify SF report ID is actually accessible, not just stored | S |
| **BKL-T07** | Tableau/Supportable checks: extend session TTL on each status probe | S |
| **BKL-M20** | SF keep-alive 60 min → detect expiry faster (more frequent health check or event-driven) | S |
| **BKL-M21** | Scraper partial result validation: warn if fewer accounts returned than expected | S |
| **BKL-M27** | Bootstrap: Drive-side existence check before creating folders/sheets | M |

---

## Background — UI Polish (batch between waves, never blocking)

Batch these in groups of 5-10 between larger wave work. Don't let them block anything.

**Highest priority within polish (accessibility / correctness):**
- **BKL-UX12** — focus-visible rings (WCAG 2.1 AA failure)
- **BKL-UX13** — aria-labels on icon-only buttons
- **BKL-UX32** — `prefers-reduced-motion` media query
- **BKL-UX19** — shared Modal shell component (deduplicates 8+ modal implementations)
- **BKL-UX26** — Escape key handler on all modals

**Medium polish (consistency):**
- BKL-UX03 (tabular number fonts), BKL-UX04 (design tokens in SetupPage), BKL-UX06 (card wrapping), BKL-UX07 (modal animations), BKL-UX08 (card padding), BKL-UX09 (header sizes), BKL-UX10 (EmptyState component), BKL-UX11 (design tokens), BKL-UX15 (CopyButton dedup), BKL-UX21 (calendar grid alignment), BKL-UX27 (relative timestamp tooltip), BKL-UX29 (last updated per section), BKL-UX31 (border-radius tokens), BKL-UX33 (currency formatter dedup)

**Low polish (nice-to-have):**
- BKL-UX14/16/17/18/20/22/23/25/34/35/37/38/47/49 — do last or as filler

---

## Recommended Sprint Sequence

| Sprint | Waves | Focus | Parallel |
|---|---|---|---|
| **Sprint 1** | Wave 1 | XS quick wins + security close-outs | Marcus + Rook scan |
| **Sprint 2** | Wave 2 + 3 | S quick wins + HIGH bug fixes | Marcus builds, Quinn validates |
| **Sprint 3** | Wave 4a-c | Version number → triple-click → Admin page | Marcus |
| **Sprint 4** | Wave 4d-e + Wave 5 Phase 1 | Sync Now change + SF 2am scrape | Marcus; Rook scan after |
| **Sprint 5** | Wave 5 Phase 2 + 4 | CCSP + Territory automation | Marcus |
| **Sprint 6** | Wave 5 Phase 3 (if M36 decided) OR Wave 6a | Supportable automation OR routing refactor | Decision-dependent |
| **Sprint 7+** | Wave 6 (sequential) | Scale UX epic | Aditi design → Marcus build |
| **Parallel** | Wave 7 | Session hardening sprint | Between Wave 5 and 6 |
| **Ongoing** | Background | UI polish batches | Slot between sprints |

---

## Dependency Map (key relationships)

```
BKL-M42 (version) ──→ BKL-M43 (triple-click) ──→ BKL-M40 (Admin page)
                                                      ├──→ BKL-M41 (Sync Now change)
                                                      ├──→ BKL-M44 (initial load job)
                                                      └──→ BKL-M38 (configurable intervals)
                                                                └──→ BKL-M39 (freshness UX)

BKL-M36 (decision) ──→ BKL-M33 Phase 3 (Supportable automation)

BKL-UX40 (routing) ──→ BKL-UX39/43 (virtualization/list)
                    └──→ BKL-UX48 (AE sub-nav)

BKL-UX44 (KPI system) ──→ BKL-UX45/46 (KPI preferences + modal extract)

BKL-M34 (territory sync) ──→ BKL-M32 (territory drift fix)

BKL-M33 Phase 2 (CCSP automation) ──→ BKL-M35 (CCSP trend diff)

BKL-UX19 (shared Modal) ──→ BKL-UX26 (Escape key, use shared modal)
```
