// BKL-ARCH-XX (issue #56): DocExtractor interface + implementations.
// Replaces the per-MIME-type dispatch logic that lived inside
// fetchCustomerDocsImpl. Folder resolution stays in docs-fetcher.ts;
// only the file-content extraction is dispatched through this module.

import { google, type drive_v3 } from 'googleapis'
import { extractText as extractPdfText } from 'unpdf'
import { Buffer } from 'buffer'
import { readDocContentCache, writeDocContentCache } from '../cache-layer.ts'
import { callGemini } from '../gemini-call.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'

// ── Constants (moved from docs-fetcher.ts) ──────────────────────────────────
export const EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
])
export const DOC_CONTENT_CAP = 8_000 // chars per document
const PDF_MAX_BYTES = 15_000_000     // 15MB hard guard for PDFs

// ── Interface ───────────────────────────────────────────────────────────────
export interface ExtractableFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
}

export interface DocExtractor {
  /** Returns true if this extractor handles this MIME type. */
  matches(file: { mimeType: string }): boolean
  /** Extracts text content. Returns null if nothing useful extracted. */
  extract(
    file: ExtractableFile,
    drive: drive_v3.Drive,
  ): Promise<string | null>
}

// ── Shared helper: extract text from ALL tabs of a Google Doc ──────────────
/**
 * Uses Google Docs API v1 with includeTabsContent to read ALL tabs.
 * Multi-tab docs get "## Tab: {title}" headers; single-tab docs return plain text.
 * Respects DOC_CONTENT_CAP across all tabs combined.
 */
export async function extractDocTextWithTabs(
  docId: string,
  auth: ReturnType<typeof makeAuth>,
): Promise<string | null> {
  const docs = google.docs({ version: 'v1', auth })
  const doc = await docs.documents.get({
    documentId: docId,
    includeTabsContent: true,
  })

  const tabs = doc.data.tabs ?? []
  if (tabs.length === 0) return null

  /** Recursively collect all tabs (including childTabs) */
  function flattenTabs(tabList: typeof tabs): typeof tabs {
    const result: typeof tabs = []
    for (const tab of tabList) {
      result.push(tab)
      if (tab.childTabs?.length) {
        result.push(...flattenTabs(tab.childTabs))
      }
    }
    return result
  }

  const allTabs = flattenTabs(tabs)
  const isMultiTab = allTabs.length > 1

  const parts: string[] = []
  let totalLen = 0

  for (const tab of allTabs) {
    if (totalLen >= DOC_CONTENT_CAP) break
    const bodyContent = tab.documentTab?.body?.content ?? []
    const lines: string[] = []
    for (const element of bodyContent) {
      if (element.paragraph?.elements) {
        const lineText = element.paragraph.elements
          .map((el: any) => el.textRun?.content ?? '')
          .join('')
        if (lineText.trim()) lines.push(lineText)
      }
    }
    const tabText = lines.join('').replace(/\s+/g, ' ').trim()
    if (!tabText) continue

    const remaining = DOC_CONTENT_CAP - totalLen
    const capped = tabText.slice(0, remaining)

    if (isMultiTab) {
      const title = tab.tabProperties?.title ?? 'Untitled'
      parts.push(`## Tab: ${title}\n${capped}`)
    } else {
      parts.push(capped)
    }
    totalLen += capped.length
  }

  const result = parts.join('\n\n').trim()
  return result.length > 50 ? result : null
}

// ── ExportableDocExtractor: GoogleDoc / Slides / Sheets via files.export ────
export class ExportableDocExtractor implements DocExtractor {
  matches(file: { mimeType: string }): boolean {
    return EXPORTABLE_MIME_TYPES.has(file.mimeType)
  }

  async extract(f: ExtractableFile, drive: drive_v3.Drive): Promise<string | null> {
    if (!f.id) return null
    if (f.modifiedTime) {
      const cached = readDocContentCache(f.id, f.modifiedTime)
      if (cached !== null) return cached
    }

    // Google Docs: use Docs API v1 with includeTabsContent for multi-tab support
    if (f.mimeType === 'application/vnd.google-apps.document') {
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const content = await extractDocTextWithTabs(f.id, auth)
        if (content !== null && f.modifiedTime) {
          writeDocContentCache(f.id, f.modifiedTime, content)
        }
        return content
      } catch {
        // Fallback to drive.files.export if Docs API fails
      }
    }

    // Slides / Sheets (and Google Docs fallback): use drive.files.export
    try {
      const exportRes = await drive.files.export(
        { fileId: f.id, mimeType: 'text/plain' },
        { responseType: 'text' },
      )
      const raw = String(exportRes.data ?? '').replace(/\s+/g, ' ').trim()
      const capped = raw.slice(0, DOC_CONTENT_CAP)
      const content = capped.length > 50 ? capped : null
      if (content !== null && f.modifiedTime) {
        writeDocContentCache(f.id, f.modifiedTime, content)
      }
      return content
    } catch {
      return null
    }
  }
}

// ── PdfDocExtractor: local unpdf, falling back to Gemini multimodal ─────────
export class PdfDocExtractor implements DocExtractor {
  matches(file: { mimeType: string }): boolean {
    return file.mimeType === 'application/pdf'
  }

  async extract(f: ExtractableFile, drive: drive_v3.Drive): Promise<string | null> {
    if (!f.id) return null
    if (f.modifiedTime) {
      const cachedPdf = readDocContentCache(f.id, f.modifiedTime)
      if (cachedPdf !== null) return cachedPdf
    }

    try {
      const pdfRes = await drive.files.get(
        { fileId: f.id, alt: 'media' },
        { responseType: 'arraybuffer' },
      )
      const pdfBytes = Buffer.from(pdfRes.data as ArrayBuffer)
      if (pdfBytes.length > PDF_MAX_BYTES) {
        console.warn(`[docs] PDF too large to extract (${Math.round(pdfBytes.length / 1e6)}MB): ${f.name}`)
        return null
      }

      // Try local extraction first
      let localText = ''
      try {
        const u8 = new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength)
        const { text } = await extractPdfText(u8, { mergePages: true })
        localText = (text as string).replace(/\s+/g, ' ').trim()
      } catch {
        // Local extraction unsupported for this PDF — fall through to multimodal
      }

      if (localText.length >= 50) {
        console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using text path`)
        const capped = localText.slice(0, DOC_CONTENT_CAP)
        if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
        return capped
      }

      // Fallback: Gemini multimodal via callGemini() gateway
      console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using multimodal fallback`)
      const b64 = pdfBytes.toString('base64')
      if (b64.length === 0) return null

      const geminiResult = await callGemini(
        '', // no system prompt needed for extraction
        'Extract the text content from this PDF document. Return only the extracted text, no commentary or formatting.',
        {
          callType: 'doc-pdf-extraction',
          temperature: 0,
          inlineDataParts: [{ mimeType: 'application/pdf', data: b64 }],
        }
      )

      const extracted = geminiResult.text
      const capped = extracted.replace(/\s+/g, ' ').trim().slice(0, DOC_CONTENT_CAP)
      if (capped.length > 50) {
        if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
        return capped
      }
      return null
    } catch (e: any) {
      const safeName = String(f.name ?? '').replace(/[\r\n]/g, ' ').slice(0, 200)
      console.warn(`[docs] PDF extraction failed for ${safeName}: ${e?.message?.slice?.(0, 100) ?? 'unknown'}`)
      return null
    }
  }
}

// ── Default registry ────────────────────────────────────────────────────────
export const DEFAULT_EXTRACTORS: DocExtractor[] = [
  new ExportableDocExtractor(),
  new PdfDocExtractor(),
]
