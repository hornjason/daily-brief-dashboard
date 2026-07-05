/**
 * Regression test for #964 — screenshot placement in scrapeProductPage.
 *
 * The page screenshot (_page-screenshot.png) must be captured AFTER all expansion
 * steps complete, including carousel click-through which navigates away from the
 * page and back. Accordions and DocListPickers must be re-expanded after carousel
 * processing since navigation collapses them.
 *
 * This test reads the source file and verifies the structural ordering of calls
 * within scrapeProductPage(). Structural source tests are the correct approach
 * here because the function requires a live browser and authenticated Seismic session.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SCRAPER_PATH = resolve(__dirname, '../../scripts/scrape-saleshub-product-page.ts')
const source = readFileSync(SCRAPER_PATH, 'utf-8')

// Extract the scrapeProductPage function body (from its export to the next top-level export or EOF)
function getScrapeProductPageBody(): string {
  const fnStart = source.indexOf('export async function scrapeProductPage(')
  if (fnStart === -1) throw new Error('scrapeProductPage not found in source')
  // The function body extends to the end of the file (it's the last major export)
  return source.slice(fnStart)
}

describe('#964 — screenshot after all expansion steps', () => {
  const fnBody = getScrapeProductPageBody()

  test('AC-1: screenshot is captured AFTER captureCarouselViewerUrls()', () => {
    const screenshotPos = fnBody.indexOf('page.screenshot({ fullPage: true')
    const carouselPos = fnBody.indexOf('captureCarouselViewerUrls(page)')
    expect(screenshotPos).toBeGreaterThan(0)
    expect(carouselPos).toBeGreaterThan(0)
    expect(screenshotPos).toBeGreaterThan(carouselPos)
  })

  test('AC-2: accordions and DocListPickers are re-expanded after carousel, before screenshot', () => {
    const carouselPos = fnBody.indexOf('captureCarouselViewerUrls(page)')
    const screenshotPos = fnBody.indexOf('page.screenshot({ fullPage: true')

    // Between carousel call and screenshot, there must be re-expansion calls
    const betweenCarouselAndScreenshot = fnBody.slice(carouselPos, screenshotPos)
    expect(betweenCarouselAndScreenshot).toContain('expandAllAccordions(page)')
    expect(betweenCarouselAndScreenshot).toContain('expandDomainDocListPickers(page)')
  })

  test('AC-3: no premature screenshot before carousel processing', () => {
    // There should be exactly ONE page.screenshot({ fullPage: true }) call in scrapeProductPage
    const matches = fnBody.match(/page\.screenshot\(\{\s*fullPage:\s*true/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBe(1)
  })

  test('AC-4: _product-source.json still references _page-screenshot.png', () => {
    // The sourceFiles assignment must still exist
    expect(fnBody).toContain("'_page-screenshot.png'")
    expect(fnBody).toContain('sourceFiles')
  })
})
