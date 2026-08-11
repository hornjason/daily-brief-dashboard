import { describe, test, expect } from 'bun:test'
import { shouldSuppressBanner } from '../../src/lib/version-utils.ts'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

describe('shouldSuppressBanner (dismiss logic)', () => {
  test('dismissing v1.7.2 should NOT hide v1.7.3', () => {
    const now = Date.now()
    expect(shouldSuppressBanner('1.7.2', now - 1000, '1.7.3')).toBe(false)
  })

  test('dismissing v1.7.2 should hide v1.7.2 within 7 days', () => {
    const now = Date.now()
    expect(shouldSuppressBanner('1.7.2', now - 1000, '1.7.2')).toBe(true)
  })

  test('expired dismiss should show same version', () => {
    const now = Date.now()
    const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000)
    expect(shouldSuppressBanner('1.7.2', eightDaysAgo, '1.7.2')).toBe(false)
  })

  test('null dismissed version always shows banner', () => {
    expect(shouldSuppressBanner(null, null, '1.7.3')).toBe(false)
  })

  test('dismiss at exactly 7 days boundary still suppresses', () => {
    const now = Date.now()
    const exactlySevenDays = now - SEVEN_DAYS_MS + 1
    expect(shouldSuppressBanner('1.7.2', exactlySevenDays, '1.7.2')).toBe(true)
  })
})
