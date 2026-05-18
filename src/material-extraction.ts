/**
 * Material Extraction API — GitHub Issue #164
 *
 * Shared material extraction logic with URL hash-based caching.
 * Extracts content from Google Docs/Slides and decomposes via Gemini.
 *
 * Extracted from campaigns-routes.ts to enable reuse across campaign generation
 * and standalone material extraction endpoints.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { google } from 'googleapis'
import { callGemini } from './gemini-call.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../cache')
const MATERIAL_CACHE_DIR = resolve(CACHE_DIR, 'material-extractions')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MaterialExtraction {
  materialTitle: string
  personas: Array<{ role: string; relevantVPs: string[]; enabled: boolean }>
  valueProps: Array<{ id: string; claim: string; detail: string }>
  useCases: Array<{ name: string; description: string }>
  style: string  // e.g., "executive", "technical"
  extractedAt: string
  materialUrl: string
}

// ── Google Drive extraction ──────────────────────────────────────────────────

/**
 * Extract Google Doc/Slides file ID from URL.
 * Accepts: https://docs.google.com/presentation/d/{fileId}/...
 *          https://docs.google.com/document/d/{fileId}/...
 */
function extractFileId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

/**
 * Export material as plain text via Google Drive API.
 * Returns { title, content }
 */
async function extractMaterialContent(fileId: string): Promise<{ title: string; content: string }> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Get file metadata (title + mimeType)
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  })

  const title = meta.data.name ?? 'Untitled'

  // Export as plain text
  const exportRes = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' },
  )

  const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)

  return { title, content }
}

// ── Gemini decomposition ─────────────────────────────────────────────────────

const DECOMPOSITION_PROMPT = `You are analyzing a Red Hat product material (slide deck, white paper, or product brief) to extract structured data for campaign generation.

Your job:
1. Extract the material title
2. Identify target personas (roles/titles)
3. Extract value propositions (claims + supporting detail)
4. Identify use cases
5. Determine recommended communication style (executive, technical, business-focused)

Rules:
- Be specific: extract exact claims and details from the material
- Personas should be B2B roles (e.g., "VP Infrastructure", "Platform Engineering Lead")
- Each value prop needs an ID (lowercase-hyphenated), a claim (1 sentence), and detail (2-3 sentences)
- Use cases should be specific scenarios, not just product features
- Style should be one of: "executive", "technical", "business-focused"

Output format (JSON):
{
  "materialTitle": "...",
  "personas": [
    { "role": "VP Infrastructure", "relevantVPs": ["reduce-costs", "improve-reliability"], "enabled": true },
    { "role": "Platform Engineering Lead", "relevantVPs": ["automation", "scale"], "enabled": true }
  ],
  "valueProps": [
    { "id": "reduce-costs", "claim": "...", "detail": "..." },
    { "id": "improve-reliability", "claim": "...", "detail": "..." }
  ],
  "useCases": [
    { "name": "Cloud Migration", "description": "..." },
    { "name": "Container Orchestration", "description": "..." }
  ],
  "style": "executive"
}

IMPORTANT: Output ONLY valid JSON — no markdown fences, no commentary.`

async function callGeminiForDecomposition(opts: {
  materialTitle: string
  materialContent: string
}): Promise<MaterialExtraction> {
  const userPrompt = `## Material: ${opts.materialTitle}

### Content (first 16000 chars):
${opts.materialContent.substring(0, 16000)}

---
Now extract structured data from this material in JSON format.`

  const result = await callGemini(DECOMPOSITION_PROMPT, userPrompt, {
    callType: 'material-decomposition',
    customerName: 'n/a',
    model: 'full',
    temperature: 0.3,
    // No deltaKey — material content may change, and we want fresh extraction each time
  })

  if (!result.text) throw new Error('Gemini returned empty response')

  // Parse JSON output
  let parsed: any
  try {
    // Strip markdown fences if present
    const cleaned = result.text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch (e: any) {
    console.error('[material-extraction] Gemini response was not valid JSON:', result.text.substring(0, 500))
    throw new Error(`Gemini returned invalid JSON: ${e.message}`)
  }

  // Validate structure
  if (!parsed.materialTitle || !Array.isArray(parsed.personas) || !Array.isArray(parsed.valueProps)) {
    throw new Error('Gemini response missing required fields (materialTitle, personas, valueProps)')
  }

  return {
    materialTitle: parsed.materialTitle,
    personas: parsed.personas,
    valueProps: parsed.valueProps,
    useCases: parsed.useCases ?? [],
    style: parsed.style ?? 'business-focused',
    extractedAt: new Date().toISOString(),
    materialUrl: '',  // Will be set by caller
  }
}

// ── Cache layer ──────────────────────────────────────────────────────────────

function getMaterialCachePath(materialUrl: string): string {
  const urlHash = createHash('md5').update(materialUrl).digest('hex')
  mkdirSync(MATERIAL_CACHE_DIR, { recursive: true })
  return resolve(MATERIAL_CACHE_DIR, `${urlHash}.json`)
}

function readMaterialCache(materialUrl: string): MaterialExtraction | null {
  const cachePath = getMaterialCachePath(materialUrl)
  try {
    if (!existsSync(cachePath)) return null
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8'))
    console.log(`[material-extraction] Cache HIT for ${materialUrl}`)
    return cached
  } catch (e: any) {
    console.warn(`[material-extraction] Failed to read cache for ${materialUrl}:`, e.message)
    return null
  }
}

function writeMaterialCache(extraction: MaterialExtraction): void {
  const cachePath = getMaterialCachePath(extraction.materialUrl)
  writeFileSync(cachePath, JSON.stringify(extraction, null, 2), { mode: 0o600 })
  console.log(`[material-extraction] Cache WRITE for ${extraction.materialUrl}`)
}

export function deleteMaterialCache(materialUrl: string): boolean {
  const cachePath = getMaterialCachePath(materialUrl)
  try {
    if (existsSync(cachePath)) {
      const { unlinkSync } = require('fs')
      unlinkSync(cachePath)
      console.log(`[material-extraction] Cache DELETED for ${materialUrl}`)
      return true
    }
    return false
  } catch (e: any) {
    console.warn(`[material-extraction] Failed to delete cache for ${materialUrl}:`, e.message)
    return false
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract material from Google Doc/Slides and decompose via Gemini.
 * Results are cached by URL hash.
 *
 * @param materialUrl - Google Docs or Slides URL
 * @param forceRefresh - If true, bypass cache and re-extract
 * @returns MaterialExtraction with decomposed structure
 */
export async function extractMaterial(
  materialUrl: string,
  forceRefresh = false,
): Promise<MaterialExtraction> {
  console.log(`[material-extraction] Extracting ${materialUrl} (forceRefresh=${forceRefresh})`)

  // 1. Check cache (unless forceRefresh)
  if (!forceRefresh) {
    const cached = readMaterialCache(materialUrl)
    if (cached) return cached
  }

  // 2. Validate and extract file ID
  const fileId = extractFileId(materialUrl)
  if (!fileId) {
    throw new Error('Invalid materialUrl — expected a Google Docs or Slides link')
  }

  // 3. Extract content from Google Drive
  const { title, content } = await extractMaterialContent(fileId)
  console.log(`[material-extraction] Extracted "${title}" (${content.length} chars)`)

  // 4. Decompose via Gemini
  const extraction = await callGeminiForDecomposition({
    materialTitle: title,
    materialContent: content,
  })

  // 5. Set materialUrl and cache
  extraction.materialUrl = materialUrl
  writeMaterialCache(extraction)

  return extraction
}
