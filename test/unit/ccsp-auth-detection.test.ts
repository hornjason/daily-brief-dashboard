/**
 * test/unit/ccsp-auth-detection.test.ts
 *
 * Regression tests for BKL-CCSP-RETRY-02 and BKL-CCSP-RETRY-03.
 *
 * BKL-CCSP-RETRY-02: doKeepalive() detects login form presence on Tableau home
 *   page (stale-cookie case — no redirect, but MFA wall is present).
 *
 * BKL-CCSP-RETRY-03: scrapePodCcspRaw() sets _tableauSessionExpired when a CSV
 *   download times out and the login form is found on the current page.
 *
 * Both tests use source-inspection strategy (no live browser, no Playwright context)
 * so they run in the standard bun:test environment without container dependency.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

const DAEMON_SRC = readFileSync(resolve(ROOT, 'scripts/sync-l3-daemon.ts'), 'utf-8')
const CCSP_SCRAPER_SRC = readFileSync(resolve(ROOT, 'src/ccsp-scraper.ts'), 'utf-8')
const CCSP_FETCH_SRC = readFileSync(resolve(ROOT, 'src/ccsp-tableau-fetch.ts'), 'utf-8')

// ── BKL-CCSP-RETRY-02: doKeepalive login form check ──────────────────────────

describe('BKL-CCSP-RETRY-02: doKeepalive checks login form after Tableau navigation', () => {
  const getFnSlice = () => {
    const fnIdx = DAEMON_SRC.indexOf('async function doKeepalive()')
    expect(fnIdx).toBeGreaterThan(-1)
    return DAEMON_SRC.slice(fnIdx, fnIdx + 5000)
  }

  test('doKeepalive checks for input[type="password"] after URL check', () => {
    const fnSlice = getFnSlice()
    expect(fnSlice).toContain('input[type="password"]')
    expect(fnSlice).toContain('input#username')
  })

  test('doKeepalive throws when login page is detected', () => {
    const fnSlice = getFnSlice()
    expect(fnSlice).toContain('Tableau session expired')
  })

  test('doKeepalive login form check comes after the URL redirect check', () => {
    const fnSlice = getFnSlice()
    const urlCheckIdx = fnSlice.indexOf('10ay.online.tableau.com')
    const loginFormIdx = fnSlice.indexOf('input[type="password"]')
    expect(urlCheckIdx).toBeGreaterThan(-1)
    expect(loginFormIdx).toBeGreaterThan(-1)
    expect(loginFormIdx).toBeGreaterThan(urlCheckIdx)
  })

  test('doKeepalive uses isLoginPage pattern matching ccsp-tableau-fetch login detection', () => {
    const fnSlice = getFnSlice()
    expect(fnSlice).toContain('isLoginPage')
    expect(fnSlice).toContain('if (isLoginPage)')
  })
})

// ── BKL-CCSP-RETRY-03: scrapePodCcspRaw sets _tableauSessionExpired on timeout ─

describe('BKL-CCSP-RETRY-03: scrapePodCcspRaw marks session expired on auth-timeout', () => {
  test('ccsp-tableau-fetch exports setTableauSessionExpired setter', () => {
    expect(CCSP_FETCH_SRC).toContain('export function setTableauSessionExpired(')
  })

  test('setTableauSessionExpired accepts a boolean parameter', () => {
    const idx = CCSP_FETCH_SRC.indexOf('export function setTableauSessionExpired(')
    const slice = CCSP_FETCH_SRC.slice(idx, idx + 100)
    expect(slice).toContain('value: boolean')
  })

  test('setTableauSessionExpired assigns to _tableauSessionExpired', () => {
    const idx = CCSP_FETCH_SRC.indexOf('export function setTableauSessionExpired(')
    const slice = CCSP_FETCH_SRC.slice(idx, idx + 150)
    expect(slice).toContain('_tableauSessionExpired = value')
  })

  test('ccsp-scraper imports setTableauSessionExpired from ccsp-tableau-fetch', () => {
    expect(CCSP_SCRAPER_SRC).toContain('setTableauSessionExpired')
    expect(CCSP_SCRAPER_SRC).toContain("from './ccsp-tableau-fetch.ts'")
  })

  // BKL-ARCH-17: scrapePodCcspRaw no longer owns inline CSV-download auth detection —
  // it delegates the entire Tableau navigation + CSV download to fetchPodCsv. The
  // BKL-CCSP-RETRY-03 contract (mark _tableauSessionExpired on auth issues) is now
  // enforced inside fetchPodCsv via its login-wall handshake.
  test('scrapePodCcspRaw delegates Tableau navigation + download to fetchPodCsv', () => {
    const fnIdx = CCSP_SCRAPER_SRC.indexOf('export async function scrapePodCcspRaw(')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnSlice = CCSP_SCRAPER_SRC.slice(fnIdx, fnIdx + 9000)
    expect(fnSlice).toContain('fetchPodCsv({')
    // Inline CSV-download error path is gone — proof of delegation.
    expect(fnSlice).not.toContain('CSV download failed:')
  })

  test('fetchPodCsv detects login wall and sets _tableauSessionExpired', () => {
    // fetchPodCsv inspects the post-navigation URL/DOM and flips the expired flag
    // before launching the 5-min recovery wait. Replaces the inline auth-on-timeout
    // path that used to live in scrapePodCcspRaw.
    expect(CCSP_FETCH_SRC).toContain('isLoginPage')
    expect(CCSP_FETCH_SRC).toContain('input[type="password"]')
    expect(CCSP_FETCH_SRC).toContain('input#username')
    expect(CCSP_FETCH_SRC).toContain('_tableauSessionExpired = true')
  })

  test('fetchPodCsv throws when SSO recovery wait deadline passes', () => {
    // Equivalent to the old scrapePodCcspRaw "Tableau auth expired" throw — now
    // emitted inside fetchPodCsv after the 5-minute manual login window expires.
    expect(CCSP_FETCH_SRC).toContain('Tableau session required')
  })
})
