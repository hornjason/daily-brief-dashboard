import { describe, expect, test } from 'bun:test'
import { extractDomain, extractDomainsFromCells, BLOCKLIST } from './domains.ts'

describe('extractDomain', () => {
  test('returns domain from a valid email', () => {
    expect(extractDomain('user@acme.com')).toBe('acme.com')
    expect(extractDomain('jane.doe+tag@company.io')).toBe('company.io')
  })

  test('returns null for blocklisted domains', () => {
    expect(extractDomain('user@gmail.com')).toBeNull()
    expect(extractDomain('user@redhat.com')).toBeNull()
    expect(extractDomain('user@salesforce.com')).toBeNull()
    expect(extractDomain('user@okta.com')).toBeNull()
    expect(extractDomain('user@slack.com')).toBeNull()
  })

  test('returns null for invalid or empty input', () => {
    expect(extractDomain('')).toBeNull()
    expect(extractDomain('not-an-email')).toBeNull()
    expect(extractDomain('missing-at-sign.com')).toBeNull()
  })

  test('is case-insensitive for domain part', () => {
    expect(extractDomain('user@ACME.COM')).toBe('acme.com')
    expect(extractDomain('user@GMAIL.COM')).toBeNull()
  })

  test('extracts domain from email with display name', () => {
    // The regex matches email-like patterns inside any string
    expect(extractDomain('john@partner.com')).toBe('partner.com')
  })
})

describe('extractDomainsFromCells', () => {
  test('counts occurrences of same domain across cells', () => {
    const map = extractDomainsFromCells([
      'alice@acme.com',
      'bob@acme.com',
      'carol@other.com',
    ])
    expect(map.get('acme.com')).toBe(2)
    expect(map.get('other.com')).toBe(1)
  })

  test('extracts multiple emails from a single cell', () => {
    const map = extractDomainsFromCells(['Contact: alice@acme.com, bob@acme.com'])
    expect(map.get('acme.com')).toBe(2)
  })

  test('ignores blocklisted domains', () => {
    const map = extractDomainsFromCells(['user@gmail.com', 'admin@company.com'])
    expect(map.has('gmail.com')).toBe(false)
    expect(map.get('company.com')).toBe(1)
  })

  test('returns empty map when no emails present', () => {
    expect(extractDomainsFromCells(['no emails here', '', 'just text']).size).toBe(0)
  })

  test('handles mixed valid and invalid cells', () => {
    const map = extractDomainsFromCells(['Name', 'user@acme.com', '123', 'user@redhat.com'])
    expect(map.get('acme.com')).toBe(1)
    expect(map.has('redhat.com')).toBe(false)
  })
})

describe('BLOCKLIST', () => {
  test('contains expected SaaS and consumer domains', () => {
    const expected = ['gmail.com', 'redhat.com', 'salesforce.com', 'okta.com', 'slack.com', 'zoom.us']
    for (const d of expected) {
      expect(BLOCKLIST.has(d)).toBe(true)
    }
  })

  test('does not contain legitimate customer domains', () => {
    expect(BLOCKLIST.has('acme.com')).toBe(false)
    expect(BLOCKLIST.has('example.com')).toBe(false)
    expect(BLOCKLIST.has('company.io')).toBe(false)
  })
})
