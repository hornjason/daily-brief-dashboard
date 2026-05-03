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
  test('doKeepalive checks for input[type="password"] after URL check', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function doKeepalive()')
    expect(fnIdx).toBeGreaterThan(-1)
    const fnSlice = DAEMON_SRC.slice(fnIdx, fnIdx + 1500)
    // Must check login form presence — not only URL redirect
    expect(fnSlice).toContain('input[type="password"]')
    expect(fnSlice).toContain('input#username')
  })

  test("doKeepalive throws 'Tableau auth expired' when login form is found", () => {
    const fnIdx = DAEMON_SRC.indexOf('async function doKeepalive()')
    const fnSlice = DAEMON_SRC.slice(fnIdx, fnIdx + 1500)
    // Exact message required so the keepalive failure email has a clear subject
    expect(fnSlice).toContain("'Tableau auth expired'")
  })

  test('doKeepalive login form check comes after the URL redirect check', () => {
    const fnIdx = DAEMON_SRC.indexOf('async function doKeepalive()')
    const fnSlice = DAEMON_SRC.slice(fnIdx, fnIdx + 1500)
    const urlCheckIdx = fnSlice.indexOf('tableauFinal.includes(\'signin\')')
    const loginFormIdx = fnSlice.indexOf('input[type="password"]')
    // login form check must appear after URL check
    expect(urlCheckIdx).toBeGreaterThan(-1)
    expect(loginFormIdx).toBeGreaterThan(-1)
    expect(loginFormIdx).toBeGreaterThan(urlCheckIdx)
  })

  test('doKeepalive uses .$(selector) pattern matching ccsp-tableau-fetch login detection', () => {
    // doKeepalive must use page.$() with same selectors as fetchPodCsv
    const fnIdx = DAEMON_SRC.indexOf('async function doKeepalive()')
    const fnSlice = DAEMON_SRC.slice(fnIdx, fnIdx + 1500)
    expect(fnSlice).toContain('hasLoginForm')
    // Throws on true
    expect(fnSlice).toContain('if (hasLoginForm)')
    expect(fnSlice).toContain('throw new Error(\'Tableau auth expired\')')
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

  test('scrapePodCcspRaw checks for login form after CSV download failure', () => {
    const fnIdx = CCSP_SCRAPER_SRC.indexOf('export async function scrapePodCcspRaw(')
    expect(fnIdx).toBeGreaterThan(-1)
    // Function body is ~8000 chars to the relevant section — use a large enough slice
    const fnSlice = CCSP_SCRAPER_SRC.slice(fnIdx, fnIdx + 9000)

    // Must check login form inside the download catch block
    const catchIdx = fnSlice.indexOf('CSV download failed:')
    expect(catchIdx).toBeGreaterThan(-1)
    const afterCatch = fnSlice.slice(catchIdx, catchIdx + 600)
    expect(afterCatch).toContain('input[type="password"]')
    expect(afterCatch).toContain('input#username')
    expect(afterCatch).toContain('hasLoginForm')
  })

  test('scrapePodCcspRaw calls setTableauSessionExpired(true) when login form detected', () => {
    const fnIdx = CCSP_SCRAPER_SRC.indexOf('export async function scrapePodCcspRaw(')
    const fnSlice = CCSP_SCRAPER_SRC.slice(fnIdx, fnIdx + 9000)

    const catchIdx = fnSlice.indexOf('CSV download failed:')
    const afterCatch = fnSlice.slice(catchIdx, catchIdx + 600)
    expect(afterCatch).toContain('setTableauSessionExpired(true)')
  })

  test('scrapePodCcspRaw login form check is inside the CSV download catch block', () => {
    const fnIdx = CCSP_SCRAPER_SRC.indexOf('export async function scrapePodCcspRaw(')
    const fnSlice = CCSP_SCRAPER_SRC.slice(fnIdx, fnIdx + 9000)

    // The check must appear between the catch keyword and the closing brace of the catch block
    // Verify it is NOT outside the catch (i.e. placed before csvPath check)
    const catchIdx = fnSlice.indexOf('CSV download failed:')
    const setExpiredIdx = fnSlice.indexOf('setTableauSessionExpired(true)')
    const csvPathCheckIdx = fnSlice.indexOf('if (csvPath) {')

    expect(catchIdx).toBeGreaterThan(-1)
    expect(setExpiredIdx).toBeGreaterThan(-1)
    expect(csvPathCheckIdx).toBeGreaterThan(-1)
    // setTableauSessionExpired must appear BEFORE the csvPath check (it's inside catch, not after)
    expect(setExpiredIdx).toBeLessThan(csvPathCheckIdx)
  })
})
