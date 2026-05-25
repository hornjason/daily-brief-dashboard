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
  parseTdpPageSections,
  parseSalesPlayPageSections,
  buildSalesHubKnowledge,
  type SalesHubKnowledge,
  type ScrapedProduct,
  type ScrapedSalesPlay,
  type ScrapedSalesTactic,
  type ScrapedTdpPage,
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
    expect(knowledge.tactics.length).toBe(4) // 1 from product tdpSections (non-TDP entry) + 1 standalone + 2 injected (#368: Sovereign Infrastructure, AI Factory)
    expect(knowledge.tdps.length).toBeGreaterThanOrEqual(1)

    // Verify product structure
    expect(knowledge.products[0].name).toBe('Ansible Automation Platform')
    expect(knowledge.products[0].tdpContent.length).toBe(3) // 2 tdpSections + 1 salesTactic
    expect(knowledge.products[0].googleDocsUrls.length).toBe(1)

    // Verify sales play structure
    expect(knowledge.salesPlays[0].linkedTdps).toContain('Automation')

    // Verify tactic structure — standalone tactic has customerWins
    const standaloneTactic = knowledge.tactics.find(t => t.name === 'AIOps: Turn Intelligence into Action')
    expect(standaloneTactic).toBeDefined()
    expect(standaloneTactic!.customerWins.length).toBe(1)
    expect(standaloneTactic!.parentTdp).toBe('Automation')

    // Verify TDP aggregation from products
    const automationTdp = knowledge.tdps.find(t => t.name === 'Automation TDP')
    expect(automationTdp).toBeDefined()

    // Verify extractedContent and metrics fields are initialized (#369)
    expect(automationTdp!.extractedContent).toBe('')
    expect(automationTdp!.metrics).toEqual([])
    expect(standaloneTactic!.extractedContent).toBe('')
    expect(standaloneTactic!.metrics).toEqual([])
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

  it('maps new SalesPlay structured fields through (#367)', () => {
    const salesPlays: ScrapedSalesPlay[] = [
      {
        name: 'Build and Run Applications',
        description: 'Build cloud-native apps on OpenShift',
        linkedTdps: ['App Platform'],
        url: 'https://saleshub.redhat.com/plays/build-run',
        customerLens: {
          pain: ['Slow release cycles', 'Vendor lock-in'],
          outcomes: ['Faster time to market', 'Multi-cloud portability'],
          impact: ['50% faster deployments'],
        },
        realWorldExamples: [{ customer: 'AcmeCo', outcome: 'Reduced deploy time by 60%' }],
        emailTemplateUrl: 'https://example.com/email-template',
        discoveryQuestionsUrl: 'https://example.com/discovery',
        introPitchDeckUrl: 'https://example.com/deck',
        personas: ['VP Engineering', 'Platform Engineer'],
        tdpAlignment: ['App Platform TDP', 'Container Management TDP'],
        regionalCampaigns: [{ name: 'Americas Commercial', url: 'https://example.com/campaign' }],
      },
    ]

    const knowledge = buildSalesHubKnowledge([], salesPlays, [])
    const play = knowledge.salesPlays[0]
    expect(play.customerLens.pain).toContain('Slow release cycles')
    expect(play.customerLens.outcomes).toContain('Faster time to market')
    expect(play.realWorldExamples[0].customer).toBe('AcmeCo')
    expect(play.emailTemplateUrl).toBe('https://example.com/email-template')
    expect(play.personas).toContain('VP Engineering')
    expect(play.tdpAlignment).toContain('App Platform TDP')
    expect(play.regionalCampaigns[0].name).toBe('Americas Commercial')
  })

  it('maps new TDP page structured fields through (#366)', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'ansible',
        name: 'Ansible',
        description: 'Automation',
        url: 'https://example.com/ansible',
        tdpSections: [{ name: 'Automation TDP', description: 'Enterprise automation' }],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-24T00:00:00Z',
      },
    ]

    const tdpPages: ScrapedTdpPage[] = [
      {
        name: 'Automation',
        customerWins: [{ name: 'AcmeCo', description: 'Automated 500 workflows' }],
        whatToSay: [{ name: 'Intro Deck', url: 'https://example.com/intro', type: 'google-slides' }],
        whatToShare: [{ name: 'Customer Deck', url: 'https://example.com/deck' }],
        whatToShow: [{ name: 'Demo Environment', url: 'https://example.com/demo', type: 'demo' }],
        services: [{ name: 'IBM Consulting', description: 'Deployment services' }],
        cheatsheetUrl: 'https://example.com/cheatsheet',
        customerDeckUrl: 'https://example.com/customer-deck',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [], tdpPages)
    const tdp = knowledge.tdps.find(t => t.name === 'Automation TDP')
    expect(tdp).toBeDefined()
    expect(tdp!.customerWins[0].name).toBe('AcmeCo')
    expect(tdp!.whatToSay[0].name).toBe('Intro Deck')
    expect(tdp!.whatToShare[0].name).toBe('Customer Deck')
    expect(tdp!.whatToShow[0].name).toBe('Demo Environment')
    expect(tdp!.services[0].name).toBe('IBM Consulting')
    expect(tdp!.cheatsheetUrl).toBe('https://example.com/cheatsheet')
    expect(tdp!.customerDeckUrl).toBe('https://example.com/customer-deck')
  })

  it('restructures TDPs to match SalesHub actual structure (#368)', () => {
    // Build products that produce App Platform TDP with container mgmt tactics
    const products: ScrapedProduct[] = [
      {
        slug: 'openshift',
        name: 'Red Hat OpenShift',
        description: 'Enterprise Kubernetes',
        url: 'https://example.com/ocp',
        tdpSections: [
          { name: 'App Platform TDP', description: 'Application platform for cloud-native apps' },
          { name: 'Kubernetes for 3rd party workloads (Non-AI)', description: 'Run 3rd party non-AI workloads on OpenShift' },
          { name: 'Kubernetes for 3rd party AI workloads', description: 'Run 3rd party AI workloads on OpenShift' },
          { name: 'Multicluster management & security at scale for Kubernetes', description: 'Manage multiple clusters' },
          { name: 'Secure the software supply chain', description: 'Supply chain security with ACS' },
          { name: 'Cloud marketplaces and private offers', description: 'Purchase through cloud marketplaces' },
          { name: 'Container Adoption Journey', description: 'Adoption path for containers' },
          { name: 'AI TDP', description: 'AI Technology Decision Point' },
          { name: 'Agentic AI', description: 'Deploy agentic AI applications' },
          { name: 'Edge TDP', description: 'Edge computing decision point' },
        ],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-24T00:00:00Z',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [])

    // Container Mgmt TDP should exist with 5 tactics
    const containerMgmt = knowledge.tdps.find(t => t.name === 'Container Mgmt')
    expect(containerMgmt).toBeDefined()
    expect(containerMgmt!.tactics).toContain('Kubernetes for 3rd party workloads (Non-AI)')
    expect(containerMgmt!.tactics).toContain('Kubernetes for 3rd party AI workloads')
    expect(containerMgmt!.tactics).toContain('Multicluster management & security at scale for Kubernetes')
    expect(containerMgmt!.tactics).toContain('Secure the software supply chain')
    expect(containerMgmt!.tactics).toContain('Sovereign Infrastructure')
    expect(containerMgmt!.tactics.length).toBe(5)

    // Edge TDP should NOT exist
    const edge = knowledge.tdps.find(t => t.name.toLowerCase().includes('edge'))
    expect(edge).toBeUndefined()

    // AI should be renamed to AI Platform
    const aiTdp = knowledge.tdps.find(t => t.name === 'AI Platform')
    expect(aiTdp).toBeDefined()
    const oldAi = knowledge.tdps.find(t => t.name === 'AI TDP' || t.name === 'AI')
    expect(oldAi).toBeUndefined()

    // Sovereign Infrastructure should exist under Container Mgmt
    const sovereign = knowledge.tactics.find(t => t.name === 'Sovereign Infrastructure')
    expect(sovereign).toBeDefined()
    expect(sovereign!.parentTdp).toBe('Container Mgmt')

    // Red Hat AI Factory with NVIDIA should exist under AI Platform
    const aiFactory = knowledge.tactics.find(t => t.name === 'Red Hat AI Factory with NVIDIA')
    expect(aiFactory).toBeDefined()
    expect(aiFactory!.parentTdp).toBe('AI Platform')

    // App Platform should NOT have the moved tactics
    const appPlatform = knowledge.tdps.find(t => t.name === 'App Platform TDP')
    expect(appPlatform).toBeDefined()
    expect(appPlatform!.tactics).not.toContain('Kubernetes for 3rd party workloads (Non-AI)')
    expect(appPlatform!.tactics).not.toContain('Kubernetes for 3rd party AI workloads')
    expect(appPlatform!.tactics).not.toContain('Multicluster management & security at scale for Kubernetes')
    expect(appPlatform!.tactics).not.toContain('Secure the software supply chain')
    // App Platform should still have its non-moved tactics
    expect(appPlatform!.tactics).toContain('Cloud marketplaces and private offers')
    expect(appPlatform!.tactics).toContain('Container Adoption Journey')

    // Agentic AI should have parentTdp updated to AI Platform
    const agenticAi = knowledge.tactics.find(t => t.name === 'Agentic AI')
    expect(agenticAi).toBeDefined()
    expect(agenticAi!.parentTdp).toBe('AI Platform')
  })

  it('defaults SalesPlay new fields when not provided (#367)', () => {
    const salesPlays: ScrapedSalesPlay[] = [
      {
        name: 'Legacy Play',
        description: 'Old play without new fields',
        linkedTdps: ['AI'],
        url: 'https://example.com/old',
      },
    ]

    const knowledge = buildSalesHubKnowledge([], salesPlays, [])
    const play = knowledge.salesPlays[0]
    expect(play.customerLens).toEqual({ pain: [], outcomes: [], impact: [] })
    expect(play.realWorldExamples).toEqual([])
    expect(play.emailTemplateUrl).toBe('')
    expect(play.personas).toEqual([])
    expect(play.tdpAlignment).toEqual([])
    expect(play.regionalCampaigns).toEqual([])
  })
})

describe('parseTdpPageSections (#366)', () => {
  it('extracts all 7 TDP page sections from sample text', () => {
    const text = `
AI Platform
Some intro text about the AI Platform TDP.
Customer Wins
AcmeCo — Deployed OpenShift AI to production in 3 weeks
BigBank — Reduced model training costs by 40% using RHEL AI
What to Say
Intro deck for AI Platform positioning
Discovery guide for customer conversations
Business value tree for ROI discussions
What to Share
Customer-facing AI Platform overview deck
Forrester TEI study for OpenShift AI
What to Show
AI Platform demo environment with InstructLab
Self-paced workshop for model fine-tuning
Services and Partner Solutions
IBM Consulting offers AI deployment services
Wipro provides managed AI infrastructure
5-Minute Briefs
Listen to the AI Platform podcast episode
Develop Your Skills
Red Hat AI training and certification paths
Product Features
Some other content here.
    `

    const links = [
      { text: 'AI Platform Cheatsheet', href: 'https://example.com/cheatsheet.pdf' },
      { text: 'Customer Deck for AI', href: 'https://example.com/customer-deck' },
      { text: 'Intro deck for AI Platform positioning', href: 'https://docs.google.com/presentation/d/abc' },
    ]

    const result = parseTdpPageSections(text, links)

    // Customer Wins
    expect(result.customerWins.length).toBe(2)
    expect(result.customerWins[0].name).toBe('AcmeCo')
    expect(result.customerWins[0].description).toContain('OpenShift AI')

    // What to Say
    expect(result.whatToSay.length).toBe(3)
    expect(result.whatToSay[0].name).toContain('Intro deck')
    expect(result.whatToSay[0].url).toBe('https://docs.google.com/presentation/d/abc')
    expect(result.whatToSay[0].type).toBe('google-slides')

    // What to Share
    expect(result.whatToShare.length).toBe(2)

    // What to Show
    expect(result.whatToShow.length).toBe(2)
    expect(result.whatToShow[0].type).toBe('demo')
    expect(result.whatToShow[1].type).toBe('workshop')

    // Services
    expect(result.services.length).toBe(2)
    expect(result.services[0].name).toContain('IBM Consulting')

    // Cheatsheet and Customer Deck URLs from links
    expect(result.cheatsheetUrl).toBe('https://example.com/cheatsheet.pdf')
    expect(result.customerDeckUrl).toBe('https://example.com/customer-deck')
  })

  it('handles missing sections gracefully', () => {
    const text = `
Some TDP page
Customer Wins
AcmeCo — Great results
Product Features
End of content.
    `
    const result = parseTdpPageSections(text, [])
    expect(result.customerWins.length).toBe(1)
    expect(result.whatToSay).toEqual([])
    expect(result.whatToShare).toEqual([])
    expect(result.whatToShow).toEqual([])
    expect(result.services).toEqual([])
    expect(result.cheatsheetUrl).toBe('')
    expect(result.customerDeckUrl).toBe('')
  })

  it('handles empty text', () => {
    const result = parseTdpPageSections('', [])
    expect(result.customerWins).toEqual([])
    expect(result.whatToSay).toEqual([])
    expect(result.cheatsheetUrl).toBe('')
  })
})

describe('parseSalesPlayPageSections (#367)', () => {
  it('extracts all structured sections from sample text', () => {
    const text = `
Build and Run Applications
Sales Play overview text.
Customer Lens
Pain
Slow release cycles blocking business agility
High infrastructure costs from legacy platforms
Outcomes
Faster time to market for new features
Multi-cloud portability reduces vendor lock-in
Impact
50% faster application deployments measured at scale
30% reduction in infrastructure operational costs
Real-World Examples
AcmeCo — Reduced deployment time from 2 weeks to 2 hours using OpenShift
BigBank — Migrated 500 apps to containers, saving $2M annually
What to Say
Discovery questions document for initial conversations
Intro pitch deck for executive audiences
Email template for follow-up after discovery
What to Share
Customer reference deck for proof points
Forrester TEI study showing 300% ROI
Personas & Challenges
VP of Engineering struggling with developer productivity
Platform Engineer needing self-service infrastructure
CTO evaluating multi-cloud strategy
TDPs Powering the Play
Application Platform TDP
Container Management TDP
Americas Commercial Campaign
Cloud-native adoption push for mid-market
Content Details
End of content.
    `

    const links = [
      { text: 'Discovery questions document', href: 'https://example.com/discovery-questions' },
      { text: 'Intro pitch deck', href: 'https://docs.google.com/presentation/d/xyz' },
      { text: 'Email template for follow-up', href: 'https://example.com/email-template' },
    ]

    const result = parseSalesPlayPageSections(text, links)

    // Customer Lens
    expect(result.customerLens.pain.length).toBe(2)
    expect(result.customerLens.pain[0]).toContain('Slow release cycles')
    expect(result.customerLens.outcomes.length).toBe(2)
    expect(result.customerLens.impact.length).toBe(2)
    expect(result.customerLens.impact[0]).toContain('50%')

    // Real-World Examples
    expect(result.realWorldExamples.length).toBe(2)
    expect(result.realWorldExamples[0].customer).toBe('AcmeCo')
    expect(result.realWorldExamples[0].outcome).toContain('OpenShift')

    // What to Say assets
    expect(result.discoveryQuestionsUrl).toBe('https://example.com/discovery-questions')
    expect(result.introPitchDeckUrl).toBe('https://docs.google.com/presentation/d/xyz')
    expect(result.emailTemplateUrl).toBe('https://example.com/email-template')

    // Personas
    expect(result.personas.length).toBe(3)
    expect(result.personas[0]).toContain('VP of Engineering')

    // TDP Alignment
    expect(result.tdpAlignment.length).toBe(2)
    expect(result.tdpAlignment).toContain('Application Platform TDP')

    // Regional Campaigns
    expect(result.regionalCampaigns.length).toBeGreaterThanOrEqual(1)
  })

  it('handles missing sections gracefully', () => {
    const text = `
Simple play page
Customer Lens
Pain
Budget constraints
Content Details
End of content.
    `
    const result = parseSalesPlayPageSections(text, [])
    expect(result.customerLens.pain.length).toBe(1)
    expect(result.customerLens.outcomes).toEqual([])
    expect(result.customerLens.impact).toEqual([])
    expect(result.realWorldExamples).toEqual([])
    expect(result.personas).toEqual([])
    expect(result.tdpAlignment).toEqual([])
    expect(result.emailTemplateUrl).toBe('')
  })

  it('handles empty text', () => {
    const result = parseSalesPlayPageSections('', [])
    expect(result.customerLens).toEqual({ pain: [], outcomes: [], impact: [] })
    expect(result.realWorldExamples).toEqual([])
    expect(result.personas).toEqual([])
  })
})

describe('TDP name normalization (#381)', () => {
  it('normalizes "Server/Cloud Operating System TDP" to "Server/Cloud OS"', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'rhel',
        name: 'RHEL',
        description: 'Enterprise Linux',
        url: 'https://example.com/rhel',
        tdpSections: [{ name: 'Server/Cloud Operating System TDP', description: 'RHEL server TDP' }],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-24T00:00:00Z',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [])
    const serverOs = knowledge.tdps.find(t => t.name === 'Server/Cloud OS')
    expect(serverOs).toBeDefined()
    const oldName = knowledge.tdps.find(t => t.name === 'Server/Cloud Operating System TDP')
    expect(oldName).toBeUndefined()
  })

  it('normalizes "Application Platform TDP" to "App Platform TDP"', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'ocp',
        name: 'Red Hat OpenShift',
        description: 'Enterprise Kubernetes',
        url: 'https://example.com/ocp',
        tdpSections: [{ name: 'Application Platform TDP', description: 'App platform TDP' }],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-24T00:00:00Z',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [])
    const appPlatform = knowledge.tdps.find(t => t.name === 'App Platform TDP')
    expect(appPlatform).toBeDefined()
    const oldName = knowledge.tdps.find(t => t.name === 'Application Platform TDP')
    expect(oldName).toBeUndefined()
  })

  it('merges duplicate TDPs after normalization (Container Management TDP + Container Mgmt)', () => {
    const products: ScrapedProduct[] = [
      {
        slug: 'ocp',
        name: 'Red Hat OpenShift',
        description: 'Enterprise Kubernetes',
        url: 'https://example.com/ocp',
        tdpSections: [
          { name: 'App Platform TDP', description: 'Application platform' },
          { name: 'Container Management TDP', description: 'Container mgmt from scrape' },
          { name: 'Kubernetes for 3rd party workloads (Non-AI)', description: 'Run 3rd party non-AI workloads' },
        ],
        salesTactics: [],
        googleDocsUrls: [],
        keyResources: [],
        decks: [],
        scrapedAt: '2026-05-24T00:00:00Z',
      },
    ]

    const knowledge = buildSalesHubKnowledge(products, [], [])
    // "Container Management TDP" should be normalized to "Container Mgmt" and merged with
    // the Container Mgmt TDP created by #368 restructure
    const containerMgmt = knowledge.tdps.filter(t => t.name === 'Container Mgmt')
    expect(containerMgmt.length).toBe(1)
    const oldName = knowledge.tdps.find(t => t.name === 'Container Management TDP')
    expect(oldName).toBeUndefined()
  })

  it('normalizes tactic parentTdp references', () => {
    const tactics: ScrapedSalesTactic[] = [
      {
        name: 'RHEL Image Mode',
        talkTrack: 'Deploy bootable images',
        customerWins: [],
        whatToSay: [],
        whatToShare: [],
        parentTdp: 'Server/Cloud Operating System',
        url: 'https://example.com/image-mode',
      },
      {
        name: 'Container Adoption',
        talkTrack: 'Adopt containers',
        customerWins: [],
        whatToSay: [],
        whatToShare: [],
        parentTdp: 'Container Management',
        url: 'https://example.com/container-adoption',
      },
    ]

    const knowledge = buildSalesHubKnowledge([], [], tactics)
    const imageMode = knowledge.tactics.find(t => t.name === 'RHEL Image Mode')
    expect(imageMode).toBeDefined()
    expect(imageMode!.parentTdp).toBe('Server/Cloud OS')

    const containerAdoption = knowledge.tactics.find(t => t.name === 'Container Adoption')
    expect(containerAdoption).toBeDefined()
    expect(containerAdoption!.parentTdp).toBe('Container Mgmt')
  })
})

describe('tdpAlignment parsing filter (#381)', () => {
  it('stops at non-TDP lines like sidebar nav text', () => {
    const text = `
Build and Run Applications
Sales Play overview.
TDPs Powering the Play
AI Platform
Container Management
Account research in minutes
Quick links to resources
Content Details
End.
    `
    const result = parseSalesPlayPageSections(text, [])
    expect(result.tdpAlignment.length).toBe(2)
    expect(result.tdpAlignment).toContain('AI Platform')
    expect(result.tdpAlignment).toContain('Container Management')
    // Garbage lines should NOT be included
    expect(result.tdpAlignment).not.toContain('Account research in minutes')
    expect(result.tdpAlignment).not.toContain('Quick links to resources')
  })

  it('accepts all canonical TDP name variants', () => {
    const text = `
Some Play
TDPs Powering the Play
AI Platform
Server/Cloud Operating System
Container Management
Automation
App Platform
Virtualization
Content Details
End.
    `
    const result = parseSalesPlayPageSections(text, [])
    expect(result.tdpAlignment.length).toBe(6)
  })
})
