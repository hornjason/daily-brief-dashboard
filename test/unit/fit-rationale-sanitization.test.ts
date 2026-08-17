/**
 * Regression test for #1128 — subscription count leak in fit rationale
 *
 * The "Why Strong Fit" section must NOT leak subscription counts, pipeline data,
 * or other creepy internal data to external-audience campaign output.
 */

import { describe, it, expect } from 'bun:test'
import { renderFitFromPass0 } from '../../src/campaign-html-template.ts'
import type { PersonaBrief } from '../../src/lib/persona-selector.ts'

describe('renderFitFromPass0 — subscription count sanitization (#1128)', () => {
  it('strips subscription counts from installedBase before rendering', () => {
    const customerName = 'Acme Corp'
    const pass0Briefs: PersonaBrief[] = [
      {
        persona: 'technical-evaluator',
        timingTrigger: 'Infrastructure modernization initiative underway',
        valueProposition: 'Ansible automates configuration management across hybrid cloud',
        installedBase: 'They run RHEL in production with 57 subscriptions across three data centers. OpenShift Container Platform deployment.',
        objectiveMatch: 'Reduce operational complexity',
        reasoning: 'test',
        evidenceCount: 2,
      },
    ]

    const result = renderFitFromPass0(customerName, pass0Briefs)

    // The output should NOT contain subscription count text
    expect(result).not.toContain('57 subscriptions')
    expect(result).not.toContain('subscriptions')

    // The sentence with subscription count should be removed entirely
    // But the remaining sentence should still be present
    expect(result).toContain('OpenShift Container Platform deployment')
    expect(result).toContain('Product alignment')
  })

  it('strips multiple subscription count patterns from installedBase', () => {
    const customerName = 'Beta Inc'
    const pass0Briefs: PersonaBrief[] = [
      {
        persona: 'champion',
        timingTrigger: 'Cloud migration',
        valueProposition: 'Test value prop',
        installedBase: 'Running 120 RHEL subscriptions and 45 OpenShift nodes in production',
        objectiveMatch: 'Cost optimization',
        reasoning: 'test',
        evidenceCount: 1,
      },
    ]

    const result = renderFitFromPass0(customerName, pass0Briefs)

    expect(result).not.toContain('120 RHEL subscriptions')
    expect(result).not.toContain('45 OpenShift nodes')
    expect(result).not.toContain('subscriptions')
    expect(result).not.toContain('nodes')
  })

  it('handles empty installedBase after sanitization', () => {
    const customerName = 'Gamma Ltd'
    const pass0Briefs: PersonaBrief[] = [
      {
        persona: 'executive-sponsor',
        timingTrigger: 'Digital transformation',
        valueProposition: 'Cloud-native platform',
        installedBase: '57 subscriptions currently active', // Will be fully stripped
        objectiveMatch: 'Accelerate innovation',
        reasoning: 'test',
        evidenceCount: 1,
      },
    ]

    const result = renderFitFromPass0(customerName, pass0Briefs)

    // Should render other sections but not the Product alignment section
    expect(result).toContain('What\'s happening now')
    expect(result).toContain('Digital transformation')
    expect(result).not.toContain('Product alignment')
  })
})
