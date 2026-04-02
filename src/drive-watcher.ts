import { google } from 'googleapis'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { aes } from './server-state.ts'
import type { Customer } from './types.ts'

const STATE_PATH = process.env.CONFIG_DIR
  ? resolve(process.env.CONFIG_DIR, 'drive-watcher-state.json')
  : resolve(import.meta.dir, '../config/drive-watcher-state.json')

export interface FolderEntry {
  folderId: string
  customerName: string
  folderName: string
}

interface WatcherState {
  pageToken: string
  folderMap: FolderEntry[]
  builtAt: string
  lastChecked?: string
}

function loadState(): WatcherState | null {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) }
  catch { return null }
}

function saveState(state: WatcherState): void {
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 }) }
  catch (e: any) { console.warn('[drive-watcher] failed to save state:', e.message) }
}

// Normalize name for fuzzy matching — strip legal suffixes, punctuation, lowercase
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s+(inc|llc|ltd|corp|corporation|incorporated|limited|co|group|holdings|international|technologies|logistics|solutions|services|foods|systems|global|networks|software|health sciences|cancer center|cancer research)\.?\s*$/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

function matchScore(folderName: string, customerName: string): number {
  const fn = normalize(folderName)
  const cn = normalize(customerName)
  if (fn === cn) return 1
  if (fn.includes(cn) || cn.includes(fn)) return 0.9
  const fWords = new Set(fn.split(/\s+/).filter(w => w.length > 2))
  const cWords = cn.split(/\s+/).filter(w => w.length > 2)
  if (fWords.size === 0 || cWords.length === 0) return 0
  const overlap = cWords.filter(w => fWords.has(w)).length
  return overlap / Math.max(fWords.size, cWords.length)
}

// Scan AE parent folders for customer subfolders and build the mapping
// List direct child folders of a given folder ID
async function listSubfolders(drive: ReturnType<typeof google.drive>, parentId: string): Promise<{ id: string; name: string }[]> {
  const results: { id: string; name: string }[] = []
  let pageToken: string | undefined
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken,files(id,name)',
      pageSize: 100,
      pageToken,
    })
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) results.push({ id: f.id, name: f.name })
    }
    pageToken = res.data.nextPageToken ?? undefined
  } while (pageToken)
  return results
}

export async function buildFolderMap(customers: Customer[], parentIds: string[]): Promise<FolderEntry[]> {
  if (!existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return []

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const entries: FolderEntry[] = []
  const mapped = new Set<string>()  // track already-mapped customer names

  function tryMatch(folder: { id: string; name: string }) {
    let bestScore = 0
    let bestCustomer = ''
    for (const cu of customers) {
      if (mapped.has(cu.name)) continue
      const score = matchScore(folder.name, cu.name)
      if (score > bestScore) { bestScore = score; bestCustomer = cu.name }
    }
    if (bestScore >= 0.5) {
      entries.push({ folderId: folder.id, customerName: bestCustomer, folderName: folder.name })
      mapped.add(bestCustomer)
      return true
    }
    return false
  }

  // ── Priority 1: Use per-AE driveFolderIds to find customer subfolders ──────
  const aeFolderIds = aes.map(a => a.driveFolderId).filter(Boolean)
  for (const aeFolderId of aeFolderIds) {
    const subfolders = await listSubfolders(drive, aeFolderId)
    for (const folder of subfolders) tryMatch(folder)
  }

  // ── Priority 2: Fall back to global parent folder scan for unmatched ────────
  if (parentIds.length && mapped.size < customers.length) {
    for (const parentId of parentIds) {
      const level1 = await listSubfolders(drive, parentId)
      for (const folder of level1) {
        const matched = tryMatch(folder)
        if (!matched) {
          const level2 = await listSubfolders(drive, folder.id)
          for (const sub of level2) {
            const matched2 = tryMatch(sub)
            if (!matched2) {
              const level3 = await listSubfolders(drive, sub.id)
              for (const leaf of level3) tryMatch(leaf)
            }
          }
        }
      }
    }
  }

  console.log(`[drive-watcher] folder map built: ${entries.length} folders matched to ${customers.length} customers`)
  return entries
}

// Initialize watcher — gets a start page token baseline, no-ops if already done
export async function initDriveWatcher(customers: Customer[], parentIds: string[]): Promise<void> {
  if (!parentIds.length || !existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return

  const existing = loadState()
  if (existing?.pageToken) {
    console.log(`[drive-watcher] already initialized, ${existing.folderMap.length} folders mapped`)
    return
  }

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const tokenRes = await drive.changes.getStartPageToken({})
    const pageToken = tokenRes.data.startPageToken!

    const folderMap = await buildFolderMap(customers, parentIds)
    saveState({ pageToken, folderMap, builtAt: new Date().toISOString() })
    console.log(`[drive-watcher] initialized with page token, ${folderMap.length} customer folders`)
  } catch (e: any) {
    console.warn('[drive-watcher] init failed (auth not ready?):', e.message)
  }
}

// Check for Drive changes — returns customer names whose folders had new/modified files
export async function checkDriveChanges(): Promise<string[]> {
  const state = loadState()
  if (!state?.pageToken || !existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return []

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const folderIndex = new Map(state.folderMap.map(e => [e.folderId, e.customerName]))
    const affected = new Set<string>()

    let pageToken = state.pageToken
    let newStartPageToken = pageToken

    let hasMore = true
    while (hasMore) {
      const res = await drive.changes.list({
        pageToken,
        spaces: 'drive',
        fields: 'nextPageToken,newStartPageToken,changes(file(id,name,parents,mimeType),removed)',
        pageSize: 100,
      })

      for (const change of res.data.changes ?? []) {
        if (change.removed) continue
        for (const parentId of change.file?.parents ?? []) {
          const customerName = folderIndex.get(parentId)
          if (customerName) affected.add(customerName)
        }
      }

      if (res.data.nextPageToken) {
        pageToken = res.data.nextPageToken
      } else {
        newStartPageToken = res.data.newStartPageToken ?? pageToken
        hasMore = false
      }
    }

    saveState({ ...state, pageToken: newStartPageToken, lastChecked: new Date().toISOString() })

    if (affected.size > 0) {
      console.log(`[drive-watcher] detected changes for: ${[...affected].join(', ')}`)
    }
    return [...affected]
  } catch (e: any) {
    console.warn('[drive-watcher] check failed:', e.message)
    return []
  }
}

// Check if any of the given file IDs have been modified after cachedAt.
// Returns true (force refresh) on Drive error — better to re-fetch than miss an update.
export async function checkFilesModified(fileIds: string[], cachedAt: string): Promise<boolean> {
  if (!fileIds.length || !existsSync(GOOGLE_UNIFIED_TOKEN_PATH)) return true
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    for (const fileId of fileIds) {
      const res = await drive.files.get({ fileId, fields: 'modifiedTime' })
      if (res.data.modifiedTime && res.data.modifiedTime > cachedAt) return true
    }
    return false
  } catch {
    return true  // on error, default to re-fetching
  }
}

// Rebuild folder map in-place, keeping existing page token
export async function rebuildFolderMap(customers: Customer[], parentIds: string[]): Promise<FolderEntry[]> {
  const folderMap = await buildFolderMap(customers, parentIds)
  const existing = loadState()
  if (existing) {
    saveState({ ...existing, folderMap, builtAt: new Date().toISOString() })
  }
  return folderMap
}

export function getWatcherState(): (WatcherState & { enabled: boolean }) | null {
  const state = loadState()
  if (!state) return null
  return { ...state, enabled: true }
}
