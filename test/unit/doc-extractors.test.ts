// Issue #56: DocExtractor interface + implementations.
// Issue #986: Multi-tab Google Docs extraction via Docs API v1.
// Validates matches() dispatch, extract() truncation, and multi-tab behavior.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Module-level mock controls ────────────────────────────────────────────────
// These variables are referenced by mock.module callbacks.
// Set per-test to control whether makeAuth succeeds and what docs.documents.get returns.
let makeAuthShouldThrow = true
let mockDocsGetResult: any = { data: { tabs: [] } }

mock.module('../../src/google.ts', () => ({
  makeAuth: () => {
    if (makeAuthShouldThrow) throw new Error('No token file in test')
    return {}
  },
  GOOGLE_UNIFIED_TOKEN_PATH: '/tmp/mock-token.json',
}))

mock.module('googleapis', () => ({
  google: {
    docs: () => ({
      documents: {
        get: async () => mockDocsGetResult,
      },
    }),
  },
}))

// ── Imports (AFTER mock.module so mocks are applied) ─────────────────────────
import {
  ExportableDocExtractor,
  PdfDocExtractor,
  DEFAULT_EXTRACTORS,
  DOC_CONTENT_CAP,
  EXPORTABLE_MIME_TYPES,
  extractDocTextWithTabs,
} from '../../src/customer/doc-extractors.ts'
import type { drive_v3 } from 'googleapis'
import { initCacheLayer } from '../../src/cache-layer.ts'

const GOOGLE_DOC = 'application/vnd.google-apps.document'
const GOOGLE_PRES = 'application/vnd.google-apps.presentation'
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet'
const PDF = 'application/pdf'

let tmpCacheDir: string

beforeEach(() => {
  tmpCacheDir = mkdtempSync(join(tmpdir(), 'doc-extractors-test-'))
  initCacheLayer(tmpCacheDir, join(tmpCacheDir, 'rh-cases.json'))
  // Default: makeAuth throws so ExportableDocExtractor falls back to drive.files.export
  makeAuthShouldThrow = true
  mockDocsGetResult = { data: { tabs: [] } }
})

afterEach(() => {
  try { rmSync(tmpCacheDir, { recursive: true, force: true }) } catch {}
})

// ── Helper: build mock Tab structure matching Google Docs API v1 ─────────────
function buildTab(title: string, text: string, childTabs?: any[]) {
  const paragraphs = text.split('\n').filter(l => l.length > 0).map(line => ({
    paragraph: {
      elements: [{ textRun: { content: line + '\n' } }],
    },
  }))
  return {
    tabProperties: { title },
    documentTab: { body: { content: paragraphs } },
    childTabs: childTabs ?? [],
  }
}

// ── ExportableDocExtractor.matches() ────────────────────────────────────────
describe('ExportableDocExtractor.matches()', () => {
  const ex = new ExportableDocExtractor()

  it('returns true for Google Doc', () => {
    expect(ex.matches({ mimeType: GOOGLE_DOC })).toBe(true)
  })

  it('returns true for Google Presentation', () => {
    expect(ex.matches({ mimeType: GOOGLE_PRES })).toBe(true)
  })

  it('returns true for Google Spreadsheet', () => {
    expect(ex.matches({ mimeType: GOOGLE_SHEET })).toBe(true)
  })

  it('returns false for PDF', () => {
    expect(ex.matches({ mimeType: PDF })).toBe(false)
  })

  it('returns false for arbitrary MIME', () => {
    expect(ex.matches({ mimeType: 'image/png' })).toBe(false)
  })
})

// ── PdfDocExtractor.matches() ───────────────────────────────────────────────
describe('PdfDocExtractor.matches()', () => {
  const ex = new PdfDocExtractor()

  it('returns true for application/pdf', () => {
    expect(ex.matches({ mimeType: PDF })).toBe(true)
  })

  it('returns false for Google Doc', () => {
    expect(ex.matches({ mimeType: GOOGLE_DOC })).toBe(false)
  })

  it('returns false for plain text', () => {
    expect(ex.matches({ mimeType: 'text/plain' })).toBe(false)
  })
})

// ── ExportableDocExtractor.extract() — fallback path (drive.files.export) ───
describe('ExportableDocExtractor.extract() — fallback path', () => {
  const ex = new ExportableDocExtractor()

  function mockDrive(exportData: string): drive_v3.Drive {
    return {
      files: {
        export: async () => ({ data: exportData }),
      },
    } as unknown as drive_v3.Drive
  }

  it('returns extracted text under the cap', async () => {
    const drive = mockDrive('hello world this is a doc with more than fifty characters of content here')
    const out = await ex.extract(
      { id: 'f1', name: 'doc.gdoc', mimeType: GOOGLE_DOC },
      drive,
    )
    expect(out).toBe('hello world this is a doc with more than fifty characters of content here')
  })

  it('truncates output to DOC_CONTENT_CAP', async () => {
    const big = 'x'.repeat(DOC_CONTENT_CAP + 5_000)
    const drive = mockDrive(big)
    const out = await ex.extract(
      { id: 'f2', name: 'big.gdoc', mimeType: GOOGLE_DOC },
      drive,
    )
    expect(out).not.toBeNull()
    expect(out!.length).toBe(DOC_CONTENT_CAP)
  })

  it('returns null for content under 50 chars', async () => {
    const drive = mockDrive('short')
    const out = await ex.extract(
      { id: 'f3', name: 'short.gdoc', mimeType: GOOGLE_DOC },
      drive,
    )
    expect(out).toBeNull()
  })

  it('returns null when drive.files.export throws', async () => {
    const drive = {
      files: {
        export: async () => { throw new Error('permission denied') },
      },
    } as unknown as drive_v3.Drive
    const out = await ex.extract(
      { id: 'f4', name: 'forbidden.gdoc', mimeType: GOOGLE_DOC },
      drive,
    )
    expect(out).toBeNull()
  })

  it('collapses whitespace in output', async () => {
    const drive = mockDrive('hello   \n\n  world\t\twith\nplenty   of    whitespace and over fifty chars total')
    const out = await ex.extract(
      { id: 'f5', name: 'ws.gdoc', mimeType: GOOGLE_DOC },
      drive,
    )
    expect(out).not.toBeNull()
    expect(out!.includes('  ')).toBe(false)
    expect(out!.includes('\n')).toBe(false)
  })

  it('uses drive.files.export for Slides', async () => {
    // Slides always use drive.files.export, never Docs API
    makeAuthShouldThrow = false
    const exportFn = mock(async () => ({
      data: 'Slide content about platform capabilities and enterprise customer onboarding process.',
    }))
    const drive = { files: { export: exportFn } } as unknown as drive_v3.Drive

    const out = await ex.extract(
      { id: 'slide1', name: 'deck.gslides', mimeType: GOOGLE_PRES },
      drive,
    )
    expect(out).not.toBeNull()
    expect(out).toContain('platform capabilities')
    expect(exportFn).toHaveBeenCalled()
  })
})

// ── extractDocTextWithTabs — multi-tab extraction (#986) ────────────────────
describe('extractDocTextWithTabs', () => {
  beforeEach(() => {
    makeAuthShouldThrow = false
  })

  it('single-tab doc returns plain text without tab header', async () => {
    const tabContent = 'This is a meeting transcript with important details about the project timeline and budget allocation.'
    mockDocsGetResult = { data: { tabs: [buildTab('Tab 1', tabContent)] } }

    const result = await extractDocTextWithTabs('doc-single', {} as any)

    expect(result).not.toBeNull()
    expect(result).not.toContain('## Tab:')
    expect(result).toContain('meeting transcript')
  })

  it('multi-tab doc prepends "## Tab: {title}" per tab', async () => {
    mockDocsGetResult = {
      data: {
        tabs: [
          buildTab('Meeting Notes', 'Notes from the meeting about Q3 planning and resource allocation review.'),
          buildTab('Transcript', 'Speaker 1: Let us discuss the roadmap for next quarter and our integration plans.'),
        ],
      },
    }

    const result = await extractDocTextWithTabs('doc-multi', {} as any)

    expect(result).not.toBeNull()
    expect(result).toContain('## Tab: Meeting Notes')
    expect(result).toContain('## Tab: Transcript')
    expect(result).toContain('Q3 planning')
    expect(result).toContain('integration plans')
  })

  it('DOC_CONTENT_CAP enforced across all tabs', async () => {
    const longText = 'A'.repeat(DOC_CONTENT_CAP + 2000)
    mockDocsGetResult = {
      data: {
        tabs: [
          buildTab('Tab 1', longText),
          buildTab('Tab 2', 'This content should be truncated or omitted because cap reached.'),
        ],
      },
    }

    const result = await extractDocTextWithTabs('doc-cap', {} as any)

    expect(result).not.toBeNull()
    // Strip tab headers to measure actual content length
    const textOnly = result!.replace(/## Tab: [^\n]+\n/g, '')
    expect(textOnly.length).toBeLessThanOrEqual(DOC_CONTENT_CAP + 10) // small margin for join whitespace
  })

  it('returns null when no tabs', async () => {
    mockDocsGetResult = { data: { tabs: [] } }

    const result = await extractDocTextWithTabs('doc-empty', {} as any)
    expect(result).toBeNull()
  })

  it('returns null when tab content < 50 chars', async () => {
    mockDocsGetResult = { data: { tabs: [buildTab('Short', 'Hi')] } }

    const result = await extractDocTextWithTabs('doc-short', {} as any)
    expect(result).toBeNull()
  })

  it('handles child tabs recursively', async () => {
    const childTab = buildTab('Child Tab', 'Content from nested child tab with additional context and information for the review.')
    const parentTab = buildTab('Parent Tab', 'Content from parent tab describing the main topic of discussion and planning.', [childTab])
    mockDocsGetResult = { data: { tabs: [parentTab] } }

    const result = await extractDocTextWithTabs('doc-nested', {} as any)

    expect(result).not.toBeNull()
    expect(result).toContain('## Tab: Parent Tab')
    expect(result).toContain('## Tab: Child Tab')
    expect(result).toContain('nested child tab')
  })

  it('skips empty tabs in multi-tab docs', async () => {
    mockDocsGetResult = {
      data: {
        tabs: [
          buildTab('Full Tab', 'This tab has real meaningful content about the project status and upcoming milestones review.'),
          buildTab('Empty Tab', ''),
          buildTab('Another Tab', 'More real content about technical architecture decisions and implementation strategy details.'),
        ],
      },
    }

    const result = await extractDocTextWithTabs('doc-mixed', {} as any)

    expect(result).not.toBeNull()
    expect(result).toContain('## Tab: Full Tab')
    expect(result).toContain('## Tab: Another Tab')
    expect(result).not.toContain('## Tab: Empty Tab')
  })
})

// ── ExportableDocExtractor.extract() — Docs API path (#986) ─────────────────
describe('ExportableDocExtractor.extract() — Docs API path', () => {
  const ex = new ExportableDocExtractor()

  beforeEach(() => {
    makeAuthShouldThrow = false
  })

  it('uses Docs API for Google Docs and returns multi-tab content', async () => {
    mockDocsGetResult = {
      data: {
        tabs: [
          buildTab('Notes', 'Meeting notes from the quarterly business review covering strategic initiatives.'),
          buildTab('Transcript', 'Speaker 1: We need to accelerate the migration timeline for cloud infrastructure.'),
        ],
      },
    }
    const mockDrive = { files: { export: async () => ({ data: '' }) } } as unknown as drive_v3.Drive

    const result = await ex.extract(
      { id: 'doc-api', name: 'Meeting Notes', mimeType: GOOGLE_DOC, modifiedTime: '2026-07-14T00:00:00Z' },
      mockDrive,
    )

    expect(result).not.toBeNull()
    expect(result).toContain('## Tab: Notes')
    expect(result).toContain('## Tab: Transcript')
  })

  it('falls back to drive.files.export when Docs API fails', async () => {
    // Force Docs API failure
    makeAuthShouldThrow = true

    const mockDrive = {
      files: {
        export: async () => ({
          data: 'Fallback content from drive export API containing the full document text for analysis.',
        }),
      },
    } as unknown as drive_v3.Drive

    const result = await ex.extract(
      { id: 'doc-fallback', name: 'Fallback Doc', mimeType: GOOGLE_DOC, modifiedTime: '2026-07-14T00:00:00Z' },
      mockDrive,
    )

    expect(result).not.toBeNull()
    expect(result).toContain('Fallback content')
  })
})

// ── DEFAULT_EXTRACTORS registry ─────────────────────────────────────────────
describe('DEFAULT_EXTRACTORS registry', () => {
  it('contains both extractors', () => {
    expect(DEFAULT_EXTRACTORS.length).toBe(2)
    expect(DEFAULT_EXTRACTORS[0]).toBeInstanceOf(ExportableDocExtractor)
    expect(DEFAULT_EXTRACTORS[1]).toBeInstanceOf(PdfDocExtractor)
  })

  it('dispatches Google Doc to ExportableDocExtractor', () => {
    const e = DEFAULT_EXTRACTORS.find(ex => ex.matches({ mimeType: GOOGLE_DOC }))
    expect(e).toBeInstanceOf(ExportableDocExtractor)
  })

  it('dispatches PDF to PdfDocExtractor', () => {
    const e = DEFAULT_EXTRACTORS.find(ex => ex.matches({ mimeType: PDF }))
    expect(e).toBeInstanceOf(PdfDocExtractor)
  })

  it('finds no extractor for unsupported MIME', () => {
    const e = DEFAULT_EXTRACTORS.find(ex => ex.matches({ mimeType: 'image/jpeg' }))
    expect(e).toBeUndefined()
  })
})

// ── Constants sanity ────────────────────────────────────────────────────────
describe('Exported constants', () => {
  it('EXPORTABLE_MIME_TYPES contains the three Google Workspace types', () => {
    expect(EXPORTABLE_MIME_TYPES.has(GOOGLE_DOC)).toBe(true)
    expect(EXPORTABLE_MIME_TYPES.has(GOOGLE_PRES)).toBe(true)
    expect(EXPORTABLE_MIME_TYPES.has(GOOGLE_SHEET)).toBe(true)
  })

  it('DOC_CONTENT_CAP is 8000', () => {
    expect(DOC_CONTENT_CAP).toBe(8_000)
  })
})
