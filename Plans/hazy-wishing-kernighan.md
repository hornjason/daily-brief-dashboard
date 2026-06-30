---
doc-type: reference
status: active
owner: jason
updated: 2026-06-29
---

# Plan: Consumer-Output Verification Gate

## Context

This session shipped 7 issues — none changed `.tsx` files, so the durability gate's Quinn check passed automatically. But several changes directly affect what users see: morning summary temperature/grounding (#908), campaign quality/peer-proof (#853/#854), TDP normalization in motions (#914), and cache key fix (#820). The gate missed these because its consumer detection is incomplete.

**Root cause:** `durability-gate.sh` line 154 defines `CONSUMER_PATHS` as a hardcoded regex covering only 4 of 8 consumers:
```
src/lib/templates/|src/campaign-|src/brief-pipeline|src/meeting-prep-
```
Missing: `dashboard-service.ts`, `value-positioning.ts`, `account-plan.ts`, `customer.ts`, `playbook-generator.ts`. Also missing: files that FEED consumers (e.g., `motion-builder.ts`, `customer-product-context.ts`, `tactic-scorer.ts`).

**Existing infrastructure we can leverage:**
- `PRINCIPLES.md` §Consumer → File Mapping — authoritative 8-consumer table already parsed by `architecture-compliance.test.ts`
- `doc-cascade-map.json` — proven pattern for file-glob → required-action mapping
- The compliance test's `parseConsumerMapping()` function (architecture-compliance.test.ts:428) already extracts consumer source files from PRINCIPLES.md at runtime

## Approach: `consumer-cascade-map.json` + gate update

Create a `consumer-cascade-map.json` alongside `doc-cascade-map.json`. The durability gate reads it instead of the hardcoded regex. Same proven pattern, different data.

### 1. Create `~/.claude/skills/ship/consumer-cascade-map.json`

Maps file globs to consumer names and required verification type. Two tiers:

- **Direct consumers** — the 8 consumer source files from PRINCIPLES.md. Changing these requires consumer output verification (generate real output, read it, verify quality).
- **Consumer feeders** — files that produce data consumers render (motion-builder, tactic-scorer, customer-product-context, product-vocabulary, signal scoring). Changing these requires verifying downstream consumer output is still correct.

```json
{
  "consumers": [
    { "glob": "src/dashboard-service.ts", "consumer": "Morning Summary", "verify": "curl /api/morning-summary" },
    { "glob": "src/value-positioning.ts", "consumer": "Value Positioning", "verify": "curl /api/customer/:name/value-positioning" },
    { "glob": "src/account-plan.ts", "consumer": "Account Plan", "verify": "curl /api/customer/:name/account-plan" },
    { "glob": "src/customer.ts", "consumer": "Customer Detail", "verify": "curl /api/customer/:name/brief" },
    { "glob": "src/brief-pipeline.ts", "consumer": "Brief Pipeline", "verify": "curl /api/customer/:name/brief" },
    { "glob": "src/campaign-service.ts", "consumer": "Campaign", "verify": "curl /api/customer/:name/campaigns" },
    { "glob": "src/meeting-prep-service.ts", "consumer": "Meeting Prep", "verify": "curl /api/customer/:name/meeting-prep" },
    { "glob": "src/playbook-generator.ts", "consumer": "Playbook", "verify": "curl /api/customer/:name/playbook" }
  ],
  "feeders": [
    { "glob": "src/lib/motion-builder.ts", "affects": ["Campaign", "Meeting Prep", "Playbook"] },
    { "glob": "src/lib/tactic-scorer.ts", "affects": ["Campaign", "Meeting Prep", "Playbook"] },
    { "glob": "src/lib/customer-product-context.ts", "affects": ["All consumers"] },
    { "glob": "src/lib/product-vocabulary.ts", "affects": ["All consumers"] },
    { "glob": "src/lib/templates/*.ts", "affects": ["All consumers"] },
    { "glob": "src/lib/signal-*.ts", "affects": ["Morning Summary", "Campaign", "Meeting Prep"] },
    { "glob": "src/quality-validators/*.ts", "affects": ["Campaign", "Meeting Prep", "Account Plan"] }
  ],
  "comment": "Maps changed files to consumer output verification requirements. Used by durability-gate.sh."
}
```

### 2. Update `durability-gate.sh` — replace hardcoded regex with JSON lookup

Replace lines 153-156 (hardcoded `CONSUMER_PATHS` regex) with logic that reads `consumer-cascade-map.json` and matches changed files against both `consumers` and `feeders` globs. When a match is found, the gate:
- Reports WHICH consumers are affected and HOW to verify
- FAILs if no consumer verification evidence exists on the issue

### 3. Add architecture compliance test

Add a test to `architecture-compliance.test.ts` that verifies `consumer-cascade-map.json` covers all consumers from the PRINCIPLES.md table. This prevents the map from going stale — if a new consumer is added to PRINCIPLES.md but not to the cascade map, the test fails.

### 4. Update PRINCIPLES.md feeder table

Add a "Consumer Feeders" section to PRINCIPLES.md documenting which lib files feed which consumers. This becomes the second source of truth (alongside the consumer table) for the cascade map compliance test.

## Files to modify

1. `~/.claude/skills/ship/consumer-cascade-map.json` — NEW
2. `~/.claude/skills/ship/durability-gate.sh` — replace L153-156 hardcoded regex with JSON map reader
3. `~/.claude/PAI/Projects/DailyBriefDashboard/test/unit/architecture-compliance.test.ts` — add cascade map coverage test
4. `~/.claude/PAI/Projects/DailyBriefDashboard/PRINCIPLES.md` — add Consumer Feeders section

## Verification

1. Run `durability-gate.sh` against the #908 issue — should now FAIL with "dashboard-service.ts and value-positioning.ts are consumer files, no consumer verification found"
2. Run `bun test --isolate test/unit/architecture-compliance.test.ts` — new test passes, confirming cascade map covers all PRINCIPLES.md consumers
3. Manually test: commit a change to `motion-builder.ts`, run durability gate — should flag "affects Campaign, Meeting Prep, Playbook consumers"
