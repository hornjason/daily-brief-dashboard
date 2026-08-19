/**
 * Anti-gaming tests for two-pass campaign template blocks.
 * Each test verifies a specific quality property that the template
 * must maintain — preventing regressions to generic/broken output.
 *
 * These test the FIXED behavior from #1068. Red before fixes, green after.
 */

import { describe, it, expect } from 'bun:test'
import {
  buildOpener,
  buildSignalBridge,
  buildRelationshipLine,
  buildFeatureBullets,
  buildPeerPattern,
  buildChallengerFrame,
  buildCTA,
  buildSignOff,
  assembleEmail,
  sanitizeCreepyLines,
  renderObjectiveBlock,
} from '../../src/campaign-html-template.ts'
import type { CustomerObjectiveProfile } from '../../src/modules/intelligence-module.ts'
import { resolveFeatureUrl } from '../../src/lib/feature-url-registry.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// ── Test fixtures ───────────────────────────────────────────────────────────

const makeSignal = (headline: string, type: string = 'intelligence'): Signal => ({
  headline,
  type,
  source: 'intelligence',
  featureKey: 'ansible-automation-platform',
  confidence: 0.8,
  timestamp: '2026-08-01',
})

const testSignals: Signal[] = [
  makeSignal('Infrastructure-as-Code Modernization — Terraform detected'),
  makeSignal('Cloud Migration Initiative — AWS expansion identified', 'news'),
  makeSignal('AI/ML Platform Evaluation — GPU cluster provisioning'),
]

const testSubscriptions = [
  { product: 'RHEL', productDescription: 'Red Hat Enterprise Linux Server', status: 'Active' },
  { product: 'OCP', productDescription: 'Red Hat OpenShift Container Platform', status: 'Active' },
  { product: 'AAP', productDescription: 'Red Hat Ansible Automation Platform', status: 'Inactive' },
]

const testPlays = [
  {
    name: 'Cloud Migration',
    parentTdp: 'TDP-001',
    realWorldExamples: [
      { customer: 'Amadeus', outcome: 'replaced Chef SaaS with AAP — $5.62M in benefits, 257.9% ROI' },
    ],
    extractedMetrics: [
      { value: '40% reduction', context: 'in deployment time after consolidating on enterprise automation' },
    ],
  },
]

// ── buildOpener ─────────────────────────────────────────────────────────────

describe('buildOpener — anti-gaming', () => {
  it('strips internal metadata tokens from signal headline', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi')
    expect(result).not.toContain('Terraform detected')
    expect(result).not.toContain('identified')
    expect(result).not.toContain('flagged')
  })

  it('uses the business observation part of the headline', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi')
    expect(result).toContain('Dhrupad')
    // Should contain something about IaC modernization, not the raw "— Terraform detected" part
    expect(result.toLowerCase()).toContain('infrastructure')
  })

  it('produces 3 distinct variants', () => {
    const v0 = buildOpener(0, testSignals, 0, 'Test User')
    const v1 = buildOpener(0, testSignals, 1, 'Test User')
    const v2 = buildOpener(0, testSignals, 2, 'Test User')
    const unique = new Set([v0, v1, v2])
    expect(unique.size).toBe(3)
  })

  it('gracefully handles signal with no em-dash separator', () => {
    const simpleSignal = [makeSignal('Cloud cost optimization strategy')]
    const result = buildOpener(0, simpleSignal, 0, 'Jane Doe')
    expect(result).toContain('Jane')
    expect(result.length).toBeGreaterThan(20)
  })
})

// ── buildOpener — opener polish (#197) ────────────────────────────────────

const makeBrief = (overrides: Partial<import('../../src/lib/persona-selector.ts').PersonaBrief> = {}): import('../../src/lib/persona-selector.ts').PersonaBrief => ({
  role: 'automation-champion' as any,
  suggestedTitle: 'VP Infrastructure',
  why: 'test',
  objectiveMatch: overrides.objectiveMatch ?? 'modernize the automation stack',
  peerProofCandidates: [],
  timingTrigger: overrides.timingTrigger ?? 'Q4 budget cycle approaching',
  valueProposition: overrides.valueProposition ?? 'unified platform for operations',
  featureKeys: ['ansible-automation-platform'],
  competitiveContext: null,
  relationshipPath: 'existing customer',
  installedBase: 'RHEL',
  suppressTriggers: [],
  confidence: { overall: 'HIGH' },
  ...overrides,
})

describe('buildOpener — imperative verb stripping (#197)', () => {
  it('strips imperative coaching instructions from openers', () => {
    const brief = makeBrief({
      objectiveMatch: 'lead a strategic initiative to modernize A10\'s automation stack, delivering operational efficiency',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).not.toMatch(/^Dhrupad, lead\b/i)
  })

  it('strips "empower" imperative from openers', () => {
    const brief = makeBrief({
      objectiveMatch: 'empower your teams with a single, powerful automation platform that unifies operations',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).not.toMatch(/^Dhrupad, empower\b/i)
  })

  it('skips to next field when imperative stripping leaves <20 chars', () => {
    const brief = makeBrief({
      objectiveMatch: 'deploy it quickly',
      timingTrigger: 'Q4 budget cycle approaching fast',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).not.toContain('deploy')
  })
})

describe('buildOpener — third-person replacement (#197)', () => {
  it('replaces "their" with "your" in direct emails', () => {
    const brief = makeBrief({
      objectiveMatch: 'their goal is to provide developers with self-service infrastructure',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).not.toContain('their')
    expect(result).toContain('your')
  })

  it('replaces customer name possessive with "your"', () => {
    const brief = makeBrief({
      objectiveMatch: "A10's strong financial discipline creates room for automation investment",
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief, 'A10')
    expect(result).not.toContain("A10's")
    expect(result).toContain('your')
  })
})

describe('buildOpener — smart lowercase (#197)', () => {
  it('preserves acronym casing at start of opener field', () => {
    const brief = makeBrief({
      objectiveMatch: 'IBM partnership accelerates their cloud migration',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).toContain('IBM')
    expect(result).not.toContain('iBM')
  })

  it('preserves proper noun casing at start of opener field', () => {
    const brief = makeBrief({
      objectiveMatch: 'Kubernetes adoption is driving infrastructure consolidation',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).toContain('Kubernetes')
    expect(result).not.toContain('kubernetes')
  })

  it('lowercases generic words at start of opener field', () => {
    const brief = makeBrief({
      objectiveMatch: 'Growing demand for automation across the enterprise',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).toMatch(/Dhrupad, growing/)
  })
})

describe('buildOpener — trailing cleanup (#197)', () => {
  it('strips trailing prepositions from opener sentences', () => {
    const brief = makeBrief({
      objectiveMatch: 'modernize the tools they depend on.',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).not.toMatch(/\b(on|with|for|and|to)\.\s*$/)
  })
})

// ── buildSignalBridge ───────────────────────────────────────────────────────

describe('buildSignalBridge — anti-gaming', () => {
  it('produces different bridges for ansible vs openshift vs rhel features', () => {
    const ansibleBridge = buildSignalBridge(testSignals[0], ['ansible-automation-platform'])
    const openshiftBridge = buildSignalBridge(testSignals[0], ['openshift-container-platform'])
    const rhelBridge = buildSignalBridge(testSignals[0], ['red-hat-enterprise-linux'])

    // All three must be different — not the same generic pattern
    const bridges = new Set([ansibleBridge, openshiftBridge, rhelBridge])
    expect(bridges.size).toBe(3)
  })

  it('never returns the exact same text for different product categories', () => {
    const ansibleBridge = buildSignalBridge(testSignals[0], ['ansible-automation-platform'])
    const openshiftBridge = buildSignalBridge(testSignals[0], ['openshift-container-platform'])
    expect(ansibleBridge).not.toBe(openshiftBridge)
  })
})

// ── buildRelationshipLine ───────────────────────────────────────────────────

describe('buildRelationshipLine — anti-gaming', () => {
  it('renders complete sentence without dangling prepositions', () => {
    const result = buildRelationshipLine(testSubscriptions)
    // Must not end with "for." or "with." or other dangling preposition
    expect(result).not.toMatch(/\b(for|with|to|from|by|in|on|at)\.\s*$/)
  })

  it('includes "Red Hat" prefix on known products', () => {
    const result = buildRelationshipLine(testSubscriptions)
    // Should say "Red Hat Enterprise Linux" not just "Enterprise Linux Server"
    expect(result).not.toContain('Enterprise Linux Server')
    if (result.toLowerCase().includes('enterprise linux')) {
      expect(result).toContain('Red Hat Enterprise Linux')
    }
  })

  it('only includes active subscriptions', () => {
    const result = buildRelationshipLine(testSubscriptions)
    // Ansible Automation Platform is inactive — should not appear
    expect(result).not.toContain('Ansible Automation Platform')
  })

  it('returns empty string for no subscriptions', () => {
    expect(buildRelationshipLine([])).toBe('')
  })
})

// ── buildFeatureBullets ─────────────────────────────────────────────────────

describe('buildFeatureBullets — anti-gaming', () => {
  const featureKeys = ['ansible-automation-platform', 'event-driven-ansible', 'openshift-ai']

  it('uses correct product name casing from registry', () => {
    const result = buildFeatureBullets(featureKeys, 'manager')
    // Must use registry names, not key-derived names
    expect(result).not.toContain('Aiops')
    expect(result).not.toContain('Openshift Ai')
    // Should contain proper names
    expect(result).toContain('Ansible Automation Platform')
    expect(result).toContain('Event-Driven Ansible')
    expect(result).toContain('OpenShift AI')
  })

  it('exec tier produces flowing prose, not pseudo-bullets', () => {
    const result = buildFeatureBullets(featureKeys, 'executive')
    // Exec tier must NOT have bare "FeatureName (url) description" pattern
    // But markdown links [Name](url) are fine — only catch unlinked bare URLs in parens
    expect(result).not.toMatch(/[A-Z][a-z]+\s+\(https?:\/\/[^)]+\)\s+[a-z]/)
    // Should read as connected prose — contains connecting words
    expect(result).toMatch(/\b(and|for|position|with)\b/)
  })

  it('manager tier has proper markdown links', () => {
    const result = buildFeatureBullets(featureKeys, 'manager')
    // Manager tier should have markdown links [Name](url)
    expect(result).toMatch(/\[.+\]\(https?:\/\/.+\)/)
  })

  it('exec tier embeds URLs as markdown links, not bare parenthetical', () => {
    const result = buildFeatureBullets(featureKeys, 'executive')
    // Should have [Name](url) format, not "Name (url)"
    expect(result).toMatch(/\[.+\]\(https?:\/\/.+\)/)
  })
})

// ── buildChallengerFrame ────────────────────────────────────────────────────

describe('buildChallengerFrame — anti-gaming', () => {
  it('does not use generic "While many organizations" wrapper', () => {
    const result = buildChallengerFrame(testSignals[0])
    expect(result).not.toContain('While many organizations')
    expect(result).not.toContain('broad digital transformation')
  })

  it('derives insight from signal headline', () => {
    const result = buildChallengerFrame(testSignals[0])
    expect(result).toContain('Infrastructure-as-Code Modernization')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns empty string for undefined signal', () => {
    expect(buildChallengerFrame(undefined)).toBe('')
  })
})

// ── buildCTA ────────────────────────────────────────────────────────────────

describe('buildCTA — anti-gaming', () => {
  it('produces different CTAs for different email indices', () => {
    // buildCTA accepts optional emailIndex as 4th param
    const ctas = Array.from({ length: 6 }, (_, i) =>
      (buildCTA as any)('Carolanne Farrell', 'Dhrupad Trivedi', 'A10 Networks', i)
    )

    // All 6 should be unique — identical CTAs across emails is a dead giveaway of automation
    const unique = new Set(ctas)
    expect(unique.size).toBe(6)
  })

  it('varies the deliverable across emails', () => {
    const cta0 = (buildCTA as any)('AE Name', 'Recipient Name', 'Customer', 0)
    const cta1 = (buildCTA as any)('AE Name', 'Recipient Name', 'Customer', 1)
    // At minimum, the deliverable phrasing should differ
    expect(cta0).not.toBe(cta1)
  })

  it('includes a specific deliverable, not just generic "conversation"', () => {
    // At least some CTAs should have specific deliverables beyond just "conversation"
    const ctas = Array.from({ length: 6 }, (_, i) =>
      (buildCTA as any)('Carolanne Farrell', 'Dhrupad Trivedi', 'A10 Networks', i)
    )
    const hasSpecific = ctas.some(c =>
      /overview|analysis|review|session|alignment/i.test(c)
    )
    expect(hasSpecific).toBe(true)
  })
})

// ── buildPeerPattern ────────────────────────────────────────────────────────

describe('buildPeerPattern — anti-gaming', () => {
  it('renders peer proof when available', () => {
    const result = buildPeerPattern(
      { playName: 'Cloud Migration', exampleIndex: 0 },
      testPlays,
    )
    expect(result).toContain('Amadeus')
    expect(result).toContain('$5.62M')
  })

  it('returns fallback from realWorldExamples when peerProof is null', () => {
    const result = buildPeerPattern(null, testPlays)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain('Amadeus')
  })

  it('returns generic fallback when no plays have metrics', () => {
    const emptyPlays = [{ name: 'Empty', parentTdp: 'TDP-X' }]
    const result = buildPeerPattern(null, emptyPlays)
    expect(result).toContain('sat with a handful of leaders')
  })
})

// ── Custom content passthrough ──────────────────────────────────────────────

describe('deterministic content generation', () => {
  it('buildOpener uses tier-aware variants for executive', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'executive')
    expect(result).toContain('Dhrupad')
    expect(result).toContain('Infrastructure-as-Code Modernization')
  })

  it('buildOpener uses tier-aware variants for manager', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager')
    expect(result).toContain('Dhrupad')
    expect(result).toContain('Infrastructure-as-Code Modernization')
  })

  it('buildSignalBridge uses SIGNAL_BRIDGES lookup', () => {
    const result = buildSignalBridge(testSignals[0], ['ansible-automation-platform'])
    expect(result).toContain('automation')
  })

  it('buildFeatureBullets uses getCapabilityDescription deterministically', () => {
    const result = buildFeatureBullets(['ansible-automation-platform', 'event-driven-ansible', 'execution-environments'], 'manager')
    expect(result).toContain('unifies automation')
    expect(result).toContain('triggers automated responses')
  })
})

// ── Product name dedup ─────────────────────────────────────────────────────

describe('buildFeatureBullets — every bullet always linked', () => {
  const featureKeys = ['ansible-automation-platform', 'event-driven-ansible', 'openshift-ai']

  it('links all products in deterministic output', () => {
    const result = buildFeatureBullets(featureKeys, 'manager')
    const lines = result.split('\n')
    expect(lines[0]).toContain('[Ansible Automation Platform]')
    expect(lines[1]).toContain('[Event-Driven Ansible]')
    expect(lines[2]).toContain('[OpenShift AI]')
  })

  it('links all products with theme modifier', () => {
    const result = buildFeatureBullets(featureKeys, 'manager', 'SaaS tax')
    expect(result).toContain('[Ansible Automation Platform]')
    expect(result).toContain('[Event-Driven Ansible]')
    expect(result).toContain('[OpenShift AI]')
    expect(result).toContain('SaaS tax exposure')
  })
})

// ── Cross-email anti-gaming ─────────────────────────────────────────────────

describe('cross-email quality properties', () => {
  it('competitor-swap test: output contains Red Hat-specific language', () => {
    const opener = buildOpener(0, testSignals, 0, 'Test User')
    const bridge = buildSignalBridge(testSignals[0], ['ansible-automation-platform'])
    const relationship = buildRelationshipLine(testSubscriptions)
    const combined = [opener, bridge, relationship].join(' ')

    // Should contain at least one Red Hat-specific term
    const rhTerms = ['Red Hat', 'Ansible', 'OpenShift', 'RHEL', 'automation platform']
    const hasRhTerm = rhTerms.some(term => combined.includes(term))
    expect(hasRhTerm).toBe(true)
  })
})

// ── sanitizeCreepyLines ────────────────────────────────────────────────────

describe('sanitizeCreepyLines — creepy line sanitizer', () => {
  it('strips sentences with pipeline opportunity data', () => {
    const input = 'Acme is modernizing their infrastructure. They have a $139k VMware replacement pipeline opportunity. This creates alignment with automation.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('$139k')
    expect(result).not.toContain('pipeline opportunity')
    expect(result).toContain('Acme is modernizing')
    expect(result).toContain('This creates alignment')
  })

  it('strips sentences with support case references', () => {
    const input = 'Their platform team is expanding. There is an open support case #12345 about RHEL upgrades. The CTO wants to consolidate tooling.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('support case')
    expect(result).not.toContain('#12345')
    expect(result).toContain('platform team')
    expect(result).toContain('CTO wants')
  })

  it('strips sentences with subscription/node counts', () => {
    const input = 'They run OpenShift in production. They have 57 RHEL subscriptions across three data centers. Cloud migration is a priority.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('57 RHEL subscriptions')
    expect(result).toContain('OpenShift in production')
    expect(result).toContain('Cloud migration')
  })

  it('strips SKU codes but preserves surrounding text', () => {
    const input = 'Their deployment includes MCT3691 and standard enterprise components.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('MCT3691')
  })

  it('strips sentences with layoff/headcount reduction data', () => {
    const input = 'The company is restructuring. They laid off 200 employees last quarter. New leadership is focused on automation.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('laid off')
    expect(result).not.toContain('200 employees')
    expect(result).toContain('restructuring')
    expect(result).toContain('New leadership')
  })

  it('strips sentences with renewal amounts', () => {
    const input = 'They are a long-standing customer. Their $450k renewal is coming up in Q4. This is an expansion opportunity.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('$450k renewal')
    expect(result).toContain('long-standing customer')
    expect(result).toContain('expansion opportunity')
  })

  it('preserves normal business text unchanged', () => {
    const input = 'Acme is investing in cloud-native infrastructure. Their CTO recently spoke about AI-first strategy at KubeCon. Red Hat OpenShift aligns with their containerization goals.'
    const result = sanitizeCreepyLines(input)
    expect(result).toBe(input)
  })

  it('preserves peer proof dollar amounts (not internal data)', () => {
    const input = 'Amadeus replaced Chef SaaS with AAP — $5.62M in benefits, 257.9% ROI.'
    const result = sanitizeCreepyLines(input)
    expect(result).toContain('$5.62M in benefits')
    expect(result).toContain('Amadeus')
  })

  it('handles newline-separated sentences', () => {
    const input = 'Strong cloud-native adoption\nThey have a $200k pipeline opportunity with VMware\nLeadership is aligned on modernization'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('pipeline opportunity')
    expect(result).toContain('cloud-native adoption')
    expect(result).toContain('Leadership is aligned')
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeCreepyLines('')).toBe('')
  })

  it('strips $NNM deal pattern', () => {
    const input = 'We see strong momentum. This is a $2M deal in the pipeline. Their team is growing.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('$2M deal')
  })

  it('strips pending dollar amounts', () => {
    const input = 'Good engagement so far. Pending $500k from the automation expansion. Next step is a technical review.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('pending $')
    expect(result).not.toContain('$500k')
  })

  it('strips support ticket references', () => {
    const input = 'They had a support ticket about kernel upgrades. Their team prefers RHEL for stability.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('support ticket')
    expect(result).toContain('RHEL for stability')
  })

  it('strips instance count references', () => {
    const input = 'Running 150 instances in production. They need better observability.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('150 instances')
    expect(result).toContain('better observability')
  })

  it('strips workforce reduction references', () => {
    const input = 'After the workforce reduction, they are doing more with less. Automation is critical.'
    const result = sanitizeCreepyLines(input)
    expect(result).not.toContain('workforce reduction')
    expect(result).toContain('Automation is critical')
  })
})

// ── renderObjectiveBlock (ADR-044) ────────────────────────────────────────

function makeProfile(overrides: Partial<CustomerObjectiveProfile> = {}): CustomerObjectiveProfile {
  return {
    financial: [],
    security: [],
    operational: [],
    innovation: [],
    growth: [],
    ...overrides,
  }
}

function makeEntry(obj: string, opts: { metric?: string | null; category?: string } = {}) {
  return {
    objective: obj,
    metric: opts.metric ?? null,
    priority: null as 'HIGH' | 'MED' | 'LOW' | null,
    source: 'test',
    confidence: 'HIGH' as const,
  }
}

const defaultTheme = { threat: 'SaaS tax and vendor lock-in', solution: 'self-managed automation' }

describe('renderObjectiveBlock', () => {
  it('returns financial sentence with objective context and threat', () => {
    const profile = makeProfile({ financial: [makeEntry('25-30% EBITDA margins target', { metric: '25-30%' })] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('25-30% EBITDA margins target')
    expect(result).toContain('SaaS tax and vendor lock-in')
    expect(result).toContain('self-managed automation')
    expect(result).toContain('protects this trajectory')
    expect(result).toStartWith('With ')
  })

  it('returns security sentence about strategic exposure', () => {
    const profile = makeProfile({ security: [makeEntry('zero-trust security initiative')] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('zero-trust security initiative')
    expect(result).toContain('strategic exposure')
    expect(result).toContain('reduces this surface')
    expect(result).toStartWith('Given ')
  })

  it('returns operational sentence', () => {
    const profile = makeProfile({ operational: [makeEntry('modernization initiative')] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('modernization initiative')
    expect(result).toContain('operational overhead')
    expect(result).toContain('consolidates this')
  })

  it('returns innovation sentence about progress', () => {
    const profile = makeProfile({ innovation: [makeEntry('AI platform strategy')] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('AI platform strategy')
    expect(result).toContain('keeps this on track')
    expect(result).toStartWith('As ')
  })

  it('returns growth sentence', () => {
    const profile = makeProfile({ growth: [makeEntry('15% YoY growth', { metric: '15% YoY growth' })] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('15% YoY growth')
    expect(result).toContain('removes this barrier')
  })

  it('returns empty string for undefined profile', () => {
    expect(renderObjectiveBlock(undefined, defaultTheme)).toBe('')
  })

  it('returns empty string for profile with no entries', () => {
    const profile = makeProfile()
    expect(renderObjectiveBlock(profile, defaultTheme)).toBe('')
  })

  it('Red Hat products never in threat position — threat is always external', () => {
    const profile = makeProfile({ financial: [makeEntry('cost discipline', { metric: '20%' })] })
    const theme = { threat: 'rising SaaS costs', solution: 'Red Hat Ansible Automation Platform' }
    const result = renderObjectiveBlock(profile, theme)
    expect(result).toContain('rising SaaS costs')
    expect(result).toContain('Red Hat Ansible Automation Platform')
    expect(result).not.toMatch(/Red Hat.*creates a direct headwind/)
    expect(result).toMatch(/Red Hat.*protects this trajectory/)
  })

  it('uses objective text as metric fallback when metric is null', () => {
    const profile = makeProfile({ operational: [makeEntry('modernize legacy stack')] })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('modernize legacy stack')
  })
})

// ── renderObjectiveBlock persona fallback ──────────────────────────────────

describe('renderObjectiveBlock — persona fallback', () => {
  it('null selection + CFO title → picks financial entry', () => {
    const profile = makeProfile({
      financial: [makeEntry('25% margin target', { metric: '25%' })],
      security: [makeEntry('zero-trust initiative')],
    })
    const result = renderObjectiveBlock(profile, defaultTheme, 'CFO')
    expect(result).toContain('25% margin target')
    expect(result).toContain('protects this trajectory')
  })

  it('null selection + security title → picks security entry', () => {
    const profile = makeProfile({
      financial: [makeEntry('margin target')],
      security: [makeEntry('breach prevention program')],
    })
    const result = renderObjectiveBlock(profile, defaultTheme, 'Head of Cybersecurity and Threat Protection')
    expect(result).toContain('breach prevention program')
    expect(result).toContain('strategic exposure')
  })

  it('null selection + innovation title → picks innovation entry', () => {
    const profile = makeProfile({
      innovation: [makeEntry('AI platform rollout')],
      financial: [makeEntry('cost discipline')],
    })
    const result = renderObjectiveBlock(profile, defaultTheme, 'VP AI and Digital Transformation')
    expect(result).toContain('AI platform rollout')
    expect(result).toContain('keeps this on track')
  })

  it('filters LOW urgency entries', () => {
    const profile = makeProfile({
      financial: [{
        objective: 'low priority thing',
        metric: null,
        priority: 'LOW',
        source: 'test',
        confidence: 'HIGH' as const,
      }, {
        objective: 'high priority margin target',
        metric: '25%',
        priority: 'HIGH',
        source: 'test',
        confidence: 'HIGH' as const,
      }],
    })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('high priority margin target')
    expect(result).not.toContain('low priority thing')
  })

  it('filters internal signal entries (termination, resignation)', () => {
    const profile = makeProfile({
      operational: [{
        objective: 'CEO termination creates leadership vacuum',
        metric: null,
        priority: 'HIGH',
        source: 'test',
        confidence: 'HIGH' as const,
      }, {
        objective: 'infrastructure modernization initiative',
        metric: null,
        priority: 'HIGH',
        source: 'test',
        confidence: 'HIGH' as const,
      }],
    })
    const result = renderObjectiveBlock(profile, defaultTheme)
    expect(result).toContain('infrastructure modernization initiative')
    expect(result).not.toContain('termination')
  })
})

// ── renderObjectiveBlock — preMatch (ADR-045) ─────────────────────────────

describe('renderObjectiveBlock — preMatch priority', () => {
  it('preMatch bypasses profile selection entirely', () => {
    const profile = makeProfile({
      financial: [makeEntry('EBITDA margins target')],
      security: [makeEntry('zero-trust initiative')],
    })
    const preMatch = {
      recipientName: 'Sean Pike',
      recipientTitle: 'Head of Information Security',
      category: 'security' as const,
      confidence: 0.9,
      entry: makeEntry('zero-trust architecture initiative'),
    }
    const result = renderObjectiveBlock(profile, defaultTheme, undefined, preMatch)
    expect(result).toContain('zero-trust architecture initiative')
    expect(result).toContain('strategic exposure')
    expect(result).not.toContain('EBITDA')
  })

  it('preMatch works without profile', () => {
    const preMatch = {
      recipientName: 'Ryan Henderson',
      recipientTitle: 'Director of Finance',
      category: 'financial' as const,
      confidence: 0.7,
      entry: makeEntry('25-30% EBITDA margins target', { metric: '25-30%' }),
    }
    const result = renderObjectiveBlock(undefined, defaultTheme, undefined, preMatch)
    expect(result).toContain('25-30% EBITDA margins target')
    expect(result).toContain('protects this trajectory')
  })

  it('preMatch innovation category uses correct template', () => {
    const preMatch = {
      recipientName: 'Dhrupad Trivedi',
      recipientTitle: 'President and CEO',
      category: 'innovation' as const,
      confidence: 0.5,
      entry: makeEntry('AI platform modernization'),
    }
    const result = renderObjectiveBlock(undefined, defaultTheme, undefined, preMatch)
    expect(result).toContain('AI platform modernization')
    expect(result).toContain('keeps this on track')
    expect(result).toStartWith('As ')
  })

  it('preMatch takes priority over recipientTitle fallback', () => {
    const profile = makeProfile({
      financial: [makeEntry('EBITDA target')],
      security: [makeEntry('breach prevention')],
    })
    const preMatch = {
      recipientName: 'Test',
      recipientTitle: 'CISO',
      category: 'security' as const,
      confidence: 0.8,
      entry: makeEntry('breach prevention'),
    }
    const result = renderObjectiveBlock(profile, defaultTheme, undefined, preMatch)
    expect(result).toContain('breach prevention')
    expect(result).toContain('strategic exposure')
    expect(result).not.toContain('EBITDA')
  })
})
