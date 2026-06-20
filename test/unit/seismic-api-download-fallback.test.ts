/**
 * Unit tests for Seismic API download fallback (#857)
 *
 * Tests the third download fallback in downloadProductDocuments() that uses
 * the Seismic DocCenter download API when both viewer and three-dot methods fail.
 *
 * Tests:
 * - buildDownloadUrl constructs correct DocCenter API URL
 * - Guard condition: items without contentId or versionId are skipped
 * - shouldAttemptApiDownload correctly gates the fallback
 *
 * No browser required — pure function tests.
 */

import { describe, it, expect } from 'bun:test'
import {
  buildDownloadUrl,
  shouldAttemptApiDownload,
} from '../../scripts/scrape-saleshub-product-page.ts'

// -- buildDownloadUrl for API fallback --

describe('buildDownloadUrl (API fallback)', () => {
  it('constructs URL with contentId and versionId in correct order', () => {
    const url = buildDownloadUrl('ver-123', 'cnt-456')
    expect(url).toBe('https://saleshub.redhat.com/api/doccenter/download/cnt-456/ver-123')
  })

  it('handles UUIDs typical of Seismic documents', () => {
    const url = buildDownloadUrl(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      'f0e1d2c3-b4a5-6789-0abc-def123456789',
    )
    expect(url).toContain('/api/doccenter/download/')
    expect(url).toContain('f0e1d2c3-b4a5-6789-0abc-def123456789')
    expect(url).toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })
})

// -- shouldAttemptApiDownload --

describe('shouldAttemptApiDownload', () => {
  it('returns true when item has both contentId and versionId', () => {
    const item = { name: 'Doc', contentId: 'c1', versionId: 'v1' }
    expect(shouldAttemptApiDownload(item)).toBe(true)
  })

  it('returns false when contentId is missing', () => {
    const item = { name: 'Doc', versionId: 'v1' }
    expect(shouldAttemptApiDownload(item)).toBe(false)
  })

  it('returns false when versionId is missing', () => {
    const item = { name: 'Doc', contentId: 'c1' }
    expect(shouldAttemptApiDownload(item)).toBe(false)
  })

  it('returns false when both are missing', () => {
    const item = { name: 'Doc' }
    expect(shouldAttemptApiDownload(item)).toBe(false)
  })

  it('returns false when contentId is empty string', () => {
    const item = { name: 'Doc', contentId: '', versionId: 'v1' }
    expect(shouldAttemptApiDownload(item)).toBe(false)
  })

  it('returns false when versionId is empty string', () => {
    const item = { name: 'Doc', contentId: 'c1', versionId: '' }
    expect(shouldAttemptApiDownload(item)).toBe(false)
  })
})
