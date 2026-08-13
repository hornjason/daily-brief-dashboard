---
doc-type: adr
status: active
owner: jason
updated: 2026-08-12
---

# ADR-043: Two-Pass Campaign Email Generation

**Status:** Accepted
**Date:** 2026-08-12
**Decision Makers:** Council (Serena, Aditi, Marcus, Ava) — unanimous across 3 rounds
**Drives:** PRD #1052 (Unified Campaign Generation), EMAIL-OUTREACH-SPEC.md

## Context

The campaign email pipeline uses Gemini 2.5 Pro to write full email bodies from a structured JSON schema (ADR-040). Despite 15 quality gate checks, the output produces recurring errors:

- Wrong person names in greetings (Sean Pike's email opens with "Mr. Trivedi")
- Duplicate action steps (generated in both `actionStep` field and email body)
- Pipeline dollar amounts ($517K, $139K) leaking into customer-facing text
- Wrong team member assigned to CTAs (SSA instead of AE)
- Missing relationship context despite subscription data being loaded
- Generic URLs reused across emails despite 30+ verified URLs available

These are **data selection failures**, not prose quality failures. The LLM is stochastic — it cannot reliably produce output where exactly one value is correct (the right name, the right URL, the right AE).

## Decision

**Two-pass architecture: Gemini selects data, template assembles emails.**

### Pass 1 — Data Selection (Gemini, temperature 0.3)

Gemini receives:
- Resolved contacts (names, titles, emails)
- Loaded signals (24 sources)
- URL registry feature keys (enum-constrained)
- Solution plays with customer wins
- Campaign directive / source material

Gemini returns typed `EmailSelection` objects — NOT prose:
```typescript
interface EmailSelection {
  recipientName: string      // Must match a resolved contact exactly
  tier: 'executive' | 'manager'
  intent: 'nurture' | 'expand' | 're-engage'
  subject: string            // 2-4 word observation, no product names
  signalIndex: number        // Index into loaded signals array
  featureKeys: [string, string, string]  // 3 keys from URL registry enum
  peerProof: { playName: string; exampleIndex: number } | null
  challengerDataPoint: string  // Selected from signals, not invented
}
```

### Pass 2 — Template Assembly (deterministic, no LLM)

Template engine receives `EmailSelection[]` + data sources. Assembles each email from 8 composable blocks:

1. **Opener** — Signal-driven observation (3 variants rotate across campaign)
2. **Signal Bridge** — Connects signal to Red Hat value prop
3. **Relationship Line** — Existing Red Hat products from subscription data (existing customers only)
4. **Feature Bullets** — 3 bullets, each linked to verified URL resolved from `featureKeys`
5. **Peer Pattern** — Customer win from solution plays resolved by `{playName, exampleIndex}`
6. **Challenger Frame** — `challengerDataPoint` wrapped in proven narrative structure
7. **CTA** — AE name from account team data + specific dates
8. **Sign-off** — AE name + title from voice profile

Word budgets enforced by template: exec 70-90, manager 120-160.
Voice profile tokens (formality, wordBudget, assertionLevel) shape sentence structure.
URLs resolved mechanically from parsed registry — Gemini never provides URLs.

## Consequences

### Positive
- **Names can never be wrong** — greeting uses `recipientName` from contact data, not Gemini text
- **URLs can never be hallucinated** — resolved from registry by feature key
- **CTA always uses AE** — pulled from account team data, not Gemini selection
- **Pipeline amounts can never leak** — template never inserts dollar values from signals
- **Testable** — each block is a pure function, unit-testable in isolation
- **Consistent** — same inputs always produce same output

### Negative
- **Less prose variety** — emails share skeletal structure (mitigated by 3 opener variants)
- **Template maintenance** — 8 blocks need design ownership (Aditi: "design owns template quality")
- **Challenger insight constrained** — structured framing may reduce surprise (mitigated by stochastic data point selection)

### Neutral
- **Build cost** — 3 days (Phase 1: schema, Phase 2: template engine, Phase 3: parallel migration)
- **Migration risk** — Old path stays behind flag during parallel run; rollback is instant

## Alternatives Considered

| Option | Verdict | Reason |
|--------|---------|--------|
| A: Slot-based (7 independent Gemini calls) | Rejected | Multiplies API calls, each slot can still hallucinate |
| C: Stronger validation on freeform | Rejected | Whack-a-mole — treats symptoms, not root cause |
| D: Hybrid (structured data + freeform narrative) | Rejected | Freeform paragraphs reintroduce hallucination surface |

## References

- Council debate transcript: 2026-08-12 (4 agents, 3 rounds, unanimous Option B)
- Industry precedent: Apollo.io, Salesloft, Outreach all converged on structured assembly by 2025
- Research: AI+structured = 4.6-7% reply rate vs 1-3% freeform (Instantly 2026, Hunter.io 2026)
- ADR-040: Universal Structured Output (extends this pattern)
- EMAIL-OUTREACH-SPEC.md: Verified URL Registry, email design rules, voice profiles
