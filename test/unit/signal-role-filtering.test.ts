/**
 * Signal role filtering tests — ADR-032a
 * Verifies trigger/enrichment separation in cross-referencing logic.
 */

import { describe, test, expect } from 'bun:test'
import { getRecommendations } from '../../src/lib/signal-query.ts'
import type { Signal } from '../../src/feature-module-registry.ts'

// ── Test fixtures ──────────────────────────────────────────────────────────

const makeTriggerSignal = (overrides: Partial<Signal> = {}): Signal => ({
  source: 'tech-stack',
  type: 'technology',
  headline: 'Customer uses VMware vSphere',
  detail: 'VMware detected in customer environment',
  rawRelevance: 0.8,
  timestamp: new Date().toISOString(),
  role: 'trigger',
  audience: 'customer-specific',
  metadata: {
    customerSlug: 'test-corp',
    techName: 'VMware',
  },
  ...overrides,
})

const makeEnrichmentSignal = (overrides: Partial<Signal> = {}): Signal => ({
  source: 'ecosystem-catalog',
  type: 'product-intel',
  headline: 'VMware Migration Solution Brief',
  detail: 'Partner solution for VMware migration',
  rawRelevance: 0.6,
  timestamp: new Date().toISOString(),
  role: 'enrichment',
  audience: 'all',
  url: 'https://catalog.example.com/vmware-migration',
  ...overrides,
})

const makePlayCatalog = () => [
  {
    id: 'vmware-migration',
    name: 'VMware Migration Play',
    triggerTechnologies: ['VMware', 'vSphere', 'ESXi'],
    description: 'Migrate VMware workloads to OpenShift Virtualization',
  },
  {
    id: 'ansible-automation',
    name: 'Ansible Automation Play',
    triggerTechnologies: ['Ansible', 'Puppet', 'Chef'],
    description: 'Automate with Ansible',
  },
]

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ADR-032a: Signal role filtering in getRecommendations', () => {
  test('enrichment-role signals do NOT appear in trigger matching', () => {
    const enrichmentOnlySignals: Signal[] = [
      makeEnrichmentSignal({
        source: 'ecosystem-catalog',
        type: 'technology',
        headline: 'VMware partner solution',
        metadata: { techName: 'VMware' },
      }),
    ]

    const results = getRecommendations(
      enrichmentOnlySignals,
      makePlayCatalog(),
      [],
      null,
      null,
    )

    // Enrichment signals should not create play matches on their own
    expect(results).toHaveLength(0)
  })

  test('trigger-role signals DO create play matches', () => {
    const triggerSignals: Signal[] = [
      makeTriggerSignal(),
    ]

    const results = getRecommendations(
      triggerSignals,
      makePlayCatalog(),
      [],
      null,
      null,
    )

    expect(results.length).toBeGreaterThan(0)
    expect(results[0].solution.name).toBe('VMware Migration Play')
  })

  test('enrichment signals attach as assets to matched plays', () => {
    const signals: Signal[] = [
      makeTriggerSignal(),
      makeEnrichmentSignal({
        headline: 'VMware to OpenShift Migration Guide',
        url: 'https://example.com/guide',
      }),
    ]

    const results = getRecommendations(
      signals,
      makePlayCatalog(),
      [],
      null,
      null,
    )

    expect(results.length).toBeGreaterThan(0)
    const vmwarePlay = results.find(r => r.solution.name === 'VMware Migration Play')
    expect(vmwarePlay).toBeDefined()
    // Enrichment signal should be attached as an asset
    const assets = vmwarePlay!.solution.assets ?? []
    const enrichmentAsset = assets.find(a => a.name === 'VMware to OpenShift Migration Guide')
    expect(enrichmentAsset).toBeDefined()
    expect(enrichmentAsset!.url).toBe('https://example.com/guide')
  })

  test('headline shows customer-specific triggers, not portfolio content', () => {
    const signals: Signal[] = [
      makeTriggerSignal({
        headline: 'Acme Corp runs VMware vSphere 7.0',
        audience: 'customer-specific',
        metadata: { customerSlug: 'acme-corp', techName: 'VMware' },
      }),
      makeTriggerSignal({
        headline: 'Product Lifecycle: VMware support ending',
        audience: 'all',
        source: 'product-lifecycle',
        type: 'product-release',
        metadata: { techName: 'VMware' },
      }),
    ]

    const results = getRecommendations(
      signals,
      makePlayCatalog(),
      [],
      null,
      null,
    )

    expect(results.length).toBeGreaterThan(0)
    // The action string should lead with customer-specific trigger, not portfolio
    expect(results[0].action).toContain('Acme Corp runs VMware vSphere 7.0')
  })

  test('backward compat: signals without role are treated as triggers', () => {
    const noRoleSignal: Signal = {
      source: 'tech-stack',
      type: 'technology',
      headline: 'Legacy signal without role field',
      detail: 'Should still trigger matches',
      rawRelevance: 0.8,
      timestamp: new Date().toISOString(),
      // No role field — should default to trigger behavior
      metadata: { customerSlug: 'test-corp', techName: 'VMware' },
    }

    const results = getRecommendations(
      [noRoleSignal],
      makePlayCatalog(),
      [],
      null,
      null,
    )

    // Signals without role should create matches (backward compat)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].solution.name).toBe('VMware Migration Play')
  })

  test('enrichment assets are capped at 5 per play', () => {
    const triggerSignal = makeTriggerSignal()
    const manyEnrichments = Array.from({ length: 10 }, (_, i) =>
      makeEnrichmentSignal({
        headline: `VMware Resource ${i + 1}`,
        url: `https://example.com/resource-${i + 1}`,
      })
    )

    const results = getRecommendations(
      [triggerSignal, ...manyEnrichments],
      makePlayCatalog(),
      [],
      null,
      null,
    )

    expect(results.length).toBeGreaterThan(0)
    const vmwarePlay = results.find(r => r.solution.name === 'VMware Migration Play')
    expect(vmwarePlay).toBeDefined()
    const enrichmentAssets = (vmwarePlay!.solution.assets ?? []).filter(
      a => a.name.startsWith('VMware Resource')
    )
    expect(enrichmentAssets.length).toBeLessThanOrEqual(5)
  })

  test('enrichment signals for unmatched plays are not attached', () => {
    const signals: Signal[] = [
      makeTriggerSignal(), // VMware trigger
      makeEnrichmentSignal({
        headline: 'Kubernetes best practices guide',
        detail: 'General Kubernetes guide for container orchestration',
        url: 'https://example.com/k8s-guide',
      }),
    ]

    const results = getRecommendations(
      signals,
      makePlayCatalog(),
      [],
      null,
      null,
    )

    expect(results.length).toBeGreaterThan(0)
    const vmwarePlay = results.find(r => r.solution.name === 'VMware Migration Play')
    expect(vmwarePlay).toBeDefined()
    // The k8s guide should NOT be attached since it doesn't mention VMware triggers
    const assets = vmwarePlay!.solution.assets ?? []
    const k8sAsset = assets.find(a => a.name === 'Kubernetes best practices guide')
    expect(k8sAsset).toBeUndefined()
  })
})
