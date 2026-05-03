// BKL-ARCH-23: Golden snapshot test for buildXmlSources() byte-identical output.
// MUST pass against unmodified customer.ts. The byte-identical contract is the
// safety net for the per-source signal module decomposition.
//
// Mocks all external dependencies (scraper status, settings, product intel)
// so the test is fully deterministic and runs under `bun test test/unit/`.

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'

// ── Freeze time so today / scraper-status staleness math is deterministic ───
// Pick a fixed "now" — 2026-05-02T12:00:00.000Z (UTC) — and a fixed
// scraperStatus map below. Combined, the buildXmlSources output is fully
// determined by inputs only.
const FROZEN_NOW = new Date('2026-05-02T12:00:00.000Z')
const _origDateNow = Date.now
const _origDate = global.Date

// ── Mocks ───────────────────────────────────────────────────────────────────
mock.module('../../../src/scraper-status-store.ts', () => ({
  // Static map: rh-cases failed (sub-block off + failed source tag),
  // sf-pipeline stale (older than 24h),
  // ccsp fresh, supportable not present (retired).
  getStatus: () => ({
    'rh-cases': {
      state: 'failed',
      lastRun: '2026-05-01T10:00:00.000Z',
      lastSuccess: '2026-04-30T10:00:00.000Z',
      lastError: 'connection refused',
      recordCount: 0,
      durationMs: 0,
      updatedAt: '2026-05-01T10:00:00.000Z',
      consecutiveFailures: 1,
    },
    'ccsp': {
      state: 'fresh',
      lastRun: '2026-05-02T08:00:00.000Z',
      lastSuccess: '2026-05-02T08:00:00.000Z',
      lastError: null,
      recordCount: 5,
      durationMs: 1000,
      updatedAt: '2026-05-02T08:00:00.000Z',
      consecutiveFailures: 0,
    },
    'sf-pipeline': {
      state: 'fresh',
      lastRun: '2026-04-30T08:00:00.000Z',
      lastSuccess: '2026-04-30T08:00:00.000Z',
      lastError: null,
      recordCount: 3,
      durationMs: 1000,
      updatedAt: '2026-04-30T08:00:00.000Z',
      consecutiveFailures: 0,
    },
  }),
  // ScraperName re-export — type is erased at runtime so any value works
}))

mock.module('../../../src/settings-api.ts', () => ({
  getAiConfig: () => ({ briefSynthesisTemperature: 0.4 }),
  getGeminiModel: () => 'gemini-2.5-pro',
  getGeminiModelLite: () => 'gemini-2.5-flash',
  getAutomationConfig: () => ({ briefEmailsInPrompt: 5 }),
}))

mock.module('../../../src/product-release-radar.ts', () => ({
  loadProductConfig: () => [
    { slug: 'openshift', name: 'OpenShift' },
    { slug: 'rhel',      name: 'RHEL' },
  ],
}))

mock.module('../../../src/customer-product-intel.ts', () => ({
  getCachedCustomerProductIntel: (slug: string, customerSlug: string) => {
    // Return product intel only for the openshift+acme-corp pairing,
    // so we exercise the product_intelligence rendering path once.
    if (slug === 'openshift' && customerSlug === 'acme-corp') {
      return {
        relevanceScore: 'HIGH',
        generatedAt: '2026-05-01T00:00:00.000Z',
        priorityAction: 'Pitch OpenShift Virtualization in May QBR.',
        roadmapRelevance: [
          { feature: 'Virt 4.16', talkingPoint: 'New live-migration tooling.' },
        ],
        expansionOpportunities: [
          { gap: 'No K8s platform', product: 'OpenShift', rationale: 'Aligns with VMware exit.' },
        ],
        caseAlignment: [
          { caseNumber: '00112233', roadmapFix: 'Fix in 4.17', timeline: 'Q3 2026' },
        ],
        competitiveAngle: 'OpenShift vs Tanzu — emphasise integrated CI/CD.',
      }
    }
    return null
  },
}))

// Silence the disk read for accountIntelligence by setting CACHE_DIR to a
// directory that does not contain intelligence/<slug>.json — buildXmlSources
// catches the read error and proceeds. We pass accountIntelligence explicitly
// in the fixture, so the disk-read fallback is not exercised.
process.env.CACHE_DIR = '/tmp/bkl-arch-23-nonexistent'

// ── Freeze Date ─────────────────────────────────────────────────────────────
beforeAll(() => {
  Date.now = () => FROZEN_NOW.getTime()
  // @ts-expect-error - replace the constructor for new Date() with no args
  global.Date = class extends _origDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FROZEN_NOW.getTime())
      } else {
        // @ts-expect-error spread args
        super(...args)
      }
    }
    static now() { return FROZEN_NOW.getTime() }
  } as DateConstructor
})

afterAll(() => {
  global.Date = _origDate
  Date.now = _origDateNow
})

// ── Now import the module under test (after mocks are in place) ─────────────
import { buildXmlSources, type XmlEnrichment } from '../../../src/customer.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from '../../../src/types.ts'
import type { PipelineRecord } from '../../../src/pipeline.ts'
import type { CCSPRecord } from '../../../src/sheets.ts'

// ── Fixture: a customer that exercises every render path ─────────────────────
const customer: Customer = {
  name: 'Acme Corp',
  ae: 'Jane AE',
  segment: 'Commercial',
  region: 'AMER',
  domain: 'acme.com',
}

const subscriptions: CustomerSubscription[] = [
  { subscriptionNumber: 'SUB-001', productName: 'RHEL Server', quantity: 100, endDate: '2026-12-31', daysLeft: 243, status: 'Active' },
]

const products: ProductSubscription[] = [
  { sku: 'RH00001', productDescription: 'RHEL Premium', quantity: 50, status: 'Active', endDate: '2026-12-31' },
  // free/trial — should be filtered out of paidProducts
  { sku: 'RH00002', productDescription: 'RHEL Free Trial', quantity: 1, status: 'Trial', endDate: '2026-06-01' },
]

const cases: SupportCase[] = [
  { caseNumber: '00112233', summary: 'Pod CrashLoopBackOff', status: 'Open', severity: '2', accountNumber: '999', daysOpen: 5, product: 'OpenShift' },
]

const meetings: CalendarEvent[] = [
  // upcoming
  { title: 'Q2 QBR', start: '2026-05-15T15:00:00.000Z', end: '2026-05-15T16:00:00.000Z', attendees: ['alice@acme.com', 'bob@acme.com'], needsPrep: true, customers: ['Acme Corp'] },
  // past — should be filtered out
  { title: 'Last week sync', start: '2026-04-25T15:00:00.000Z', end: '2026-04-25T16:00:00.000Z', attendees: ['alice@acme.com'], needsPrep: true, customers: ['Acme Corp'] },
]

const emails: EmailHighlight[] = [
  { customer: 'Acme Corp', subject: 'Renewal question', from: 'alice@acme.com', date: '2026-05-01', snippet: 'Can we discuss renewal terms next week?', actionRequired: true },
  { customer: 'Acme Corp', subject: 'Pricing & terms <important>', from: 'bob@acme.com', date: '2026-04-30', snippet: 'See attached.', actionRequired: false },
]

const docs: DriveFile[] = [
  { id: 'd1', name: 'Account Plan FY26', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-04-15T00:00:00.000Z', content: 'Account plan content here.', customer: 'Acme Corp' },
  { id: 'd2', name: 'Company Brief — Acme', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-04-20T00:00:00.000Z', content: 'Strategic background.', customer: 'Acme Corp' },
  { id: 'd3', name: 'Untyped doc', mimeType: 'application/vnd.google-apps.document', content: 'No mod time.' },
]

const pipeline: PipelineRecord[] = [
  { oppName: 'Acme OpenShift Expansion', forecastCategory: 'Commit', acv: 250000, closeDate: '2026-06-30' } as unknown as PipelineRecord,
]

const ccsp: CCSPRecord[] = [
  { cloudPartner: 'AWS', quarter: 'Q2-2026', acvPlus: 50000, closeDate: '2026-06-15' } as unknown as CCSPRecord,
]

const enrichment: XmlEnrichment = {
  docClassifications: new Map([
    ['Account Plan FY26', {
      type: 'ACCOUNT_PLAN',
      action_items: [{ text: 'Schedule QBR', owner: 'Jane', deadline: '2026-05-10' }],
      decisions: [{ text: 'Move to OpenShift in Q3' }],
      stakeholders_mentioned: [{ name: 'Alice', role: 'CTO', sentiment: 'positive' }],
      technical_signals: [],
      competitive_mentions: [{ competitor: 'Tanzu', context: 'Evaluating alongside.' }],
      timelines: [],
      pain_points: [],
      strategic_signals: [],
    }],
    ['Company Brief — Acme', {
      type: 'COMPANY_INTELLIGENCE',
      action_items: [],
      decisions: [],
      stakeholders_mentioned: [],
      technical_signals: [],
      competitive_mentions: [],
      timelines: [],
      pain_points: [],
      // strategic_signals only render for COMPANY_INTELLIGENCE / INDUSTRY_ANALYSIS
      strategic_signals: [
        { signal_type: 'trigger_event', text: 'CEO transition announced', significance: 'high' },
      ],
    }],
  ]),
  emailClassifications: new Map([
    ['alice@acme.com|Renewal question|2026-05-01', {
      classification: 'ACTION_REQUIRED',
      action_items: [{ text: 'Send renewal quote', deadline: '2026-05-08', confidence: 'HIGH' } as { text: string; deadline?: string; confidence: string }],
      competitive_mentions: [{ competitor: 'VMware', context: 'asked about migration', risk_level: 'MEDIUM' }],
      stakeholder_signals: [],
    }],
  ]),
  silentContacts: [
    { email: 'carol@acme.com', name: 'Carol', lastContact: '2026-02-01', daysSilent: 90, previousFrequency: 4, currentFrequency: 0 },
  ],
  meetingPreps: [
    {
      meeting: { title: 'Q2 QBR', start: '2026-05-15T15:00:00.000Z', attendees: ['alice@acme.com', 'bob@acme.com'] },
      attendeeContext: [
        { name: 'alice@acme.com', lastInteraction: '2026-05-01', emailFrequency: 'weekly' },
      ],
      openActionItems: [],
      healthSignals: { cases: '1 open Sev2', renewals: '1 within 90d', pipeline: '$250K' },
      competitiveContext: ['VMware bake-off'],
      stakeholderCoverage: { engaged: ['alice@acme.com'], missing: ['cfo@acme.com'], silent: ['carol@acme.com'] },
    },
  ],
}

const previousBrief = '## Previous brief content here.'
const lastBriefDate = '2026-04-25'
const lastInteraction = '2026-05-01'
const accountIntelligence = {
  company: 'Acme Corp is a Fortune 500 ...',
  industry: 'Manufacturing & Logistics ...',
  cachedAt: '2026-04-30T00:00:00.000Z',
}

describe('buildXmlSources — golden snapshot', () => {
  it('produces byte-identical output for the canonical fixture', () => {
    const xml = buildXmlSources(
      customer,
      meetings,
      emails,
      docs,
      cases,
      subscriptions,
      products,
      pipeline,
      ccsp,
      previousBrief,
      lastBriefDate,
      lastInteraction,
      enrichment,
      accountIntelligence,
    )

    // Canonical structural assertions — the shape contract that the
    // per-source decomposition (BKL-ARCH-23) must preserve byte-for-byte.
    expect(xml).toMatchSnapshot()
  })

  it('emits failed-source self-closing tag for rh-cases when cases array is empty', () => {
    const xml = buildXmlSources(
      customer, [], [], [], [], [], [], [], [],
      null, null, lastInteraction, undefined, null,
    )
    // rh-cases is mocked as failed → expect self-closing tag with count="0"
    expect(xml).toContain('<source type="support_cases" status="scraper_failed"')
    expect(xml).toContain('count="0" />')
  })

  it('omits previous_brief block when previousBrief is null', () => {
    const xml = buildXmlSources(
      customer, [], [], [], [], [], [], [], [],
      null, null, lastInteraction, undefined, null,
    )
    expect(xml).not.toContain('<source type="previous_brief"')
  })

  it('omits subscriptions detailed block when all products are free/trial', () => {
    const onlyTrial: ProductSubscription[] = [
      { sku: 'RH-FREE', productDescription: 'Trial', quantity: 1, status: 'Trial' },
    ]
    const xml = buildXmlSources(
      customer, [], [], [], [], [], onlyTrial, [], [],
      null, null, lastInteraction, undefined, null,
    )
    expect(xml).not.toContain('<source type="subscriptions_detailed"')
  })

  it('marks account_intelligence stale when cachedAt is older than TTL', () => {
    const stale = { company: 'Stale company', industry: 'Stale industry', cachedAt: '2026-01-01T00:00:00.000Z' }
    const xml = buildXmlSources(
      customer, [], [], [], [], [], [], [], [],
      null, null, lastInteraction, undefined, stale,
    )
    expect(xml).toContain('<source type="account_intelligence" status="stale"')
  })
})
