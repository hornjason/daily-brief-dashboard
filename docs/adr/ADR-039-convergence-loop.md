---
doc-type: adr
status: active
owner: jason
updated: 2026-06-19
---

# ADR-039: Convergence Loop Architecture

**Status:** Accepted
**Date:** 2026-06-18
**Council:** 3-round debate, 4 members (Serena, Marcus, Rook, Aditi), unanimous ship vote
**Drivers:** Premature closure of #844 (Ansible AAP at 4% coverage declared "done"), consumer audit methodology from session 2026-06-18

## Context

Ship's SCOPE→BUILD→VERIFY→DURABILITY workflow handles single issues well but has no mechanism for iterative quality convergence. When work requires multiple passes to reach a quality bar (scaling a feature, auditing consumers, improving coverage), the current flow executes once and stops — relying on humans to catch gaps and re-enter the loop manually.

This produced two failure patterns:
1. **Premature closure** — Ansible AAP scraped with 4% download coverage, declared done because presence-check ACs passed
2. **Manual iteration** — Consumer module audits require repeated screenshot→score→fix→re-score cycles with no automation

## Decision

Add a **convergence loop** that wraps ship with goal-driven iteration. The loop runs autonomously (AFK) until a measurable quality threshold is met or a circuit breaker fires.

## Architecture

```
GOAL ← Human sets in natural language
  │    System decomposes into measurable ACs (garbage test applied)
  │    Human approves scope (touchpoint 1 of 3)
  │    Scope lock: files + ACs locked; goal amendments via council vote only
  │
  ▼
ITERATION 1 ──────────────────────────────────────
  │ DISCOVERY → domain-pluggable audit → typed gap list
  │ PLANNING  → ACs for top gaps (garbage test)
  │ EXECUTION → Marcus BUILD in worktree
  │ VERIFY    → mechanical check + full regression suite
  │ COUNCIL   → MANDATORY full architectural review
  │            (foundation poisoning gate — blocks iteration 2
  │             if structural flaw detected)
  │
  ▼
ITERATIONS 2-4 ───────────────────────────────────
  │ DISCOVERY → scoped to original goal ACs only
  │            (new findings → logged as issues, not loop work)
  │ PLANNING  → ACs for remaining gaps
  │ EXECUTION → Marcus BUILD
  │ VERIFY    → mechanical check + full regression
  │ GATE      → automated regression check
  │            (any metric regresses → full council fires)
  │            (all metrics improving → continue)
  │
  ▼
FINAL ITERATION ──────────────────────────────────
  │ COUNCIL   → MANDATORY full review
  │            Checks: loop goal + mission goal
  │            Reviews: cumulative diff from baseline
  │
  ├── PASS → PUBLISH (convergence report, deploy, close)
  │
  └── FAIL → CIRCUIT BREAKER STOP
             Decision prompt (touchpoint 2 of 3)
             → continue / merge partial / abandon
```

## Six Security Gates (mandatory, non-negotiable)

1. **Foundation poisoning gate** — full architectural review after iteration 1; blocks iteration 2 if structural flaw detected
2. **Immutable plugin registry** — DISCOVERY audit functions locked at loop start; no dynamic registration mid-loop
3. **Scope lock with amendment escape** — files and ACs locked; goal amendments require council vote with logged rationale
4. **Circuit breaker** — max 5 iterations, max 2-hour wall clock, configurable token ceiling; breach any → stop + checkpoint + notify
5. **Git revert rollback** — every iteration produces one squashed commit on feature branch; rollback = `git revert`, not `git reset`; main branch untouched until full convergence
6. **Mandatory council in AFK** — no structural change ships without judgment review; iterations 1 and final always get full council

## UX Contract (3 touchpoints only)

| Touchpoint | When | What Jason sees |
|---|---|---|
| 1. Approve scope | Loop start | Numbered ACs, estimated size, locked boundary |
| 2. Decide at breaker | Circuit breaker fires | What finished, what didn't, why stopped, options with cost estimates |
| 3. Review report | Loop end | Convergence report: shipped, deferred, checkpoints, evidence |

No mid-session check-ins. Autonomous between touchpoints.

## Gap-List Schema

```typescript
interface Gap {
  metric: MetricEnum       // registered metric name
  current: number | string // measured value
  target: number | string  // threshold to meet
  gap: number              // distance to target
  priority: 1 | 2 | 3 | 4 | 5
  source: string           // which DISCOVERY audit produced this
  actionable: boolean      // false = real gap but outside scope
}
```

Data layer (structured) + presentation layer (prose with progress indicators) — both mandatory outputs.

## Convergence Report Template

```markdown
## Convergence Report — {goal description}

### Goal
{original natural language goal} → {decomposed ACs}

### Iterations
- Iteration 1: {gap count} gaps found, {fixed} fixed, council: {PASS/FAIL + notes}
- Iteration 2: {gap count} gaps, {fixed} fixed, gate: {auto-pass/council-triggered}
- ...

### Shipped
- AC-1 → Evidence: {file:line or screenshot or API response}
- AC-2 → Evidence: ...

### Deferred
- {item} → Reason: {why} → Issue #{number}

### Circuit Breaker Events
- {trigger, decision made, rationale}

### Checkpoints
- iter-1: {git tag} — revertible
- iter-2: {git tag} — revertible
- ...

### Outcome Diff
- Before: {baseline metrics}
- After: {final metrics}
```

## Domain Examples

### SalesHub Product Scaling
- **Goal:** "All 21 SalesHub products scraped with ≥50% download coverage and ≥4 signals per product"
- **DISCOVERY:** Audit `_product.json` items vs downloaded files vs signals emitted; returns gap list per product
- **Iteration:** Fix download failures, re-scrape, re-enrich, re-audit
- **Council checks:** Coverage percentage AND "do these signals help the AE?" (mission goal)

### Consumer Module Audit
- **Goal:** "All 9 consumers pass contract (MA-1 through MA-7, TC-1 through TC-7)"
- **DISCOVERY:** Screenshot consumer output → score against contract criteria → gap list per consumer
- **Iteration:** Fix contract violations (missing ensureFresh, unwired validators, empty sections), re-score
- **Council checks:** Contract score AND "does this output connect customer tech to business objectives?" (mission goal)

## Implementation

- **Where:** Ship skill extension — `convergence` mode triggered by goal-type issues
- **File:** `convergence-gate` module within ship skill
- **MVP:** One domain (SalesHub product coverage), one project (DailyBriefDashboard)
- **First test:** Ansible AAP download coverage convergence
- **Persistence:** `MEMORY/WORK/{slug}/CONVERGENCE-REPORT.md` + GitHub issue comment

## PRINCIPLES.md Update

Add pre-flight question:
> **Does this work require iterative convergence?** If the quality bar is a measurable threshold (coverage %, contract score, signal count) rather than a binary done/not-done — use the convergence loop (ADR-039). Set the goal, approve scope, step away. Never iterate manually when the loop can converge autonomously.

Add anti-pattern:
> Presence-check ACs on iterative work. "Signals exist" passes with 1 garbage signal. Use the garbage test: "Could garbage data pass this AC?" If yes, add a measurable threshold.

## Follow-on (logged, doesn't block)

- Supply chain integrity check for worktree `bun install` (Rook)
- Token budget circuit breaker tuning after MVP data (Marcus)
- Product-page-only trigger for faster iteration (#845)
- Daemon products.length crash fix (#846)
