/**
 * Anti-gaming tests for two-pass campaign template blocks.
 * Each test verifies a specific quality property that the template
 * must maintain — preventing regressions to generic/broken output.
 *
 * These test the FIXED behavior from #1068. Red before fixes, green after.
 */

import { describe, it, expect } from 'bun:test'
import type { BusinessObjective } from '../../src/campaign-html-template.ts'
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
  extractFinancialTargets,
  buildFinancialConflict,
  extractBusinessObjectives,
  buildObjectiveCorrelation,
  buildObjectiveContext,
} from '../../src/campaign-html-template.ts'
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
    const result = buildChallengerFrame('Companies adopting self-managed automation see 40% lower TCO')
    expect(result).not.toContain('While many organizations')
    expect(result).not.toContain('broad digital transformation')
  })

  it('uses the data point as the lead sentence', () => {
    const dataPoint = 'Companies adopting self-managed automation see 40% lower TCO'
    const result = buildChallengerFrame(dataPoint)
    // Data point should appear at the start, not buried in a wrapper
    expect(result.indexOf(dataPoint)).toBeLessThan(5)
  })

  it('returns empty string for empty data point', () => {
    expect(buildChallengerFrame('')).toBe('')
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

  it('returns empty string when no plays have metrics either', () => {
    const emptyPlays = [{ name: 'Empty', parentTdp: 'TDP-X' }]
    const result = buildPeerPattern(null, emptyPlays)
    expect(result).toBe('')
  })
})

// ── Custom content passthrough ──────────────────────────────────────────────

describe('custom content passthrough', () => {
  it('buildOpener uses customOpener when provided', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi', 'SB 122 takes effect January 1 — every SaaS tool picks up 8-10% tax')
    expect(result).toContain('SB 122 takes effect')
    expect(result).toContain('Dhrupad')
  })

  it('buildOpener falls back to signal when no customOpener', () => {
    const result = buildOpener(0, testSignals, 0, 'Dhrupad Trivedi')
    expect(result).toContain('Dhrupad')
    expect(result).not.toContain('SB 122 takes effect')
  })

  it('buildSignalBridge uses custom bridge when provided', () => {
    const result = buildSignalBridge(testSignals[0], ['ansible-automation-platform'], 'For a company shipping products built on RHEL, the fix is straightforward.')
    expect(result).toContain('shipping products')
  })

  it('buildFeatureBullets uses custom applications when provided', () => {
    const apps = ['self-managed in your VPC, zero SaaS tax exposure', 'automated security response for Thunder and Defend', 'portable automation across cloud and on-prem']
    const result = buildFeatureBullets(['ansible-automation-platform', 'event-driven-ansible', 'execution-environments'], 'manager', apps)
    expect(result).toContain('self-managed in your VPC')
    expect(result).toContain('Thunder and Defend')
  })
})

// ── Product name dedup ─────────────────────────────────────────────────────

describe('buildFeatureBullets — every bullet always linked', () => {
  const featureKeys = ['ansible-automation-platform', 'event-driven-ansible', 'openshift-ai']

  it('links all products even when mentioned in prior text', () => {
    const priorText = 'switching to Red Hat Ansible Automation Platform avoids the SaaS tax'
    const result = buildFeatureBullets(featureKeys, 'manager', undefined, priorText)
    const lines = result.split('\n')
    expect(lines[0]).toContain('[Ansible Automation Platform]')
    expect(lines[1]).toContain('[Event-Driven Ansible]')
    expect(lines[2]).toContain('[OpenShift AI]')
  })

  it('links all products when none appear in prior text', () => {
    const priorText = 'Your teams are evaluating cloud infrastructure options'
    const result = buildFeatureBullets(featureKeys, 'manager', undefined, priorText)
    expect(result).toContain('[Ansible Automation Platform]')
    expect(result).toContain('[Event-Driven Ansible]')
    expect(result).toContain('[OpenShift AI]')
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

// ── extractFinancialTargets ───────────────────────────────────────────────

describe('extractFinancialTargets', () => {
  it('finds margin target from signal with "operating margin of 25.5%"', () => {
    const signals: Signal[] = [
      makeSignal('Q2 2026 earnings: operating margin of 25.5% reported'),
    ]
    const targets = extractFinancialTargets(signals)
    expect(targets.length).toBeGreaterThanOrEqual(1)
    expect(targets[0].type).toBe('margin')
    expect(targets[0].metric).toContain('25.5%')
    expect(targets[0].source).toContain('Q2 2026 earnings')
  })

  it('finds growth target from "15.5% YoY revenue growth"', () => {
    const signals: Signal[] = [
      makeSignal('Company posts 15.5% YoY revenue growth in latest quarter'),
    ]
    const targets = extractFinancialTargets(signals)
    expect(targets.length).toBeGreaterThanOrEqual(1)
    const growth = targets.find(t => t.type === 'growth')
    expect(growth).toBeDefined()
    expect(growth!.metric).toContain('15.5%')
  })

  it('returns empty array for signals with no financial data', () => {
    const signals: Signal[] = [
      makeSignal('New CTO appointed at Acme Corp'),
      makeSignal('Cloud migration initiative announced'),
    ]
    const targets = extractFinancialTargets(signals)
    expect(targets).toEqual([])
  })

  it('finds cost-reduction target', () => {
    const signals: Signal[] = [
      makeSignal('CFO announces cost reduction initiative: reduce costs by 15%'),
    ]
    const targets = extractFinancialTargets(signals)
    expect(targets.length).toBeGreaterThanOrEqual(1)
    expect(targets.some(t => t.type === 'cost-reduction')).toBe(true)
  })

  it('finds discipline target from EBITDA mention', () => {
    const signals: Signal[] = [
      makeSignal('Board sets EBITDA target of $500M for FY2027'),
    ]
    const targets = extractFinancialTargets(signals)
    expect(targets.length).toBeGreaterThanOrEqual(1)
    expect(targets.some(t => t.type === 'discipline')).toBe(true)
  })
})

// ── buildFinancialConflict ────────────────────────────────────────────────

describe('buildFinancialConflict', () => {
  it('produces conflict sentence for margin target', () => {
    const targets = [{ type: 'margin' as const, metric: '25.5% operating margin', source: 'Q2 2026 earnings', raw: 'operating margin of 25.5%' }]
    const result = buildFinancialConflict(targets, 'SaaS Tax Exposure')
    expect(result).toContain('25.5% operating margin')
    expect(result).toContain('SaaS Tax Exposure')
    expect(result).toContain('discipline')
  })

  it('returns empty string when no targets', () => {
    const result = buildFinancialConflict([], 'SaaS Tax Exposure')
    expect(result).toBe('')
  })

  it('selects most specific target: margin over discipline', () => {
    const targets = [
      { type: 'discipline' as const, metric: 'operational discipline', source: 'earnings call', raw: 'operational discipline' },
      { type: 'margin' as const, metric: '30% gross margin', source: 'Q3 report', raw: 'gross margin of 30%' },
    ]
    const result = buildFinancialConflict(targets, 'VMware migration')
    expect(result).toContain('30% gross margin')
  })
})

// ── extractBusinessObjectives ─────────────────────────────────────────────

describe('extractBusinessObjectives', () => {
  it('extracts financial objectives from margin signals', () => {
    const signals: Signal[] = [
      makeSignal('Q2 2026 earnings: operating margin of 25.5% reported'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives.length).toBeGreaterThanOrEqual(1)
    expect(objectives.some(o => o.category === 'financial')).toBe(true)
    expect(objectives.find(o => o.category === 'financial')!.objective).toContain('25.5%')
  })

  it('extracts security initiative from signal', () => {
    const signals: Signal[] = [
      makeSignal('CISO launches zero-trust security initiative across all divisions'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives.length).toBeGreaterThanOrEqual(1)
    expect(objectives.some(o => o.category === 'security')).toBe(true)
  })

  it('extracts operational initiative from signal', () => {
    const signals: Signal[] = [
      makeSignal('CTO announces automation initiative to reduce manual ops by 40%'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives.length).toBeGreaterThanOrEqual(1)
    expect(objectives.some(o => o.category === 'operational')).toBe(true)
  })

  it('extracts innovation initiative from signal', () => {
    const signals: Signal[] = [
      makeSignal('Board approves AI strategy initiative for FY2027 — HIGH priority'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives.length).toBeGreaterThanOrEqual(1)
    const innovation = objectives.find(o => o.category === 'innovation')
    expect(innovation).toBeDefined()
    expect(innovation!.priority).toBe('HIGH')
  })

  it('returns empty array for signals with no objectives', () => {
    const signals: Signal[] = [
      makeSignal('New office opened in Austin'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives).toEqual([])
  })

  it('extracts from both financial and initiative patterns in same signal set', () => {
    const signals: Signal[] = [
      makeSignal('Q1 earnings: gross margin of 30%'),
      makeSignal('VP Infra launches modernization initiative for legacy systems'),
    ]
    const objectives = extractBusinessObjectives(signals)
    expect(objectives.some(o => o.category === 'financial')).toBe(true)
    expect(objectives.some(o => o.category === 'operational')).toBe(true)
  })
})

// ── buildObjectiveCorrelation ─────────────────────────────────────────────

describe('buildObjectiveCorrelation', () => {
  it('produces financial correlation for cost-themed campaign', () => {
    const objectives = [
      { category: 'financial' as const, objective: '25.5% operating margin', source: 'Q2 earnings' },
    ]
    const result = buildObjectiveCorrelation(objectives, 'SaaS Tax Exposure')
    expect(result).toContain('25.5% operating margin')
    expect(result).toContain('SaaS Tax Exposure')
  })

  it('produces security correlation for security-themed campaign', () => {
    const objectives = [
      { category: 'financial' as const, objective: '30% margin', source: 'earnings' },
      { category: 'security' as const, objective: 'zero-trust security initiative', priority: 'HIGH', source: 'Strategic Initiatives' },
    ]
    const result = buildObjectiveCorrelation(objectives, 'Vulnerability Remediation Platform')
    expect(result).toContain('zero-trust security initiative')
    expect(result).toContain('$4.5M')
    expect(result).toContain('Vulnerability Remediation Platform')
  })

  it('produces operational correlation for automation-themed campaign', () => {
    const objectives = [
      { category: 'operational' as const, objective: 'automation initiative', source: 'Strategic Initiatives' },
    ]
    const result = buildObjectiveCorrelation(objectives, 'Infrastructure Automation Consolidation')
    expect(result).toContain('automation initiative')
    expect(result).toContain('consolidates operational overhead')
  })

  it('produces innovation correlation for AI-themed campaign', () => {
    const objectives = [
      { category: 'innovation' as const, objective: 'AI strategy initiative', priority: 'HIGH', source: 'Strategic Initiatives' },
    ]
    const result = buildObjectiveCorrelation(objectives, 'OpenShift AI Model Serving')
    expect(result).toContain('AI strategy initiative')
    expect(result).toContain('accelerates this roadmap')
  })

  it('returns empty string when no objectives', () => {
    expect(buildObjectiveCorrelation([], 'Any Theme')).toBe('')
  })

  it('matches theme to correct category when multiple objectives exist', () => {
    const objectives = [
      { category: 'financial' as const, objective: '25% margin', source: 'earnings' },
      { category: 'security' as const, objective: 'compliance program', priority: 'HIGH', source: 'Strategic Initiatives' },
      { category: 'operational' as const, objective: 'modernization initiative', source: 'Strategic Initiatives' },
    ]
    const result = buildObjectiveCorrelation(objectives, 'Security Patch Automation')
    expect(result).toContain('compliance program')
    expect(result).not.toContain('25% margin')
  })
})

// ── buildObjectiveContext — financial correlation in email body ─────────────

describe('buildObjectiveContext — financial correlation in email body', () => {
  it('returns financial context sentence when financial objective exists', () => {
    const objectives: BusinessObjective[] = [
      { category: 'financial', objective: '12% YoY revenue growth', source: 'Q2 earnings' },
    ]
    const result = buildObjectiveContext(objectives, 'SaaS Tax', 0)
    expect(result).toContain('12% YoY revenue growth')
    expect(result.length).toBeGreaterThan(20)
  })

  it('returns security context for security objective', () => {
    const objectives: BusinessObjective[] = [
      { category: 'security', objective: 'zero-trust security initiative', source: 'Strategic Initiatives' },
    ]
    const result = buildObjectiveContext(objectives, 'platform security', 0)
    expect(result).toContain('zero-trust')
  })

  it('varies objective selection by email index', () => {
    const objectives: BusinessObjective[] = [
      { category: 'financial', objective: '12% growth', source: 'earnings' },
      { category: 'operational', objective: 'automation initiative', source: 'strategy' },
      { category: 'security', objective: 'breach prevention', source: 'initiatives' },
    ]
    const r0 = buildObjectiveContext(objectives, 'SaaS Tax', 0)
    const r1 = buildObjectiveContext(objectives, 'SaaS Tax', 1)
    const r2 = buildObjectiveContext(objectives, 'SaaS Tax', 2)
    expect(new Set([r0, r1, r2]).size).toBeGreaterThanOrEqual(2)
  })

  it('returns empty string when no objectives exist', () => {
    expect(buildObjectiveContext([], 'SaaS Tax', 0)).toBe('')
  })

  it('handles single objective across all email indices', () => {
    const objectives: BusinessObjective[] = [
      { category: 'financial', objective: '15% margin', source: 'earnings' },
    ]
    expect(buildObjectiveContext(objectives, 'cost reduction', 0)).toContain('15% margin')
    expect(buildObjectiveContext(objectives, 'cost reduction', 5)).toContain('15% margin')
  })
})
