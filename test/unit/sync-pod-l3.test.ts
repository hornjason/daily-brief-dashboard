import { describe, it, expect } from 'bun:test'

/**
 * normalizeForMatch removes underscores and spaces to enable fuzzy matching
 * between pod keys (EAST_COMM_CORP_POD01) and GSheet names ("East Comm Corp POD01 - Subscriptions")
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[_\s]/g, '')
}

describe('normalizeForMatch', () => {
  it('removes underscores', () => {
    expect(normalizeForMatch('EAST_COMM_CORP_POD01')).toBe('eastcommcorppod01')
  })

  it('removes spaces', () => {
    expect(normalizeForMatch('East Comm Corp POD01')).toBe('eastcommcorppod01')
  })

  it('preserves alphanumerics and hyphens', () => {
    expect(normalizeForMatch('East Comm Corp POD01 - Subscriptions')).toBe('eastcommcorppod01-subscriptions')
  })

  it('matches pod key against GSheet name after normalization', () => {
    const podKey = 'EAST_COMM_CORP_POD01'
    const sheetName = 'East Comm Corp POD01 - Subscriptions'

    const podKeyNorm = normalizeForMatch(podKey)
    const sheetNameNorm = normalizeForMatch(sheetName)

    expect(sheetNameNorm).toContain(podKeyNorm)
  })

  it('handles empty strings', () => {
    expect(normalizeForMatch('')).toBe('')
  })

  it('handles strings with multiple consecutive spaces and underscores', () => {
    expect(normalizeForMatch('EAST__COMM  CORP___POD01')).toBe('eastcommcorppod01')
  })
})
