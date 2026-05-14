/**
 * Contract tests for scraper content quality gate (BKL-SCRAPE-01 / #190)
 *
 * Validates that scraped content is checked for error pages, login walls,
 * and insufficient length BEFORE entering the hash/cache pipeline.
 */

import { describe, test, expect } from 'bun:test'
import { validateScrapedContent } from '../../src/product-release-radar.ts'

describe('validateScrapedContent', () => {
  // ── Valid content ──────────────────────────────────────────────────────

  test('accepts valid release notes content (>200 chars, no error indicators)', () => {
    const validContent = `Red Hat Enterprise Linux 10 is now generally available.
      This release includes enhanced security features, improved container support,
      and updated system libraries. Key highlights include SELinux policy improvements,
      Podman 5.0 integration, and kernel 6.x support. The release also adds new
      networking capabilities and storage management tools for enterprise deployments.
      For more information, see the full release notes at docs.redhat.com.`.repeat(2)

    const result = validateScrapedContent(validContent, 'rhel', 'https://docs.redhat.com/rhel/10')
    expect(result.valid).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  // ── Too short ──────────────────────────────────────────────────────────

  test('rejects empty string', () => {
    const result = validateScrapedContent('', 'rhel', 'https://docs.redhat.com/rhel/10')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('too short')
  })

  test('rejects content under 200 characters', () => {
    const shortContent = 'Red Hat Enterprise Linux. Welcome to the documentation portal.'
    expect(shortContent.length).toBeLessThan(200)

    const result = validateScrapedContent(shortContent, 'rhel', 'https://docs.redhat.com/rhel/10')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('too short')
    expect(result.reason).toContain(`${shortContent.length} chars`)
  })

  // ── Error page indicators ─────────────────────────────────────────────

  test('rejects content with "Access Denied" (403 page)', () => {
    const errorPage = 'x'.repeat(250) + ' Access Denied — You do not have permission to view this resource.'
    const result = validateScrapedContent(errorPage, 'ocp', 'https://access.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "403 Forbidden"', () => {
    const errorPage = 'x'.repeat(250) + ' 403 Forbidden'
    const result = validateScrapedContent(errorPage, 'ocp', 'https://access.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "sign in required"', () => {
    const loginPage = 'x'.repeat(250) + ' Please sign in required to continue'
    const result = validateScrapedContent(loginPage, 'rhel', 'https://content.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "login required"', () => {
    const loginPage = 'x'.repeat(250) + ' Login Required — Authenticate to proceed'
    const result = validateScrapedContent(loginPage, 'rhel', 'https://content.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "you do not have permission"', () => {
    const errorPage = 'x'.repeat(250) + ' You do not have permission to access this page.'
    const result = validateScrapedContent(errorPage, 'ocp', 'https://access.redhat.com/articles/12345')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "unauthorized"', () => {
    const errorPage = 'x'.repeat(250) + ' Unauthorized — please log in.'
    const result = validateScrapedContent(errorPage, 'ocp', 'https://access.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content with "session expired"', () => {
    const expiredPage = 'x'.repeat(250) + ' Your session expired. Please sign in again.'
    const result = validateScrapedContent(expiredPage, 'rhel', 'https://access.redhat.com/something')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  test('rejects content.redhat.com login page (digital asset management system)', () => {
    const loginPage = 'x'.repeat(250) + ' Welcome to the Digital Asset Management System. Please authenticate.'
    const result = validateScrapedContent(loginPage, 'ocp', 'https://content.redhat.com/content/slides')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('error indicator')
  })

  // ── Case insensitivity ────────────────────────────────────────────────

  test('error detection is case-insensitive', () => {
    const errorPage = 'x'.repeat(250) + ' ACCESS DENIED'
    const result = validateScrapedContent(errorPage, 'ocp', 'https://access.redhat.com/something')
    expect(result.valid).toBe(false)
  })

  // ── Edge cases ────────────────────────────────────────────────────────

  test('accepts content at exactly 200 chars with no error indicators', () => {
    const content = 'a'.repeat(200)
    const result = validateScrapedContent(content, 'rhel', 'https://docs.redhat.com')
    expect(result.valid).toBe(true)
  })

  test('rejects content at 199 chars', () => {
    const content = 'a'.repeat(199)
    const result = validateScrapedContent(content, 'rhel', 'https://docs.redhat.com')
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('too short')
  })
})
