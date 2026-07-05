/**
 * test/unit/release-notes-filter.test.ts — Regression tests for #969
 *
 * AC-1: Google Docs URLs use Drive API export in extract-product-content.ts
 * AC-3: Release notes content filtered before enrichment
 */

import { describe, it, expect } from 'bun:test'
import {
  isReleaseNotesItem,
  filterReleaseNotesContent,
} from '../../scripts/extract-product-content.ts'

// ── AC-3: Release notes detection ──────────────────────────────────────────

describe('isReleaseNotesItem()', () => {
  it('detects release_notes in URL', () => {
    expect(isReleaseNotesItem('Some Item', 'https://docs.redhat.com/en/documentation/release_notes/')).toBe(true)
  })

  it('detects "Release notes" in item name', () => {
    expect(isReleaseNotesItem('AAP 2.5 Release notes', 'https://example.com')).toBe(true)
  })

  it('detects "release_notes" in URL path', () => {
    expect(isReleaseNotesItem('Doc', 'https://docs.redhat.com/en/documentation/ansible/2.5/html/release_notes/')).toBe(true)
  })

  it('returns false for non-release-notes items', () => {
    expect(isReleaseNotesItem('Getting Started Guide', 'https://docs.redhat.com/en/guide/')).toBe(false)
  })

  it('returns false for empty inputs', () => {
    expect(isReleaseNotesItem('', '')).toBe(false)
  })
})

// ── AC-3: Release notes content filtering ──────────────────────────────────

describe('filterReleaseNotesContent()', () => {
  const fullContent = [
    '# Release Notes for Red Hat AAP 2.5',
    '',
    '## New features',
    'Added Event-Driven Ansible support.',
    'New automation mesh capabilities.',
    '',
    '## Technology Preview',
    'This is a very long section with lots of technology preview content.',
    'It contains many details about preview features that are not GA.',
    'This section can be 78K characters in production.',
    Array(500).fill('Technology preview detail line.').join('\n'),
    '',
    '## Deprecated features',
    'Removed legacy tower CLI.',
    'Deprecated old API v1 endpoints.',
    '',
    '## Known issues',
    'Some known issue content here.',
    '',
    '## Bug fixes',
    'Fixed various bugs.',
  ].join('\n')

  it('keeps New features section', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).toContain('New features')
    expect(result).toContain('Event-Driven Ansible')
  })

  it('keeps Deprecated features section', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).toContain('Deprecated features')
    expect(result).toContain('legacy tower CLI')
  })

  it('removes Technology Preview section', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).not.toContain('Technology Preview')
    expect(result).not.toContain('Technology preview detail line')
  })

  it('removes Known issues section', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).not.toContain('Known issues')
  })

  it('removes Bug fixes section', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).not.toContain('Bug fixes')
  })

  it('reduces content from ~85K to ~5K range', () => {
    expect(fullContent.length).toBeGreaterThan(10_000)
    const result = filterReleaseNotesContent(fullContent)
    expect(result.length).toBeLessThan(fullContent.length)
    // The filtered content should be much smaller
    expect(result.length).toBeLessThan(10_000)
  })

  it('preserves the title/header if present', () => {
    const result = filterReleaseNotesContent(fullContent)
    expect(result).toContain('Release Notes for Red Hat AAP')
  })

  it('returns content unchanged if no recognized sections', () => {
    const plain = 'Just some plain text without any markdown headers'
    expect(filterReleaseNotesContent(plain)).toBe(plain)
  })
})

// ── AC-1: classifyUrl routes docs.google.com to drive-api ──────────────────

describe('classifyUrl() for Google Docs', () => {
  // Import classifyUrl to verify it now routes Google Docs to 'drive-api' method
  let classifyUrl: (url: string) => { method: string; needsAuth: boolean }

  it('routes docs.google.com to drive-api method', async () => {
    const mod = await import('../../scripts/extract-product-content.ts')
    classifyUrl = mod.classifyUrl
    const result = classifyUrl('https://docs.google.com/document/d/abc123/edit')
    expect(result.method).toBe('drive-api')
    expect(result.needsAuth).toBe(false)
  })

  it('routes slides.google.com to drive-api method', async () => {
    const mod = await import('../../scripts/extract-product-content.ts')
    classifyUrl = mod.classifyUrl
    const result = classifyUrl('https://docs.google.com/presentation/d/abc123/edit')
    expect(result.method).toBe('drive-api')
    expect(result.needsAuth).toBe(false)
  })

  it('keeps other redhat.com URLs as webpage', async () => {
    const mod = await import('../../scripts/extract-product-content.ts')
    classifyUrl = mod.classifyUrl
    const result = classifyUrl('https://docs.redhat.com/en/documentation/')
    expect(result.method).toBe('webpage')
  })
})
