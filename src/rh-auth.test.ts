/**
 * src/rh-auth.test.ts
 * Unit tests for the isPortalUrl() helper exported from rh-auth.ts.
 */
import { test, expect, describe } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { isPortalUrl, getRhStatus } from './rh-auth.ts'

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

// ── BKL-UX93: getRhStatus TTL logic ─────────────────────────────────────────
// The /api/auth/redhat/status endpoint relied solely on a scrape-failure flag
// to surface session expiry. If the RH SSO session silently died (idle > 12h)
// the UI still showed "Connected" until the next scheduled scrape failed.
// getRhStatus now consults the session marker's loggedInAt timestamp and
// returns sessionExpired: true once the 12h fallback TTL has passed.
describe('getRhStatus (BKL-UX93 TTL)', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'rh-auth-test-'))

  test('hasSession is false when the marker file does not exist', () => {
    const status = getRhStatus(resolve(tmp, 'missing.json'))
    expect(status.hasSession).toBe(false)
    expect(status.sessionExpired).toBe(false)
  })

  test('sessionExpired is false for a fresh loggedInAt (< 12h)', () => {
    const sessionPath = resolve(tmp, 'fresh.json')
    writeFileSync(sessionPath, JSON.stringify({
      loggedInAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
    }))
    const status = getRhStatus(sessionPath)
    expect(status.hasSession).toBe(true)
    expect(status.sessionExpired).toBe(false)
  })

  test('sessionExpired is true when loggedInAt is older than 12h', () => {
    const sessionPath = resolve(tmp, 'stale.json')
    writeFileSync(sessionPath, JSON.stringify({
      loggedInAt: new Date(Date.now() - (13 * 60 * 60 * 1000)).toISOString(), // 13h ago
    }))
    const status = getRhStatus(sessionPath)
    expect(status.hasSession).toBe(true)
    expect(status.sessionExpired).toBe(true)
  })

  test('sessionExpired is false when loggedInAt is just under TTL (11h 59m)', () => {
    const sessionPath = resolve(tmp, 'near-ttl.json')
    writeFileSync(sessionPath, JSON.stringify({
      loggedInAt: new Date(Date.now() - ((12 * 60 - 1) * 60 * 1000)).toISOString(),
    }))
    const status = getRhStatus(sessionPath)
    expect(status.sessionExpired).toBe(false)
  })

  test('sessionExpired is false when marker file has no loggedInAt field', () => {
    const sessionPath = resolve(tmp, 'no-timestamp.json')
    writeFileSync(sessionPath, JSON.stringify({ someOtherField: true }))
    const status = getRhStatus(sessionPath)
    expect(status.hasSession).toBe(true)
    expect(status.sessionExpired).toBe(false)
  })

  test('sessionExpired is false when marker file is unparseable JSON', () => {
    const sessionPath = resolve(tmp, 'garbage.json')
    writeFileSync(sessionPath, 'not-json-at-all')
    const status = getRhStatus(sessionPath)
    expect(status.hasSession).toBe(true)
    expect(status.sessionExpired).toBe(false)
  })

  test('cleanup', () => {
    rmSync(tmp, { recursive: true, force: true })
  })
})

// ── getRhStatus sessionExpiresAt ────────────────────────────────────────────
// getRhStatus() surfaces the raw KEYCLOAK_SESSION cookie expiry from
// Playwright's session-state.json as an ISO string on the status payload.
// readKeycloakExpiry() reads <profileDir>/session-state.json, filters for
// KEYCLOAK_SESSION cookies with expires > 0, and returns the earliest expiry
// (ms). getRhStatus then converts that to an ISO string or null.
describe('getRhStatus (sessionExpiresAt)', () => {
  const tmp = mkdtempSync(resolve(tmpdir(), 'rh-auth-expires-test-'))

  test('sessionExpiresAt is null when session-state.json does not exist', () => {
    const profileDir = mkdtempSync(resolve(tmp, 'no-state-'))
    const sessionPath = resolve(profileDir, 'session.json')
    // Write a minimal session marker so hasSession is true — we want to
    // isolate the session-state.json absence from the marker file absence.
    writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    const status = getRhStatus(sessionPath, undefined, profileDir)
    expect(status.sessionExpiresAt).toBeNull()
  })

  test('sessionExpiresAt is null when session-state.json has no KEYCLOAK_SESSION cookies', () => {
    const profileDir = mkdtempSync(resolve(tmp, 'empty-cookies-'))
    const sessionPath = resolve(profileDir, 'session.json')
    writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    writeFileSync(resolve(profileDir, 'session-state.json'), JSON.stringify({ cookies: [] }))
    const status = getRhStatus(sessionPath, undefined, profileDir)
    expect(status.sessionExpiresAt).toBeNull()
  })

  test('sessionExpiresAt is null when KEYCLOAK_SESSION cookie has expires: -1', () => {
    const profileDir = mkdtempSync(resolve(tmp, 'session-cookie-'))
    const sessionPath = resolve(profileDir, 'session.json')
    writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    writeFileSync(resolve(profileDir, 'session-state.json'), JSON.stringify({
      cookies: [
        { name: 'KEYCLOAK_SESSION', domain: 'sso.redhat.com', expires: -1 },
      ],
    }))
    const status = getRhStatus(sessionPath, undefined, profileDir)
    expect(status.sessionExpiresAt).toBeNull()
  })

  test('sessionExpiresAt is an ISO string when a valid KEYCLOAK_SESSION cookie exists', () => {
    const profileDir = mkdtempSync(resolve(tmp, 'valid-cookie-'))
    const sessionPath = resolve(profileDir, 'session.json')
    writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    const expiresSec = Math.floor((Date.now() + 3600000) / 1000) // 1h future, seconds
    writeFileSync(resolve(profileDir, 'session-state.json'), JSON.stringify({
      cookies: [
        { name: 'KEYCLOAK_SESSION', domain: 'sso.redhat.com', expires: expiresSec },
      ],
    }))
    const status = getRhStatus(sessionPath, undefined, profileDir)
    expect(status.sessionExpiresAt).not.toBeNull()
    expect(typeof status.sessionExpiresAt).toBe('string')
    expect(status.sessionExpiresAt).toBe(new Date(expiresSec * 1000).toISOString())
    // Sanity: parseable and matches ISO 8601 shape
    expect(Number.isNaN(Date.parse(status.sessionExpiresAt as string))).toBe(false)
  })

  test('sessionExpiresAt picks the earliest expiry when multiple KEYCLOAK_SESSION cookies exist', () => {
    const profileDir = mkdtempSync(resolve(tmp, 'multi-cookie-'))
    const sessionPath = resolve(profileDir, 'session.json')
    writeFileSync(sessionPath, JSON.stringify({ loggedInAt: new Date().toISOString() }))
    const earlierSec = Math.floor((Date.now() + 1800000) / 1000) // 30 min future
    const laterSec = Math.floor((Date.now() + 7200000) / 1000)   // 2h future
    writeFileSync(resolve(profileDir, 'session-state.json'), JSON.stringify({
      cookies: [
        { name: 'KEYCLOAK_SESSION', domain: 'auth.redhat.com', expires: laterSec },
        { name: 'KEYCLOAK_SESSION', domain: 'sso.redhat.com', expires: earlierSec },
      ],
    }))
    const status = getRhStatus(sessionPath, undefined, profileDir)
    expect(status.sessionExpiresAt).toBe(new Date(earlierSec * 1000).toISOString())
  })

  test('cleanup', () => {
    rmSync(tmp, { recursive: true, force: true })
  })
})
