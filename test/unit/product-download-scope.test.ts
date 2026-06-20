/**
 * Product Download Scope — Unit Tests (GitHub Issue #847)
 *
 * Validates that downloadProductDocuments():
 * 1. Processes ALL sections (not just Domains) — AC-1
 * 2. SKIP_FORMATS filter prevents PNG/MP4/WEBM/YouTube/URL downloads — AC-A1
 * 3. Viewer click-to-download is PRIMARY path, three-dot menu is FALLBACK
 * 4. Circuit breaker preserved (5 consecutive failures)
 * 5. No navigation away from product page in fallback path (ANTI-1)
 * 6. No product-specific special-casing (ANTI-3)
 *
 * These tests verify the scraper script's structural patterns via
 * source code analysis (grep-verifiable).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const SCRAPER_PATH = resolve(import.meta.dir, '../../scripts/scrape-saleshub-product-page.ts')
const scraperSource = readFileSync(SCRAPER_PATH, 'utf-8')

/**
 * Extract the body of downloadProductDocuments() from source.
 * Finds the function signature end (Promise<void> {) then walks braces.
 */
function extractDownloadFn(): string {
  const fnStart = scraperSource.indexOf('async function downloadProductDocuments')
  if (fnStart === -1) throw new Error('downloadProductDocuments not found in source')
  const sigEnd = scraperSource.indexOf('): Promise<void>', fnStart)
  if (sigEnd === -1) throw new Error('Could not find Promise<void> signature end')
  const bodyStart = scraperSource.indexOf('{', sigEnd)
  let depth = 0
  let i = bodyStart
  for (; i < scraperSource.length; i++) {
    if (scraperSource[i] === '{') depth++
    if (scraperSource[i] === '}') depth--
    if (depth === 0) break
  }
  return scraperSource.slice(fnStart, i + 1)
}

describe('product-download-scope (#847)', () => {
  const downloadFn = extractDownloadFn()

  describe('AC-1: all-sections download scope', () => {
    test('downloadProductDocuments iterates ALL section keys from sections parameter', () => {
      const hasAllSectionsLoop =
        downloadFn.includes('Object.keys(sections)') ||
        downloadFn.includes('Object.entries(sections)') ||
        downloadFn.includes('Object.values(sections)')
      expect(hasAllSectionsLoop).toBe(true)
    })

    test('downloadProductDocuments does NOT filter to Domain-only sections', () => {
      expect(downloadFn).not.toContain("text=Domains")
      expect(downloadFn).not.toContain("Expanding Domain accordion")
    })

    test('viewer click-to-download is the primary download path', () => {
      expect(downloadFn.toLowerCase()).toContain('viewer')
    })

    test('three-dot menu is the fallback download path', () => {
      expect(downloadFn.toLowerCase()).toContain('three-dot')
      expect(downloadFn.toLowerCase()).toContain('fallback')
    })
  })

  describe('AC-A1: SKIP_FORMATS filter', () => {
    test('SKIP_FORMATS includes PNG, MP4, WEBM, YouTube, URL', () => {
      const match = scraperSource.match(/SKIP_FORMATS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/)
      expect(match).not.toBeNull()
      const formatsStr = match![1]
      expect(formatsStr).toContain("'PNG'")
      expect(formatsStr).toContain("'MP4'")
      expect(formatsStr).toContain("'WEBM'")
      expect(formatsStr).toContain("'YouTube'")
      expect(formatsStr).toContain("'URL'")
    })

    test('downloadProductDocuments checks SKIP_FORMATS before downloading', () => {
      expect(downloadFn).toContain('SKIP_FORMATS')
    })
  })

  describe('ANTI-1: no navigation away from product page in three-dot fallback', () => {
    test('three-dot fallback section does not navigate to viewer pages', () => {
      // The three-dot FALLBACK section starts at "FALLBACK: Three-dot" and ends
      // before "FALLBACK 3" (the API download). ANTI-1 applies only to the
      // three-dot method — the API fallback (#857) legitimately opens a new page.
      const fallbackHeader = 'FALLBACK: Three-dot'
      const fallbackIdx = downloadFn.indexOf(fallbackHeader)
      expect(fallbackIdx).toBeGreaterThan(-1)

      // Scope to just the three-dot section (before FALLBACK 3)
      const apiFallbackHeader = 'FALLBACK 3'
      const apiFallbackIdx = downloadFn.indexOf(apiFallbackHeader, fallbackIdx)
      const threeDotSection = apiFallbackIdx > -1
        ? downloadFn.slice(fallbackIdx, apiFallbackIdx)
        : downloadFn.slice(fallbackIdx)

      // Three-dot fallback must not navigate to any URL
      expect(threeDotSection).not.toContain('.goto(item.url')
      expect(threeDotSection).not.toContain('dlPage.goto')
      expect(threeDotSection).not.toContain('context.newPage')
    })

    test('API fallback (#857) exists as a third download method', () => {
      expect(downloadFn).toContain('FALLBACK 3')
      expect(downloadFn).toContain('shouldAttemptApiDownload')
      expect(downloadFn).toContain('buildDownloadUrl')
    })
  })

  describe('ANTI-3: no product-specific special-casing', () => {
    test('downloadProductDocuments does not reference Ansible or AAP', () => {
      expect(downloadFn.toLowerCase()).not.toContain('ansible')
    })

    test('downloadProductDocuments does not reference OCP-V specifically', () => {
      expect(downloadFn.toLowerCase()).not.toContain('ocp-v')
      expect(downloadFn.toLowerCase()).not.toContain('openshift virtualization')
    })
  })

  describe('Circuit breaker preserved', () => {
    test('circuit breaker threshold is 5 consecutive failures', () => {
      expect(downloadFn).toContain('CIRCUIT_BREAKER')
      expect(downloadFn).toContain('consecutiveFailures')
      expect(downloadFn).toMatch(/CIRCUIT_BREAKER\s*=\s*5/)
    })

    test('circuit breaker resets on successful download (viewer or fallback)', () => {
      const resets = downloadFn.match(/consecutiveFailures\s*=\s*0/g)
      expect(resets).not.toBeNull()
      // At least 2 resets: one for viewer success, one for fallback success, one for cache hit
      expect(resets!.length).toBeGreaterThanOrEqual(2)
    })
  })
})
