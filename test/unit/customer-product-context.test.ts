import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { normalizeProductSlug, getCustomerProductContext } from '../../src/lib/customer-product-context'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

describe('normalizeProductSlug', () => {
  it('normalizes exact matches', () => {
    expect(normalizeProductSlug('openshift')).toBe('ocp')
    expect(normalizeProductSlug('rhel')).toBe('rhel')
    expect(normalizeProductSlug('ansible')).toBe('aap')
    expect(normalizeProductSlug('quay')).toBe('quay')
    expect(normalizeProductSlug('satellite')).toBe('satellite')
    expect(normalizeProductSlug('insights')).toBe('insights')
  })

  it('normalizes full product names', () => {
    expect(normalizeProductSlug('OpenShift Container Platform')).toBe('ocp')
    expect(normalizeProductSlug('Enterprise Linux')).toBe('rhel')
    expect(normalizeProductSlug('Ansible Automation Platform')).toBe('aap')
    expect(normalizeProductSlug('Advanced Cluster Security')).toBe('acs')
    expect(normalizeProductSlug('Advanced Cluster Management')).toBe('acm')
    expect(normalizeProductSlug('Developer Hub')).toBe('rhdh')
  })

  it('normalizes with Red Hat prefix via substring match', () => {
    expect(normalizeProductSlug('Red Hat OpenShift')).toBe('ocp')
    expect(normalizeProductSlug('Red Hat Enterprise Linux')).toBe('rhel')
    expect(normalizeProductSlug('Red Hat Ansible Automation Platform')).toBe('aap')
    expect(normalizeProductSlug('Red Hat Advanced Cluster Security for Kubernetes')).toBe('acs')
  })

  it('is case-insensitive', () => {
    expect(normalizeProductSlug('OPENSHIFT')).toBe('ocp')
    expect(normalizeProductSlug('Rhel')).toBe('rhel')
    expect(normalizeProductSlug('ANSIBLE AUTOMATION PLATFORM')).toBe('aap')
  })

  it('handles OpenShift AI before OpenShift', () => {
    expect(normalizeProductSlug('OpenShift AI')).toBe('rhoai')
    expect(normalizeProductSlug('Red Hat OpenShift AI')).toBe('rhoai')
    expect(normalizeProductSlug('rhoai')).toBe('rhoai')
  })

  it('returns undefined for unknown products', () => {
    expect(normalizeProductSlug('unknown product')).toBeUndefined()
    expect(normalizeProductSlug('')).toBeUndefined()
    expect(normalizeProductSlug('VMware vSphere')).toBeUndefined()
  })
})

describe('getCustomerProductContext', () => {
  const TEST_DIR = resolve(import.meta.dir, '.test-customer-product-context')
  const CONFIG_DIR = resolve(TEST_DIR, 'config')
  const CACHE_DIR = resolve(TEST_DIR, 'cache')

  beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    mkdirSync(resolve(CACHE_DIR, 'intelligence'), { recursive: true })
    process.env.CONFIG_DIR = CONFIG_DIR
    process.env.CACHE_DIR = CACHE_DIR
  })

  afterEach(() => {
    delete process.env.CONFIG_DIR
    delete process.env.CACHE_DIR
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  })

  it('extracts owned products from subscriptions', () => {
    writeFileSync(resolve(CONFIG_DIR, 'customers.json'), JSON.stringify({
      customers: [{
        name: 'Acme Corp',
        slug: 'acme-corp',
        subscriptions: [
          { productName: 'Red Hat Enterprise Linux', quantity: 10 },
          { productName: 'OpenShift Container Platform', quantity: 5 },
        ]
      }]
    }))

    const ctx = getCustomerProductContext('acme-corp')
    expect(ctx.ownedProducts).toContain('rhel')
    expect(ctx.ownedProducts).toContain('ocp')
    expect(ctx.allRelevantProducts).toContain('rhel')
    expect(ctx.allRelevantProducts).toContain('ocp')
  })

  it('deduplicates products', () => {
    writeFileSync(resolve(CONFIG_DIR, 'customers.json'), JSON.stringify({
      customers: [{
        name: 'Acme Corp',
        slug: 'acme-corp',
        subscriptions: [
          { productName: 'RHEL', quantity: 10 },
          { productName: 'Red Hat Enterprise Linux for SAP', quantity: 5 },
        ]
      }]
    }))

    const ctx = getCustomerProductContext('acme-corp')
    expect(ctx.ownedProducts.filter(p => p === 'rhel')).toHaveLength(1)
  })

  it('returns empty for unknown customer', () => {
    writeFileSync(resolve(CONFIG_DIR, 'customers.json'), JSON.stringify({ customers: [] }))
    const ctx = getCustomerProductContext('nonexistent')
    expect(ctx.ownedProducts).toEqual([])
    expect(ctx.interestProducts).toEqual([])
    expect(ctx.allRelevantProducts).toEqual([])
  })

  it('returns empty when customers.json missing', () => {
    const ctx = getCustomerProductContext('acme-corp')
    expect(ctx.ownedProducts).toEqual([])
  })

  it('handles array format customers.json', () => {
    writeFileSync(resolve(CONFIG_DIR, 'customers.json'), JSON.stringify([{
      name: 'Acme Corp',
      slug: 'acme-corp',
      subscriptions: [{ productName: 'OpenShift', quantity: 5 }]
    }]))

    const ctx = getCustomerProductContext('acme-corp')
    expect(ctx.ownedProducts).toContain('ocp')
  })

  it('handles customer with no subscriptions', () => {
    writeFileSync(resolve(CONFIG_DIR, 'customers.json'), JSON.stringify({
      customers: [{ name: 'Acme Corp', slug: 'acme-corp' }]
    }))

    const ctx = getCustomerProductContext('acme-corp')
    expect(ctx.ownedProducts).toEqual([])
  })
})
