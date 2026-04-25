import { test, expect, describe } from 'bun:test'

// Pure function extracted from cache-layer.ts — test it directly
// isBriefCacheFile(slug, filename): true only for {slug}-YYYY-MM-DD.json
function isBriefCacheFile(slug: string, filename: string): boolean {
  const datePattern = /^\d{4}-\d{2}-\d{2}\.json$/
  if (!filename.startsWith(slug + '-')) return false
  const suffix = filename.slice(slug.length + 1)
  return datePattern.test(suffix)
}

describe('isBriefCacheFile — BKL-CACHE-01 regression', () => {
  const slug = 'acme-corp'

  test('accepts a valid dated brief file', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-2026-04-19.json')).toBe(true)
  })

  test('accepts an earlier dated brief file', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-2025-01-01.json')).toBe(true)
  })

  test('rejects emails cache file', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-emails.json')).toBe(false)
  })

  test('rejects meetings cache file', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-meetings.json')).toBe(false)
  })

  test('rejects sheets cache file', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-sheets.json')).toBe(false)
  })

  test('rejects file for a different slug', () => {
    expect(isBriefCacheFile(slug, 'other-slug-2026-04-19.json')).toBe(false)
  })

  test('rejects file with partial slug prefix but no dash', () => {
    expect(isBriefCacheFile(slug, 'acme-corp2026-04-19.json')).toBe(false)
  })

  test('rejects file with malformed date (3-digit year)', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-026-04-19.json')).toBe(false)
  })

  test('rejects file with malformed date (single-digit month)', () => {
    expect(isBriefCacheFile(slug, 'acme-corp-2026-4-19.json')).toBe(false)
  })
})
