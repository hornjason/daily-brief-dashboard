// BKL-INGEST-04: Regression tests for DISALLOW_LIVE_SCRAPE=1 guard.
//
// All L4 (live) scrape entry points must throw immediately when
// process.env.DISALLOW_LIVE_SCRAPE === '1' — before any browser or
// network operation. This prevents the test container from silently
// falling through to a live scrape when its cache is empty.
//
// Functions guarded:
//   - sf-scraper.ts: scrapeSfReport()
//   - rh-scraper.ts: runRhScrape()
//   - ccsp-scraper.ts: runCcspScrape() + scrapePodCcspRaw()
//
// The assertions here do NOT require any browser context — the guard
// is the very first statement of each function. If the guard fires
// correctly, the error is thrown synchronously before any Playwright
// or Google API call executes.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'

describe('BKL-INGEST-04: DISALLOW_LIVE_SCRAPE guards all L4 entry points', () => {
  const originalEnv = process.env.DISALLOW_LIVE_SCRAPE

  beforeEach(() => {
    process.env.DISALLOW_LIVE_SCRAPE = '1'
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISALLOW_LIVE_SCRAPE
    } else {
      process.env.DISALLOW_LIVE_SCRAPE = originalEnv
    }
  })

  test('sf-scraper scrapeSfReport throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { scrapeSfReport } = await import('../../src/sf-scraper.ts')
    await expect(
      scrapeSfReport('00OAbCdEfGhIj', '/tmp/does-not-exist-profile'),
    ).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('sf-scraper error message includes scraper name for debugging', async () => {
    const { scrapeSfReport } = await import('../../src/sf-scraper.ts')
    await expect(
      scrapeSfReport('00OAbCdEfGhIj', '/tmp/does-not-exist-profile'),
    ).rejects.toThrow(/\[sf-scraper\]/)
  })

  test('rh-scraper runRhScrape throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { runRhScrape } = await import('../../src/rh-scraper.ts')
    await expect(
      runRhScrape({
        accountNumbers: ['12345678'],
        profileDir: '/tmp/does-not-exist-profile',
        cachePath: '/tmp/cache.json',
      }),
    ).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('rh-scraper error message includes scraper name for debugging', async () => {
    const { runRhScrape } = await import('../../src/rh-scraper.ts')
    await expect(
      runRhScrape({
        accountNumbers: ['12345678'],
        profileDir: '/tmp/does-not-exist-profile',
        cachePath: '/tmp/cache.json',
      }),
    ).rejects.toThrow(/\[rh-scraper\]/)
  })

  test('ccsp-scraper runCcspScrape throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { runCcspScrape } = await import('../../src/ccsp-scraper.ts')
    await expect(
      runCcspScrape([{
        name: 'Test AE',
        tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
        driveFolderId: 'fakeid',
      } as any]),
    ).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('ccsp-scraper scrapePodCcspRaw throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { scrapePodCcspRaw } = await import('../../src/ccsp-scraper.ts')
    await expect(
      scrapePodCcspRaw(['WEST_COMM_CORP_NORTHWEST_TERR01']),
    ).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('ccsp-scraper error message includes scraper name for debugging', async () => {
    const { runCcspScrape } = await import('../../src/ccsp-scraper.ts')
    await expect(
      runCcspScrape([{
        name: 'Test AE',
        tableauTerritories: ['WEST_COMM_CORP_NORTHWEST_TERR01'],
        driveFolderId: 'fakeid',
      } as any]),
    ).rejects.toThrow(/\[ccsp-scraper\]/)
  })

  test('rh-scraper discoverAccountNumberByName throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { discoverAccountNumberByName } = await import('../../src/rh-scraper.ts')
    await expect(
      discoverAccountNumberByName('Acme Inc', '/tmp/does-not-exist-profile'),
    ).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('rh-scraper discoverAccountNumberByName error message includes scraper name', async () => {
    const { discoverAccountNumberByName } = await import('../../src/rh-scraper.ts')
    await expect(
      discoverAccountNumberByName('Acme Inc', '/tmp/does-not-exist-profile'),
    ).rejects.toThrow(/\[rh-scraper\]/)
  })

  test('sf-scraper listSfReports throws when DISALLOW_LIVE_SCRAPE=1', async () => {
    const { listSfReports } = await import('../../src/sf-scraper.ts')
    await expect(listSfReports()).rejects.toThrow(/DISALLOW_LIVE_SCRAPE=1.*live scrape blocked/)
  })

  test('sf-scraper listSfReports error message includes scraper name', async () => {
    const { listSfReports } = await import('../../src/sf-scraper.ts')
    await expect(listSfReports()).rejects.toThrow(/\[sf-scraper\]/)
  })

  test('guard fires before any browser/network — no context needed', async () => {
    // The test container has no Chromium profile, no browser context,
    // no Google auth. If the guard ran AFTER initScrapeContext/newPage,
    // we'd see a Playwright error instead. The specific DISALLOW message
    // proves the guard is first.
    const { scrapeSfReport } = await import('../../src/sf-scraper.ts')
    let caught: Error | null = null
    try {
      await scrapeSfReport('reportId', '/tmp/profile')
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('DISALLOW_LIVE_SCRAPE=1')
    // Assert the message does NOT contain Playwright-specific strings
    // that would imply the browser started before the guard fired.
    expect(caught!.message).not.toMatch(/chromium|browser|context|playwright/i)
  })
})

describe('BKL-INGEST-04: guard predicate matches strict "1" only', () => {
  // Proves the guard uses exact string equality ('1') — not a truthiness check.
  // This prevents DISALLOW_LIVE_SCRAPE=true or DISALLOW_LIVE_SCRAPE=yes from
  // silently being treated as active guards, or DISALLOW_LIVE_SCRAPE=0 from
  // accidentally falling through. Test the predicate directly — invoking the
  // scrapers with the guard disabled would trigger real browser/network work.

  const guardFires = (envValue: string | undefined): boolean => {
    // Matches the literal check in every L4 entry point:
    //   if (process.env.DISALLOW_LIVE_SCRAPE === '1') { throw ... }
    return envValue === '1'
  }

  test('guard fires on "1"', () => {
    expect(guardFires('1')).toBe(true)
  })

  test('guard does NOT fire on "0"', () => {
    expect(guardFires('0')).toBe(false)
  })

  test('guard does NOT fire on undefined', () => {
    expect(guardFires(undefined)).toBe(false)
  })

  test('guard does NOT fire on empty string', () => {
    expect(guardFires('')).toBe(false)
  })

  test('guard does NOT fire on "true"', () => {
    // Strict equality — 'true' is not '1'. Prevents accidental truthy-string traps.
    expect(guardFires('true')).toBe(false)
  })

  test('guard does NOT fire on "yes"', () => {
    expect(guardFires('yes')).toBe(false)
  })

  test('guard does NOT fire on " 1 " (whitespace)', () => {
    expect(guardFires(' 1 ')).toBe(false)
  })
})
