/**
 * Unit tests for SalesHub knowledge extraction logic.
 * Tests the parsing/extraction functions that transform raw page data
 * into structured SalesHub knowledge objects.
 *
 * These test the pure extraction logic (no browser required).
 */

import { describe, it, expect } from 'bun:test'
import {
  parseTdpSectionsFromText,
  parseSalesTacticSections,
  buildSalesHubKnowledge,
  type SalesHubKnowledge,
  type ScrapedProduct,
  type ScrapedSalesPlay,
  type ScrapedSalesTactic,
} from '../../scripts/saleshub-knowledge-extraction.ts'

describe('parseTdpSectionsFromText', () => {
  it('extracts TDP name and description from accordion-expanded text', () => {
    const text = `
2026 Red Hat Ansible Automation Platform TDP & Sales tactics
Automation TDP
The Automation Technical Decision Point (TDP) positions Red Hat Ansible Automation Platform as the enterprise standard for IT automation across cloud, network, and security domains.
AIOps: Turn Intelligence into Action
This AIOps tactic positions Event-Driven Ansible as the automation layer that transforms monitoring insights into automated remediation actions.
Network Automation
This network automation tactic positions Ansible as the agentless multi-vendor network automation platform for Cisco, Juniper, Arista, and 50+ vendors.
Product Features
Some other content here.
    `

    const result = parseTdpSectionsFromText(text)

    expect(result.length).toBeGreaterThanOrEqual(3)

    const automationTdp = result.find(r => r.name === 'Automation TDP')
    expect(automationTdp).toBeDefined()
    expect(automationTdp!.description).toContain('Automation Technical Decision Point')

    const aiops = result.find(r => r.name.includes('AIOps'))
    expect(aiops).toBeDefined()
    expect(aiops!.description).toContain('Event-Driven Ansible')

    const network = result.find(r => r.name.includes('Network Automation'))
    expect(network).toBeDefined()
    expect(network!.description).toContain('agentless')
  })

  it('handles empty or irrelevant text gracefully', () => {
    const result = parseTdpSectionsFromText('No TDP content here at all')
    expect(result).toEqual([])
  })

  it('stops at Product Features boundary', () => {
    const text = `
2026 TDP & Sales tactics
Automation TDP
The Automation TDP positions Red Hat Ansible for enterprise automation.
Product Features
This should not be extracted as a TDP section.
    `
    const result = parseTdpSectionsFromText(text)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Automation TDP')
  })
})

describe('parseSalesTacticSections', () => {
  it('extracts tactic sections from page text', () => {
    const text = `
Agentic AI
Sales Tactic
Build and deploy agentic AI applications that move from insights to automated action on the enterprise Red Hat platform
How to use this page
Customer wins
Acme Corp deployed agentic AI on OpenShift to automate claims processing
BigCo reduced manual intervention by 80% using AI agents
What to say
Position Red Hat as the enterprise platform for deploying AI agents at scale
Highlight InstructLab for model customization without expensive retraining
What to share
Customer deck for AI agents
Services and Partner Solutions
IBM Consulting offers AI agent deployment services
Supporting TDPs and products
OpenShift AI
RHEL AI
    `

    const result = parseSalesTacticSections(text)

    expect(result.customerWins.length).toBeGreaterThanOrEqual(1)
    expect(result.whatToSay.length).toBeGreaterThanOrEqual(1)
    expect(result.whatToShare.length).toBeGreaterThanOrEqual(0)
    expect(result.talkTrack).toBeTruthy()
  })

  it('handles missing sections gracefully', () => {
    const text = `
Some Tactic
Sales Tactic
Just a basic page with no structured sections.
    `
    const result = parseSalesTacticSections(text)
    expect(result.customerWins).toEqual([])
    expect(result.whatToSay).toEqual([])
    expect(result.whatToShare).toEqual([])
  })
})

describe('buildSalesHubKnowledge', () => {
  it('assembles all node types into the knowledge structure', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'ansible-automation-platform',
        name: 'Ansible Automation Platform',
        description: 'Enterprise automation platform',
        url: 'https://saleshub.redhat.com/ansible',
        tdpSections: [
          { name: 'Automation TDP', description: 'Positions AAP for enterprise automation' },
          { name: 'AIOps Tactic', description: 'Event-driven automation' },
        ],
        salesTactics: [{ name: 'AIOps', description: 'Turn intelligence into action' }],
        googleDocsUrls: ['https://docs.google.com/document/d/abc123'],
        keyResources: [{ text: 'Competitive Guide', url: 'https://example.com/guide', type: 'external' }],
        decks: [{ text: 'Customer Deck', url: 'https://docs.google.com/presentation/d/xyz', type: 'google-slides' }],
        scrapedAt: '2026-05-21T00:00:00Z',
      },
    ]

    const salesPlays: ScrapedSalesPlay[] = [
      {
        name: 'IT Service Management Automation',
        description: 'Automate ITSM with Event-Driven Ansible',
        linkedTdps: ['Automation'],
        url: 'https://saleshub.redhat.com/plays/itsm',
      },
    ]

    const tactics: ScrapedSalesTactic[] = [
      {
        name: 'AIOps: Turn Intelligence into Action',
        talkTrack: 'Position EDA as the bridge between monitoring and automated remediation',
        customerWins: ['Acme Corp reduced MTTR by 60%'],
        whatToSay: ['Event-driven workflows replace manual troubleshooting'],
        whatToShare: [{ name: 'AIOps Deck', url: 'https://example.com/deck', type: 'seismic' }],
        parentTdp: 'Automation',
        url: 'https://saleshub.redhat.com/tactics/aiops',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, salesPlays, tactics)

    expect(knowledge.version).toBe(1)
    expect(knowledge.scrapedAt).toBeTruthy()
    expect(knowledge.products.length).toBe(1)
    expect(knowledge.salesPlays.length).toBe(1)
    expect(knowledge.tactics.length).toBe(1)
    expect(knowledge.tdps.length).toBeGreaterThanOrEqual(1)

    // Verify product structure
    expect(knowledge.products[0].name).toBe('Ansible Automation Platform')
    expect(knowledge.products[0].tdpContent.length).toBe(3) // 2 tdpSections + 1 salesTactic
    expect(knowledge.products[0].googleDocsUrls.length).toBe(1)

    // Verify sales play structure
    expect(knowledge.salesPlays[0].linkedTdps).toContain('Automation')

    // Verify tactic structure
    expect(knowledge.tactics[0].customerWins.length).toBe(1)
    expect(knowledge.tactics[0].parentTdp).toBe('Automation')

    // Verify TDP aggregation from products
    const automationTdp = knowledge.tdps.find(t => t.name === 'Automation TDP')
    expect(automationTdp).toBeDefined()
  })

  it('deduplicates TDPs by name', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'ansible',
        name: 'Ansible',
        description: 'Automation',
        url: 'https://example.com/ansible',
        tdpSections: [{ name: 'Automation TDP', description: 'From Ansible page' }],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-21T00:00:00Z',
      },
      {
        slug: 'rhel',
        name: 'RHEL',
        description: 'Enterprise Linux',
        url: 'https://example.com/rhel',
        tdpSections: [{ name: 'Automation TDP', description: 'From RHEL page' }],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-21T00:00:00Z',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [])
    const automationTdps = knowledge.tdps.filter(t => t.name === 'Automation TDP')
    expect(automationTdps.length).toBe(1)
    // Should keep the longer description
    expect(automationTdps[0].products.length).toBe(2)
  })
})
