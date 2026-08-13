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
