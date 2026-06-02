/**
 * Signal URL Tests — GitHub Issue #523
 * PRINCIPLES.md pre-flight Q9: every signal referencing a source document
 * MUST populate the url field with a clickable link.
 *
 * Tests that subscription and CCSP signals include Drive URLs
 * pointing to the source spreadsheet for the customer's AE.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_AES = [
  {
    name: 'Jane Smith',
    driveFolderId: '1abc',
    parentFolderId: '1xyz',
    subscriptionSheetId: 'sheet-sub-123',
    ccspSheetId: 'sheet-ccsp-456',
    pipelineSheetId: 'sheet-pipe-789',
  },
  {
    name: 'Bob Jones',
    driveFolderId: '2abc',
    parentFolderId: '2xyz',
    // No subscriptionSheetId or ccspSheetId — tests graceful fallback
    pipelineSheetId: 'sheet-pipe-000',
  },
]

const MOCK_CUSTOMERS = [
  { name: 'Acme Corp', ae: 'Jane Smith' },
  { name: 'Globex Inc', ae: 'Bob Jones' },
  { name: 'Orphan Ltd' }, // No AE assigned
]

const MOCK_SUBSCRIPTION_DATA = {
  cachedAt: '2026-05-31T00:00:00Z',
  rows: [
    {
      productDescription: 'Red Hat OpenShift Container Platform',
      quantity: 10,
      endDate: '2027-01-15',
    },
  ],
}

const MOCK_CCSP_DATA = {
  cachedAt: '2026-05-31T00:00:00Z',
  records: [
    {
      accountName: 'Acme Corp',
      cloudPartner: 'AWS',
      acvPlus: 50000,
      productOfferingGroup: 'OpenShift',
    },
  ],
}

// ── Module-level mocks ────────────────────────────────────────────────────────

// Mock server-state to provide our fixture data
mock.module('../../src/server-state.ts', () => ({
  aes: MOCK_AES,
  customers: MOCK_CUSTOMERS,
  AES_PATH: '/fake/aes.json',
  CUSTOMERS_PATH: '/fake/customers.json',
  CONFIG_DIR_PATH: '/fake/config',
  loadServerState: () => {},
  saveAes: () => {},
  saveCustomers: () => {},
  patchAe: () => {},
  patchCustomer: () => {},
  setAes: () => {},
  setCustomers: () => {},
}))

// Mock cache-layer for CCSP
mock.module('../../src/cache-layer.ts', () => ({
  readCCSPCache: () => MOCK_CCSP_DATA,
  toSlug: (name: string) =>
    name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, ''),
}))

// Mock fs for subscription cache reads
const { existsSync: origExistsSync, readFileSync: origReadFileSync } = await import('fs')

mock.module('fs', () => ({
  existsSync: (p: string) => {
    if (typeof p === 'string' && p.includes('acme-corp-sheets.json')) return true
    if (typeof p === 'string' && p.includes('globex-inc-sheets.json')) return true
    if (typeof p === 'string' && p.includes('orphan-ltd-sheets.json')) return false
    return origExistsSync(p)
  },
  readFileSync: (p: string, enc?: string) => {
    if (typeof p === 'string' && p.includes('acme-corp-sheets.json')) {
      return JSON.stringify(MOCK_SUBSCRIPTION_DATA)
    }
    if (typeof p === 'string' && p.includes('globex-inc-sheets.json')) {
      return JSON.stringify(MOCK_SUBSCRIPTION_DATA)
    }
    return origReadFileSync(p, enc as any)
  },
  statSync: () => ({ mtimeMs: Date.now() }),
  writeFileSync: () => {},
}))

describe('Signal URLs — GitHub Issue #523', () => {
  beforeAll(async () => {
    FeatureModuleRegistry._resetForTesting()
    // Import modules to trigger registration
    await import('../../src/modules/subscriptions-module.ts')
    await import('../../src/modules/ccsp-module.ts')
  })

  afterAll(() => {
    FeatureModuleRegistry._resetForTesting()
  })

  describe('subscription signals', () => {
    it('include url field pointing to Drive sheet when AE has subscriptionSheetId', async () => {
      const mod = FeatureModuleRegistry.get('subscriptions')!
      const signals = await mod.signals!('acme-corp')
      expect(signals.length).toBeGreaterThan(0)
      for (const s of signals) {
        expect(s.url).toBe('https://docs.google.com/spreadsheets/d/sheet-sub-123/edit')
      }
    })

    it('url is omitted when AE has no subscriptionSheetId', async () => {
      const mod = FeatureModuleRegistry.get('subscriptions')!
      const signals = await mod.signals!('globex-inc')
      expect(signals.length).toBeGreaterThan(0)
      for (const s of signals) {
        expect(s.url).toBeUndefined()
      }
    })

    it('url is omitted when customer has no AE', async () => {
      const mod = FeatureModuleRegistry.get('subscriptions')!
      // orphan-ltd has no sheets cache file, so returns empty
      const signals = await mod.signals!('orphan-ltd')
      expect(signals.length).toBe(0)
    })
  })

  describe('ccsp signals', () => {
    it('include url field pointing to Drive sheet when AE has ccspSheetId', async () => {
      const mod = FeatureModuleRegistry.get('ccsp')!
      const signals = await mod.signals!('acme-corp')
      expect(signals.length).toBeGreaterThan(0)
      for (const s of signals) {
        expect(s.url).toBe('https://docs.google.com/spreadsheets/d/sheet-ccsp-456/edit')
      }
    })
  })
})
