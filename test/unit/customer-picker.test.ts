/**
 * Unit tests for CustomerPicker data transformation logic
 *
 * Tests the search filtering and AE grouping functions that power
 * the CustomerPicker component. Does not test React rendering.
 */

import { describe, it, expect } from 'bun:test'
import { filterCustomers, groupCustomersByAE } from '../../dashboard/src/components/CustomerPicker'

interface Customer {
  name: string
  ae: string
  slug: string
}

describe('CustomerPicker data logic', () => {
  const mockCustomers: Customer[] = [
    { name: 'Acme Corp', ae: 'Alice Johnson', slug: 'acme-corp' },
    { name: 'Beta Industries', ae: 'Alice Johnson', slug: 'beta-industries' },
    { name: 'Gamma LLC', ae: 'Bob Smith', slug: 'gamma-llc' },
    { name: 'Delta Co', ae: 'Bob Smith', slug: 'delta-co' },
    { name: 'Epsilon Inc', ae: 'Bob Smith', slug: 'epsilon-inc' },
  ]

  describe('filterCustomers', () => {
    it('returns all customers when query is empty', () => {
      const result = filterCustomers(mockCustomers, '')
      expect(result).toEqual(mockCustomers)
    })

    it('returns all customers when query is whitespace', () => {
      const result = filterCustomers(mockCustomers, '   ')
      expect(result).toEqual(mockCustomers)
    })

    it('filters by case-insensitive substring match', () => {
      const result = filterCustomers(mockCustomers, 'beta')
      expect(result).toEqual([{ name: 'Beta Industries', ae: 'Alice Johnson', slug: 'beta-industries' }])
    })

    it('matches partial names', () => {
      const result = filterCustomers(mockCustomers, 'Corp')
      expect(result).toEqual([{ name: 'Acme Corp', ae: 'Alice Johnson', slug: 'acme-corp' }])
    })

    it('returns empty array when no matches', () => {
      const result = filterCustomers(mockCustomers, 'Nonexistent')
      expect(result).toEqual([])
    })

    it('matches across multiple results', () => {
      const result = filterCustomers(mockCustomers, 'a')
      expect(result.length).toBeGreaterThan(0)
      expect(result.every(c => c.name.toLowerCase().includes('a'))).toBe(true)
    })
  })

  describe('groupCustomersByAE', () => {
    it('groups customers by AE name', () => {
      const result = groupCustomersByAE(mockCustomers)
      expect(result).toHaveLength(2)
      expect(result[0].ae).toBe('Alice Johnson')
      expect(result[1].ae).toBe('Bob Smith')
    })

    it('sorts customers within each group alphabetically', () => {
      const result = groupCustomersByAE(mockCustomers)
      const aliceGroup = result.find(g => g.ae === 'Alice Johnson')!
      expect(aliceGroup.customers[0].name).toBe('Acme Corp')
      expect(aliceGroup.customers[1].name).toBe('Beta Industries')

      const bobGroup = result.find(g => g.ae === 'Bob Smith')!
      expect(bobGroup.customers[0].name).toBe('Delta Co')
      expect(bobGroup.customers[1].name).toBe('Epsilon Inc')
      expect(bobGroup.customers[2].name).toBe('Gamma LLC')
    })

    it('sorts groups by AE name alphabetically', () => {
      const result = groupCustomersByAE(mockCustomers)
      expect(result[0].ae).toBe('Alice Johnson')
      expect(result[1].ae).toBe('Bob Smith')
    })

    it('handles customers with no AE', () => {
      const customersWithNoAE: Customer[] = [
        { name: 'Orphan Corp', ae: '', slug: 'orphan-corp' },
      ]
      const result = groupCustomersByAE(customersWithNoAE)
      expect(result).toHaveLength(1)
      expect(result[0].ae).toBe('Unassigned')
    })

    it('returns empty array for empty input', () => {
      const result = groupCustomersByAE([])
      expect(result).toEqual([])
    })
  })

})
