/**
 * Unit tests for playbookToMarkdown -- converts PlaybookState to markdown
 * for Google Docs API rendering via markdownToDocsRequests.
 * GitHub Issue #314
 */

import { describe, test, expect } from 'bun:test'
import { playbookToMarkdown } from '../../src/playbook-to-markdown.ts'
import type { PlaybookState } from '../../src/playbook-types.ts'

function makePlaybook(overrides?: Partial<PlaybookState>): PlaybookState {
  return {
    version: 1,
    customerSlug: 'acme-corp',
    customerName: 'Acme Corp',
    generatedAt: '2026-05-24T00:00:00.000Z',
    lastMeetingNoteAt: null,
    sections: {
      strategicPosition: {
        content: '- Strong presence in **cloud native** infrastructure',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      keyRelationships: {
        content: '| Name | Role | Focus Area |\n|---|---|---|\n| Jane Doe | VP Infra | Cloud migration |',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      currentPriorities: {
        content: '- Migrating to **OpenShift** for container orchestration',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      productAlignment: {
        products: [
          {
            productSlug: 'ocp',
            displayName: 'OpenShift Container Platform',
            confidence: 'HIGH',
            useCase: 'Primary container orchestration platform for cloud-native migration.',
            proofPoints: '40% reduction in deployment time | 30% infrastructure cost savings',
            whatsNew: 'New AI/ML operator support; Enhanced security scanning',
            lifecycle: 'v4.15 (GA: 2024-03-01, EOL: 2025-09-01)',
            featureTalkingPoints: 'Pipelines (GA): CI/CD built-in; Virtualization (Beta): VM workloads',
            dashboardLink: '/dashboard/products/ocp',
          },
        ],
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      openActionItems: {
        items: [
          {
            id: 'ai-1',
            text: 'Schedule OpenShift POC',
            owner: 'Jane Doe',
            sourceNoteId: null,
            createdAt: '2026-05-24T00:00:00.000Z',
            completedAt: null,
            status: 'open',
          },
          {
            id: 'ai-2',
            text: 'Review subscription renewal',
            owner: 'Bob Smith',
            sourceNoteId: 'doc-1',
            createdAt: '2026-05-20T00:00:00.000Z',
            completedAt: '2026-05-22T00:00:00.000Z',
            status: 'completed',
          },
        ],
        updatedAt: '2026-05-24T00:00:00.000Z',
      },
      engagementHistory: {
        entries: [
          {
            date: '2026-05-20',
            type: 'meeting',
            summary: 'Discussed OpenShift migration timeline.',
            sourceNoteId: 'doc-1',
            attendees: ['Jane Doe', 'Bob Smith'],
          },
        ],
        updatedAt: '2026-05-24T00:00:00.000Z',
      },
      expansionOpportunities: {
        content: '- **Ansible Automation Platform (HIGH):** Observed manual provisioning. Business value: 60% reduction in provisioning time.',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      renewalsAndRisk: {
        content: '- **RHEL renewal due 2026-07-15** -- 90-day window active\n- Risk: competitor evaluation of VMware alternatives',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      swotAnalysis: {
        content: '### Strengths\n- Active OpenShift subscriptions\n### Weaknesses\n- No Ansible adoption yet',
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
      meddpicc: {
        entries: [
          {
            field: 'M',
            displayName: 'Metrics',
            status: 'confirmed',
            evidence: 'Customer targets 40% deployment time reduction.',
            sourceNoteId: null,
            updatedAt: '2026-05-24T00:00:00.000Z',
          },
          {
            field: 'E',
            displayName: 'Economic Buyer',
            status: 'developing',
            evidence: 'VP Infra likely controls budget.',
            sourceNoteId: null,
            updatedAt: '2026-05-24T00:00:00.000Z',
          },
        ],
        qualificationScore: 13,
        updatedAt: '2026-05-24T00:00:00.000Z',
        sourceNotes: [],
      },
    },
    deterministic: {
      subscriptions: [
        {
          sku: 'MCT3718',
          productDescription: 'Red Hat OpenShift Container Platform',
          quantity: 50,
          status: 'Active',
          startDate: '2025-01-01',
          endDate: '2026-12-31',
        },
      ],
      cases: [
        {
          caseNumber: '03456789',
          summary: 'OCP upgrade issue from 4.14 to 4.15',
          status: 'Waiting on Red Hat',
          severity: '2',
          product: 'OpenShift',
          daysOpen: 5,
        },
      ],
      lifecycle: [
        {
          productSlug: 'ocp',
          displayName: 'OpenShift Container Platform',
          currentVersion: '4.15',
          gaDate: '2024-03-01',
          eolDate: '2025-09-01',
          nextVersion: '4.16',
          nextExpected: '2024-09-01',
        },
      ],
      teamMembers: [],
      solutionPlays: [
        {
          tdp: 'TDP-CLOUD',
          playName: 'Cloud-Native Modernization',
          triggerTechnologies: ['Docker', 'Kubernetes'],
          talkTrack: 'Modernize legacy workloads with OpenShift.',
          customerWins: ['Acme saved 30% on infra costs'],
          linkedAssets: [{ name: 'Case Study', url: 'https://example.com/case' }],
          confidence: 'HIGH',
        },
      ],
    },
    sources: [],
  }
}

describe('playbookToMarkdown', () => {
  test('produces a string starting with the playbook title', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md.startsWith('# Customer Engagement Playbook: Acme Corp')).toBe(true)
  })

  test('includes all major section headings', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('## Strategic Position')
    expect(md).toContain('## SWOT Analysis')
    expect(md).toContain('## Key Relationships')
    expect(md).toContain('## Current Priorities')
    expect(md).toContain('## MEDDPICC Qualification')
    expect(md).toContain('## Product Alignment')
    expect(md).toContain('## Solution Plays')
    expect(md).toContain('## Open Action Items')
    expect(md).toContain('## Engagement History')
    expect(md).toContain('## Expansion Opportunities')
    expect(md).toContain('## Renewals and Risk')
  })

  test('passes section content through unchanged', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('Strong presence in **cloud native** infrastructure')
    expect(md).toContain('Migrating to **OpenShift** for container orchestration')
  })

  test('renders product alignment entries with confidence and use case', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('OpenShift Container Platform')
    expect(md).toContain('HIGH')
    expect(md).toContain('Primary container orchestration platform')
  })

  test('renders product proof points', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('40% reduction in deployment time')
  })

  test('renders action items with status', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('Schedule OpenShift POC')
    expect(md).toContain('OPEN')
    expect(md).toContain('Review subscription renewal')
    expect(md).toContain('COMPLETED')
  })

  test('renders engagement history entries', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('2026-05-20')
    expect(md).toContain('Discussed OpenShift migration timeline')
    expect(md).toContain('Jane Doe, Bob Smith')
  })

  test('renders MEDDPICC entries with status and evidence', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('Metrics')
    expect(md).toContain('CONFIRMED')
    expect(md).toContain('Customer targets 40% deployment time reduction')
    expect(md).toContain('DEVELOPING')
  })

  test('renders MEDDPICC qualification score', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('Qualification Score: 13%')
  })

  test('renders solution plays', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('Cloud-Native Modernization')
    expect(md).toContain('TDP-CLOUD')
    expect(md).toContain('Docker, Kubernetes')
  })

  test('renders subscriptions table', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('MCT3718')
    expect(md).toContain('Red Hat OpenShift Container Platform')
    expect(md).toContain('50')
  })

  test('renders cases table', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('03456789')
    expect(md).toContain('OCP upgrade issue')
    expect(md).toContain('Waiting on Red Hat')
  })

  test('handles empty action items gracefully', () => {
    const pb = makePlaybook()
    pb.sections.openActionItems.items = []
    const md = playbookToMarkdown(pb)
    expect(md).toContain('No action items')
  })

  test('handles empty engagement history gracefully', () => {
    const pb = makePlaybook()
    pb.sections.engagementHistory.entries = []
    const md = playbookToMarkdown(pb)
    expect(md).toContain('No engagement history')
  })

  test('handles empty product alignment gracefully', () => {
    const pb = makePlaybook()
    pb.sections.productAlignment.products = []
    const md = playbookToMarkdown(pb)
    expect(md).toContain('No product alignment data')
  })

  test('handles missing meddpicc section gracefully', () => {
    const pb = makePlaybook()
    // @ts-expect-error -- testing missing section
    pb.sections.meddpicc = undefined
    const md = playbookToMarkdown(pb)
    expect(md).toContain('## MEDDPICC Qualification')
    expect(md).toContain('No MEDDPICC data')
  })

  test('output is valid input for markdownToDocsRequests', () => {
    const { markdownToDocsRequests } = require('../../src/lib/markdown-to-docs.ts')
    const md = playbookToMarkdown(makePlaybook())
    const result = markdownToDocsRequests(md)
    expect(result.requests.length).toBeGreaterThan(0)
    expect(result.plainText.length).toBeGreaterThan(0)
    const headingReqs = result.requests.filter(
      (r: any) => r.updateParagraphStyle?.paragraphStyle?.namedStyleType,
    )
    expect(headingReqs.length).toBeGreaterThan(0)
  })

  test('includes generated date in subtitle', () => {
    const md = playbookToMarkdown(makePlaybook())
    expect(md).toContain('May 24, 2026')
  })
})
