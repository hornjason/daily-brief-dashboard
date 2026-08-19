import { describe, it, expect } from 'bun:test'
import { generateCampaignFromStructured } from '../../../src/campaign-html-template.ts'

describe('generateCampaignFromStructured (dashboard)', () => {
  const minimalSelection = {
    campaignSummary: 'Test campaign',
    customerContext: 'Test context',
    positioning: 'Test positioning',
    emails: [] as any[],
  }

  const minimalData = {
    resolvedExecs: [],
    signals: [],
    voiceProfile: null,
    accountTeam: [],
    subscriptions: [],
    structuredPlays: [],
    customerName: 'Test Corp',
    materialTitle: 'Test Material',
    materialUrl: 'https://test.com',
    generatedDate: 'May 13, 2026',
    enablePolish: false,
  }

  it('should generate HTML with core structure and branding', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...minimalData,
      materialTitle: 'Cloud Migration Strategy Guide',
      materialUrl: 'https://docs.google.com/document/d/test123/edit',
      customerName: 'Test Corporation',
      accountTeam: [{ name: 'Carolanne Farrell', title: 'Account Executive', role: 'ae' }],
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('#c41e3a')
    expect(html).toContain('Content Campaign: Cloud Migration Strategy Guide')
    expect(html).toContain('Test Corporation')
    expect(html).toContain('Carolanne Farrell')
    expect(html).toContain('Email Templates by Role')
  })

  it('should escape HTML special characters', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, {
      ...minimalData,
      materialTitle: 'Test <script>',
      customerName: 'Test & Co.',
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('should include all intelligence dashboard metrics', async () => {
    const html = await generateCampaignFromStructured(minimalSelection, minimalData)

    expect(html).toContain('Annual Revenue')
    expect(html).toContain('Employees')
  })
})
