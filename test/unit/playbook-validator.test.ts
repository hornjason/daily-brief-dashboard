/**
 * Playbook Validator Tests — ADR-024
 */

import { describe, it, expect } from 'bun:test'
import { playbookValidator } from '../../src/quality-validators/playbook-validator.ts'
import type { PlaybookState } from '../../src/playbook-types.ts'

describe('playbook-validator', () => {
  it('should pass on gold standard output', () => {
    const goldStandard: PlaybookState = {
      version: 1,
      customerSlug: 'acme-corp',
      customerName: 'Acme Corp',
      generatedAt: new Date().toISOString(),
      lastMeetingNoteAt: null,
      sections: {
        strategicPosition: {
          content: 'Acme Corp is a Fortune 500 enterprise transitioning to cloud-native infrastructure. Their strategic focus is modernizing legacy systems while maintaining operational stability. Key drivers: cost reduction, developer velocity, security posture.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        keyRelationships: {
          content: 'Primary contacts: CTO Sarah Chen (modernization champion), VP Eng Mike Johnson (budget owner). Strong relationship with DevOps team.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        currentPriorities: {
          content: 'Q2 priorities: migrate payment processing to containers, implement GitOps pipeline, establish security baselines.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        productAlignment: {
          products: [
            {
              productSlug: 'openshift',
              displayName: 'OpenShift',
              confidence: 'HIGH',
              useCase: 'Container platform for payment processing workloads',
              proofPoints: 'Running 3 pilot apps successfully',
              whatsNew: 'OpenShift 4.18 released with improved observability',
              lifecycle: 'Version 4.17 (EOL: 2027-01-15)',
              featureTalkingPoints: 'GitOps integration, zero-downtime upgrades',
              dashboardLink: '/dashboard/products/openshift',
            },
            {
              productSlug: 'ansible',
              displayName: 'Ansible',
              confidence: 'MEDIUM',
              useCase: 'Config management for hybrid infrastructure',
              proofPoints: 'Proof of concept underway',
              whatsNew: 'Ansible Automation Platform 2.5 released',
              lifecycle: 'Version 2.4 (EOL: 2026-08-01)',
              featureTalkingPoints: 'Event-driven automation, controller HA',
              dashboardLink: '/dashboard/products/ansible',
            },
          ],
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        openActionItems: {
          items: [],
          updatedAt: new Date().toISOString(),
        },
        engagementHistory: {
          entries: [],
          updatedAt: new Date().toISOString(),
        },
        expansionOpportunities: {
          content: 'Potential expansion into observability stack (Service Interconnect, RHEL System Roles).',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        renewalsAndRisk: {
          content: 'Current subscription expires Q4 2026. No identified renewal risk. Budget approved for expansion.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        swotAnalysis: {
          content: 'Strengths: strong technical team with deep infrastructure experience. Weaknesses: limited cloud-native expertise and skills gaps. Opportunities: modernization budget approved for cloud migration. Threats: competing priorities and vendor lock-in concerns.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        meddpicc: {
          entries: [
            { field: 'metrics', status: 'known', evidence: 'ROI analysis complete' },
            { field: 'economic-buyer', status: 'known', evidence: 'CFO approved budget' },
            { field: 'decision-criteria', status: 'known', evidence: 'Security and TCO are primary' },
            { field: 'decision-process', status: 'known', evidence: 'Q3 evaluation timeline' },
            { field: 'paper-process', status: 'known', evidence: 'Standard procurement flow' },
            { field: 'identify-pain', status: 'known', evidence: 'Legacy system maintenance costs' },
            { field: 'champion', status: 'known', evidence: 'CTO Sarah Chen' },
            { field: 'competition', status: 'known', evidence: 'AWS and VMware in evaluation' },
          ],
          updatedAt: new Date().toISOString(),
        },
      },
      deterministic: {
        subscriptions: [],
        cases: [],
        lifecycle: [],
        teamMembers: [],
      },
      sources: [],
    }

    const result = playbookValidator.validate(JSON.stringify(goldStandard, null, 2))

    expect(result.passed).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(playbookValidator.passThreshold)
    expect(result.failures.length).toBe(0)
  })

  it('should fail on minimal output', () => {
    const minimal: Partial<PlaybookState> = {
      version: 1,
      customerSlug: 'minimal',
      customerName: 'Minimal Corp',
      generatedAt: new Date().toISOString(),
      lastMeetingNoteAt: null,
      sections: {
        strategicPosition: {
          content: 'Short',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        keyRelationships: {
          content: 'X',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        currentPriorities: {
          content: 'Y',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        productAlignment: {
          products: [],
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        openActionItems: {
          items: [],
          updatedAt: new Date().toISOString(),
        },
        engagementHistory: {
          entries: [],
          updatedAt: new Date().toISOString(),
        },
        expansionOpportunities: {
          content: '',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        renewalsAndRisk: {
          content: '',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
      } as any,
      deterministic: {
        subscriptions: [],
        cases: [],
        lifecycle: [],
        teamMembers: [],
      },
      sources: [],
    }

    const result = playbookValidator.validate(JSON.stringify(minimal, null, 2))

    expect(result.passed).toBe(false)
    expect(result.score).toBeLessThan(playbookValidator.passThreshold)
    expect(result.failures.length).toBeGreaterThan(0)

    // Specific failures expected
    const failureNames = result.failures.map(f => f.name)
    expect(failureNames).toContain('strategic-position') // < 100 chars
    expect(failureNames).toContain('key-relationships') // < 50 chars
    expect(failureNames).toContain('current-priorities') // < 50 chars
    expect(failureNames).toContain('product-alignment-count') // 0 products
    expect(failureNames).toContain('expansion-opportunities') // empty
    expect(failureNames).toContain('renewals-risk') // empty
  })

  it('should fail on invalid JSON', () => {
    const result = playbookValidator.validate('{ invalid json }')

    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
    expect(result.failures.length).toBe(1)
    expect(result.failures[0].name).toBe('json-parse')
  })

  it('should identify failures for products lacking confidence', () => {
    const state: PlaybookState = {
      version: 1,
      customerSlug: 'test',
      customerName: 'Test Corp',
      generatedAt: new Date().toISOString(),
      lastMeetingNoteAt: null,
      sections: {
        strategicPosition: {
          content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        keyRelationships: {
          content: 'Key contacts include CTO and VP Engineering teams.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        currentPriorities: {
          content: 'Modernizing infrastructure and improving security posture.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        productAlignment: {
          products: [
            {
              productSlug: 'openshift',
              displayName: 'OpenShift',
              confidence: '' as any, // Invalid confidence
              useCase: 'Container platform',
              proofPoints: '',
              whatsNew: '',
              lifecycle: '',
              featureTalkingPoints: '',
              dashboardLink: '/dashboard/products/openshift',
            },
          ],
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        openActionItems: {
          items: [],
          updatedAt: new Date().toISOString(),
        },
        engagementHistory: {
          entries: [],
          updatedAt: new Date().toISOString(),
        },
        expansionOpportunities: {
          content: 'Potential expansion opportunities exist.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        renewalsAndRisk: {
          content: 'No significant renewal risks identified.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        swotAnalysis: {
          content: 'Strengths: strong engineering team with deep expertise. Weaknesses: limited cloud skills. Opportunities: budget approved. Threats: vendor lock-in.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        meddpicc: {
          entries: [
            { field: 'metrics', status: 'known', evidence: 'test' },
            { field: 'economic-buyer', status: 'known', evidence: 'test' },
            { field: 'decision-criteria', status: 'known', evidence: 'test' },
            { field: 'decision-process', status: 'known', evidence: 'test' },
            { field: 'paper-process', status: 'known', evidence: 'test' },
            { field: 'identify-pain', status: 'known', evidence: 'test' },
            { field: 'champion', status: 'known', evidence: 'test' },
            { field: 'competition', status: 'known', evidence: 'test' },
          ],
          updatedAt: new Date().toISOString(),
        },
      },
      deterministic: {
        subscriptions: [],
        cases: [],
        lifecycle: [],
        teamMembers: [],
      },
      sources: [],
    }

    const result = playbookValidator.validate(JSON.stringify(state, null, 2))

    // Score will be 78% (7/9 checks pass) which still passes threshold of 75%
    // But should identify the specific failures
    const failureNames = result.failures.map(f => f.name)
    expect(failureNames).toContain('product-alignment-confidence')
    expect(failureNames).toContain('product-alignment-proof-points')
    expect(result.failures.length).toBe(2)
  })

  it('should identify failure when products lack dashboard links', () => {
    const state: PlaybookState = {
      version: 1,
      customerSlug: 'test',
      customerName: 'Test Corp',
      generatedAt: new Date().toISOString(),
      lastMeetingNoteAt: null,
      sections: {
        strategicPosition: {
          content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        keyRelationships: {
          content: 'Key contacts include CTO and VP Engineering teams.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        currentPriorities: {
          content: 'Modernizing infrastructure and improving security posture.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        productAlignment: {
          products: [
            {
              productSlug: 'openshift',
              displayName: 'OpenShift',
              confidence: 'HIGH',
              useCase: 'Container platform',
              proofPoints: 'Running 5 production workloads',
              whatsNew: '',
              lifecycle: '',
              featureTalkingPoints: '',
              dashboardLink: '', // Missing link
            },
          ],
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        openActionItems: {
          items: [],
          updatedAt: new Date().toISOString(),
        },
        engagementHistory: {
          entries: [],
          updatedAt: new Date().toISOString(),
        },
        expansionOpportunities: {
          content: 'Potential expansion opportunities exist.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        renewalsAndRisk: {
          content: 'No significant renewal risks identified.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        swotAnalysis: {
          content: 'Strengths: strong engineering team with deep expertise. Weaknesses: limited cloud skills. Opportunities: budget approved. Threats: vendor lock-in.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        meddpicc: {
          entries: [
            { field: 'metrics', status: 'known', evidence: 'test' },
            { field: 'economic-buyer', status: 'known', evidence: 'test' },
            { field: 'decision-criteria', status: 'known', evidence: 'test' },
            { field: 'decision-process', status: 'known', evidence: 'test' },
            { field: 'paper-process', status: 'known', evidence: 'test' },
            { field: 'identify-pain', status: 'known', evidence: 'test' },
            { field: 'champion', status: 'known', evidence: 'test' },
            { field: 'competition', status: 'known', evidence: 'test' },
          ],
          updatedAt: new Date().toISOString(),
        },
      },
      deterministic: {
        subscriptions: [],
        cases: [],
        lifecycle: [],
        teamMembers: [],
      },
      sources: [],
    }

    const result = playbookValidator.validate(JSON.stringify(state, null, 2))

    // Score will be 89% (8/9 checks pass) which passes threshold
    // But should identify the specific failure
    const failureNames = result.failures.map(f => f.name)
    expect(failureNames).toContain('product-alignment-links')
    expect(result.failures.length).toBe(1)
  })

  it('should pass when empty products array with all other fields valid', () => {
    const state: PlaybookState = {
      version: 1,
      customerSlug: 'test',
      customerName: 'Test Corp',
      generatedAt: new Date().toISOString(),
      lastMeetingNoteAt: null,
      sections: {
        strategicPosition: {
          content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        keyRelationships: {
          content: 'Key contacts include CTO and VP Engineering teams with strong relationships.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        currentPriorities: {
          content: 'Modernizing infrastructure and improving security posture for Q2.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        productAlignment: {
          products: [],
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        openActionItems: {
          items: [],
          updatedAt: new Date().toISOString(),
        },
        engagementHistory: {
          entries: [],
          updatedAt: new Date().toISOString(),
        },
        expansionOpportunities: {
          content: 'Potential expansion opportunities exist in observability and automation.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
        renewalsAndRisk: {
          content: 'No significant renewal risks identified at this time.',
          updatedAt: new Date().toISOString(),
          sourceNotes: [],
        },
      },
      deterministic: {
        subscriptions: [],
        cases: [],
        lifecycle: [],
        teamMembers: [],
      },
      sources: [],
    }

    const result = playbookValidator.validate(JSON.stringify(state, null, 2))

    // Should fail because of no products, but other sections pass
    expect(result.passed).toBe(false)
    const failureNames = result.failures.map(f => f.name)
    expect(failureNames).toContain('product-alignment-count')
    expect(failureNames).toContain('product-alignment-confidence')
    expect(failureNames).toContain('product-alignment-proof-points')
    expect(failureNames).toContain('product-alignment-links')

    // But these should pass
    expect(failureNames).not.toContain('strategic-position')
    expect(failureNames).not.toContain('key-relationships')
    expect(failureNames).not.toContain('current-priorities')
    expect(failureNames).not.toContain('expansion-opportunities')
    expect(failureNames).not.toContain('renewals-risk')
  })
})
