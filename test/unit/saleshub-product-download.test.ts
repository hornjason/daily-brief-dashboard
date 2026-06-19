/**
 * Unit tests for SalesHub product page API-based document download (#847)
 *
 * Tests the pure logic functions used by downloadProductDocuments:
 * - collectDownloadableItems: filters section items to downloadable API-sourced docs
 * - isSkippedFormat: format gate (PNG/MP4/WEBM/YouTube/URL excluded)
 * - isNonEnglishDoc: language filter for non-English documents
 * - buildDownloadUrl: Seismic download URL construction from contentId/versionId
 * - buildLocalPath: local path construction from section + document name
 *
 * No browser required — pure function tests.
 */

import { describe, it, expect } from 'bun:test'
import {
  collectDownloadableItems,
  isSkippedFormat,
  isNonEnglishDoc,
  buildDownloadUrl,
  buildLocalPath,
  type DownloadableItem,
} from '../../scripts/scrape-saleshub-product-page.ts'
import type { ProductSection, SectionItem } from '../../src/types/saleshub-product-types.ts'

// ── Test Data ──────────────────────────────────────────────────────────────────

function makeSection(title: string, items: Partial<SectionItem>[]): ProductSection {
  return {
    title,
    type: 'mixed',
    items: items.map(i => ({
      name: i.name ?? 'Test Item',
      url: i.url,
      description: i.description,
      ...i,
    })) as SectionItem[],
  }
}

// ── collectDownloadableItems ────────────────────────────────────────────────

describe('collectDownloadableItems', () => {
  it('returns items with versionId + contentId + downloadable format', () => {
    const sections: Record<string, ProductSection> = {
      'business-decks': makeSection('Business decks', [
        { name: 'Deck A', versionId: 'v1', contentId: 'c1', format: 'PPTX' } as any,
        { name: 'Deck B', versionId: 'v2', contentId: 'c2', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(2)
    expect(result[0].name).toBe('Deck A')
    expect(result[0].format).toBe('PPTX')
    expect(result[0].sectionKey).toBe('business-decks')
    expect(result[1].name).toBe('Deck B')
  })

  it('excludes items without versionId', () => {
    const sections: Record<string, ProductSection> = {
      'links': makeSection('Links', [
        { name: 'DOM Link', url: 'https://example.com' },
        { name: 'API Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('API Doc')
  })

  it('excludes items without contentId', () => {
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'No CID', versionId: 'v1', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(0)
  })

  it('excludes skipped formats (PNG, MP4, WEBM, YouTube, URL)', () => {
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Image', versionId: 'v1', contentId: 'c1', format: 'PNG' } as any,
        { name: 'Video', versionId: 'v2', contentId: 'c2', format: 'MP4' } as any,
        { name: 'WebM', versionId: 'v3', contentId: 'c3', format: 'WEBM' } as any,
        { name: 'YT', versionId: 'v4', contentId: 'c4', format: 'YouTube' } as any,
        { name: 'Link', versionId: 'v5', contentId: 'c5', format: 'URL' } as any,
        { name: 'Good PDF', versionId: 'v6', contentId: 'c6', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('Good PDF')
  })

  it('excludes non-English documents', () => {
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'English Guide', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
        { name: 'Guía en español (es)', versionId: 'v2', contentId: 'c2', format: 'PDF' } as any,
        { name: 'Guide en français (fr)', versionId: 'v3', contentId: 'c3', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe('English Guide')
  })

  it('collects from all sections, not just Domain', () => {
    const sections: Record<string, ProductSection> = {
      'business-decks': makeSection('Business decks', [
        { name: 'Deck', versionId: 'v1', contentId: 'c1', format: 'PPTX' } as any,
      ]),
      'competitive': makeSection('Competitive', [
        { name: 'Battlecard', versionId: 'v2', contentId: 'c2', format: 'DOCX' } as any,
      ]),
      'technical-resources': makeSection('Technical resources', [
        { name: 'Arch Guide', versionId: 'v3', contentId: 'c3', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(3)
    const sectionKeys = result.map(r => r.sectionKey)
    expect(sectionKeys).toContain('business-decks')
    expect(sectionKeys).toContain('competitive')
    expect(sectionKeys).toContain('technical-resources')
  })

  it('deduplicates by versionId', () => {
    const sections: Record<string, ProductSection> = {
      'a': makeSection('A', [
        { name: 'Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
      'b': makeSection('B', [
        { name: 'Doc Copy', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const result = collectDownloadableItems(sections)
    expect(result.length).toBe(1)
  })
})

// ── isSkippedFormat ─────────────────────────────────────────────────────────

describe('isSkippedFormat', () => {
  it('returns true for PNG, MP4, WEBM, YouTube, URL, JSON, MOV, ZIP', () => {
    expect(isSkippedFormat('PNG')).toBe(true)
    expect(isSkippedFormat('MP4')).toBe(true)
    expect(isSkippedFormat('WEBM')).toBe(true)
    expect(isSkippedFormat('YouTube')).toBe(true)
    expect(isSkippedFormat('URL')).toBe(true)
    expect(isSkippedFormat('JSON')).toBe(true)
    expect(isSkippedFormat('MOV')).toBe(true)
    expect(isSkippedFormat('ZIP')).toBe(true)
  })

  it('returns false for PDF, PPTX, DOCX', () => {
    expect(isSkippedFormat('PDF')).toBe(false)
    expect(isSkippedFormat('PPTX')).toBe(false)
    expect(isSkippedFormat('DOCX')).toBe(false)
  })

  it('returns true for empty format', () => {
    expect(isSkippedFormat('')).toBe(true)
  })
})

// ── isNonEnglishDoc ─────────────────────────────────────────────────────────

describe('isNonEnglishDoc', () => {
  it('returns true for documents with language codes in name', () => {
    expect(isNonEnglishDoc('Guide de déploiement (fr)')).toBe(true)
    expect(isNonEnglishDoc('Guía rápida (es)')).toBe(true)
    expect(isNonEnglishDoc('Leitfaden (de)')).toBe(true)
    expect(isNonEnglishDoc('ガイド (ja)')).toBe(true)
  })

  it('returns false for English documents', () => {
    expect(isNonEnglishDoc('Quick Start Guide')).toBe(false)
    expect(isNonEnglishDoc('AAP 2.6 Release Overview')).toBe(false)
    expect(isNonEnglishDoc('Red Hat Ansible Automation Platform Cheatsheet')).toBe(false)
  })
})

// ── buildDownloadUrl ────────────────────────────────────────────────────────

describe('buildDownloadUrl', () => {
  it('constructs Seismic download URL from versionId', () => {
    const url = buildDownloadUrl('v-abc-123', 'c-def-456')
    expect(url).toContain('v-abc-123')
    expect(url).toContain('saleshub.redhat.com')
    expect(url).toContain('download')
  })

  it('includes the content ID in the URL', () => {
    const url = buildDownloadUrl('v-abc-123', 'c-def-456')
    expect(url).toContain('c-def-456')
  })
})

// ── buildLocalPath ──────────────────────────────────────────────────────────

describe('buildLocalPath', () => {
  it('constructs path under product downloads directory by section', () => {
    const path = buildLocalPath('/data/products/my-product', 'business-decks', 'My Deck', 'PPTX')
    expect(path).toContain('/data/products/my-product/downloads/business-decks/')
    expect(path).toEndWith('.pptx')
    expect(path).toContain('My Deck')
  })

  it('sanitizes special characters in filename', () => {
    const path = buildLocalPath('/data/products/my-product', 's', 'Doc/With:Special*Chars', 'PDF')
    // The filename part (after last /) should not contain special chars
    const filename = path.split('/').pop()!
    expect(filename).not.toContain('/')
    expect(filename).not.toContain(':')
    expect(filename).not.toContain('*')
  })

  it('uses lowercase extension', () => {
    const path = buildLocalPath('/data/products/my-product', 's', 'Doc', 'PPTX')
    expect(path).toEndWith('.pptx')
  })
})
