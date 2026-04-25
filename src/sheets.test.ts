import { describe, expect, test } from 'bun:test'
import { normalizeForMatch, tabMatchesCustomer, tabMatchesAny, normalizeRows } from './sheets.ts'
import type { Customer } from './types.ts'

describe('normalizeForMatch', () => {
  test('strips common legal entity suffixes', () => {
    expect(normalizeForMatch('Acme, Inc.')).toBe('acme')
    expect(normalizeForMatch('Globex LLC')).toBe('globex')
    expect(normalizeForMatch('Initech Corp')).toBe('initech')
    expect(normalizeForMatch('Umbrella Corporation')).toBe('umbrella')
    expect(normalizeForMatch('Nakatomi Ltd')).toBe('nakatomi')
    expect(normalizeForMatch('Weyland-Yutani Co.')).toBe('weyland yutani')
  })

  test('lowercases the result', () => {
    expect(normalizeForMatch('ACME CORP')).toBe('acme')
  })

  test('collapses whitespace', () => {
    expect(normalizeForMatch('  A10  Networks  ')).toBe('a10 networks')
  })

  test('handles already-normalized input', () => {
    expect(normalizeForMatch('acme')).toBe('acme')
  })
})

describe('tabMatchesCustomer', () => {
  test('matches identical names', () => {
    expect(tabMatchesCustomer('Acme', 'Acme')).toBe(true)
  })

  test('tab is subset of customer name (after normalization)', () => {
    expect(tabMatchesCustomer('Acme', 'Acme Corporation')).toBe(true)
  })

  test('customer name is subset of tab name (after normalization)', () => {
    expect(tabMatchesCustomer('Acme Corporation', 'Acme')).toBe(true)
  })

  test('returns false for unrelated names', () => {
    expect(tabMatchesCustomer('Globex', 'Acme')).toBe(false)
    expect(tabMatchesCustomer('Initech', 'Umbrella')).toBe(false)
  })

  test('is case-insensitive', () => {
    expect(tabMatchesCustomer('ACME', 'acme')).toBe(true)
  })

  test('handles legal suffix differences gracefully', () => {
    expect(tabMatchesCustomer('A10 Networks Inc', 'A10 Networks, Inc.')).toBe(true)
  })
})

describe('tabMatchesAny', () => {
  const customer: Customer = {
    name: 'Acme Corporation',
    aliases: ['Acme Corp', 'ACME INC'],
    domain: 'acme.com',
  } as Customer

  test('matches canonical customer name', () => {
    expect(tabMatchesAny('Acme Corporation', customer)).toBe(true)
  })

  test('matches alias', () => {
    expect(tabMatchesAny('ACME INC', customer)).toBe(true)
    expect(tabMatchesAny('Acme Corp', customer)).toBe(true)
  })

  test('returns false when no names match', () => {
    expect(tabMatchesAny('Globex', customer)).toBe(false)
  })

  test('handles customer with no aliases', () => {
    const simple: Customer = { name: 'Globex', domain: 'globex.com' } as Customer
    expect(tabMatchesAny('Globex', simple)).toBe(true)
    expect(tabMatchesAny('Acme', simple)).toBe(false)
  })
})

describe('normalizeRows', () => {
  type Row = Record<string, string>
  const makeRow = (sku: string, qty: string, status: string, desc = 'RHEL Server'): Row => ({
    'Internal Sku': sku,
    'Quantity': qty,
    'Status': status,
    'Product Description': desc,
  })

  test('returns empty array for empty input', () => {
    expect(normalizeRows([])).toEqual([])
  })

  test('filters out CANCELLED rows, includes EXPIRED', () => {
    const rows = [
      makeRow('RHEL', '10', 'ACTIVE'),
      makeRow('OCP', '5', 'CANCELLED'),
      makeRow('AAP', '2', 'EXPIRED'),
    ]
    const result = normalizeRows(rows)
    expect(result).toHaveLength(2)
    expect(result.find(r => r.sku === 'RHEL')).toBeDefined()
    expect(result.find(r => r.sku === 'AAP')).toBeDefined()
    expect(result.find(r => r.sku === 'OCP')).toBeUndefined()
  })

  test('aggregates quantity for duplicate SKUs', () => {
    const rows = [
      makeRow('RHEL', '10', 'ACTIVE'),
      makeRow('RHEL', '5', 'ACTIVE'),
      makeRow('OCP', '3', 'ACTIVE', 'OpenShift'),
    ]
    const result = normalizeRows(rows)
    const rhel = result.find(r => r.sku === 'RHEL')
    expect(rhel?.quantity).toBe(15)
    expect(result).toHaveLength(2)
  })

  test('includes all ACTIVE rows', () => {
    const rows = [
      makeRow('RHEL', '1', 'ACTIVE', 'RHEL Server'),
      makeRow('AAP', '2', 'ACTIVE', 'Ansible Automation'),
    ]
    const result = normalizeRows(rows)
    expect(result).toHaveLength(2)
  })
})
