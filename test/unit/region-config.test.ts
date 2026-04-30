/**
 * BKL-HERO-01 Phase 0 — unit tests for isPodFilterActive.
 *
 * The single rule that activates pod filtering anywhere in the app:
 *   `Array.isArray(value) && value.length > 0`
 * `undefined`, `null`, `[]` all return false (legacy installs unaffected).
 */
import { test, expect, describe } from 'bun:test'
import { isPodFilterActive } from '../../src/region-config.ts'

describe('isPodFilterActive', () => {
  test('returns false for undefined (legacy install — no filter)', () => {
    expect(isPodFilterActive(undefined)).toBe(false)
  })

  test('returns false for null (legacy install — no filter)', () => {
    expect(isPodFilterActive(null)).toBe(false)
  })

  test('returns false for empty array (deliberately empty — no filter)', () => {
    expect(isPodFilterActive([])).toBe(false)
  })

  test('returns true for non-empty array of qualified pod keys', () => {
    expect(isPodFilterActive(['west-commercial.WEST_COMM_CORP_NORTHWEST'])).toBe(true)
  })

  test('returns true for multi-element array', () => {
    expect(isPodFilterActive([
      'west-commercial.WEST_COMM_CORP_NORTHWEST',
      'central-enterprise-tola.CENTRAL_ENT_TOLA',
    ])).toBe(true)
  })

  test('returns false for non-array values (string, number, object)', () => {
    expect(isPodFilterActive('west-commercial')).toBe(false)
    expect(isPodFilterActive(42)).toBe(false)
    expect(isPodFilterActive({ enabled: true })).toBe(false)
  })
})
