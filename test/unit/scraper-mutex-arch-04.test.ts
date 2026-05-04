/**
 * BKL-ARCH-SCRAPER-04 Wave 3 — verify per-module mutex exports.
 *
 * Confirms that the inner mutex state and helpers introduced in Wave 3 are
 * actually exported from rh-scraper.ts and sf-scraper.ts (not just present
 * in source text — the Playwright REG-ARCH-04-* tests cover that). Importing
 * the modules also smoke-tests that they parse and load under bun:test.
 */
import { describe, test, expect } from 'bun:test'

describe('ARCH-04 mutex exports are present and correct shape', () => {
  test('rh-scraper exports mutex symbols', async () => {
    const mod = await import('../../src/rh-scraper.ts')
    expect(typeof mod._rhScrapeRunning).toBe('boolean')
    expect(mod._rhScrapeRunning).toBe(false)
    expect(typeof mod.releaseRhScrapeMutex).toBe('function')
  })

  test('sf-scraper exports per-report mutex symbols', async () => {
    const mod = await import('../../src/sf-scraper.ts')
    expect(typeof mod._sfReportScrapeRunning).toBe('boolean')
    expect(mod._sfReportScrapeRunning).toBe(false)
  })
})
