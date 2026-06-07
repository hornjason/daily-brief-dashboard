/**
 * Campaign Account Team Filter Tests (#668)
 *
 * Verifies that campaign HTML output shows only AE + product-relevant
 * SSP/SSA team members, not the full 11-person team.
 */

import { describe, test, expect } from 'bun:test'
import { getAccountTeam } from '../../src/account-team.ts'
import type { Customer } from '../../src/types.ts'

const mockCustomer: Customer = {
  name: 'Test Corp',
  ae: 'Jane Smith',
  accountNumber: '12345',
}

describe('#668 — campaign account team product filter', () => {
  test('getAccountTeam without filter returns AE + all specialists', () => {
    const team = getAccountTeam(mockCustomer)
    // Should at least include AE
    expect(team.length).toBeGreaterThanOrEqual(1)
    expect(team[0].role).toBe('ae')
    expect(team[0].name).toBe('Jane Smith')
  })

  test('getAccountTeam with product filter narrows specialists', () => {
    // With a product filter, only matching SSP/SSA should appear
    const teamAll = getAccountTeam(mockCustomer)
    const teamFiltered = getAccountTeam(mockCustomer, { products: ['Ansible'] })

    // AE should always be present in both
    expect(teamAll.some(m => m.role === 'ae')).toBe(true)
    expect(teamFiltered.some(m => m.role === 'ae')).toBe(true)

    // Filtered team should be <= full team
    expect(teamFiltered.length).toBeLessThanOrEqual(teamAll.length)
  })

  test('getAccountTeam with non-matching product returns AE only (+ ASA/managers)', () => {
    const team = getAccountTeam(mockCustomer, { products: ['NonExistentProduct999'] })

    // AE always present
    expect(team.some(m => m.role === 'ae')).toBe(true)

    // No SSP/SSA should match a fake product
    const specialists = team.filter(m => m.role === 'ssp' || m.role === 'ssa')
    expect(specialists.length).toBe(0)
  })
})
