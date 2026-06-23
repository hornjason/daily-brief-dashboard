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
  isNonEnglishByMetadata,
  buildDownloadUrl,
  buildLocalPath,
  authCanaryCheck,
  deduplicateAcrossSections,
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

describe('isNonEnglishDoc (#872 two-tier)', () => {
  it('returns true for ISO language code suffixes', () => {
    expect(isNonEnglishDoc('Guide de déploiement (fr)')).toBe(true)
    expect(isNonEnglishDoc('Guía rápida (es)')).toBe(true)
    expect(isNonEnglishDoc('Leitfaden (de)')).toBe(true)
    expect(isNonEnglishDoc('ガイド (ja)')).toBe(true)
    expect(isNonEnglishDoc('Guia (pt-BR)')).toBe(true)
  })

  it('returns true for non-English word patterns in title', () => {
    // Portuguese
    expect(isNonEnglishDoc('Acelere os resultados com Red Hat')).toBe(true)
    expect(isNonEnglishDoc('Começe a usar automação')).toBe(true)
    expect(isNonEnglishDoc('5 maneiras de usar OpenShift')).toBe(true)
    expect(isNonEnglishDoc('Faça mais com menos')).toBe(true)
    // Spanish
    expect(isNonEnglishDoc('Comience con la automatización')).toBe(true)
    expect(isNonEnglishDoc('5 motivos para migrar')).toBe(true)
    // French
    expect(isNonEnglishDoc('Débuter avec RHEL')).toBe(true)
    // German
    expect(isNonEnglishDoc('Einstieg in die Virtualisierung')).toBe(true)
    // Italian
    expect(isNonEnglishDoc('Introduzione alla gestione')).toBe(true)
    expect(isNonEnglishDoc('I vantaggi di OpenShift')).toBe(true)
    // Korean
    expect(isNonEnglishDoc('비즈니스 자동화 가이드')).toBe(true)
    // Japanese
    expect(isNonEnglishDoc('仮想化ソリューション')).toBe(true)
  })

  it('returns false for English documents', () => {
    expect(isNonEnglishDoc('Quick Start Guide')).toBe(false)
    expect(isNonEnglishDoc('AAP 2.6 Release Overview')).toBe(false)
    expect(isNonEnglishDoc('Red Hat Ansible Automation Platform Cheatsheet')).toBe(false)
    expect(isNonEnglishDoc('Accelerate business outcomes')).toBe(false)
    expect(isNonEnglishDoc('Getting Started with OpenShift')).toBe(false)
  })
})

describe('isNonEnglishByMetadata (#872)', () => {
  it('returns true for non-English language metadata', () => {
    expect(isNonEnglishByMetadata({ language: 'fr' })).toBe(true)
    expect(isNonEnglishByMetadata({ language: 'pt-BR' })).toBe(true)
    expect(isNonEnglishByMetadata({ language: 'de' })).toBe(true)
    expect(isNonEnglishByMetadata({ language: 'ja' })).toBe(true)
  })

  it('returns false for English language variants', () => {
    expect(isNonEnglishByMetadata({ language: 'en' })).toBe(false)
    expect(isNonEnglishByMetadata({ language: 'en-us' })).toBe(false)
    expect(isNonEnglishByMetadata({ language: 'en-US' })).toBe(false)
    expect(isNonEnglishByMetadata({ language: 'en-gb' })).toBe(false)
    expect(isNonEnglishByMetadata({ language: 'EN' })).toBe(false)
  })

  it('returns false when no language field', () => {
    expect(isNonEnglishByMetadata({})).toBe(false)
    expect(isNonEnglishByMetadata({ language: '' })).toBe(false)
    expect(isNonEnglishByMetadata({ language: undefined })).toBe(false)
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

// ── authCanaryCheck (#874) ────────────────────────────────────────────────

describe('authCanaryCheck', () => {
  it('returns { ok: true } when fetch returns 200', async () => {
    const mockFetch = async () => ({ status: 200, ok: true, redirected: false, url: 'https://saleshub.redhat.com/api/doccenter/download/c1/v1' }) as any
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const authCtx = { auth: 'Bearer xyz', headers: { Authorization: 'Bearer xyz' }, searchUrl: '' }
    const result = await authCanaryCheck(authCtx, sections, mockFetch)
    expect(result.ok).toBe(true)
  })

  it('returns { ok: false } with reason on 401', async () => {
    const mockFetch = async () => ({ status: 401, ok: false, redirected: false, url: '' }) as any
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const authCtx = { auth: 'Bearer xyz', headers: { Authorization: 'Bearer xyz' }, searchUrl: '' }
    const result = await authCanaryCheck(authCtx, sections, mockFetch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('401')
  })

  it('returns { ok: false } with reason on 403', async () => {
    const mockFetch = async () => ({ status: 403, ok: false, redirected: false, url: '' }) as any
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const authCtx = { auth: 'Bearer xyz', headers: { Authorization: 'Bearer xyz' }, searchUrl: '' }
    const result = await authCanaryCheck(authCtx, sections, mockFetch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('403')
  })

  it('returns { ok: false } when redirected to login page', async () => {
    const mockFetch = async () => ({ status: 200, ok: true, redirected: true, url: 'https://auth.redhat.com/login' }) as any
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
    }
    const authCtx = { auth: 'Bearer xyz', headers: { Authorization: 'Bearer xyz' }, searchUrl: '' }
    const result = await authCanaryCheck(authCtx, sections, mockFetch)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('login')
  })

  it('returns { ok: true, skipped: true } when no downloadable items exist', async () => {
    const mockFetch = async () => { throw new Error('should not be called') }
    const sections: Record<string, ProductSection> = {
      's': makeSection('S', [
        { name: 'Link Only', url: 'https://example.com' },
      ]),
    }
    const authCtx = { auth: 'Bearer xyz', headers: { Authorization: 'Bearer xyz' }, searchUrl: '' }
    const result = await authCanaryCheck(authCtx, sections, mockFetch)
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
  })
})

// ── deduplicateAcrossSections (#873) ──────────────────────────────────────

describe('deduplicateAcrossSections', () => {
  it('removes duplicate items by normalized name across sections', () => {
    const sections: Record<string, ProductSection> = {
      'resources': makeSection('Resources', [
        { name: 'Getting Started Guide', url: 'https://example.com' },
        { name: 'Unique Doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,
      ]),
      'technical-resources': makeSection('Technical resources', [
        { name: 'getting started guide', versionId: 'v2', contentId: 'c2', format: 'PDF' } as any,
      ]),
    }
    const result = deduplicateAcrossSections(sections)
    expect(result.removed).toHaveLength(1)

    // Total items after dedup: 2 (unique + the kept copy)
    const totalItems = Object.values(sections).reduce((sum, s) => sum + s.items.length, 0)
    expect(totalItems).toBe(2)
  })

  it('keeps the entry with contentId when deduplicating', () => {
    const sections: Record<string, ProductSection> = {
      'a': makeSection('A', [
        { name: 'My Doc', url: 'https://example.com' },  // no contentId
      ]),
      'b': makeSection('B', [
        { name: 'my doc', versionId: 'v1', contentId: 'c1', format: 'PDF' } as any,  // has contentId
      ]),
    }
    const result = deduplicateAcrossSections(sections)
    expect(result.removed).toHaveLength(1)

    // Section 'a' should have the DOM-only item removed
    expect(sections['a'].items).toHaveLength(0)
    // Section 'b' should keep its item (has contentId)
    expect(sections['b'].items).toHaveLength(1)
    expect(sections['b'].items[0].name).toBe('my doc')
  })

  it('returns empty removed array when no duplicates', () => {
    const sections: Record<string, ProductSection> = {
      'a': makeSection('A', [
        { name: 'Doc A' },
        { name: 'Doc B' },
      ]),
    }
    const result = deduplicateAcrossSections(sections)
    expect(result.removed).toHaveLength(0)
  })

  it('handles multiple duplicates of the same item', () => {
    const sections: Record<string, ProductSection> = {
      'a': makeSection('A', [{ name: 'Same Doc' }]),
      'b': makeSection('B', [{ name: 'same doc', contentId: 'c1' } as any]),
      'c': makeSection('C', [{ name: 'SAME DOC' }]),
    }
    const result = deduplicateAcrossSections(sections)
    expect(result.removed).toHaveLength(2)

    const totalItems = Object.values(sections).reduce((sum, s) => sum + s.items.length, 0)
    expect(totalItems).toBe(1)
  })
})
