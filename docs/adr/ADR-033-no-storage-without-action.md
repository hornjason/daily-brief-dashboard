---
doc-type: adr
status: proposed
owner: jason
updated: 2026-06-03
---

# ADR-033: No Storage Without Action — Graph Registration Gate

**Date:** 2026-06-03
**References:** ADR-032 (Intelligence Substrate), #574 (Intelligence Graph v2 Council Audit), #591 (TacticScorer), #594 (this ADR)
**Deciders:** Council audit (unanimous), Serena Blackwood (architecture), Rayford (DA)

## Status

Proposed

## Context

### The accumulation-without-action pattern

The intelligence graph council audit (#574) found that 67% of graph nodes produce zero seller value. Phases 1-2 added 16+ signal sources that create nodes (engagement, intel, lifecycle, event, evidence, partner), but `buildMotion()` only traversed 3 node types (subscription, program, play). The remaining nodes were stored but never influenced tactic selection or motion generation.

This pattern — storing data without a corresponding action pathway — erodes both system value and seller trust:
1. **False completeness:** The graph appears rich (high node count) but recommendations don't improve
2. **Maintenance cost:** Every node type requires schema, tests, and migration support
3. **Silent regression:** New signal sources can be added to `SIGNAL_CONFIGS` without anyone noticing they're unused

### Root cause

No structural enforcement exists between signal registration (`SIGNAL_CONFIGS` in `intelligence-graph.ts`) and scoring consumption (`TacticScorer` in `tactic-scorer.ts`). A developer can add a new `SIGNAL_CONFIGS` entry that creates nodes, and the system accepts it without verifying those nodes influence any output.

## Decision

**Every node type registered in `SIGNAL_CONFIGS` that creates nodes (where `buildNode !== null`) MUST have a corresponding handler in `TacticScorer`.** Node types without scoring handlers are rejected at test time via an architecture compliance test.

### The gate

Add a test to `test/unit/architecture-compliance.test.ts`:

```typescript
test('every node-creating signal config has a TacticScorer handler', () => {
  // Parse SIGNAL_CONFIGS entries where buildNode returns a node (not null)
  const nodeCreatingConfigs = Object.entries(SIGNAL_CONFIGS)
    .filter(([_, config]) => config.nodeType !== 'none')
    .map(([source, config]) => ({ source, nodeType: config.nodeType }))

  // Verify each has a corresponding scorer
  for (const { source, nodeType } of nodeCreatingConfigs) {
    expect(
      TACTIC_SCORER_HANDLED_TYPES.includes(nodeType),
      `Node type '${nodeType}' (from source '${source}') has no TacticScorer handler`
    ).toBe(true)
  }
})
```

### Exceptions

Signal configs where `buildNode` returns `null` (nodeType: 'none') are exempt — these create derived edges only or enrich the customer node. Examples: `solution-intelligence`, `intelligence`, `account-plan`, `saleshub-plays`, `saleshub-tactics`, `recommended-actions`, `playbook`, `SalesHub Content`.

## Consequences

### Positive
- Adding a new signal source that creates nodes forces the developer to add a scoring handler
- Silent accumulation is structurally impossible
- The compliance test documents which node types are handled and which are exempted
- Pre-push hook catches violations before code reaches main

### Negative
- Slightly more work when adding a new signal source (must add both config + scorer)
- This is the correct tradeoff — the work of adding a scorer is the work of making the signal useful

### Neutral
- Existing exempt sources (nodeType: 'none') are unaffected
- The compliance test runs in the existing architecture-compliance.test.ts alongside other contract tests

## Implementation

1. `TacticScorer` exports a `TACTIC_SCORER_HANDLED_TYPES` constant listing all node types it handles
2. Architecture compliance test imports both `SIGNAL_CONFIGS` and `TACTIC_SCORER_HANDLED_TYPES`
3. Test fails pre-push if any node-creating config lacks a scorer handler
