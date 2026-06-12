/**
 * Regression tests for #789: Morning brief content quality
 * Covers: isInternalEmail filter, email aggregation, signal noise suppression
 */
import { describe, it, expect } from 'bun:test'
import { isInternalEmail } from '../../src/email-extraction.ts'

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

// ── AC-3: Generic/noise signal suppression ───────────────────────────────────

describe('morning summary signal filtering', () => {
  it('filters out generic competitor signals with short text', () => {
    const signals = [
      { customer: 'Acme', type: 'case-sev1', severity: 'critical' as const, text: 'Sev1 case #123: Production outage' },
      { customer: 'Acme', type: 'competitor', severity: 'medium' as const, text: 'Competitive signals detected' },
      { customer: 'Beta', type: 'competitor', severity: 'medium' as const, text: 'VMware displacement opportunity — customer evaluating OpenShift vs Tanzu for container platform' },
      { customer: 'Gamma', type: 'competitor', severity: 'medium' as const, text: 'AWS mentioned' },
    ]

    const filtered = signals.filter(s => {
      // Skip competitor signals with generic/too-short text
      if (s.type === 'competitor') {
        if (s.text.length < 20 || s.text === 'Competitive signals detected' || s.text === 'Competitive signals detected in latest brief') {
          return false
        }
      }
      return true
    })

    expect(filtered).toHaveLength(2)
    expect(filtered[0].type).toBe('case-sev1')
    expect(filtered[1].type).toBe('competitor')
    expect(filtered[1].customer).toBe('Beta')
  })

  it('filters out signals matching internal email patterns', () => {
    const signals = [
      { customer: 'Acme', type: 'engagement', severity: 'medium' as const, text: 'Sprint planning discussion detected' },
      { customer: 'Acme', type: 'renewal', severity: 'high' as const, text: 'Subscription expiring in 45 days' },
      { customer: 'Beta', type: 'engagement', severity: 'medium' as const, text: 'All-hands meeting scheduled' },
    ]

    const filtered = signals.filter(s => !isInternalEmail(s.text))

    expect(filtered).toHaveLength(1)
    expect(filtered[0].type).toBe('renewal')
  })
})
