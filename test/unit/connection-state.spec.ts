// test/unit/connection-state.spec.ts
//
// Unit tests for the two-axis connection state derivation in
// dashboard/src/lib/connection-state.ts. Run with:
//   bun test test/unit/connection-state.spec.ts
//
// These are pure-function tests with no browser/server dependency. They use
// bun:test (the project convention for test/unit/*) — Playwright's e2e-tier
// project has a globalSetup that requires a live server, so it is not
// appropriate for pure unit tests.
import { test, expect, describe } from 'bun:test'
import { deriveRhCard, deriveSfCard, deriveTableauCard } from '../../dashboard/src/lib/connection-state'

describe('deriveRhCard', () => {
  test('fresh install — no session → Not connected, not counted', () => {
    const c = deriveRhCard({ hasSession: false, sessionExpired: false, lastScraped: null }, false)
    expect(c.sessionState).toBe('none')
    expect(c.label).toBe('Not connected')
    expect(c.countsAsConnected).toBe(false)
    expect(c.dotColor).toBe('gray')
  })

  test('session active, no scrape yet → Connected first sync, COUNTED', () => {
    const c = deriveRhCard({ hasSession: true, sessionExpired: false, lastScraped: null }, false)
    expect(c.sessionState).toBe('active')
    expect(c.label).toBe('Connected — first sync…')
    expect(c.countsAsConnected).toBe(true)
    expect(c.dotColor).toBe('blue')
  })

  test('session active, scrape done → Connected, counted, green', () => {
    const c = deriveRhCard({ hasSession: true, sessionExpired: false, lastScraped: new Date().toISOString() }, false)
    expect(c.sessionState).toBe('active')
    expect(c.label).toBe('Connected')
    expect(c.countsAsConnected).toBe(true)
    expect(c.dotColor).toBe('green')
  })

  test('session expired → Session expired, not counted, red', () => {
    const c = deriveRhCard({ hasSession: true, sessionExpired: true, lastScraped: new Date().toISOString() }, false)
    expect(c.sessionState).toBe('expired')
    expect(c.label).toBe('Session expired')
    expect(c.countsAsConnected).toBe(false)
    expect(c.dotColor).toBe('red')
  })

  test('scraper running → Syncing, counted, blue pulse', () => {
    const c = deriveRhCard({ hasSession: true, sessionExpired: false, lastScraped: new Date().toISOString() }, true)
    expect(c.dataState).toBe('syncing')
    expect(c.label).toBe('Syncing…')
    expect(c.countsAsConnected).toBe(true)
    expect(c.dotPulse).toBe(true)
  })

  test('session aging (>7d) → Connected — re-auth soon, amber, counted', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const c = deriveRhCard({ hasSession: true, sessionExpired: false, lastScraped: new Date().toISOString(), lastAuthenticatedAt: oldDate }, false)
    expect(c.sessionState).toBe('aging')
    expect(c.label).toBe('Connected — re-auth soon')
    expect(c.countsAsConnected).toBe(true)
    expect(c.dotColor).toBe('amber')
  })
})

describe('deriveSfCard', () => {
  test('fresh install → Not connected, not counted', () => {
    const c = deriveSfCard({ hasSession: false }, false)
    expect(c.sessionState).toBe('none')
    expect(c.label).toBe('Not connected')
    expect(c.countsAsConnected).toBe(false)
  })

  test('session active, no sync → Connected first sync, counted', () => {
    const c = deriveSfCard({ hasSession: true }, false)
    expect(c.sessionState).toBe('active')
    expect(c.label).toBe('Connected — first sync…')
    expect(c.countsAsConnected).toBe(true)
  })

  test('syncError = session expired string → Session expired, not counted', () => {
    const c = deriveSfCard({ hasSession: true, syncError: 'Salesforce session expired — please reconnect via the dashboard' }, false)
    expect(c.sessionState).toBe('expired')
    expect(c.countsAsConnected).toBe(false)
    expect(c.dotColor).toBe('red')
  })

  test('syncError = non-auth error → Connected — sync failed, STILL COUNTED', () => {
    const c = deriveSfCard({ hasSession: true, syncError: 'Network timeout fetching pipeline report' }, false)
    expect(c.sessionState).toBe('active')
    expect(c.dataState).toBe('failed')
    expect(c.label).toBe('Connected — sync failed')
    expect(c.countsAsConnected).toBe(true)  // KEY: session still active, just data failed
    expect(c.dotColor).toBe('amber')
  })
})

describe('deriveTableauCard', () => {
  test('fresh install, no status yet → Checking, not counted', () => {
    const c = deriveTableauCard(null, null, false)
    expect(c.label).toBe('Checking…')
    expect(c.countsAsConnected).toBe(false)
  })

  test('session invalid → Not connected, not counted', () => {
    const c = deriveTableauCard({ sessionValid: false, reachable: true }, null, false)
    expect(c.sessionState).toBe('none')
    expect(c.label).toBe('Not connected')
    expect(c.countsAsConnected).toBe(false)
  })

  test('session valid, no CCSP data → verifying CCSP (amber, not counted)', () => {
    const c = deriveTableauCard({ sessionValid: true, reachable: true }, { state: null, lastScrape: null, lastError: null }, false)
    expect(c.sessionState).toBe('active')
    expect(c.label).toBe('Session active — verifying CCSP…')
    expect(c.countsAsConnected).toBe(false)
    expect(c.dotColor).toBe('amber')
  })

  test('session valid, CCSP stale → Connected — refreshing, COUNTED (fixes Stale bug)', () => {
    const c = deriveTableauCard(
      { sessionValid: true, reachable: true },
      { state: 'stale', lastScrape: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), lastError: null },
      false
    )
    expect(c.sessionState).toBe('active')
    expect(c.dataState).toBe('stale')
    expect(c.label).toContain('Connected')
    expect(c.label).not.toBe('Stale')  // 'Stale' must not be the primary label
    expect(c.countsAsConnected).toBe(true)
  })

  test('session valid, CCSP scrape failed → Connected — sync failed, NOT counted (no verified download)', () => {
    const c = deriveTableauCard(
      { sessionValid: true, reachable: true },
      { state: 'failed', lastScrape: null, lastError: 'Sheet not found' },
      false
    )
    expect(c.dataState).toBe('failed')
    expect(c.label).toBe('Connected — sync failed')
    expect(c.countsAsConnected).toBe(false)
  })

  test('connecting = true → Logging in, not counted', () => {
    const c = deriveTableauCard({ sessionValid: false, reachable: true }, null, true)
    expect(c.sessionState).toBe('authenticating')
    expect(c.label).toBe('Logging in…')
    expect(c.countsAsConnected).toBe(false)
  })

  test('session valid, aging → counted, amber', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const c = deriveTableauCard(
      { sessionValid: true, reachable: true },
      { state: null, lastScrape: new Date().toISOString(), lastError: null },
      false,
      oldDate
    )
    expect(c.sessionState).toBe('aging')
    expect(c.countsAsConnected).toBe(true)
    expect(c.dotColor).toBe('amber')
  })
})
