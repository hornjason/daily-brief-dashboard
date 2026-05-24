import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getTacticsByTdp, getTalkTrack, getTdpDescription, getKnowledgeStats, getSalesPlayByName, resetKnowledgeCache } from '../../src/lib/saleshub-knowledge-loader'
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
      personas: ['CTO', 'VP Infrastructure'],
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
    },
    {
      name: 'Virtualization TDP',
      description: 'The Virtualization TDP positions OpenShift Virtualization for VMware migration.',
      tactics: ['VMware Migration'],
      products: ['Red Hat OpenShift Virtualization'],
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
