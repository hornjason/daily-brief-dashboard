// Issue #56: DocExtractor interface + implementations.
// Validates matches() dispatch and extract() truncation behavior.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  ExportableDocExtractor,
  PdfDocExtractor,
  DEFAULT_EXTRACTORS,
  DOC_CONTENT_CAP,
  EXPORTABLE_MIME_TYPES,
} from '../../src/customer/doc-extractors.ts'
import type { drive_v3 } from 'googleapis'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initCacheLayer } from '../../src/cache-layer.ts'

const GOOGLE_DOC = 'application/vnd.google-apps.document'
const GOOGLE_PRES = 'application/vnd.google-apps.presentation'
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet'
const PDF = 'application/pdf'

let tmpCacheDir: string

beforeEach(() => {
  tmpCacheDir = mkdtempSync(join(tmpdir(), 'doc-extractors-test-'))
  initCacheLayer(tmpCacheDir, join(tmpCacheDir, 'rh-cases.json'))
})

afterEach(() => {
  try { rmSync(tmpCacheDir, { recursive: true, force: true }) } catch {}
})

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

// ── ExportableDocExtractor.extract() ────────────────────────────────────────
describe('ExportableDocExtractor.extract()', () => {
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
