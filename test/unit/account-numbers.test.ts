import { test, expect, describe } from 'bun:test'

// Replicates the accountNumbers validation from src/setup-routes.ts line 566:
// /^\d{4,12}$/ — numeric strings between 4 and 12 digits inclusive
function isValidAccountNumber(n: unknown): boolean {
  return typeof n === 'string' && /^\d{4,12}$/.test(n)
}

describe('account number validation (/^\\d{4,12}$/)', () => {
  test('accepts 7-digit number', () => {
    expect(isValidAccountNumber('9900099')).toBe(true)
  })
  test('accepts 4-digit minimum', () => {
    expect(isValidAccountNumber('1234')).toBe(true)
  })
  test('accepts 12-digit maximum', () => {
    expect(isValidAccountNumber('123456789012')).toBe(true)
  })
  test('rejects 3-digit number (too short)', () => {
    expect(isValidAccountNumber('123')).toBe(false)
  })
  test('rejects 13-digit number (too long)', () => {
    expect(isValidAccountNumber('1234567890123')).toBe(false)
  })
  test('rejects non-numeric string', () => {
    expect(isValidAccountNumber('abc123')).toBe(false)
  })
  test('rejects number with leading hyphen', () => {
    expect(isValidAccountNumber('-1234')).toBe(false)
  })
  test('rejects empty string', () => {
    expect(isValidAccountNumber('')).toBe(false)
  })
  test('rejects number type (must be string)', () => {
    expect(isValidAccountNumber(123456)).toBe(false)
  })
  test('rejects null', () => {
    expect(isValidAccountNumber(null)).toBe(false)
  })
  test('rejects string with spaces', () => {
    expect(isValidAccountNumber('123 456')).toBe(false)
  })
  test('rejects string with decimal point', () => {
    expect(isValidAccountNumber('1234.56')).toBe(false)
  })
})
