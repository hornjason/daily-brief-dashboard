---
doc-type: runbook
status: active
owner: jason
updated: 2026-05-01
---

# Architecture Refactor Playbook

How to execute the BKL-ARCH deepening candidates one at a time without breaking production.

**Source of truth for open items:** `BACKLOG.md` (BKL-ARCH-01 through BKL-ARCH-08)
**Issue tracker:** `hornjason/asaCommandCenter` GitHub Issues

---

## Candidate execution order

Always in this order — later items depend on earlier ones:

| Order | Item | Depends on |
|---|---|---|
| 1 | BKL-ARCH-06 — atomic-write module | — |
| 2 | BKL-ARCH-07 — Drive folder traversal | — |
| 3 | BKL-ARCH-01 — customer name/folder matching | #07 |
| 4 | BKL-ARCH-03 — server.ts sub-router extraction | — |
| 5 | BKL-ARCH-05 — usePolledStatus hook | — |
| 6 | BKL-ARCH-08 — bootstrap-orchestrator split | #06, #07, #01 |

Never run two candidates in parallel — they touch overlapping files.

---

## The loop (run once per candidate)

### Phase 1 — Design

```
/grill-with-docs          cross-check interface against ARCHITECTURE.md + ADRs
                          updates CONTEXT.md inline as decisions land
                          (skip if interface is already designed — see status table below)

/to-prd                   crystallize into a GitHub Issue PRD
                          publishes to hornjason/asaCommandCenter as needs-triage

/triage #N                post durable agent brief on the issue
                          flip labels: needs-triage → enhancement + ready-for-agent
```

### Phase 2 — Implement

```
"implement BKL-ARCH-0N"   Rayford briefs Marcus with the agent brief from the GitHub Issue
                          Marcus: worktree → TDD (red-green per behavior) → Playwright on 7776
                          Marcus reports: test output + all acceptance criteria met/not met
                          Rayford: reads output, signs off, runs make rebuild
                          Quinn + Rook: spawn in parallel after make rebuild
```

### Phase 3 — Close

```
gh issue close N --repo hornjason/asaCommandCenter
Update BACKLOG.md         mark BKL-ARCH-0N DONE with date
Pick next candidate       start Phase 1 for the next item in the order table above
```

---

## Current status (updated 2026-05-01)

| Item | Interface designed | GitHub Issue | Triage state |
|---|---|---|---|
| BKL-ARCH-06 atomic-write | ✅ | #1 ✅ CLOSED | ✅ DONE 2026-05-01 |
| BKL-ARCH-07 Drive traversal | ✅ | #2 ✅ CLOSED | ✅ DONE 2026-05-01 |
| BKL-ARCH-01 customer matching | ✅ | #3 ✅ CLOSED | ✅ DONE 2026-05-01 |
| BKL-ARCH-03 server.ts routers | ❌ | — | — |
| BKL-ARCH-05 polling hook | ❌ | — | — |
| BKL-ARCH-08 bootstrap split | ❌ | — | — (blocked) |

**Next action:** `/grill-with-docs` for BKL-ARCH-03 — server.ts sub-router extraction (interface not yet designed).

**BKL-ARCH-01 commit:** 10f218ef2 — customer-folder.ts created, 3 callers migrated, 9 unit tests.

**BKL-ARCH-06 commit:** c5d9ff605 — 35 call sites migrated, 13 unit tests, src/lib/atomic-write.ts live.
**BKL-ARCH-07 commit:** d1848268e — 5-method singleton, 14 unit tests, 5 callers migrated, ADR-0016 enforced.

---

## TDD rules for Marcus

- **Vertical slices only** — one test → one implementation → repeat
- **Never horizontal** — do not write all tests then all code
- **Interface is the test surface** — tests assert on observable outcomes through the public API
- **No mocks of internal modules** — use real temp directories for filesystem tests
- **Delete old shallow tests** after writing new interface tests — replace, don't layer

---

## Gate before make rebuild

Marcus must report all of these before Rayford runs `make rebuild`:

- [ ] `bun test test/unit/` passes (unit tests)
- [ ] `npx playwright test test/api/ --project=test` passes on 7776
- [ ] `tsc --noEmit` clean
- [ ] All acceptance criteria from agent brief checked off

After `make rebuild`:
- [ ] Quinn audits on 7777
- [ ] Rook scans changed files + pattern siblings
- [ ] `npx playwright test test/api/ --project=ci` passes on 7777

---

## When a candidate needs no grilling (interface already designed)

Skip `/grill-with-docs` and go straight to `/to-prd`. This happened for BKL-ARCH-06 — Serena ran three parallel interface designs in the same session as the explore, so the interface was settled before the issue was created.

For all other candidates, run `/grill-with-docs` first — the interface is not yet decided.
