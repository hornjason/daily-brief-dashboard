/**
 * src/sf-scraper.test.ts
 *
 * Unit tests for pure helpers exported from sf-scraper.ts.
 *
 * These tests cover the URL classification helper used to detect whether a
 * post-navigation page is a Salesforce login / Red Hat SSO landing (session
 * expired) vs. a transient navigation failure that should fall under the
 * grace-period retry logic.
 *
 * Security context: BKL-SEC-SF-URL-01 — the previous implementation used
 * `currentUrl.includes('login.salesforce.com')` style substring checks, which
 * would falsely classify attacker-controlled hostnames like
 * `login.salesforce.com.evil.com` as a login page. The hostname-based
 * implementation prevents that bypass.
 */

import { describe, expect, test } from 'bun:test'
import { classifySfNavUrl } from './sf-scraper.ts'

describe('classifySfNavUrl', () => {
  test('classifies https://login.salesforce.com/ as login', () => {
    expect(classifySfNavUrl('https://login.salesforce.com/')).toBe('login')
  })

  test('classifies a my.salesforce.com subdomain as login', () => {
    expect(classifySfNavUrl('https://redhatcrm.my.salesforce.com/secur/login_portal.jsp')).toBe('login')
  })

  test('classifies https://sso.redhat.com/... as login', () => {
    expect(classifySfNavUrl('https://sso.redhat.com/auth/realms/redhat-external/protocol/saml')).toBe('login')
  })

  // --- BKL-SEC-SF-URL-01 bypass guard ---
  test('SECURITY: does NOT classify login.salesforce.com.evil.com as login', () => {
    expect(classifySfNavUrl('https://login.salesforce.com.evil.com/')).toBe('transient')
  })

  test('SECURITY: does NOT classify sso.redhat.com.attacker.test as login', () => {
    expect(classifySfNavUrl('https://sso.redhat.com.attacker.test/')).toBe('transient')
  })

  test('SECURITY: does NOT classify foo.my.salesforce.com.evil.com as login', () => {
    expect(classifySfNavUrl('https://foo.my.salesforce.com.evil.com/')).toBe('transient')
  })

  test('classifies about:blank as transient', () => {
    expect(classifySfNavUrl('about:blank')).toBe('transient')
  })

  test('classifies invalid / empty URL as transient', () => {
    expect(classifySfNavUrl('')).toBe('transient')
    expect(classifySfNavUrl('not a url')).toBe('transient')
  })

  test('classifies redhatcrm.lightning.force.com as transient (success path handled separately)', () => {
    expect(classifySfNavUrl('https://redhatcrm.lightning.force.com/lightning/r/Report/abc/view')).toBe('transient')
  })

  test('does NOT classify bare my.salesforce.com (no leading subdomain) as login', () => {
    // `.endsWith('.my.salesforce.com')` requires a dot prefix, so the apex domain shouldn't match.
    expect(classifySfNavUrl('https://my.salesforce.com/')).toBe('transient')
  })
})
