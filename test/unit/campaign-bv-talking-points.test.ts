import { describe, it, expect } from 'bun:test'
import { generateCampaignFromStructured, type BVTalkingPoint } from '../../src/campaign-html-template.ts'

function makeMinimalStructuredData(overrides: Record<string, any> = {}) {
  return {
    campaignSummary: 'Test campaign',
    customerContext: 'Test context',
    positioning: 'Test positioning',
    emails: [{ recipientName: 'Test User', tier: 'executive', intent: 'nurture', subject: 'Test', signalIndex: 0, featureKeys: [], peerProof: null }],
    referenceMaterials: [],
    eligibilityTable: [],
    bvTalkingPoints: [] as Array<{ objective: string; talkingPoints: string; keyMetrics: string }>,
    sourceAttributions: [],
    ...overrides,
  }
}

function makeMinimalOpts(overrides: Record<string, any> = {}) {
  return {
    resolvedExecs: [],
    signals: [],
    voiceProfile: null,
    accountTeam: [],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'Test Corp',
    materialTitle: 'Test Material',
    materialUrl: 'https://test.com',
    generatedDate: '2026-08-17',
    enablePolish: false,
    ...overrides,
  }
}

describe('BV Talking Points — heading rename', () => {
  it('renders "Call Prep — Key Talking Points" heading, not "BV Talking Points"', async () => {
    const bvTalkingPoints: BVTalkingPoint[] = [
      { objective: 'Cost Efficiency', talkingPoints: 'Save money on SaaS taxes', keyMetrics: '$5M savings' },
    ]
    const selection = makeMinimalStructuredData()
    const html = await generateCampaignFromStructured(selection, makeMinimalOpts({ bvTalkingPoints }))
    expect(html).toContain('Call Prep — Key Talking Points')
    expect(html).not.toContain('BV Talking Points')
  })
})

describe('BV Talking Points — section positioning', () => {
  it('renders BV talking points BEFORE "Email Templates by Role" in generateCampaignFromStructured', async () => {
    const selection = makeMinimalStructuredData()
    const opts = makeMinimalOpts({
      bvTalkingPoints: [
        { objective: 'Revenue Growth', talkingPoints: 'Cross-sell opportunity', keyMetrics: '10K nodes' },
      ],
    })
    const html = await generateCampaignFromStructured(selection, opts)
    const bvPos = html.indexOf('Call Prep — Key Talking Points')
    const emailPos = html.indexOf('Email Templates by Role')
    expect(bvPos).toBeGreaterThan(-1)
    expect(emailPos).toBeGreaterThan(-1)
    expect(bvPos).toBeLessThan(emailPos)
  })
})

describe('BV Talking Points — absent when no data', () => {
  it('does not render when bvTalkingPoints is not provided', async () => {
    const selection = makeMinimalStructuredData()
    const html = await generateCampaignFromStructured(selection, makeMinimalOpts())
    expect(html).not.toContain('Call Prep — Key Talking Points')
    expect(html).not.toContain('BV Talking Points')
  })
})
