/**
 * Subscription Urgency Tests — GitHub Issue #513
 * Tests urgency metadata computation and case cross-referencing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'

// Use a temp cache dir to avoid polluting real data
const TEST_CACHE = resolve(import.meta.dir, '__test-cache-urgency__')

// Set env before importing module
process.env.CACHE_DIR = TEST_CACHE

// We'll dynamically import after setting env
let FeatureModuleRegistry: any

beforeAll(async () => {
  // Clean registry state
  const reg = await import('../../src/feature-module-registry.ts')
  FeatureModuleRegistry = reg.FeatureModuleRegistry
  FeatureModuleRegistry._resetForTesting()
  // Import module to register it
  await import('../../src/modules/subscriptions-module.ts')
})

function writeSubCache(slug: string, rows: any[]) {
  const path = resolve(TEST_CACHE, `${slug}-sheets.json`)
  writeFileSync(path, JSON.stringify({ rows, cachedAt: new Date().toISOString() }))
}

function writeCasesCache(cases: any[]) {
  const path = resolve(TEST_CACHE, 'cases.json')
  writeFileSync(path, JSON.stringify({ cases }))
}

function futureDate(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toISOString().split('T')[0]
}

function pastDate(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

describe('Subscription urgency (#513)', () => {
  beforeEach(() => {
    if (!existsSync(TEST_CACHE)) mkdirSync(TEST_CACHE, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_CACHE)) rmSync(TEST_CACHE, { recursive: true, force: true })
  })

  it('active subscription gets urgency: active', async () => {
    writeSubCache('test-corp', [
      { productDescription: 'Red Hat Enterprise Linux Server, Premium (1-2 sockets)', endDate: futureDate(180), quantity: 10 },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('test-corp')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('active')
  })

  it('subscription expiring in 60 days gets urgency: expiring-soon', async () => {
    writeSubCache('test-corp', [
      { productDescription: 'Red Hat OpenShift Container Platform, Standard (2 Cores)', endDate: futureDate(60), quantity: 5 },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('test-corp')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expiring-soon')
  })

  it('expired subscription with no matching cases gets urgency: expired', async () => {
    writeSubCache('test-corp', [
      { productDescription: 'Red Hat Ansible Automation Platform, Premium (100 Managed Nodes)', endDate: pastDate(21), quantity: 1 },
    ])
    // No cases cache at all
    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('test-corp')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expired')
  })

  it('expired subscription with matching case gets urgency: expired-critical', async () => {
    writeSubCache('crowdstrike', [
      { productDescription: 'Red Hat Ansible Automation Platform, Premium (100 Managed Nodes)', endDate: pastDate(21), quantity: 1 },
    ])
    writeCasesCache([
      {
        caseNumber: '04459393',
        customerName: 'CrowdStrike',
        product: 'Red Hat Ansible Automation Platform',
        status: 'Waiting on Red Hat',
        severity: '3',
      },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('crowdstrike')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expired-critical')
  })

  it('product name normalization matches case product to subscription', async () => {
    // Subscription has full product description with tier info
    writeSubCache('acme-corp', [
      { productDescription: 'Red Hat Ansible Automation Platform, Premium (100 Managed Nodes)', endDate: pastDate(5), quantity: 1 },
    ])
    // Case has base product name without tier info
    writeCasesCache([
      {
        caseNumber: '12345',
        customerName: 'Acme Corp',
        product: 'Red Hat Ansible Automation Platform',
        status: 'Open',
        severity: '2',
      },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('acme-corp')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expired-critical')
  })

  it('subscription at exactly 90 days gets urgency: expiring-soon', async () => {
    writeSubCache('edge-case', [
      { productDescription: 'Red Hat Enterprise Linux Server', endDate: futureDate(90), quantity: 1 },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('edge-case')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expiring-soon')
  })

  it('expired subscription with case for different product stays expired (not critical)', async () => {
    writeSubCache('diff-product', [
      { productDescription: 'Red Hat Enterprise Linux Server, Premium', endDate: pastDate(10), quantity: 1 },
    ])
    writeCasesCache([
      {
        caseNumber: '99999',
        customerName: 'Diff Product Inc',
        product: 'Red Hat Ansible Automation Platform',
        status: 'Open',
        severity: '2',
      },
    ])

    const mod = FeatureModuleRegistry.get('subscriptions')!
    const signals = await mod.signals('diff-product')
    expect(signals.length).toBe(1)
    expect(signals[0].metadata.urgency).toBe('expired')
  })
})
