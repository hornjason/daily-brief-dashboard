import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getTacticsByTdp, getTalkTrack, getTdpDescription, getKnowledgeStats, getSalesPlayByName, getTdpByName, getKnowledgeCoverage, resetKnowledgeCache } from '../../src/lib/saleshub-knowledge-loader'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_DIR = resolve(import.meta.dir, '.test-saleshub-knowledge')
const CONFIG_DIR = resolve(TEST_DIR, 'config')

const FIXTURE_KNOWLEDGE = {
  version: 1,
  scrapedAt: '2026-05-21T20:00:00Z',
  salesPlays: [
    {
      name: 'Modernize Infrastructure',
      description: 'Modernize IT infrastructure',
      linkedTdps: ['Automation', 'Virtualization'],
      customerLens: {
        pain: ['Legacy infrastructure costs rising', 'VMware licensing uncertainty'],
        outcomes: ['Reduced TCO by 30-40%', 'Faster provisioning'],
        impact: ['Operational efficiency', 'Risk reduction'],
      },
      realWorldExamples: [
        { customer: 'GlobalBank', outcome: 'Migrated 2000 VMs in 6 months, saving $4M annually' },
        { customer: 'RetailCorp', outcome: 'Reduced provisioning time from weeks to hours' },
      ],
      emailTemplateUrl: 'https://example.com/email-template',
      discoveryQuestionsUrl: '',
      introPitchDeckUrl: '',
      personaSection: {
        roles: ['CTO', 'VP Infrastructure'],
        painPoints: [],
        discoveryQuestions: [],
        valueProps: [],
        whatWinsThemOver: [],
      },
      tdpAlignment: ['Automation', 'Virtualization'],
      regionalCampaigns: [],
    },
  ],
  tdps: [
    {
      name: 'Automation TDP',
      description: 'The Automation TDP positions Red Hat Ansible Automation Platform as the mission-critical foundation for modernizing IT.',
      tactics: ['AIOps: Turn Intelligence into Action', 'Automate at Scale'],
      products: ['Red Hat Ansible Automation Platform'],
      whatToShow: [
        { name: 'AIOps Live Demo', url: 'https://demo.example.com/aiops', type: 'live-demo' },
        { name: 'EDA Workflow Demo', url: 'https://demo.example.com/eda', type: 'recorded-demo' },
      ],
      services: [
        { name: 'Automation Adoption Program', description: 'Guided onboarding for enterprise automation at scale' },
        { name: 'Consulting Engagement', description: 'Architecture review and best practices' },
      ],
      customerWins: [],
      whatToSay: [],
      whatToShare: [],
      cheatsheetUrl: '',
      customerDeckUrl: '',
      extractedContent: '',
      metrics: [],
    },
    {
      name: 'Virtualization TDP',
      description: 'The Virtualization TDP positions OpenShift Virtualization for VMware migration.',
      tactics: ['VMware Migration'],
      products: ['Red Hat OpenShift Virtualization'],
      whatToShow: [
        { name: 'VMware Migration Demo', url: 'https://demo.example.com/vmware', type: 'live-demo' },
      ],
      services: [],
      customerWins: [],
      whatToSay: [],
      whatToShare: [],
      cheatsheetUrl: '',
      customerDeckUrl: '',
      extractedContent: '',
      metrics: [],
    },
  ],
  tactics: [
    {
      name: 'AIOps: Turn Intelligence into Action',
      talkTrack: 'This AIOps tactic positions AAP as the "action layer" that transforms monitoring insights into automated remediation.',
      customerWins: ['Acme Corp reduced MTTR by 60%'],
      whatToSay: ['Event-driven workflows replace manual troubleshooting'],
      whatToShare: [{ name: 'AIOps Customer Deck', url: 'https://docs.google.com/presentation/d/abc', type: 'google-slides' }],
      parentTdp: 'Automation TDP',
      extractedContent: 'AIOps enables event-driven automation that reduces mean time to resolution across hybrid cloud environments.',
      metrics: [
        { value: '60% MTTR reduction', context: 'Average across enterprise AIOps deployments', source: 'tactic' },
        { value: '3x faster incident response', context: 'Compared to manual troubleshooting workflows', source: 'tactic' },
      ],
    },
    {
      name: 'Automate at Scale',
      talkTrack: 'This tactic helps sellers migrate DIY users and scale existing customers.',
      customerWins: [],
      whatToSay: ['Enterprise-grade automation standard'],
      whatToShare: [],
      parentTdp: 'Automation TDP',
      extractedContent: '',
      metrics: [],
    },
    {
      name: 'VMware Migration',
      talkTrack: 'Position OpenShift Virtualization as the path from VMware.',
      customerWins: ['BigCo saved 40% on licensing'],
      whatToSay: [],
      whatToShare: [{ name: 'VMware Migration Deck', url: 'https://docs.google.com/presentation/d/xyz', type: 'google-slides' }],
      parentTdp: 'Virtualization TDP',
      extractedContent: 'Migration pathway from VMware to OpenShift Virtualization with full VM lifecycle management.',
      metrics: [
        { value: '40% licensing savings', context: 'Compared to VMware Enterprise Plus', source: 'tactic' },
      ],
    },
  ],
  products: [
    {
      name: 'Red Hat Ansible Automation Platform',
      slug: 'red-hat-ansible-automation-platform',
      description: 'Enterprise automation platform',
      tdpContent: [{ type: 'tdp', name: 'Automation TDP', description: 'Positions AAP...' }],
      decks: [{ name: 'AAP Customer Deck', url: 'https://docs.google.com/presentation/d/123', type: 'google-slides' }],
      resources: [],
      googleDocsUrls: ['https://docs.google.com/presentation/d/123'],
    },
  ],
}

beforeEach(() => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  process.env.CONFIG_DIR = CONFIG_DIR
  writeFileSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'), JSON.stringify(FIXTURE_KNOWLEDGE))
  resetKnowledgeCache()
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env.CONFIG_DIR
  resetKnowledgeCache()
})

describe('getTacticsByTdp', () => {
  it('returns tactics for Automation TDP', () => {
    const tactics = getTacticsByTdp('Automation')
    expect(tactics.length).toBe(2)
    const names = tactics.map(t => t.name)
    expect(names).toContain('AIOps: Turn Intelligence into Action')
    expect(names).toContain('Automate at Scale')
  })

  it('returns tactics for Virtualization TDP', () => {
    const tactics = getTacticsByTdp('Virtualization')
    expect(tactics.length).toBe(1)
    expect(tactics[0].name).toBe('VMware Migration')
  })

  it('returns empty for unknown TDP', () => {
    const tactics = getTacticsByTdp('NonExistent')
    expect(tactics).toEqual([])
  })

  it('returns empty when knowledge file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    const tactics = getTacticsByTdp('Automation')
    expect(tactics).toEqual([])
  })
})

describe('getTalkTrack', () => {
  it('returns talk track for known tactic', () => {
    const track = getTalkTrack('AIOps: Turn Intelligence into Action')
    expect(track).toContain('action layer')
    expect(track).toContain('automated remediation')
  })

  it('matches partial name', () => {
    const track = getTalkTrack('AIOps')
    expect(track).toContain('action layer')
  })

  it('returns empty for unknown tactic', () => {
    expect(getTalkTrack('NonExistent')).toBe('')
  })
})

describe('getTdpDescription', () => {
  it('returns TDP description', () => {
    const desc = getTdpDescription('Automation')
    expect(desc).toContain('mission-critical foundation')
  })

  it('returns empty for unknown TDP', () => {
    expect(getTdpDescription('NonExistent')).toBe('')
  })
})

describe('getSalesPlayByName', () => {
  it('returns sales play by exact name', () => {
    const play = getSalesPlayByName('Modernize Infrastructure')
    expect(play).toBeDefined()
    expect(play!.name).toBe('Modernize Infrastructure')
    expect(play!.customerLens.pain).toContain('Legacy infrastructure costs rising')
    expect(play!.realWorldExamples.length).toBe(2)
    expect(play!.realWorldExamples[0].customer).toBe('GlobalBank')
  })

  it('matches case-insensitively', () => {
    const play = getSalesPlayByName('modernize infrastructure')
    expect(play).toBeDefined()
    expect(play!.name).toBe('Modernize Infrastructure')
  })

  it('returns undefined for unknown play', () => {
    expect(getSalesPlayByName('NonExistent Play')).toBeUndefined()
  })

  it('returns undefined when knowledge file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    expect(getSalesPlayByName('Modernize Infrastructure')).toBeUndefined()
  })
})

describe('getTdpByName', () => {
  it('returns TDP node by name', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.name).toBe('Automation TDP')
    expect(tdp!.description).toContain('mission-critical foundation')
  })

  it('returns TDP with whatToShow data', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.whatToShow).toHaveLength(2)
    expect(tdp!.whatToShow[0].name).toBe('AIOps Live Demo')
    expect(tdp!.whatToShow[0].url).toBe('https://demo.example.com/aiops')
  })

  it('returns TDP with services data', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.services).toHaveLength(2)
    expect(tdp!.services[0].name).toBe('Automation Adoption Program')
  })

  it('returns undefined for unknown TDP', () => {
    expect(getTdpByName('NonExistent')).toBeUndefined()
  })

  it('returns undefined when knowledge file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    expect(getTdpByName('Automation')).toBeUndefined()
  })
})

describe('getKnowledgeStats', () => {
  it('returns correct counts', () => {
    const stats = getKnowledgeStats()
    expect(stats.tdpCount).toBe(2)
    expect(stats.tacticCount).toBe(3)
    expect(stats.salesPlayCount).toBe(1)
    expect(stats.productCount).toBe(1)
    expect(stats.scrapedAt).toBe('2026-05-21T20:00:00Z')
  })

  it('returns zeros when file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    const stats = getKnowledgeStats()
    expect(stats.tdpCount).toBe(0)
    expect(stats.scrapedAt).toBeNull()
  })
})

describe('getTdpByName', () => {
  it('returns TDP node by name', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.name).toBe('Automation TDP')
    expect(tdp!.description).toContain('mission-critical foundation')
  })

  it('returns TDP with whatToShow data', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.whatToShow).toHaveLength(2)
    expect(tdp!.whatToShow[0].name).toBe('AIOps Live Demo')
  })

  it('returns TDP with services data', () => {
    const tdp = getTdpByName('Automation')
    expect(tdp).toBeDefined()
    expect(tdp!.services).toHaveLength(2)
    expect(tdp!.services[0].name).toBe('Automation Adoption Program')
  })

  it('returns undefined for unknown TDP', () => {
    expect(getTdpByName('NonExistent')).toBeUndefined()
  })

  it('returns undefined when knowledge file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    expect(getTdpByName('Automation')).toBeUndefined()
  })
})

describe('getKnowledgeCoverage', () => {
  it('returns correct TDP coverage for fixture data', () => {
    const coverage = getKnowledgeCoverage()
    expect(coverage.tdps).toHaveLength(2)

    const automationTdp = coverage.tdps.find(t => t.name === 'Automation TDP')
    expect(automationTdp).toBeDefined()
    expect(automationTdp!.sections.whatToShow).toBe(true)
    expect(automationTdp!.sections.services).toBe(true)
    expect(automationTdp!.sections.customerWins).toBe(false)
    expect(automationTdp!.sections.whatToSay).toBe(false)
    expect(automationTdp!.sections.whatToShare).toBe(false)
    expect(automationTdp!.sections.cheatsheet).toBe(false)
    expect(automationTdp!.sections.customerDeck).toBe(false)
    expect(automationTdp!.sectionCount).toBe(2)
    expect(automationTdp!.tacticCount).toBe(2)

    const virtTdp = coverage.tdps.find(t => t.name === 'Virtualization TDP')
    expect(virtTdp).toBeDefined()
    expect(virtTdp!.sections.whatToShow).toBe(true)
    expect(virtTdp!.sectionCount).toBe(1)
    expect(virtTdp!.tacticCount).toBe(1)
  })

  it('returns correct Play coverage for fixture data', () => {
    const coverage = getKnowledgeCoverage()
    expect(coverage.plays).toHaveLength(1)

    const play = coverage.plays[0]
    expect(play.name).toBe('Modernize Infrastructure')
    expect(play.sections.customerLens).toBe(true)
    expect(play.sections.realWorldExamples).toBe(true)
    expect(play.sections.emailTemplate).toBe(true)
    expect(play.sections.discoveryQuestions).toBe(false)
    expect(play.sections.introPitchDeck).toBe(false)
    expect(play.sections.personaSection).toBe(true)
    expect(play.sectionCount).toBe(4)
  })

  it('calculates overall coverage percentage correctly', () => {
    const coverage = getKnowledgeCoverage()
    // TDP1: 2/7, TDP2: 1/7 = 3/14 TDP sections
    // Play1: 4/6 = 4/6 play sections
    // Total: 7/20 = 35%
    expect(coverage.overallCoveragePercent).toBe(35)
  })

  it('counts extracted content correctly', () => {
    const coverage = getKnowledgeCoverage()
    // AIOps has content, Automate at Scale empty, VMware Migration has content = 2
    expect(coverage.docsWithExtractedContent).toBe(2)
  })

  it('counts total linked docs', () => {
    const coverage = getKnowledgeCoverage()
    // Unique URLs: demo.example.com/aiops, demo.example.com/eda, demo.example.com/vmware
    // + tactic whatToShare: abc, xyz = 5 total unique URLs
    expect(coverage.totalLinkedDocs).toBe(5)
  })

  it('returns scrapedAt from knowledge base', () => {
    const coverage = getKnowledgeCoverage()
    expect(coverage.scrapedAt).toBe('2026-05-21T20:00:00Z')
  })

  it('returns zero coverage when knowledge file missing', () => {
    rmSync(resolve(CONFIG_DIR, 'saleshub-knowledge.json'))
    resetKnowledgeCache()
    const coverage = getKnowledgeCoverage()
    expect(coverage.tdps).toHaveLength(0)
    expect(coverage.plays).toHaveLength(0)
    expect(coverage.overallCoveragePercent).toBe(0)
    expect(coverage.totalLinkedDocs).toBe(0)
    expect(coverage.docsWithExtractedContent).toBe(0)
    expect(coverage.scrapedAt).toBeNull()
  })

  it('includes extractedContentCount per TDP', () => {
    const coverage = getKnowledgeCoverage()
    const automationTdp = coverage.tdps.find(t => t.name === 'Automation TDP')
    expect(automationTdp).toBeDefined()
    // AIOps has extractedContent, Automate at Scale does not = 1
    expect(automationTdp!.extractedContentCount).toBe(1)
  })
})
