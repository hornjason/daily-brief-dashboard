// BKL-AI-FP-06: Account intel TTL logic (FP-05) — unit tests
import { describe, it, expect } from 'bun:test'
import { ACCT_INTEL_TTL_MS } from '../../src/customer.ts'

function isStale(cachedAt: string): boolean {
  return Date.now() - new Date(cachedAt).getTime() >= ACCT_INTEL_TTL_MS
}

describe('account intel TTL (FP-05)', () => {
  it('13 days ago is not stale', () => {
    const d = new Date(Date.now() - 13 * 86_400_000).toISOString()
    expect(isStale(d)).toBe(false)
  })

  it('15 days ago is stale', () => {
    const d = new Date(Date.now() - 15 * 86_400_000).toISOString()
    expect(isStale(d)).toBe(true)
  })

  it('exactly 14 days ago is stale (boundary)', () => {
    const d = new Date(Date.now() - 14 * 86_400_000).toISOString()
    expect(isStale(d)).toBe(true)
  })
})
