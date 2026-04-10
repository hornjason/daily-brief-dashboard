import { test, expect, describe } from 'bun:test'

// toSlug is a pure function: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')
function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')
}

describe('toSlug', () => {
  test('lowercases and hyphenates', () => {
    expect(toSlug('Acme Corp')).toBe('acme-corp')
  })
  test('removes special characters', () => {
    expect(toSlug("O'Neil Corp")).toBe('oneil-corp')
  })
  test('handles multiple spaces', () => {
    expect(toSlug('Big Ten Network Services')).toBe('big-ten-network-services')
  })
  test('handles already lowercase', () => {
    expect(toSlug('initech')).toBe('initech')
  })
  test('strips non-alphanumeric except hyphen', () => {
    expect(toSlug('Globex (Industries)')).toBe('globex-industries')
  })
})
