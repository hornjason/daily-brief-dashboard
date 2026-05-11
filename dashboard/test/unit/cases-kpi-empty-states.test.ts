/**
 * BKL-#65: RH Cases KPI card empty states
 * Test the state-determination logic for showing honest empty states instead of silent zero.
 *
 * Three states:
 * 1. no-source: No L4 node, no account numbers → "No case data source configured"
 * 2. awaiting-sync: L4 configured, but never synced → "Awaiting first sync from primary node"
 * 3. synced-zero: Synced successfully, zero cases → "No cases found for your accounts"
 * 4. null: Cases present → use existing display
 */

import { describe, test, expect } from 'bun:test'
import { determineRhCasesEmptyState } from '../../src/lib/rh-cases-empty-state'

describe('RH Cases KPI empty states (BKL-#65)', () => {
  test('no-source: L3-only (hero) with no account numbers', () => {
    const state = determineRhCasesEmptyState(
      true,
      null,
      0,
      []
    )
    expect(state).toBe('no-source')
  })

  test('no-source: undefined isL3Only with no account numbers', () => {
    const state = determineRhCasesEmptyState(
      undefined,
      null,
      0,
      []
    )
    expect(state).toBe('no-source')
  })

  test('awaiting-sync: L4 node (isL3Only=false) but never synced', () => {
    const state = determineRhCasesEmptyState(
      false,
      null,
      0,
      [{ accountNumbers: ['12345'] }]
    )
    expect(state).toBe('awaiting-sync')
  })

  test('awaiting-sync: L4 node with no account numbers but primary configured', () => {
    const state = determineRhCasesEmptyState(
      false,
      null,
      0,
      []
    )
    expect(state).toBe('awaiting-sync')
  })

  test('synced-zero: synced successfully, but zero cases matched', () => {
    const state = determineRhCasesEmptyState(
      false,
      '2026-05-10T10:00:00Z',
      0,
      [{ accountNumbers: ['12345', '67890'] }]
    )
    expect(state).toBe('synced-zero')
  })

  test('synced-zero: L3-only but has lastScraped (should not happen, but handle gracefully)', () => {
    const state = determineRhCasesEmptyState(
      true,
      '2026-05-10T10:00:00Z',
      0,
      []
    )
    expect(state).toBe('synced-zero')
  })

  test('null: cases present → use normal display', () => {
    const state = determineRhCasesEmptyState(
      false,
      '2026-05-10T10:00:00Z',
      5,
      [{ accountNumbers: ['12345'] }]
    )
    expect(state).toBe(null)
  })

  test('null: cases present even without sync timestamp (edge case)', () => {
    const state = determineRhCasesEmptyState(
      false,
      null,
      3,
      [{ accountNumbers: ['12345'] }]
    )
    expect(state).toBe(null)
  })
})
