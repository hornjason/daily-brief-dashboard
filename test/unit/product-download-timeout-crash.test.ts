/**
 * #856: Regression test — download timeout must not crash the process
 *
 * Root cause: In downloadProductDocuments(), the viewer download path creates
 * a download promise BEFORE clicking, then awaits it. When the download times
 * out, the promise rejects. The page closes in the finally block, causing a
 * second async rejection on the pending promise. This unhandled rejection
 * crashes the Bun process.
 *
 * Fix: Attach .catch(() => null) to the download promise immediately when
 * created, so timeouts resolve to null instead of throwing. Same for the
 * three-dot fallback path.
 *
 * This test reads the source file and verifies the crash-safe pattern is
 * present in both download paths.
 */

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const SCRAPER_SRC = readFileSync(
  resolve(ROOT, 'scripts/scrape-saleshub-product-page.ts'),
  'utf-8',
)

describe('#856: Download timeout crash guard', () => {
  test('viewer download promise has .catch() attached at creation', () => {
    // The viewer path (dlPage.waitForEvent) must have .catch(() => null)
    // on the same line to prevent unhandled rejections
    const viewerPattern = /dlPage\.waitForEvent\(\s*'download'[^)]*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/
    expect(SCRAPER_SRC).toMatch(viewerPattern)
  })

  test('fallback download promise has .catch() attached at creation', () => {
    // The three-dot fallback path (page.waitForEvent) must also have
    // .catch(() => null) to prevent unhandled rejections
    const fallbackPattern = /page\.waitForEvent\(\s*'download'[^)]*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/
    expect(SCRAPER_SRC).toMatch(fallbackPattern)
  })

  test('viewer path handles null download (timeout) gracefully', () => {
    // After the .catch(() => null), the code must check if dl is null
    // before attempting to use it. Verify the null-guard pattern exists.
    const viewerSection = SCRAPER_SRC.slice(
      SCRAPER_SRC.indexOf("dlPage.waitForEvent('download'"),
      SCRAPER_SRC.indexOf("dlPage.waitForEvent('download'") + 600,
    )
    // Must not blindly call dl.suggestedFilename() — must check for null first
    expect(viewerSection).toMatch(/if\s*\(\s*!?\s*dl\b/)
  })

  test('fallback path handles null download (timeout) gracefully', () => {
    // Same null-guard pattern for the three-dot fallback
    const fallbackIdx = SCRAPER_SRC.indexOf("page.waitForEvent('download'")
    const fallbackSection = SCRAPER_SRC.slice(fallbackIdx, fallbackIdx + 600)
    // Must check for null before using dl
    expect(fallbackSection).toMatch(/if\s*\(\s*!?\s*dl\b/)
  })

  test('process has unhandledRejection safety net', () => {
    // As an additional safety net, the script should register a
    // process.on('unhandledRejection') handler
    expect(SCRAPER_SRC).toContain("process.on('unhandledRejection'")
  })

  test('success path is unchanged — dl.suggestedFilename() still called on success', () => {
    // The success path must still call dl.suggestedFilename() — we only
    // gate it behind a null check, not remove it entirely
    expect(SCRAPER_SRC).toContain('dl.suggestedFilename()')
  })

  test('failed downloads are still logged to manifest', () => {
    // failedDownloads.push must still exist for the error path
    expect(SCRAPER_SRC).toContain('failedDownloads.push(')
    expect(SCRAPER_SRC).toContain('_failed-downloads.json')
  })
})
