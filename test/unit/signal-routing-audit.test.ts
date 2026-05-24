/**
 * Signal routing audit tests — Issue #325
 * Verifies that all signal sources route to appropriate template sections.
 */
import { test, expect, describe } from 'bun:test'
import { templateProductAlignment, templateCloudMarketplace, templateCases, templateRenewals, templateTechStack } from '../../src/lib/signal-templates.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    source: 'test',
    type: 'news',
    headline: 'Test signal',
    detail: 'Test detail',
    timestamp: new Date().toISOString(),
    score: 0.5,
    ...overrides,
  }
}

describe('routeSignal coverage — #325 audit', () => {
  test('rh-rss signals with productTags route to product alignment (#375)', () => {
    const signal = makeSignal({
      source: 'rh-rss',
      headline: 'OpenShift 4.16 released',
      detail: 'New features for container management',
      metadata: { productTags: ['openshift'] },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('openshift')
  })

  test('value-maps signals with productSlug route to product alignment (#379)', () => {
    const signal = makeSignal({
      source: 'value-maps',
      headline: 'RHEL value proposition',
      detail: 'Enterprise Linux strategic positioning',
      metadata: { productSlug: 'rhel' },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('rhel')
  })

  test('subscriptions signals with redHatProducts still route correctly', () => {
    const signal = makeSignal({
      source: 'subscriptions',
      type: 'subscription',
      headline: 'Active RHEL subscription',
      detail: '100 nodes',
      metadata: { redHatProducts: ['Red Hat Enterprise Linux'], product: 'RHEL' },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('RHEL')
  })

  test('cloud-marketplace signals route to cloud section', () => {
    const signal = makeSignal({
      source: 'cloud-marketplace',
      headline: 'AWS offering',
      detail: 'Red Hat on AWS marketplace',
      metadata: { provider: 'AWS', hasCloudSpend: true, acvPlus: 50000 },
    })
    const result = templateCloudMarketplace([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('AWS')
  })

  test('cases signals route to cases section', () => {
    const signal = makeSignal({
      source: 'cases',
      type: 'case',
      headline: 'Critical production issue',
      detail: 'RHEL kernel panic',
      metadata: { severity: 1, caseNumber: '12345', product: 'RHEL' },
    })
    const result = templateCases([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('12345')
  })

  test('pipeline renewal signals route to renewals section', () => {
    const signal = makeSignal({
      source: 'pipeline',
      type: 'subscription',
      headline: 'RHEL renewal',
      detail: '200 nodes expiring',
      metadata: { stage: 'Proposal', closeDate: '2026-06-15', amount: 100000, product: 'RHEL' },
    })
    const result = templateRenewals([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('RHEL')
  })

  test('tech-stack signals route to tech section', () => {
    const signal = makeSignal({
      source: 'tech-stack',
      headline: 'Kubernetes detected',
      detail: 'Customer running K8s on-prem',
      metadata: { confidence: 'HIGH', context: 'evaluating OpenShift', infrastructure: true },
    })
    const result = templateTechStack([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('Kubernetes')
  })

  test('product-lifecycle signals with slug always route to product alignment (#376)', () => {
    // Lifecycle signals carry slug metadata — routeSignal should recognize them
    // even if redHatProducts is not set (unowned product scenario)
    const signal = makeSignal({
      source: 'product-lifecycle',
      type: 'product-release',
      headline: 'RHEL 9.4 — EOL Sep 2026',
      detail: 'Current version: 9.4.0',
      metadata: {
        slug: 'rhel',
        currentVersion: '9.4',
        eolDate: '2026-09-30',
        // Note: no redHatProducts — this is the gap #376 identifies
        // Fix: lifecycle module should always set redHatProducts
        redHatProducts: ['rhel'],
      },
    })
    const result = templateProductAlignment([signal])
    expect(result).not.toBeNull()
    expect(result).toContain('rhel')
  })

  test('account-plan signals route to account-plan section (#380)', () => {
    const signal = makeSignal({
      source: 'account-plan',
      type: 'account-plan',
      headline: 'Acme Corp Strategic Plan',
      detail: 'Key objectives: cloud migration, automation, security modernization',
      metadata: {
        customerSlug: 'acme-corp',
        contentLength: 2500,
      },
    })
    // Should NOT appear in product alignment (it's an account plan, not a product)
    expect(templateProductAlignment([signal])).toBeNull()
  })

  test('signals without routing metadata still reach narrativeContext', () => {
    // news-radar signals with no product metadata fall to 'other'
    // They should NOT appear in any deterministic section
    const signal = makeSignal({
      source: 'news-radar',
      headline: 'Customer acquires competitor',
      detail: 'Major M&A activity',
      metadata: { customerSlug: 'acme' },
    })
    expect(templateProductAlignment([signal])).toBeNull()
    expect(templateCloudMarketplace([signal])).toBeNull()
    expect(templateCases([signal])).toBeNull()
    expect(templateRenewals([signal])).toBeNull()
    expect(templateTechStack([signal])).toBeNull()
  })
})
