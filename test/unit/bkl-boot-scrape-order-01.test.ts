// BKL-BOOT-SCRAPE-ORDER-01: Regression tests for fresh-bootstrap scraper ordering.
//
// On fresh container bootstrap, the shared Chromium browser previously crashed
// because too many things fired the moment connections were made:
//   1. SF onComplete called runSfSyncForAes → heavy Lightning report scrape
//   2. Startup catch-up fired CCSP/Pipeline before any AE existed
//   3. Bootstrap CCSP fired L4 Tableau even when L3 Drive CSV existed today
//   4. Post-bootstrap RH cases enqueued during the fragile bootstrap window
//
// These tests are source-grep + small unit tests — they do NOT spin up the
// browser context or run scrapers. They verify the surgical guards added
// in BKL-BOOT-SCRAPE-ORDER-01 stay in place.

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const SERVER_TS = readFileSync(resolve(ROOT, 'server.ts'), 'utf-8')
// BKL-ARCH-09: SF auth routes were extracted from server.ts into src/auth-routes.ts.
// Test A reads from auth-routes.ts to find the startSfLoginBrowser call and its onComplete callback.
const AUTH_ROUTES_TS = readFileSync(resolve(ROOT, 'src/auth-routes.ts'), 'utf-8')
const BOOTSTRAP_ORCH_TS = readFileSync(resolve(ROOT, 'src/bootstrap-orchestrator.ts'), 'utf-8')
const BG_SCHED_TS = readFileSync(resolve(ROOT, 'src/background-scheduler.ts'), 'utf-8')
const CCSP_TS = readFileSync(resolve(ROOT, 'src/ccsp-scraper.ts'), 'utf-8')

describe('BKL-BOOT-SCRAPE-ORDER-01: Test A — SF onComplete does not trigger scrapes', () => {
  test('SF startSfLoginBrowser onComplete callback contains no scrape trigger', () => {
    // Locate the SF login startSfLoginBrowser block and confirm it does not call
    // runSfSyncForAes / runSfPipelineSync inside the callback (executable lines only,
    // not comment lines that explain what was removed).
    const startIdx = AUTH_ROUTES_TS.indexOf('await startSfLoginBrowser(SF_SESSION_PATH')
    expect(startIdx).toBeGreaterThan(-1)
    // Slice ~1500 chars covering the callback body and onwards
    const slice = AUTH_ROUTES_TS.slice(startIdx, startIdx + 1500)
    // Strip comment lines (// ...) before checking for executable calls
    const codeOnly = slice
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n')
    // Match function-call shape: `runSfSyncForAes(` or `runSfPipelineSync(`
    expect(codeOnly).not.toMatch(/runSfSyncForAes\s*\(/)
    expect(codeOnly).not.toMatch(/runSfPipelineSync\s*\(/)
  })

  test('Comment marker present documenting the rationale', () => {
    expect(AUTH_ROUTES_TS).toContain('Data sync is driven by bootstrap, not auth')
  })
})

describe('BKL-BOOT-SCRAPE-ORDER-01: Test B — startup catch-up skipped when no AEs configured', () => {
  test('Catch-up has top-level guard that skips when aes list is empty', () => {
    // The guard message must appear in background-scheduler.ts inside the catch-up block.
    expect(BG_SCHED_TS).toContain('catch-up skipped — no AEs configured yet')
  })

  test('Catch-up guard short-circuits before any enqueueScraperTask call', () => {
    const guardIdx = BG_SCHED_TS.indexOf('catch-up skipped — no AEs configured yet')
    expect(guardIdx).toBeGreaterThan(-1)
    // After the guard message, the next thing in flow is `return` before any enqueue.
    const slice = BG_SCHED_TS.slice(guardIdx, guardIdx + 200)
    expect(slice).toContain('return')
  })

  test('Catch-up uses aes from server-state and length check at top', () => {
    // Confirm aes.length === 0 / !aes is checked before scheduling
    expect(BG_SCHED_TS).toMatch(/!catchupAes\s*\|\|\s*catchupAes\.length\s*===\s*0/)
  })
})

describe('BKL-BOOT-SCRAPE-ORDER-01: Test C — bootstrap CCSP step always writes sheet (BKL-BOOT-CCSP-SHEET-SKIP-01 fix)', () => {
  // BKL-BOOT-CCSP-SHEET-SKIP-01: The checkCcspL3Exists pre-check was removed from
  // bootstrap-orchestrator because it short-circuited BEFORE writeCcspSheet ran,
  // meaning the AE's CCSP sheet was never written on L3 cache hits. Bootstrap now
  // always runs the full CCSP step (runCcspScrape → writeCcspSheet).

  test('checkCcspL3Exists is still exported from ccsp-scraper.ts (used by scrapePodCcspRaw)', () => {
    expect(CCSP_TS).toContain('export async function checkCcspL3Exists')
  })

  test('checkCcspL3Exists uses the canonical CCSP-${pod}-${YYYY-MM-DD}.csv filename', () => {
    expect(CCSP_TS).toMatch(/CCSP-\$\{podName\}-\$\{today\}\.csv/)
  })

  test('checkCcspL3Exists short-circuits on missing inputs (fail-closed to false)', () => {
    const startIdx = CCSP_TS.indexOf('export async function checkCcspL3Exists')
    const fnSlice = CCSP_TS.slice(startIdx, startIdx + 1200)
    expect(fnSlice).toContain('if (!podBookingsFolderId) return false')
    expect(fnSlice).toContain('if (territories.length === 0) return false')
  })

  test('Bootstrap orchestrator calls writeCcspSheet in the CCSP step', () => {
    // Pre-check block removed — bootstrap always writes the sheet
    expect(BOOTSTRAP_ORCH_TS).toContain('writeCcspSheet')
    expect(BOOTSTRAP_ORCH_TS).not.toContain('CCSP L3 hit today — skipping L4 Tableau scrape')
  })
})

describe('BKL-BOOT-SCRAPE-ORDER-01: Test D — RH Cases not triggered during bootstrap', () => {
  test('POD bootstrap completion does not enqueue rh-cases scrape', () => {
    // Removed BKL-BOOT-06/07 enqueues — confirm no rh-cases enqueue in pod-bootstrap section.
    const podBootIdx = BOOTSTRAP_ORCH_TS.indexOf('[pod-bootstrap]')
    expect(podBootIdx).toBeGreaterThan(-1)
    // Search bootstrap-orchestrator.ts for any `name: 'rh-cases'` enqueue — there should be zero now.
    const matches = BOOTSTRAP_ORCH_TS.match(/name:\s*'rh-cases'/g) ?? []
    expect(matches.length).toBe(0)
  })

  test('Single-AE auto-bootstrap does not enqueue rh-cases scrape', () => {
    // No `enqueueScraperTask` block with rh-cases inside auto-bootstrap path
    expect(BOOTSTRAP_ORCH_TS).not.toContain("name: 'rh-cases'")
  })

  test('Comment markers explain the removal rationale', () => {
    expect(BOOTSTRAP_ORCH_TS).toContain('RH Cases is scheduled-only')
  })
})
