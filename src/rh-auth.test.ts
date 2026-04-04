/**
 * src/rh-auth.test.ts
 * Unit tests for the isPortalUrl() helper exported from rh-auth.ts.
 */
import { test, expect, describe } from 'bun:test'
import { isPortalUrl } from './rh-auth.ts'

describe('isPortalUrl', () => {
  test('returns true for access.redhat.com root', () => {
    expect(isPortalUrl('https://access.redhat.com')).toBe(true)
  })

  test('returns true for support cases path', () => {
    expect(isPortalUrl('https://access.redhat.com/support/cases/#/case/list')).toBe(true)
  })

  test('returns true for management path', () => {
    expect(isPortalUrl('https://access.redhat.com/management')).toBe(true)
  })

  test('returns false for SSO login page', () => {
    expect(isPortalUrl('https://sso.redhat.com/auth/realms/redhat/login')).toBe(false)
  })

  test('returns false for sso.redhat.com root', () => {
    expect(isPortalUrl('https://sso.redhat.com')).toBe(false)
  })

  test('returns false for google.com', () => {
    expect(isPortalUrl('https://google.com')).toBe(false)
  })

  test('returns false for about:blank', () => {
    expect(isPortalUrl('about:blank')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(isPortalUrl('')).toBe(false)
  })
})
