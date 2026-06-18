/**
 * Brief Validator Unit Tests — Consumer Contract v1.0
 *
 * Verifies the brief quality validator (ADR-024) correctly:
 * - Passes good output with all required sections
 * - Fails bad output with missing sections, placeholder text, empty sections
 */

import { describe, test, expect } from 'bun:test'
import { briefValidator } from '../../src/quality-validators/brief-validator.ts'

const GOOD_BRIEF = `## Priority Action
Schedule EBC with Acme CTO Jane Smith before renewal on June 15. The OpenShift subscription renewal of $450K is at risk due to unresolved Sev-1 case #01234567 that has been open for 23 days. Engineering escalation needed before the renewal conversation. [Source: pipeline] [Source: support case]

## What Changed Since May 15, 2026
- New Sev-1 case #01234567 opened for OpenShift cluster networking failures, impacting production workloads [Source: support case]
- Pipeline opportunity "OpenShift Expansion Q3" moved to Stage 3 with $200K estimated value [Source: pipeline]
- VP Engineering Sarah Chen mentioned Kubernetes migration timeline in recent email thread [Source: email]
- RHEL subscription renewal ($125K) approaching in 45 days — no renewal conversation scheduled yet [Source: subscription]
- Competitor VMware Tanzu POC detected in dev environment based on job postings [Source: competitive intel]

## Risks & Renewals
- OpenShift renewal ($450K) expires June 15 — 28 days remaining [Source: pipeline]
- RHEL renewal ($125K) expires July 30 — 73 days remaining [Source: subscription]
- Sev-1 case unresolved for 23 days creates renewal risk [Source: support case]

## Next Steps
1. **Sarah Chen (VP Engineering)** — Schedule technical deep-dive on OpenShift networking issue before June 1. The Sev-1 case resolution is critical for renewal confidence. Potential to expand into managed services ($80K ARR).
2. **Mike Johnson (CTO)** — Executive briefing on Red Hat AI/ML roadmap by June 10. Recent job postings indicate AI infrastructure investment — position OpenShift AI before competitive alternatives.
3. **David Park (IT Director)** — RHEL renewal conversation by July 1. Bundle with Satellite for patch management automation — estimated $40K uplift.

## What They May Not Know
Industry benchmark: 73% of enterprises your size have consolidated to a single Kubernetes platform by 2026. Running both OpenShift and Tanzu creates 2.3x operational overhead per Gartner analysis. Migration path from Tanzu to OpenShift typically saves 30-40% in platform engineering costs.

DATA FRESHNESS:
All sources current as of June 18, 2026.

NEXT ACTION: Schedule EBC with Jane Smith (CTO) before June 15 renewal.`

const BAD_BRIEF_MISSING_PRIORITY = `## What Changed Since May 15, 2026
- Something changed [Source: email]
- Another thing changed [Source: pipeline]
- More changes here that are noted and documented for the record and tracked

## Next Steps
1. Do something with someone at some point in the near future to discuss things and make progress on the account strategy and relationship.

DATA FRESHNESS:
All sources current.

NEXT ACTION: Follow up on things.`

const BAD_BRIEF_PLACEHOLDERS = `## Priority Action
[Insert action here] TBD — need to determine the right approach for this customer account.

## What Changed Since May 15, 2026
- TODO: fill in changes from recent activity and customer interactions to track progress on the account.
- [Your update here] placeholder content that needs to be replaced with actual customer intelligence data.

## Next Steps
1. TBD — determine next steps after reviewing the account data and meeting with the team to discuss strategy.

DATA FRESHNESS:
All sources current.

NEXT ACTION: TBD`

const BAD_BRIEF_EMPTY_SECTIONS = `## Priority Action
Short.

## What Changed Since May 15, 2026
Minimal.

## Next Steps
Nothing.

NEXT ACTION: Do something.`

describe('Brief Validator', () => {
  test('passes good output with all required sections', () => {
    const result = briefValidator.validate(GOOD_BRIEF)
    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(70)
    expect(result.contentType).toBe('customer-brief')
  })

  test('good output has all required checks passing', () => {
    const result = briefValidator.validate(GOOD_BRIEF)
    const requiredChecks = result.checks.filter(c => c.severity === 'required')
    const failingRequired = requiredChecks.filter(c => !c.passed)
    expect(failingRequired).toHaveLength(0)
  })

  test('fails output missing Priority Action section', () => {
    const result = briefValidator.validate(BAD_BRIEF_MISSING_PRIORITY)
    const priorityCheck = result.checks.find(c => c.name === 'priority-action-present')
    expect(priorityCheck?.passed).toBe(false)
  })

  test('fails output with placeholder text', () => {
    const result = briefValidator.validate(BAD_BRIEF_PLACEHOLDERS)
    const placeholderCheck = result.checks.find(c => c.name === 'no-placeholder-text')
    expect(placeholderCheck?.passed).toBe(false)
  })

  test('detects thin sections under 30 words', () => {
    const result = briefValidator.validate(BAD_BRIEF_EMPTY_SECTIONS)
    const depthCheck = result.checks.find(c => c.name === 'min-words-per-section')
    expect(depthCheck?.passed).toBe(false)
  })

  test('detects missing NEXT ACTION line', () => {
    const briefWithoutNextAction = GOOD_BRIEF.replace(/NEXT ACTION:.*/, '')
    const result = briefValidator.validate(briefWithoutNextAction)
    const nextActionCheck = result.checks.find(c => c.name === 'next-action-line')
    expect(nextActionCheck?.passed).toBe(false)
  })

  test('detects missing Data Freshness', () => {
    const briefWithoutFreshness = GOOD_BRIEF.replace(/DATA FRESHNESS:[\s\S]*?NEXT ACTION/, 'NEXT ACTION')
    const result = briefValidator.validate(briefWithoutFreshness)
    const freshnessCheck = result.checks.find(c => c.name === 'data-freshness')
    expect(freshnessCheck?.passed).toBe(false)
  })

  test('bad output scores below threshold', () => {
    const result = briefValidator.validate(BAD_BRIEF_MISSING_PRIORITY)
    expect(result.passed).toBe(false)
  })

  test('returns correct content type', () => {
    const result = briefValidator.validate(GOOD_BRIEF)
    expect(result.contentType).toBe('customer-brief')
  })

  test('pass threshold is 70', () => {
    expect(briefValidator.passThreshold).toBe(70)
  })
})
