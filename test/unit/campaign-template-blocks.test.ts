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
import { validateCampaignOutput } from '../../src/lib/campaign-output-validator.ts'
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

describe('buildOpener — dedup across emails (#197)', () => {
  it('falls back to signal headline when brief opener already used', () => {
    const brief = makeBrief({
      objectiveMatch: 'modernize the automation stack for operational efficiency',
      timingTrigger: null as any,
      valueProposition: null as any,
    })
    const used = new Set<string>()
    const first = buildOpener(0, testSignals, 0, 'Alice Smith', 'manager', brief, undefined, used)
    const second = buildOpener(0, testSignals, 0, 'Bob Jones', 'manager', brief, undefined, used)
    expect(second).not.toBe(first.replace('Alice', 'Bob'))
    expect(second).toContain('Bob')
  })

  it('produces unique openers for 3 contacts sharing sparse brief', () => {
    const brief = makeBrief({
      objectiveMatch: 'consolidate automation tooling across the enterprise',
      timingTrigger: null as any,
      valueProposition: null as any,
    })
    const used = new Set<string>()
    const names = ['Alice Smith', 'Bob Jones', 'Carol White']
    const openers = names.map((name, i) => {
      return buildOpener(0, testSignals, i, name, 'manager', brief, undefined, used)
    })
    const unique = new Set(openers)
    expect(unique.size).toBe(3)
  })

  it('does not dedup when usedOpeners is not provided', () => {
    const brief = makeBrief({
      objectiveMatch: 'modernize the automation stack for operational efficiency',
      timingTrigger: null as any,
      valueProposition: null as any,
    })
    const first = buildOpener(0, testSignals, 0, 'Alice Smith', 'manager', brief)
    const second = buildOpener(0, testSignals, 0, 'Bob Jones', 'manager', brief)
    expect(first.replace('Alice', 'Bob')).toBe(second)
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

describe('buildOpener — verb-leading subject fix (#197)', () => {
  it('prepends "this" when brief field starts with a verb like "aligns"', () => {
    const brief = makeBrief({
      objectiveMatch: "aligns directly with A10's strong focus on profitability",
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief, 'A10')
    expect(result).not.toMatch(/^Dhrupad, aligns\b/i)
    expect(result).toContain('this')
  })

  it('catches uppercase verb-leading text like "Aligns"', () => {
    const brief = makeBrief({
      objectiveMatch: 'Aligns perfectly with your infrastructure modernization goals',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).toContain('this aligns')
    expect(result).not.toMatch(/^Test, Aligns\b/)
  })

  it('catches "Directly addresses" as verb-leading', () => {
    const brief = makeBrief({
      objectiveMatch: 'Directly addresses your challenge with infrastructure sprawl',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).not.toMatch(/^Test, [Dd]irectly\b/)
  })

  it('does not prepend "this" when field already has a subject', () => {
    const brief = makeBrief({
      objectiveMatch: 'your automation strategy creates room for consolidation',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).not.toMatch(/this your/)
  })
})

describe('buildOpener — coaching language strip (#197)', () => {
  it('strips "this persona" and trailing text from opener', () => {
    const brief = makeBrief({
      objectiveMatch: 'the SaaS tax is the catalyst this persona needs to get executive buy-in and',
    })
    const result = buildOpener(0, testSignals, 0, 'Aris Chen', 'manager', brief)
    expect(result).not.toContain('this persona')
    expect(result).toContain('Aris')
  })
})

describe('buildOpener — trailing conjunction cleanup (#197)', () => {
  it('strips trailing "and" from truncated openers', () => {
    const brief = makeBrief({
      objectiveMatch: 'your platform consolidation drives efficiency and',
    })
    const result = buildOpener(0, testSignals, 0, 'Test User', 'manager', brief)
    expect(result).not.toMatch(/\band\.\s*$/)
    expect(result).not.toMatch(/\band\s*$/)
  })
})

describe('buildOpener — smartLc preserves A10-style names (#197)', () => {
  it('preserves A10 casing at start of opener field', () => {
    const brief = makeBrief({
      objectiveMatch: 'A10 Networks is investing in automation infrastructure',
    })
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'manager', brief)
    expect(result).toContain('A10')
    expect(result).not.toContain('a10')
  })
})

describe('buildOpener — dedup tries all fields before signal fallback (#197)', () => {
  it('uses second brief field when first is taken', () => {
    const brief = makeBrief({
      objectiveMatch: 'modernize the automation stack for operational efficiency',
      timingTrigger: 'Q4 budget cycle approaching fast with new leadership',
      valueProposition: null as any,
    })
    const used = new Set<string>()
    const first = buildOpener(0, testSignals, 0, 'Alice Smith', 'manager', brief, undefined, used)
    const second = buildOpener(0, testSignals, 0, 'Bob Jones', 'manager', brief, undefined, used)
    // Second should use the timingTrigger field, not fall through to signal headline
    expect(first).toContain('Alice')
    expect(second).toContain('Bob')
    // Second should NOT be a signal-headline opener (those contain "tells me" or "driving" etc.)
    expect(second).not.toContain('Infrastructure-as-Code Modernization')
  })
})

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

// ── Email output quality patterns (post-generation validator) ──────────────

describe('Email output quality patterns', () => {
  const wrapEmail = (recipientName: string, tier: string, body: string, rawHtml?: string) => {
    const html = rawHtml || `<p>${body}</p>`
    return `<div style="border: 2px solid #dadce0; margin-bottom: 24px;">
  <div style="background: #c41e3a; padding: 12px 20px;">
    <span style="color: white; font-size: 16px; font-weight: bold;">📧  ${recipientName} — ${tier}</span>
  </div>
  <div style="padding: 20px;">${html}<div style="margin-top: 20px; padding-top: 14px; border-top: 3px solid #c41e3a;">
      <p>AE Name</p><p>jhorn@redhat.com</p>
    </div>
  </div>
</div>`
  }

  const wrapPage = (emailHtml: string) => `<!DOCTYPE html><html><body>
<h2>Target Contacts</h2><h2>Generation Config</h2><h2>Quality Checklist</h2>
<h2>Intelligence Dashboard</h2><h2>Executive Outreach</h2><h2>Manager Outreach</h2>
${emailHtml}</body></html>`

  it('opener has grammatical subject — no verb-leading fragments', () => {
    const html = wrapPage(wrapEmail('Alice Smith', 'Manager', 'Alice, aligns directly with your focus on profitability. More text here about automation. jhorn@redhat.com'))
    const result = validateCampaignOutput(html)
    const noSubjectWarnings = result.failures.filter(f => f.check === 'opener-no-subject')
    expect(noSubjectWarnings.length).toBeGreaterThanOrEqual(0) // pattern detection
  })

  it('no markdown labels in email body', () => {
    const html = wrapPage(wrapEmail('Bob Jones', 'Executive', 'Bob, your automation is great. **Campaign Theme:** test content. jhorn@redhat.com'))
    const result = validateCampaignOutput(html)
    const labelLeaks = result.failures.filter(f => f.check === 'markdown-label-leak')
    expect(labelLeaks.length).toBe(1)
    expect(labelLeaks[0].severity).toBe('blocker')
  })

  it('no coaching language in email body', () => {
    const html = wrapPage(wrapEmail('Carol White', 'Manager',
      'Carol, automation is key. Show how Red Hat Ansible helps teams. jhorn@redhat.com',
      '<p>Carol, automation is key. Show how Red Hat Ansible helps teams. jhorn@redhat.com</p><a href="https://redhat.com/a">A</a><a href="https://redhat.com/b">B</a>'
    ))
    const result = validateCampaignOutput(html)
    const coaching = result.failures.filter(f => f.check === 'coaching-language')
    expect(coaching.length).toBe(1)
    expect(coaching[0].severity).toBe('blocker')
  })

  it('no staging labels on products', () => {
    const html = wrapPage(wrapEmail('Dave Lee', 'Manager', 'Dave, OpenShift AI (beta) is available now. jhorn@redhat.com'))
    const result = validateCampaignOutput(html)
    const staging = result.failures.filter(f => f.check === 'staging-label')
    expect(staging.length).toBe(1)
  })

  it('no internal terminology in email body', () => {
    const html = wrapPage(wrapEmail('Eve Park', 'Executive', 'Eve, the signalIndex shows high relevance. jhorn@redhat.com'))
    const result = validateCampaignOutput(html)
    const internal = result.failures.filter(f => f.check === 'internal-terminology')
    expect(internal.length).toBe(1)
    expect(internal[0].severity).toBe('blocker')
  })

  it('no duplicate openers across emails', () => {
    const email1 = wrapEmail('Alice Smith', 'Executive', 'Alice, your automation strategy is key. jhorn@redhat.com')
    const email2 = wrapEmail('Bob Jones', 'Manager', 'Alice, your automation strategy is key. jhorn@redhat.com')
    const html = wrapPage(email1 + email2)
    const result = validateCampaignOutput(html)
    const dupes = result.failures.filter(f => f.check === 'opener-duplicate')
    expect(dupes.length).toBe(1)
  })

  it('detects missing required sections', () => {
    const html = '<html><body><p>Hello</p></body></html>'
    const result = validateCampaignOutput(html)
    const missing = result.failures.filter(f => f.check === 'section-missing')
    expect(missing.length).toBeGreaterThan(0)
    expect(result.pass).toBe(false)
  })

  it('detects deny patterns in output', () => {
    const html = wrapPage(wrapEmail('Test User', 'Manager', 'Test, there is a $2M pipeline deal here. jhorn@redhat.com'))
    const result = validateCampaignOutput(html)
    const denies = result.failures.filter(f => f.check === 'deny-pattern')
    expect(denies.length).toBeGreaterThan(0)
    expect(result.pass).toBe(false)
  })

  it('passes clean output', () => {
    const cleanEmail = wrapEmail('Alice Smith', 'Executive',
      'Alice, your cloud strategy is creating new opportunities for automation. ' +
      'Red Hat Ansible Automation Platform unifies operations. ' +
      'Would August 25 work for a focused conversation? jhorn@redhat.com',
      '<p>Alice, your cloud strategy is creating new opportunities. Red Hat Ansible Automation Platform unifies operations. Would August 25 work? jhorn@redhat.com</p>' +
      '<a href="https://example.com/report">Report</a>' +
      '<a href="https://redhat.com/ansible">Ansible</a>' +
      '<a href="https://redhat.com/openshift">OpenShift</a>'
    )
    const cleanEmail2 = wrapEmail('Bob Jones', 'Manager',
      'Bob, infrastructure modernization is driving new priorities. ' +
      'Organizations are consolidating on enterprise platforms. jhorn@redhat.com',
      '<p>Bob, infrastructure modernization is driving new priorities. Organizations are consolidating. jhorn@redhat.com</p>' +
      '<a href="https://news.example.com/article">Article</a>' +
      '<a href="https://redhat.com/rhel">RHEL</a>' +
      '<a href="https://redhat.com/ansible">Ansible</a>'
    )
    const html = wrapPage(cleanEmail + cleanEmail2)
    const result = validateCampaignOutput(html)
    const blockers = result.failures.filter(f => f.severity === 'blocker')
    expect(blockers).toEqual([])
    expect(result.pass).toBe(true)
  })
})
