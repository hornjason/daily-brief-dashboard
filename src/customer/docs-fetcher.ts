// BKL-ARCH-23: Customer Drive docs fetcher — extracted from src/customer.ts
// Pure code-move. Behaviour, I/O surface, and logging are byte-identical to
// the original _fetchCustomerDocsImpl + fuzzy-matching helpers.

import { google } from 'googleapis'
import { resolve } from 'path'
import { makeAuth } from '../google.ts'
import type { Customer, DriveFile } from '../types.ts'
import { driveClient, escapeQ } from '../lib/drive-client.ts'
import { aes } from '../server-state.ts'
import { DEFAULT_EXTRACTORS, type DocExtractor } from './doc-extractors.ts'

const CONFIG_DIR_PATH   = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../../config')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

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

  // Dispatch content extraction through the DocExtractor registry.
  // Folder resolution (Priorities 1/2/3) and BFS file listing above are unchanged.
  let totalChars = 0
  const results: DriveFile[] = []
  const extractors: DocExtractor[] = DEFAULT_EXTRACTORS

  for (const f of allFiles) {
    const file: DriveFile = {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      customer: customer.name,
    }

    if (totalChars < TOTAL_CONTENT_CAP && f.id) {
      const extractor = extractors.find(e => e.matches(f))
      if (extractor) {
        const content = await extractor.extract(f, drive)
        if (content) {
          file.content = content
          totalChars += content.length
        }
      }
    }

    results.push(file)
  }

  return results
}
