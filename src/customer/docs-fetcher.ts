// BKL-ARCH-23: Customer Drive docs fetcher — extracted from src/customer.ts
// Pure code-move. Behaviour, I/O surface, and logging are byte-identical to
// the original _fetchCustomerDocsImpl + fuzzy-matching helpers.

import { google } from 'googleapis'
import { resolve } from 'path'
import { extractText as extractPdfText } from 'unpdf'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import type { Customer, DriveFile } from '../types.ts'
import { driveClient, escapeQ } from '../lib/drive-client.ts'
import { aes } from '../server-state.ts'
import { readDocContentCache, writeDocContentCache } from '../cache-layer.ts'
import { getGeminiModelLite } from '../ai-config.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../../config')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

// MIME types that Drive can export as plain text
const EXPORTABLE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.spreadsheet',
])
const DOC_CONTENT_CAP   = 8_000   // chars per document
const TOTAL_CONTENT_CAP = 80_000  // chars per customer across all docs
const MAX_FILES_PER_CUSTOMER = 50
const DRIVE_SUBFOLDER_DEPTH  = 5

// Normalize name for fuzzy matching — strip legal suffixes, punctuation, lowercase
export function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s+(inc|llc|ltd|corp|corporation|incorporated|limited|co|group|holdings|international|technologies|logistics|solutions|services|foods|systems|global|networks|software|health sciences|cancer center|cancer research)\.?\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

export function folderMatchScore(folderName: string, customerName: string): number {
  const fn = normalizeFolderName(folderName)
  const cn = normalizeFolderName(customerName)
  if (fn === cn) return 1
  if (fn.includes(cn) || cn.includes(fn)) return 0.9
  const fWords = new Set(fn.split(/\s+/).filter(w => w.length > 2))
  const cWords = cn.split(/\s+/).filter(w => w.length > 2)
  if (fWords.size === 0 || cWords.length === 0) return 0
  const overlap = cWords.filter(w => fWords.has(w)).length
  return overlap / Math.max(fWords.size, cWords.length)
}

export function fuzzyFindCustomerFolder(
  folders: { id?: string | null; name?: string | null }[],
  customerName: string,
): { id: string; name: string } | undefined {
  let bestScore = 0
  let bestFolder: { id: string; name: string } | undefined
  for (const f of folders) {
    if (!f.id || !f.name) continue
    const score = folderMatchScore(f.name, customerName)
    if (score > bestScore) { bestScore = score; bestFolder = { id: f.id, name: f.name } }
  }
  return bestScore >= 0.5 ? bestFolder : undefined
}

export async function fetchCustomerDocsImpl(customer: Customer): Promise<DriveFile[]> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  let customerFolderId: string | undefined

  // ── Priority 1: Per-customer driveFolderId (exact, no search needed) ────────
  if (customer.driveFolderId) {
    customerFolderId = customer.driveFolderId
    console.log(`[drive] Using per-customer folder ID for ${customer.name}`)
  }

  // ── Priority 2: AE's driveFolderId → fuzzy-match customer subfolder ─────────
  if (!customerFolderId) {
    const ae = aes.find(a => a.name === customer.ae)
    const aeFolderId = ae?.driveFolderId
    if (aeFolderId) {
      const custFolders = await drive.files.list({
        q: `'${escapeQ(aeFolderId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 200,
      })
      const folderList = custFolders.data.files ?? []
      // Try primary name first, then aliases as fallback
      const namesToTry = [customer.name, ...(customer.aliases ?? [])]
      for (const tryName of namesToTry) {
        const match = fuzzyFindCustomerFolder(folderList, tryName)
        if (match) {
          customerFolderId = match.id
          const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
          console.log(`[drive] Matched folder "${match.name}" for ${customer.name}${aliasNote} (under AE ${customer.ae})`)
          break
        }
      }
      if (!customerFolderId) {
        // One level deeper: AE folder → subfolder (e.g. "Accounts") → customer
        for (const sub of (custFolders.data.files ?? []).slice(0, 10)) {
          if (!sub.id) continue
          const deeper = await drive.files.list({
            q: `'${escapeQ(sub.id)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            fields: 'files(id,name)', pageSize: 100,
          })
          for (const tryName of namesToTry) {
            const deepMatch = fuzzyFindCustomerFolder(deeper.data.files ?? [], tryName)
            if (deepMatch) {
              customerFolderId = deepMatch.id
              const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
              console.log(`[drive] Matched folder "${deepMatch.name}" for ${customer.name}${aliasNote} (under ${sub.name}/${customer.ae})`)
              break
            }
          }
          if (customerFolderId) break
        }
      }
    }
  }

  // ── Priority 3: Global AE_PARENT_FOLDER_ID fallback (legacy) ───────────────
  if (!customerFolderId) {
    const parentId = process.env.AE_PARENT_FOLDER_ID
    if (!parentId) {
      console.warn('[drive] No folder source for', customer.name, '— no per-customer/AE folder ID and AE_PARENT_FOLDER_ID not set')
      return []
    }
    // Scan parent → AE → customer (old path)
    const level1Res = await drive.files.list({
      q: `'${escapeQ(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)', pageSize: 50,
    })
    const legacyNamesToTry = [customer.name, ...(customer.aliases ?? [])]
    for (const aeCandidate of level1Res.data.files ?? []) {
      if (!aeCandidate.id) continue
      const custRes = await drive.files.list({
        q: `'${escapeQ(aeCandidate.id)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id,name)', pageSize: 100,
      })
      for (const tryName of legacyNamesToTry) {
        const match = fuzzyFindCustomerFolder(custRes.data.files ?? [], tryName)
        if (match) {
          customerFolderId = match.id
          const aliasNote = tryName !== customer.name ? ` (via alias "${tryName}")` : ''
          console.log(`[drive] Matched folder "${match.name}" for ${customer.name}${aliasNote} via parent scan`)
          break
        }
      }
      if (customerFolderId) break
    }
  }

  if (!customerFolderId) {
    console.warn('[drive] No customer folder found for', customer.name, 'under AE', customer.ae)
    return []
  }

  // BFS: collect all files from customer folder + subfolders (depth-limited, follows folder shortcuts)
  const twoYearsAgo = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
  const allFiles = await driveClient.listFilesUnder(customerFolderId, {
    maxFiles: MAX_FILES_PER_CUSTOMER,
    modifiedAfter: twoYearsAgo,
    maxDepth: DRIVE_SUBFOLDER_DEPTH,
    followFolderShortcuts: true,
  })

  const EXPORT_CONCURRENCY = 5

  async function exportFileContent(f: { id: string; name: string; mimeType: string; modifiedTime?: string }): Promise<string | null> {
    if (EXPORTABLE_MIME_TYPES.has(f.mimeType) && f.id) {
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
    return null
  }

  const exportableFiles = allFiles.filter(f => EXPORTABLE_MIME_TYPES.has(f.mimeType) && f.id)
  const exportResultMap = new Map<string, string>()

  for (let i = 0; i < exportableFiles.length; i += EXPORT_CONCURRENCY) {
    const batch = exportableFiles.slice(i, i + EXPORT_CONCURRENCY)
    const settled = await Promise.allSettled(batch.map(f => exportFileContent(f)))
    for (let j = 0; j < batch.length; j++) {
      const r = settled[j]
      if (r.status === 'fulfilled' && r.value) {
        exportResultMap.set(batch[j].id, r.value)
      }
    }
  }

  let totalChars = 0
  const results: DriveFile[] = []

  for (const f of allFiles) {
    const file: DriveFile = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      customer: customer.name,
    }

    const preExported = exportResultMap.get(f.id)
    if (preExported && totalChars < TOTAL_CONTENT_CAP) {
      file.content = preExported
      totalChars += preExported.length
    }
    else if (f.mimeType === 'application/pdf' && totalChars < TOTAL_CONTENT_CAP && f.id) {
      if (f.modifiedTime) {
        const cachedPdf = readDocContentCache(f.id, f.modifiedTime)
        if (cachedPdf !== null) {
          file.content = cachedPdf
          totalChars += cachedPdf.length
          results.push(file)
          continue
        }
      }
      try {
        const pdfRes = await drive.files.get(
          { fileId: f.id, alt: 'media' },
          { responseType: 'arraybuffer' },
        )
        const pdfBytes = Buffer.from(pdfRes.data as ArrayBuffer)
        if (pdfBytes.length > 15_000_000) {
          console.warn(`[docs] PDF too large to extract (${Math.round(pdfBytes.length / 1e6)}MB): ${f.name}`)
          results.push(file)
          continue
        }

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
          file.content = capped
          totalChars += capped.length
          if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
        } else {
          console.log(`[docs] PDF ${f.name}: local extraction (${localText.length} chars), using multimodal fallback`)
          const b64 = pdfBytes.toString('base64')

          const project  = process.env.GOOGLE_CLOUD_PROJECT
          const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
          const model    = getGeminiModelLite()

          if (project && b64.length > 0) {
            let token: string | null | undefined
            const saKeyB64 = process.env.GEMINI_SERVICE_ACCOUNT_KEY
            if (saKeyB64) {
              const keyData = JSON.parse(Buffer.from(saKeyB64, 'base64').toString())
              const jwtAuth = new google.auth.JWT({
                email: keyData.client_email,
                key:   keyData.private_key,
                scopes: ['https://www.googleapis.com/auth/cloud-platform'],
              })
              token = (await jwtAuth.getAccessToken()).token
            } else {
              const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
              token = (await auth.getAccessToken()).token
            }

            if (token) {
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
              if (geminiRes.ok) {
                const json = await geminiRes.json() as any
                const extracted = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
                const capped = extracted.replace(/\s+/g, ' ').trim().slice(0, DOC_CONTENT_CAP)
                if (capped.length > 50) {
                  file.content = capped
                  totalChars += capped.length
                  if (f.modifiedTime) writeDocContentCache(f.id, f.modifiedTime, capped)
                }
              }
            }
          }
        }
      } catch (e: any) {
        const safeName = String(f.name ?? '').replace(/[\r\n]/g, ' ').slice(0, 200)
        console.warn(`[docs] PDF extraction failed for ${safeName}: ${e?.message?.slice?.(0, 100) ?? 'unknown'}`)
      }
    }

    results.push(file)
  }

  return results
}
