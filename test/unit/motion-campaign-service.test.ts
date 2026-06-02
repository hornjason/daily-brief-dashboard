/**
 * test/unit/motion-campaign-service.test.ts
 * TDD tests for motion-campaign-service (#518)
 *
 * Mocks callGemini to avoid real API calls.
 * Validates: email count, template tiers, motion context inclusion, empty edge case.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ── Mock callGemini before importing the module under test ──────────────────

const mockCallGemini = mock(async (_sys: string, _user: string, _opts: any) => ({
  text: 'Subject: Industry shift in automated operations\n\nMock email body with observation and peer proof.',
  cached: false,
  inputTokens: 100,
  outputTokens: 50,
  model: 'gemini-2.5-flash',
}))

// Mock the gemini-call module
mock.module('../../src/gemini-call.ts', () => ({
  callGemini: mockCallGemini,
}))

// Import after mocking
const { generateMotionCampaigns } = await import('../../src/lib/motion-campaign-service.ts')
import type { StrategicMotion, MotionPhase } from '../../src/lib/motion-builder.ts'

// ── Test fixtures ──────────────────────────────────────────────────────────

function makePhase(overrides: Partial<MotionPhase> = {}): MotionPhase {
  return {
    id: 'phase-1-anchor',
    name: 'Anchor: Protect Automation Base',
    category: 'anchor',
    urgency: 'critical',
    tactics: [
      {
        name: 'Ansible Premium Renewal',
        parentTdp: 'Automation',
        assets: [{ name: 'Renewal Brief', url: 'https://example.com/brief', type: 'document' }],
      },
    ],
    targetPersonas: ['VP of Infrastructure', 'Director of Operations'],
    evidence: [
      { module: 'subscriptions', fact: 'Ansible expired 2026-01-15' },
    ],
    ...overrides,
  }
}

function makeMotion(overrides: Partial<StrategicMotion> = {}): StrategicMotion {
  return {
    id: 'motion:acme-corp',
    customerSlug: 'acme-corp',
    customerName: 'ACME Corp',
    title: 'Hybrid Cloud Modernization for ACME Corp',
    salesPlay: 'Hybrid Cloud Modernization',
    phases: [
      makePhase(),
      makePhase({
        id: 'phase-2-expand',
        name: 'Expand: Cloud Marketplace Growth',
        category: 'expand',
        urgency: 'high',
        targetPersonas: ['CTO', 'Cloud Architect'],
        tactics: [
          {
            name: 'Cloud Commitment Program',
            parentTdp: 'Server and Cloud Computing',
            assets: [{ name: 'Cloud Guide', url: 'https://example.com/cloud', type: 'document' }],
          },
        ],
        evidence: [
          { module: 'ccsp', fact: 'AWS cloud spend: $450,000 ACV' },
        ],
      }),
    ],
    confidence: 'high',
    totalEstimatedTcv: 500000,
    generatedAt: '2026-05-31T00:00:00.000Z',
    status: 'active',
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('motion-campaign-service', () => {
  beforeEach(() => {
    mockCallGemini.mockClear()
  })

  it('produces one email per persona per phase', async () => {
    const motion = makeMotion()
    // Phase 1: 2 personas, Phase 2: 2 personas → 4 emails total
    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    expect(result.emails).toHaveLength(4)
    expect(result.motionTitle).toBe('Hybrid Cloud Modernization for ACME Corp')
    expect(result.generatedAt).toBeTruthy()

    // Verify phase distribution
    const phase1Emails = result.emails.filter(e => e.phaseId === 'phase-1-anchor')
    const phase2Emails = result.emails.filter(e => e.phaseId === 'phase-2-expand')
    expect(phase1Emails).toHaveLength(2)
    expect(phase2Emails).toHaveLength(2)

    // Verify Gemini was called 4 times (once per email)
    expect(mockCallGemini).toHaveBeenCalledTimes(4)
  })

  it('executive personas get 90-word tier', async () => {
    const motion = makeMotion({
      phases: [
        makePhase({
          targetPersonas: ['VP of Infrastructure', 'SVP Engineering', 'CTO'],
        }),
      ],
    })

    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    // VP, SVP, CTO are all executive tier
    for (const email of result.emails) {
      expect(email.templateTier).toBe('executive')
    }

    // Verify the system prompt mentions 90-word limit for each call
    for (const call of mockCallGemini.mock.calls) {
      const systemPrompt = call[0] as string
      expect(systemPrompt).toContain('90 words')
    }
  })

  it('manager personas get 200-word tier', async () => {
    const motion = makeMotion({
      phases: [
        makePhase({
          targetPersonas: ['Director of Operations', 'Manager of DevOps', 'Senior Architect'],
        }),
      ],
    })

    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    // None of these are VP/SVP/EVP/CxO/Chief → manager tier
    for (const email of result.emails) {
      expect(email.templateTier).toBe('manager')
    }

    // Verify the system prompt mentions 200-250 word limit for each call
    for (const call of mockCallGemini.mock.calls) {
      const systemPrompt = call[0] as string
      expect(systemPrompt).toContain('200-250 words')
    }
  })

  it('emails include motion context not just product', async () => {
    const motion = makeMotion()

    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    // Verify the user prompt sent to Gemini includes motion-level context
    for (const call of mockCallGemini.mock.calls) {
      const userPrompt = call[1] as string
      expect(userPrompt).toContain('Hybrid Cloud Modernization for ACME Corp')
      // Should reference the strategic motion, not just individual products
      expect(userPrompt).toContain('strategic motion')
    }
  })

  it('returns empty when motion has no phases', async () => {
    const motion = makeMotion({ phases: [] })

    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    expect(result.emails).toHaveLength(0)
    expect(result.motionTitle).toBe('Hybrid Cloud Modernization for ACME Corp')
    expect(mockCallGemini).not.toHaveBeenCalled()
  })

  it('filters to specific phases when requested', async () => {
    const motion = makeMotion()

    const result = await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
      phases: ['phase-1-anchor'],
    })

    // Only phase 1 with 2 personas → 2 emails
    expect(result.emails).toHaveLength(2)
    expect(result.emails.every(e => e.phaseId === 'phase-1-anchor')).toBe(true)
    expect(mockCallGemini).toHaveBeenCalledTimes(2)
  })

  it('callGemini options use campaign-generation callType', async () => {
    const motion = makeMotion({ phases: [makePhase({ targetPersonas: ['CTO'] })] })

    await generateMotionCampaigns({
      motion,
      customerSlug: 'acme-corp',
      customerName: 'ACME Corp',
    })

    expect(mockCallGemini).toHaveBeenCalledTimes(1)
    const opts = mockCallGemini.mock.calls[0][2]
    expect(opts.callType).toBe('motion-campaign-generation')
    expect(opts.customerName).toBe('ACME Corp')
  })
})
