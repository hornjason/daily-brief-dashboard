// BKL-RH-TRANSPORT-GUARD: Regression test — runRhScrapeWithState() must not
// short-circuit on a missing .rh-session.json when transport=bearer.
//
// Before this fix, scraper-manager.ts unconditionally returned when the
// RH session file was absent, even though bearer transport authenticates via
// REDHAT_OFFLINE_TOKEN and never needs Playwright cookies. The guard is now
// transport-conditional: bearer skips the session-file check entirely;
// browser retains it.
//
// Strategy (no mock.module — bun's mocks are process-global and leak into
// other test files in the same `bun test` run):
//   - Set RH_CASES_TRANSPORT=bearer via env so the real getConfiguredTransport()
//     returns 'bearer'.
//   - Replace serverState.customers with [] via setCustomers([]) so the
//     function reaches the no-accounts branch immediately, without doing any
//     real network or Playwright work.
//   - Init the manager with an RH_SESSION_PATH that does NOT exist on disk.
//   - Call runRhScrapeWithState() and read the real scraper-status-store —
//     a bumped lastRun on rh-cases is observable proof the function did NOT
//     return at the legacy session-file gate.
//
// If the legacy unconditional `if (!existsSync(RH_SESSION_PATH)) return`
// is ever reintroduced, lastRun will not change and this test will fail.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'

import { initScraperManager, runRhScrapeWithState } from '../../src/scraper-manager.ts'
import * as serverState from '../../src/server-state.ts'
import { getScraperStatus } from '../../src/scraper-status-store.ts'

describe('BKL-RH-TRANSPORT-GUARD: bearer transport skips RH session-file gate', () => {
  let savedTransport: string | undefined
  let savedCustomers: typeof serverState.customers

  beforeAll(() => {
    savedTransport = process.env.RH_CASES_TRANSPORT
    process.env.RH_CASES_TRANSPORT = 'bearer'
    // Snapshot and clear customers so we hit the no-accounts branch fast.
    savedCustomers = [...serverState.customers]
    serverState.setCustomers([])
  })

  afterAll(() => {
    if (savedTransport === undefined) {
      delete process.env.RH_CASES_TRANSPORT
    } else {
      process.env.RH_CASES_TRANSPORT = savedTransport
    }
    serverState.setCustomers(savedCustomers)
  })

  test('runRhScrapeWithState does not return early when bearer + no session file', async () => {
    // Path that is guaranteed not to exist on disk.
    const nonExistentSessionPath = '/tmp/rh-transport-guard-does-not-exist.json'

    initScraperManager({
      rhSessionPath: nonExistentSessionPath,
      rhProfileDir: '/tmp/rh-transport-guard-profile',
      rhCasesCachePath: '/tmp/rh-transport-guard-cases.json',
      sfSessionPath: '/tmp/rh-transport-guard-sf-session.json',
      sfReportId: 'TEST_REPORT',
    })

    // Sanity: the session file really is absent.
    const { existsSync } = await import('node:fs')
    expect(existsSync(nonExistentSessionPath)).toBe(false)

    const beforeRun = getScraperStatus('rh-cases').lastRun
    await runRhScrapeWithState()
    const afterRun = getScraperStatus('rh-cases').lastRun

    // The function reached the no-accounts branch and called recordOutcome,
    // bumping lastRun. If the legacy `if (!existsSync(RH_SESSION_PATH)) return`
    // were still in place, lastRun would be unchanged from beforeRun.
    expect(afterRun).not.toBeNull()
    expect(afterRun).not.toBe(beforeRun)
  })
})
