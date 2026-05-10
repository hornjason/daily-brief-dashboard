// BKL-DOMAIN-01: Tests for multi-domain support and alias-based domain inference
import { describe, test, expect } from 'bun:test'
import { isPublicDomain } from '../../src/domain-waterfall.ts'

describe('isPublicDomain — alias domain validation', () => {
  test('accepts valid domains', () => {
    expect(isPublicDomain('example.com')).toBe(true)
    expect(isPublicDomain('subsidiary.org')).toBe(true)
    expect(isPublicDomain('nationalgridus.com')).toBe(true)
    expect(isPublicDomain('lifetouch.com')).toBe(true)
  })

  test('rejects invalid domains', () => {
    expect(isPublicDomain('')).toBe(false)
    expect(isPublicDomain('not-a-domain')).toBe(false)
    expect(isPublicDomain('localhost')).toBe(false)
    expect(isPublicDomain('test.local')).toBe(false)
    expect(isPublicDomain('192.168.1.1')).toBe(false)
    expect(isPublicDomain('10.0.0.1')).toBe(false)
  })

  test('rejects private/loopback IPs masquerading as domains', () => {
    expect(isPublicDomain('127.0.0.1')).toBe(false)
    expect(isPublicDomain('169.254.0.1')).toBe(false)
    expect(isPublicDomain('172.16.0.1')).toBe(false)
  })
})

describe('domain inference name selection', () => {
  // This tests the logic that setup-routes.ts uses: aliases[0] ?? customer.name
  test('prefers aliases[0] (legal entity name) over short name', () => {
    const customer = { name: 'REI', aliases: ['Recreational Equipment Inc'] }
    const inferName = customer.aliases?.[0] ?? customer.name
    expect(inferName).toBe('Recreational Equipment Inc')
  })

  test('falls back to customer.name when aliases is empty', () => {
    const customer = { name: 'Acme Corp', aliases: [] }
    const inferName = customer.aliases?.[0] ?? customer.name
    expect(inferName).toBe('Acme Corp')
  })

  test('falls back to customer.name when aliases is undefined', () => {
    const customer = { name: 'Acme Corp' } as { name: string; aliases?: string[] }
    const inferName = customer.aliases?.[0] ?? customer.name
    expect(inferName).toBe('Acme Corp')
  })
})

describe('Gmail multi-domain query construction', () => {
  // This tests the query construction pattern used in fetchCustomerEmails
  function buildGmailQuery(domain: string | undefined, aliasDomains: string[] | undefined, name: string, afterStr: string): string {
    const allDomains = [domain, ...(aliasDomains ?? [])].filter(Boolean) as string[]
    return allDomains.length > 0
      ? `(${allDomains.map(d => `from:@${d} OR to:@${d}`).join(' OR ')} OR subject:"${name}") after:${afterStr}`
      : `subject:"${name}" after:${afterStr}`
  }

  test('single domain produces standard query', () => {
    const q = buildGmailQuery('acme.com', undefined, 'Acme', '2026/4/1')
    expect(q).toBe('(from:@acme.com OR to:@acme.com OR subject:"Acme") after:2026/4/1')
  })

  test('primary + alias domains produces OR query', () => {
    const q = buildGmailQuery('shutterfly.com', ['lifetouch.com'], 'Shutterfly', '2026/4/1')
    expect(q).toBe('(from:@shutterfly.com OR to:@shutterfly.com OR from:@lifetouch.com OR to:@lifetouch.com OR subject:"Shutterfly") after:2026/4/1')
  })

  test('multiple alias domains all included', () => {
    const q = buildGmailQuery('parent.com', ['sub1.com', 'sub2.org'], 'Parent Corp', '2026/4/1')
    expect(q).toContain('from:@sub1.com OR to:@sub1.com')
    expect(q).toContain('from:@sub2.org OR to:@sub2.org')
    expect(q).toContain('from:@parent.com OR to:@parent.com')
  })

  test('no domain falls back to subject-only query', () => {
    const q = buildGmailQuery(undefined, undefined, 'Acme', '2026/4/1')
    expect(q).toBe('subject:"Acme" after:2026/4/1')
  })

  test('alias domains without primary domain still works', () => {
    const q = buildGmailQuery(undefined, ['subsidiary.com'], 'Parent Corp', '2026/4/1')
    expect(q).toContain('from:@subsidiary.com OR to:@subsidiary.com')
    expect(q).toContain('subject:"Parent Corp"')
  })

  test('empty aliasDomains array treated same as undefined', () => {
    const q1 = buildGmailQuery('acme.com', [], 'Acme', '2026/4/1')
    const q2 = buildGmailQuery('acme.com', undefined, 'Acme', '2026/4/1')
    expect(q1).toBe(q2)
  })
})

describe('aliasDomains parsing — comma-separated input', () => {
  function parseAliasDomains(input: string): string[] {
    return input.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  }

  test('parses comma-separated domains', () => {
    expect(parseAliasDomains('example.com, subsidiary.org')).toEqual(['example.com', 'subsidiary.org'])
  })

  test('trims whitespace and lowercases', () => {
    expect(parseAliasDomains('  EXAMPLE.COM ,   Subsidiary.ORG  ')).toEqual(['example.com', 'subsidiary.org'])
  })

  test('filters empty strings from trailing comma', () => {
    expect(parseAliasDomains('example.com, ')).toEqual(['example.com'])
  })

  test('handles single domain', () => {
    expect(parseAliasDomains('example.com')).toEqual(['example.com'])
  })

  test('handles empty input', () => {
    expect(parseAliasDomains('')).toEqual([])
  })
})
