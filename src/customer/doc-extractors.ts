// BKL-ARCH-XX (issue #56): DocExtractor interface + implementations.
// Replaces the per-MIME-type dispatch logic that lived inside
// fetchCustomerDocsImpl. Folder resolution stays in docs-fetcher.ts;
// only the file-content extraction is dispatched through this module.

import { google, type drive_v3 } from 'googleapis'
import { extractText as extractPdfText } from 'unpdf'
import { Buffer } from 'buffer'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { readDocContentCache, writeDocContentCache } from '../cache-layer.ts'
import { getGeminiModelLite } from '../ai-config.ts'

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

      // Fallback: Gemini multimodal via Vertex
      console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using multimodal fallback`)
      const b64 = pdfBytes.toString('base64')

      const project  = process.env.GOOGLE_CLOUD_PROJECT
      const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
      const model    = getGeminiModelLite()

      if (!project || b64.length === 0) return null

      let token: string | null | undefined
      const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
      if (saKeyB64) {
        let keyData: Record<string, unknown>
        try {
          keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
        } catch {
          console.warn('[docs] SA key parse failed — check GEMINI_SERVICE_ACCOUNT_KEY format')
          // fall through: keyData undefined, Vertex path will skip
          keyData = {}
        }
        if (keyData.client_email && keyData.private_key) {
          const jwtAuth = new google.auth.JWT({
            email: keyData.client_email as string,
            key:   keyData.private_key as string,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          })
          token = (await jwtAuth.getAccessToken()).token
        }
      } else {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        token = (await auth.getAccessToken()).token
      }

      if (!token) return null

      const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`
      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: b64 } },
              { text: 'Extract the text content from this PDF document. Return only the extracted text, no commentary or formatting.' },
            ],
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
        }),
      })
      if (!geminiRes.ok) return null

      const json = await geminiRes.json() as any
      const extracted = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
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
