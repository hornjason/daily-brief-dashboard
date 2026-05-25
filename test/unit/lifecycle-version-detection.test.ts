/**
 * GitHub Issue #350 — Product lifecycle: version detection from cases
 * Verifies that lifecycle signals include detected customer versions
 * extracted from support cases and tech-stack data.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE = resolve(import.meta.dir, '../fixtures/lifecycle-ver-cache')
const originalCacheDir = process.env.CACHE_DIR
const originalConfigDir = process.env.CONFIG_DIR

beforeAll(async () => {
  process.env.CACHE_DIR = TEST_CACHE
  process.env.CONFIG_DIR = resolve(TEST_CACHE, 'config')
  mkdirSync(resolve(TEST_CACHE, 'config'), { recursive: true })
  mkdirSync(resolve(TEST_CACHE, 'tech-stack'), { recursive: true })

  // Write a minimal customers.json
  writeFileSync(
    resolve(TEST_CACHE, 'config', 'customers.json'),
    JSON.stringify([{ name: 'Acme Corp', slug: 'acme-corp', accountNumbers: ['123'] }]),
  )

  FeatureModuleRegistry._resetForTesting()
  await import('../../src/modules/lifecycle-module.ts')
})

afterAll(() => {
  process.env.CACHE_DIR = originalCacheDir
  process.env.CONFIG_DIR = originalConfigDir
  if (existsSync(TEST_CACHE)) rmSync(TEST_CACHE, { recursive: true })
})

function writeLifecycleCache(products: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, 'product-lifecycle.json'),
    JSON.stringify({ products, fetchedAt: new Date().toISOString() }),
  )
}

function writeCasesCache(cases: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, 'cases.json'),
    JSON.stringify({ cases }),
  )
}

function writeTechStackCache(customerSlug: string, technologies: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, 'tech-stack', `${customerSlug}.json`),
    JSON.stringify({ contentHash: 'test', technologies, cachedAt: new Date().toISOString() }),
  )
}

describe('lifecycle version detection', () => {
  test('signal includes detectedVersions from support cases', async () => {
    writeLifecycleCache([
      {
        slug: 'rhel',
        displayName: 'Red Hat Enterprise Linux',
        currentVersion: '9.4',
        latestPatch: '9.4.0',
        nextVersion: null,
        nextExpected: null,
        gaDate: '2024-05-01',
        eolDate: '2032-05-31',
        eusAvailable: true,
        supportEnd: '2029-05-31',
      },
    ])

    writeCasesCache([
      { caseNumber: '100001', customerName: 'Acme Corp', product: 'Red Hat Enterprise Linux 8.9', severity: '2', status: 'Waiting on Red Hat', daysOpen: 5 },
      { caseNumber: '100002', customerName: 'Acme Corp', product: 'Red Hat Enterprise Linux 9.2', severity: '3', status: 'Closed', daysOpen: 0 },
      { caseNumber: '100003', customerName: 'Other Company', product: 'Red Hat Enterprise Linux 8.6', severity: '1', status: 'Open', daysOpen: 10 },
    ])

    const mod = FeatureModuleRegistry.get('product-lifecycle')
    const signals = await mod!.signals!('acme-corp')

    const rhelSignal = signals.find(s => s.metadata?.slug === 'rhel')
    expect(rhelSignal).toBeDefined()
    expect(rhelSignal!.metadata!.detectedVersions).toBeDefined()
    expect(rhelSignal!.metadata!.detectedVersions).toContain('8.9')
    expect(rhelSignal!.metadata!.detectedVersions).toContain('9.2')
    // Should NOT include versions from other customers
    expect(rhelSignal!.metadata!.detectedVersions).not.toContain('8.6')
  })

  test('signal includes detectedVersions from tech-stack cache', async () => {
    writeLifecycleCache([
      {
        slug: 'ocp',
        displayName: 'Red Hat OpenShift Container Platform',
        currentVersion: '4.17',
        latestPatch: '4.17.3',
        nextVersion: '4.18',
        nextExpected: '2026-06-01',
        gaDate: '2024-10-01',
        eolDate: '2026-04-01',
        eusAvailable: false,
        supportEnd: '2026-04-01',
      },
    ])

    writeCasesCache([])

    writeTechStackCache('acme-corp', [
      {
        name: 'OpenShift 4.14',
        category: 'industry-tool',
        context: 'using',
        description: 'Container platform',
        infrastructure: ['AWS'],
        redHatProducts: ['ocp'],
        confidence: 'HIGH',
        lastResearched: new Date().toISOString(),
      },
    ])

    const mod = FeatureModuleRegistry.get('product-lifecycle')
    const signals = await mod!.signals!('acme-corp')

    const ocpSignal = signals.find(s => s.metadata?.slug === 'ocp')
    expect(ocpSignal).toBeDefined()
    expect(ocpSignal!.metadata!.detectedVersions).toBeDefined()
    expect(ocpSignal!.metadata!.detectedVersions).toContain('4.14')
  })

  test('rawRelevance is boosted when customer runs older versions', async () => {
    writeLifecycleCache([
      {
        slug: 'rhel',
        displayName: 'Red Hat Enterprise Linux',
        currentVersion: '9.4',
        latestPatch: '9.4.0',
        nextVersion: null,
        nextExpected: null,
        gaDate: '2024-05-01',
        eolDate: '2032-05-31',
        eusAvailable: true,
        supportEnd: '2029-05-31',
      },
    ])

    writeCasesCache([
      { caseNumber: '100010', customerName: 'Acme Corp', product: 'Red Hat Enterprise Linux 7.9', severity: '2', status: 'Open', daysOpen: 3 },
    ])

    writeTechStackCache('acme-corp', [])

    const mod = FeatureModuleRegistry.get('product-lifecycle')
    const signals = await mod!.signals!('acme-corp')

    const rhelSignal = signals.find(s => s.metadata?.slug === 'rhel')
    expect(rhelSignal).toBeDefined()
    // Running RHEL 7 when current is 9.4 should boost relevance above default 0.5
    expect(rhelSignal!.rawRelevance).toBeGreaterThan(0.5)
    expect(rhelSignal!.metadata!.hasOlderVersion).toBe(true)
  })

  test('no detected versions when no matching cases or tech-stack', async () => {
    writeLifecycleCache([
      {
        slug: 'aap',
        displayName: 'Red Hat Ansible Automation Platform',
        currentVersion: '2.5',
        latestPatch: '2.5.0',
        nextVersion: null,
        nextExpected: null,
        gaDate: '2024-11-01',
        eolDate: '2027-11-30',
        eusAvailable: false,
        supportEnd: '2027-11-30',
      },
    ])

    writeCasesCache([
      { caseNumber: '100020', customerName: 'Other Corp', product: 'Ansible Automation Platform 2.4', severity: '3', status: 'Open', daysOpen: 1 },
    ])

    writeTechStackCache('acme-corp', [])

    const mod = FeatureModuleRegistry.get('product-lifecycle')
    const signals = await mod!.signals!('acme-corp')

    const aapSignal = signals.find(s => s.metadata?.slug === 'aap')
    expect(aapSignal).toBeDefined()
    expect(aapSignal!.metadata!.detectedVersions).toEqual([])
    expect(aapSignal!.metadata!.hasOlderVersion).toBe(false)
  })
})
