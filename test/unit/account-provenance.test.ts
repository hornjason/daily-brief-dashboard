/**
 * Unit tests for account provenance tracking and startup healer.
 *
 * Tests pure functions:
 *   - isStaleProvenance(): detects old appVersion, missing provenance, manual preservation
 *   - migratePreRc8Provenance(): stamps legacy accounts with 'pre-rc8' provenance
 *   - buildHealerPlan(): given customers + current version, returns heal plan
 *
 * Issue: #82 — Phase 1: accountNumbers provenance tracking with auto-healing
 */
import { describe, test, expect } from 'bun:test'
import type { Customer } from '../../src/types.ts'
import {
  isStaleProvenance,
  migratePreRc8Provenance,
  buildHealerPlan,
  type AccountProvenance,
} from '../../src/account-provenance-healer.ts'

const CURRENT_VERSION = '1.7.0-rc8'

describe('isStaleProvenance', () => {
  test('returns true when provenance is undefined (no tracking)', () => {
    expect(isStaleProvenance(undefined, CURRENT_VERSION)).toBe(true)
  })

  test('returns true when provenance array is empty', () => {
    expect(isStaleProvenance([], CURRENT_VERSION)).toBe(true)
  })

  test('returns true when appVersion does not match current', () => {
    const provenance: AccountProvenance[] = [{
      accountNumber: '12345',
      discoveredBy: 'rh-cases-api',
      appVersion: '1.7.0-rc6',
      discoveredAt: '2026-05-01T00:00:00Z',
    }]
    expect(isStaleProvenance(provenance, CURRENT_VERSION)).toBe(true)
  })

  test('returns false when appVersion matches current', () => {
    const provenance: AccountProvenance[] = [{
      accountNumber: '12345',
      discoveredBy: 'rh-cases-api',
      appVersion: CURRENT_VERSION,
      discoveredAt: '2026-05-01T00:00:00Z',
    }]
    expect(isStaleProvenance(provenance, CURRENT_VERSION)).toBe(false)
  })

  test('returns false when all entries are manual (never stale)', () => {
    const provenance: AccountProvenance[] = [{
      accountNumber: '12345',
      discoveredBy: 'manual',
      appVersion: '1.0.0-ancient',
      discoveredAt: '2024-01-01T00:00:00Z',
    }]
    expect(isStaleProvenance(provenance, CURRENT_VERSION)).toBe(false)
  })

  test('returns true when mix of manual and stale automated entries', () => {
    const provenance: AccountProvenance[] = [
      {
        accountNumber: '12345',
        discoveredBy: 'manual',
        appVersion: '1.0.0',
        discoveredAt: '2024-01-01T00:00:00Z',
      },
      {
        accountNumber: '67890',
        discoveredBy: 'rh-scraper',
        appVersion: '1.7.0-rc6',
        discoveredAt: '2026-05-01T00:00:00Z',
      },
    ]
    expect(isStaleProvenance(provenance, CURRENT_VERSION)).toBe(true)
  })

  test('returns false when mix of manual and current automated entries', () => {
    const provenance: AccountProvenance[] = [
      {
        accountNumber: '12345',
        discoveredBy: 'manual',
        appVersion: '1.0.0',
        discoveredAt: '2024-01-01T00:00:00Z',
      },
      {
        accountNumber: '67890',
        discoveredBy: 'rh-scraper',
        appVersion: CURRENT_VERSION,
        discoveredAt: '2026-05-10T00:00:00Z',
      },
    ]
    expect(isStaleProvenance(provenance, CURRENT_VERSION)).toBe(false)
  })
})

describe('migratePreRc8Provenance', () => {
  test('stamps accounts without provenance as pre-rc8', () => {
    const accountNumbers = ['111111', '222222']
    const result = migratePreRc8Provenance(accountNumbers, undefined)
    expect(result).toHaveLength(2)
    expect(result[0].accountNumber).toBe('111111')
    expect(result[0].discoveredBy).toBe('pre-rc8')
    expect(result[0].appVersion).toBe('pre-rc8')
    expect(result[1].accountNumber).toBe('222222')
  })

  test('returns existing provenance unchanged if already populated', () => {
    const existing: AccountProvenance[] = [{
      accountNumber: '111111',
      discoveredBy: 'rh-cases-api',
      appVersion: '1.7.0-rc7',
      discoveredAt: '2026-05-01T00:00:00Z',
    }]
    const result = migratePreRc8Provenance(['111111'], existing)
    expect(result).toEqual(existing)
  })

  test('returns empty array when no account numbers', () => {
    const result = migratePreRc8Provenance([], undefined)
    expect(result).toEqual([])
  })
})

describe('buildHealerPlan', () => {
  test('queues re-discovery for customer with stale provenance', () => {
    const customers: Customer[] = [{
      name: 'Continental Broadband',
      accountNumbers: ['7777777'],
      accountProvenance: [{
        accountNumber: '7777777',
        discoveredBy: 'rh-scraper',
        appVersion: '1.7.0-rc6',
        discoveredAt: '2026-04-01T00:00:00Z',
      }],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(1)
    expect(plan[0].customerName).toBe('Continental Broadband')
    expect(plan[0].reason).toBe('stale-version')
  })

  test('queues re-discovery for customer with missing provenance (pre-rc8 migration)', () => {
    const customers: Customer[] = [{
      name: 'Acme Corp',
      accountNumbers: ['123456'],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(1)
    expect(plan[0].customerName).toBe('Acme Corp')
    expect(plan[0].reason).toBe('missing-provenance')
  })

  test('preserves manual accounts — does not queue for re-discovery', () => {
    const customers: Customer[] = [{
      name: 'Manual Customer',
      accountNumbers: ['999999'],
      accountProvenance: [{
        accountNumber: '999999',
        discoveredBy: 'manual',
        appVersion: '1.0.0',
        discoveredAt: '2024-01-01T00:00:00Z',
      }],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(0)
  })

  test('skips customers with no account numbers', () => {
    const customers: Customer[] = [{
      name: 'New Customer',
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(0)
  })

  test('skips customers with current provenance', () => {
    const customers: Customer[] = [{
      name: 'Up To Date',
      accountNumbers: ['555555'],
      accountProvenance: [{
        accountNumber: '555555',
        discoveredBy: 'rh-cases-api',
        appVersion: CURRENT_VERSION,
        discoveredAt: '2026-05-10T00:00:00Z',
      }],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(0)
  })

  test('skips customers with skipAccountDiscovery flag', () => {
    const customers: Customer[] = [{
      name: 'No RH Account',
      accountNumbers: ['444444'],
      skipAccountDiscovery: true,
      accountProvenance: [{
        accountNumber: '444444',
        discoveredBy: 'rh-scraper',
        appVersion: '1.7.0-rc6',
        discoveredAt: '2026-04-01T00:00:00Z',
      }],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(0)
  })

  test('preserves manual accounts in mixed provenance but queues automated ones', () => {
    const customers: Customer[] = [{
      name: 'Mixed Customer',
      accountNumbers: ['111111', '222222'],
      accountProvenance: [
        {
          accountNumber: '111111',
          discoveredBy: 'manual',
          appVersion: '1.0.0',
          discoveredAt: '2024-01-01T00:00:00Z',
        },
        {
          accountNumber: '222222',
          discoveredBy: 'rh-scraper',
          appVersion: '1.7.0-rc6',
          discoveredAt: '2026-04-01T00:00:00Z',
        },
      ],
    }]
    const plan = buildHealerPlan(customers, CURRENT_VERSION)
    expect(plan).toHaveLength(1)
    expect(plan[0].customerName).toBe('Mixed Customer')
    expect(plan[0].preserveManualAccounts).toEqual(['111111'])
  })
})
