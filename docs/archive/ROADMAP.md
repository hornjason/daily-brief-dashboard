# DailyBriefDashboard — Roadmap

**Last updated:** 2026-04-01
**Open items:** ~82 (after 3 superseded)

Work is organized into 5 priority tracks. Tracks are not strictly sequential — Quick Wins and Security can run alongside the epics.

---

## Track 1 — Quick Wins
*Small, unblocked, high value. Do these first.*

| Item | What | Effort |
|---|---|---|
| BKL-M33 Phase 1 | SF Pipeline: extend 2am timer to actually scrape SF (not just read GSheet) | XS — ~15 lines in background-scheduler.ts |
| BKL-M37 | RH Cases: lower default interval 4h → 1–2h, add 30-min floor | XS — settings-api.ts default value |
| BKL-S18 | Raw e.message in sfSyncError + ccspScrapeError catch blocks | XS — 2 lines in SetupPage.tsx |
| BKL-S14 | sfSyncError raw error stored at assignment in sf-scraper.ts | XS — 1 line |
| BKL-UX28 | "Last synced: just now" shows wrong timestamp (always shows current time) | XS — logic fix |
| BKL-M19 | Subscriptions + CCSP GSheet→cache timers use raw setInterval > 4h (Bun bug) | S — convert to heartbeat tick pattern |
| BKL-I01 | x11vnc not auto-respawned if killed mid-session | S — supervisord or restart wrapper in entrypoint |
| BKL-M26 | Orphaned cache files not cleaned up when customer removed | S — cleanup on AE/customer delete |
| BKL-M42 | App version number — define semver, expose in Setup footer via GET /api/version | S — package.json + endpoint + footer display |
| BKL-M43 | Triple-click version number → navigate to /admin (hidden entry point) | XS — click counter + navigate, depends on BKL-M42 |
| BKL-M40 | Admin page — source scrape triggers + scheduler config + live status (break-glass) | M — new page + routing + status polling + schedule fields |
| BKL-M41 | Setup Data Sources "Sync Now" — change from source scrape to cache sync (fast) | S — swap endpoints, remove Playwright from user-facing buttons |

---

## Track 2 — Data Freshness Epic
*Automated source syncs. See `DATA-FRESHNESS.md` for full spec.*

**Phases in priority order:**

| Phase | Item | What | Blocked? |
|---|---|---|---|
| Phase 1 | BKL-M33 | SF Pipeline 2am source scrape | No — start now (also in Track 1) |
| Phase 5 | BKL-M37 | RH Cases interval tighten | No — start now (also in Track 1) |
| Phase 2 | BKL-M33 | CCSP daily 6:30am source scrape | No |
| Phase 3 | BKL-M33 | Supportable daily 7am source scrape — **Option B: batch rotation (3×67 customers, ~65 min/day)** | No — BKL-M36 decided 2026-04-01 |
| Phase 4 | BKL-M34 | Territory sheet daily 1:45am sync | No (prereq: extract parser from server.ts) |
| Phase 4 | BKL-M32 | Territory drift — auto-add new customers, flag removals | Depends on Phase 4 |
| Phase 4 | BKL-M15 | Territory lookup quota — add TTL cache | No |
| Phase 6 | BKL-M38 | Configurable intervals + Advanced UI with server-side floors | After Phases 1–3 timers exist |
| Phase 7 | BKL-M39 | Dashboard freshness UX — per-section source timestamps + staleness badges | After Phase 6 |

**BKL-M36 decided 2026-04-01:** Option B — batch rotation (3 groups × ~67 customers, ~65 min/day, 3-day max staleness). Phase 3 is now unblocked. Write ADR-008 before implementation starts.
Initial load (BKL-M44): run to completion with no time-box — no batching for the one-time initial load, only for ongoing daily rotation.

---

## Track 3 — Scale UX Epic
*Structural UI work required before onboarding significantly more customers. These are not polish — the app degrades without them at 200 customers.*

| Item | What | Severity |
|---|---|---|
| BKL-UX39 | Account Portfolio: pagination + virtualization + collapsible AE groups | High — 10,600px scroll at 200 accounts |
| BKL-UX40 | Sidebar: scrollIntoView → route-based navigation (/dashboard, /accounts, etc.) | High — navigation model breaks at scale |
| BKL-UX43 | Account Portfolio: add compact List view (table rows, ~40px each) | High — grid unusable at 200 accounts |
| BKL-UX41 | Account Portfolio: Triage mode (Critical expanded, Healthy collapsed, sorted by case count) | High — can't triage at scale without it |
| BKL-UX42 | KPI modals: per-AE breakdown ("Open Cases: 312" meaningless without grouping) | High |
| BKL-UX44 | KPI container: flex-wrap system replacing 7 hardcoded cards | High — can't add 8th KPI without it |
| BKL-UX48 | Sidebar: AE sub-navigation (expandable AE list with filtered account views) | High — depends on BKL-UX40 |
| BKL-UX02 | Customer detail header redesign (two-row: breadcrumb + hero name + stat badges) | High |
| BKL-UX24 | Account Portfolio: customer search/filter input | Medium |
| BKL-UX45 | KPI preferences persistence (which KPIs visible, their order) | Medium |
| BKL-UX30 | Customer detail page: SSE progress bar during load | Medium |

**Suggested sequencing:**
1. BKL-UX40 (routing) — everything else depends on stable routes
2. BKL-UX39 + BKL-UX43 (virtualization + list view) — core grid fix
3. BKL-UX44 (KPI system) — enables adding new KPIs
4. BKL-UX41 + BKL-UX42 (triage + per-AE KPIs) — usability at scale
5. BKL-UX48 (AE nav) — after routing is solid
6. BKL-UX02 (header redesign) — can land anytime

---

## Track 4 — Security & Testing
*Hardening and test coverage. Can run in parallel with other tracks.*

### Security
| Item | What | Severity |
|---|---|---|
| BKL-S13 | Session state files missing mode 0o600 (SSO cookies readable) | Medium |
| BKL-S15 | supportable-scraper calls dumpDom unconditionally (needs SUPPORTABLE_DEBUG gate) | Medium |
| BKL-S16 | AE_PARENT_FOLDER_IDS not validated before Drive query | Medium |
| BKL-S18 | Raw e.message in catch blocks (in Track 1 — fix now) | Low |
| BKL-S14 | sfSyncError raw at assignment (in Track 1 — fix now) | Medium |
| BKL-S12 | RH login browser hides before Supportable pre-warm completes | High |

### Testing
| Item | What | Severity |
|---|---|---|
| BKL-T04 | Connection status cards show stale flags — need live health probes | High |
| BKL-T05 | E2E pre-flight session checks don't cover 10-min scrape window | High |
| BKL-T06 | SF pre-flight doesn't verify report accessibility | High |
| BKL-T07 | Tableau/Supportable session checks don't extend TTL | High |
| BKL-T03 | Wizard input validation tests | Low — in progress |
| BKL-GATE01 | Full bootstrap E2E test | Partial — re-run after scraper gaps addressed |

---

## Track 5 — UI Polish
*Visual refinements, accessibility, component cleanup. Nothing breaks without these. Batch and do between larger work.*

~30 items. Key ones:
- **Accessibility:** BKL-UX12 (focus rings), BKL-UX13 (aria-labels), BKL-UX32 (prefers-reduced-motion), BKL-UX34 (keyboard nav for opp rows), BKL-UX38 (touch targets)
- **Component cleanup:** BKL-UX19 (shared Modal shell), BKL-UX10 (EmptyState), BKL-UX15 (CopyButton dedup), BKL-UX46 (extract KPI detail modals)
- **Visual consistency:** BKL-UX06 (wrap Pipeline/CCSP in cards), BKL-UX08 (standardize padding), BKL-UX09 (section header size), BKL-UX11 (design tokens), BKL-UX31 (border-radius tokens)
- **Interactions:** BKL-UX07 (modal animations), BKL-UX17 (staggered card fade-in), BKL-UX22 (refresh button state)
- **Timestamps:** BKL-UX27 (relative time tooltip), BKL-UX29 (last updated per section) — coordinate with BKL-M39 freshness UX

Full list: see BACKLOG.md BKL-UX series.

---

## Open Decisions Required from Jason

*No open decisions as of 2026-04-01. BKL-M36 resolved — see above.*

---

## Superseded Items (closed 2026-04-01)
- BKL-M16 → superseded by BKL-M33 Phase 3
- BKL-M17 → superseded by BKL-M33 Phase 2
- BKL-F03 → superseded by BKL-M38
