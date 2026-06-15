/**
 * Regression tests for #789: Morning brief content quality
 * Covers: isInternalEmail filter, email aggregation, signal noise suppression,
 *         semantic competitor validation (#793), immutable filtering (#790),
 *         XSS escaping (#799)
 */
import { describe, it, expect } from 'bun:test'
import { isInternalEmail } from '../../src/email-extraction.ts'
import { renderBriefHtml } from '../../src/email-template.ts'

// ── AC-2: isInternalEmail filter ─────────────────────────────────────────────

describe('isInternalEmail', () => {
  it('returns true for internal/operational subjects', () => {
    const internalSubjects = [
      'Team Meeting',
      'Sprint Planning',
      '1:1 with Bob',
      'Weekly standup',
      'Stand-up notes',
      'One-on-one with Sarah',
      'one on one sync',
      'All-hands meeting',
      'All hands Q3',
      'Brown bag session',
      'Lunch and learn: Kubernetes',
      'OOO next week',
      'Out of office notification',
      'PTO request',
      'Time off approval',
      'Internal review',
      'Office hours signup',
      'Townhall recap',
      'Town hall Q&A',
      'Pod meeting notes',
      'Pod call — June 12',
      'Retrospective action items',
      'Retro follow-up',
      'Planning poker session',
      'Sync on project status',
    ]
    for (const subj of internalSubjects) {
      expect(isInternalEmail(subj)).toBe(true)
    }
  })

  it('returns false for customer/business subjects', () => {
    const businessSubjects = [
      'OpenShift Migration Plan',
      'Q3 License Renewal',
      'Re: AI Discussion prep',
      'Ansible Tower deployment timeline',
      'Red Hat / Dropbox Platform Review',
      'Security vulnerability assessment',
      'Contract negotiation update',
      'POC results and next steps',
      'Budget approval for RHEL upgrade',
      'Competitive analysis — VMware displacement',
    ]
    for (const subj of businessSubjects) {
      expect(isInternalEmail(subj)).toBe(false)
    }
  })
})

// ── AC-1: Email aggregation produces BriefEmail entries ──────────────────────

describe('email aggregation', () => {
  it('maps EmailHighlight to BriefEmail format', () => {
    // This test validates the mapping logic used in background-scheduler.ts
    // We test the shape transformation inline since it's a pure data mapping
    const mockEmails = [
      {
        customer: 'Acme Corp',
        subject: 'Re: OpenShift POC',
        from: 'jane@acme.com',
        date: '2026-06-12T10:00:00Z',
        snippet: 'Wanted to discuss the POC timeline...',
        actionRequired: true,
        classification: 'ACTION_REQUIRED' as const,
      },
      {
        customer: 'Acme Corp',
        subject: 'FYI: Monthly usage report',
        from: 'reports@acme.com',
        date: '2026-06-11T08:00:00Z',
        snippet: 'Automated usage report attached',
        actionRequired: false,
        classification: 'FYI' as const,
      },
    ]

    // Simulate the mapping logic from background-scheduler
    const briefEmails = mockEmails.map(e => ({
      sender: e.from,
      customer: e.customer,
      subject: e.subject,
      snippet: e.snippet?.slice(0, 200) ?? '',
      urgency: e.classification === 'ACTION_REQUIRED' ? 'high' as const
        : e.classification === 'RESPONSE_NEEDED' ? 'medium' as const
        : 'low' as const,
      gmailLink: undefined,
    }))

    expect(briefEmails).toHaveLength(2)
    expect(briefEmails[0].sender).toBe('jane@acme.com')
    expect(briefEmails[0].urgency).toBe('high')
    expect(briefEmails[0].subject).toBe('Re: OpenShift POC')
    expect(briefEmails[1].urgency).toBe('low')
  })

  it('filters internal emails from aggregation', () => {
    const mockEmails = [
      { customer: 'Acme Corp', subject: 'OpenShift POC update', from: 'jane@acme.com', date: '2026-06-12T10:00:00Z', snippet: 'Progress update', actionRequired: true, classification: 'ACTION_REQUIRED' as const },
      { customer: 'Acme Corp', subject: 'Team Meeting notes', from: 'bob@redhat.com', date: '2026-06-12T09:00:00Z', snippet: 'Notes from standup', actionRequired: false, classification: 'FYI' as const },
      { customer: 'Acme Corp', subject: '1:1 with manager', from: 'mgr@redhat.com', date: '2026-06-12T08:00:00Z', snippet: 'Career discussion', actionRequired: false, classification: 'FYI' as const },
    ]

    const filtered = mockEmails.filter(e => !isInternalEmail(e.subject))
    expect(filtered).toHaveLength(1)
    expect(filtered[0].subject).toBe('OpenShift POC update')
  })
})

// ── AC-3: Signal suppression with semantic competitor validation (#790, #793) ─

describe('morning summary signal filtering', () => {
  // #793: Semantic validation constants (must match dashboard-service.ts)
  const COMPETITOR_BOILERPLATE = [
    'Competitive signals detected',
    'Competitive signals detected in latest brief',
  ]
  const COMPETITOR_ACTION_WORDS = [
    'evaluating', 'migration', 'migrating', 'displacement', 'replacing', 'switching',
    'versus', 'vs', 'compared', 'alternative', 'competing', 'threat', 'risk',
    'losing', 'won', 'lost',
  ]
  const MIN_COMPETITOR_TEXT_LENGTH = 15

  function filterSignals(signals: { customer: string; type: string; severity: string; text: string }[]) {
    return signals.filter(s => {
      if (isInternalEmail(s.text)) return false
      if (s.type === 'competitor') {
        const textLower = s.text.toLowerCase()
        if (
          s.text.length < MIN_COMPETITOR_TEXT_LENGTH ||
          COMPETITOR_BOILERPLATE.includes(s.text) ||
          !COMPETITOR_ACTION_WORDS.some(w => textLower.includes(w))
        ) {
          return false
        }
      }
      return true
    })
  }

  it('filters out boilerplate competitor signals', () => {
    const signals = [
      { customer: 'Acme', type: 'case-sev1', severity: 'critical', text: 'Sev1 case #123: Production outage' },
      { customer: 'Acme', type: 'competitor', severity: 'medium', text: 'Competitive signals detected' },
      { customer: 'Acme', type: 'competitor', severity: 'medium', text: 'Competitive signals detected in latest brief' },
    ]
    const filtered = filterSignals(signals)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].type).toBe('case-sev1')
  })

  it('filters out competitor signals lacking action words', () => {
    const signals = [
      { customer: 'Gamma', type: 'competitor', severity: 'medium', text: 'Some vendor was mentioned in a chat' },
      { customer: 'Beta', type: 'competitor', severity: 'medium', text: 'VMware displacement opportunity — customer evaluating OpenShift vs Tanzu for container platform' },
    ]
    const filtered = filterSignals(signals)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].customer).toBe('Beta')
  })

  it('filters out too-short competitor signals', () => {
    const signals = [
      { customer: 'Gamma', type: 'competitor', severity: 'medium', text: 'AWS mentioned' },
    ]
    const filtered = filterSignals(signals)
    expect(filtered).toHaveLength(0)
  })

  it('keeps competitor signals with action context', () => {
    const actionSignals = [
      { customer: 'A', type: 'competitor', severity: 'medium', text: 'Customer evaluating VMware alternative for containerization' },
      { customer: 'B', type: 'competitor', severity: 'medium', text: 'Risk of losing deal to Azure migration path' },
      { customer: 'C', type: 'competitor', severity: 'medium', text: 'Won competitive displacement vs Tanzu platform' },
    ]
    const filtered = filterSignals(actionSignals)
    expect(filtered).toHaveLength(3)
  })

  it('#790: filtering returns a new array without mutating the original', () => {
    const signals = [
      { customer: 'Acme', type: 'renewal', severity: 'high', text: 'Subscription expiring in 45 days' },
      { customer: 'Beta', type: 'engagement', severity: 'medium', text: 'Sprint planning discussion detected' },
    ]
    const original = [...signals]
    const filtered = filterSignals(signals)
    // Original array is unchanged
    expect(signals).toEqual(original)
    // Filtered has the internal pattern removed
    expect(filtered).toHaveLength(1)
    expect(filtered[0].type).toBe('renewal')
  })

  it('filters out signals matching internal email patterns', () => {
    const signals = [
      { customer: 'Acme', type: 'engagement', severity: 'medium', text: 'Sprint planning discussion detected' },
      { customer: 'Acme', type: 'renewal', severity: 'high', text: 'Subscription expiring in 45 days' },
      { customer: 'Beta', type: 'engagement', severity: 'medium', text: 'All-hands meeting scheduled' },
    ]

    const filtered = filterSignals(signals)

    expect(filtered).toHaveLength(1)
    expect(filtered[0].type).toBe('renewal')
  })
})

// ── #799: XSS regression test ───────────────────────────────────────────────

describe('email HTML escaping (#799)', () => {
  it('email fields are HTML-escaped in rendered output', () => {
    const maliciousEmail = {
      sender: '<script>alert(1)</script>',
      customer: '"><img src=x onerror=alert(1)>',
      subject: 'Normal subject',
      snippet: '<b>bold</b> & "quotes"',
      urgency: 'high' as const,
    }
    const html = renderBriefHtml({
      dateDisplay: 'Thursday, June 12, 2026',
      meetings: [],
      emails: [maliciousEmail],
      cases: [],
      pipeline: [],
      customerBriefs: [],
      sections: { meetings: false, emails: true, cases: false, pipeline: false, brief: false },
    })
    // Script tags must be escaped
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    // Ampersands and quotes must be escaped
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
  })
})

// ── #808: XSS test expansion — cases, pipeline, customer briefs ────────────

describe('XSS escaping — cases (#808)', () => {
  it('XSS in case fields is escaped', () => {
    const data = {
      dateDisplay: 'Test', meetings: [], emails: [], pipeline: [], customerBriefs: [],
      sections: { meetings: false, emails: false, cases: true, pipeline: false, brief: false },
      cases: [{ caseNumber: '<script>alert(1)</script>', title: '"><img onerror=alert(1)>', customer: 'Test', status: 'OPEN', age: '5d', priority: 'P1' }]
    }
    const html = renderBriefHtml(data)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('XSS escaping — pipeline (#808)', () => {
  it('XSS in pipeline fields is escaped', () => {
    const data = {
      dateDisplay: 'Test', meetings: [], emails: [], cases: [], customerBriefs: [],
      sections: { meetings: false, emails: false, cases: false, pipeline: true, brief: false },
      pipeline: [{ dealName: '<script>alert(1)</script>', customer: 'Test', stage: 'Negotiate', value: '$100', changeType: 'new' as const }]
    }
    const html = renderBriefHtml(data)
    expect(html).not.toContain('<script>alert')
  })
})

describe('XSS escaping — customer briefs (#808)', () => {
  it('XSS in customer brief fields is escaped', () => {
    const data = {
      dateDisplay: 'Test', meetings: [], emails: [], cases: [], pipeline: [],
      sections: { meetings: false, emails: false, cases: false, pipeline: false, brief: true },
      customerBriefs: [{ customerName: '<script>alert(1)</script>', briefText: '"><img onerror=alert(1)>' }]
    }
    const html = renderBriefHtml(data)
    expect(html).not.toContain('<script>alert')
  })
})

// ── #814: Internal email false positive escape hatch tests ─────────────────

describe('isInternalEmail allowlist (#814)', () => {
  it('"Cloud Planning Workshop with Fred Hutch" is NOT internal', () => {
    expect(isInternalEmail('Cloud Planning Workshop with Fred Hutch')).toBe(false)
  })

  it('"Sprint Planning" IS internal', () => {
    expect(isInternalEmail('Sprint Planning')).toBe(true)
  })

  it('"Sync with A10 Networks team" is NOT internal', () => {
    expect(isInternalEmail('Sync with A10 Networks team')).toBe(false)
  })

  it('"Team sync" IS internal', () => {
    expect(isInternalEmail('Team sync')).toBe(true)
  })
})
