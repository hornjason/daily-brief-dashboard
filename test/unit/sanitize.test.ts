import { test, expect, describe } from 'bun:test'

// sanitizeText returns string | null — it does NOT throw.
// null signals invalid input (HTML tags, empty string, over maxLen).
import { sanitizeText } from '../../src/utils.ts'

describe('sanitizeText', () => {
  test('returns plain text unchanged (trimmed)', () => {
    expect(sanitizeText('Acme Corp')).toBe('Acme Corp')
  })
  test('trims surrounding whitespace', () => {
    expect(sanitizeText('  hello  ')).toBe('hello')
  })
  test('returns null for HTML tags', () => {
    expect(sanitizeText('<script>alert(1)</script>')).toBeNull()
  })
  test('returns null for empty string', () => {
    expect(sanitizeText('')).toBeNull()
  })
  test('returns null for whitespace-only string', () => {
    expect(sanitizeText('   ')).toBeNull()
  })
  test('returns null for non-string input', () => {
    expect(sanitizeText(42 as unknown as string)).toBeNull()
  })
  test('returns null for string exceeding maxLen', () => {
    expect(sanitizeText('a'.repeat(201))).toBeNull()
  })
  test('accepts string at exactly maxLen boundary', () => {
    const exactly200 = 'a'.repeat(200)
    expect(sanitizeText(exactly200)).toBe(exactly200)
  })
  test('respects custom maxLen', () => {
    expect(sanitizeText('hello world', 5)).toBeNull()
    expect(sanitizeText('hi', 5)).toBe('hi')
  })
  test('returns null for inline HTML attribute syntax', () => {
    expect(sanitizeText('<b>bold</b>')).toBeNull()
  })
})
