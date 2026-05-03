/**
 * Drive client singleton — wraps all Google Drive folder traversal,
 * file listing, and folder creation behind a deep module interface.
 *
 * Per ADR-0016, every drive.files.list and drive.files.create call inside
 * this module includes supportsAllDrives: true and includeItemsFromAllDrives: true
 * unconditionally — required for Shared Drive (L3 shared folder) traversal,
 * harmless on personal Drive folders.
 *
 * Pagination is handled internally — callers never see nextPageToken.
 * Quota-429 responses go through the existing withQuotaRetry helper from
 * google.ts so a 429 logs `[drive-client] quota 429 — waiting 61s` and retries
 * once after 61 seconds.
 *
 * Error contract:
 *   - Returns null / [] for not-found cases (no descendant matched, no files).
 *   - Throws for real API errors propagated from googleapis.
 */

import { google, type drive_v3 } from 'googleapis'
import { makeAuth, withQuotaRetry, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

export interface FindDescendantOptions {
  /** Use fuzzy matching (legal-suffix-tolerant token overlap) instead of exact name. Default: false. */
  fuzzy?: boolean
  /** Maximum depth to descend. 0 = direct children only, 1 = one level deeper, etc. Default: 1. */
  maxDepth?: number
}

export interface ListSpreadsheetsOptions {
  /** Maximum depth to descend. 0 = root-level only. Default: unbounded (BFS until exhausted). */
  maxDepth?: number
}

export interface ListFilesOptions {
  /** Cap total files returned across all depths. Default: unbounded. */
  maxFiles?: number
  /** Filter to files modified strictly after this Date. */
  modifiedAfter?: Date
  /** Maximum depth to descend. Default: unbounded (BFS until exhausted). */
  maxDepth?: number
  /** When true, shortcuts pointing to folders are followed just like real subfolders. Default: false. */
  followFolderShortcuts?: boolean
}

// ── Drive auth singleton (lazy) ──────────────────────────────────────────────

type DriveApi = drive_v3.Drive

/**
 * Internal interface used to inject a stub Drive in unit tests. Production
 * code never calls this — it uses the exported `driveClient` singleton.
 */
export interface DriveClientDeps {
  /** Provide a Drive API instance. If omitted, the client builds one from GOOGLE_UNIFIED_TOKEN_PATH. */
  drive?: DriveApi
}

// ── Fuzzy folder matching ────────────────────────────────────────────────────

/**
 * Canonical fuzzy matcher (extracted from src/account-intelligence.ts:818).
 * Strips legal-entity suffixes and punctuation, then scores by exact match,
 * substring inclusion, or token overlap. Returns the best match if its score
 * is >= 0.5.
 */
function normalizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /,?\s+(inc|llc|ltd|corp|corporation|incorporated|limited|co|group|holdings|international|technologies|logistics|solutions|services|foods|systems|global|networks|software|health sciences|cancer center|cancer research)\.?\s*$/gi,
      '',
    )
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

function folderMatchScore(folderName: string, customerName: string): number {
  const fn = normalizeFolderName(folderName)
  const cn = normalizeFolderName(customerName)
  if (fn === cn) return 1
  if (fn.includes(cn) || cn.includes(fn)) return 0.9
  const fWords = new Set(fn.split(/\s+/).filter((w) => w.length > 2))
  const cWords = cn.split(/\s+/).filter((w) => w.length > 2)
  if (fWords.size === 0 || cWords.length === 0) return 0
  const overlap = cWords.filter((w) => fWords.has(w)).length
  return overlap / Math.max(fWords.size, cWords.length)
}

function fuzzyFindFolder(
  folders: Array<{ id?: string | null; name?: string | null }>,
  targetName: string,
): { id: string; name: string } | undefined {
  let bestScore = 0
  let bestFolder: { id: string; name: string } | undefined
  for (const f of folders) {
    if (!f.id || !f.name) continue
    const score = folderMatchScore(f.name, targetName)
    if (score > bestScore) {
      bestScore = score
      bestFolder = { id: f.id, name: f.name }
    }
  }
  return bestScore >= 0.5 ? bestFolder : undefined
}

// ── DriveFolderClient implementation ─────────────────────────────────────────

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/** Escape single quotes in Drive query string values. */
export function escapeQ(value: string): string {
  return value.replace(/'/g, "\\'")
}

export class DriveFolderClient {
  private readonly tokenPath: string
  private cachedDrive?: DriveApi

  constructor(tokenPath: string, private readonly deps?: DriveClientDeps) {
    this.tokenPath = tokenPath
  }

  /** Get the underlying Drive API. Tests inject deps.drive; production builds lazily. */
  private getDrive(): DriveApi {
    if (this.deps?.drive) return this.deps.drive
    if (this.cachedDrive) return this.cachedDrive
    const auth = makeAuth(this.tokenPath)
    this.cachedDrive = google.drive({ version: 'v3', auth })
    return this.cachedDrive
  }

  /**
   * Run a paginated drive.files.list query, looping until nextPageToken is exhausted.
   * Wraps each page in withQuotaRetry. ADR-0016: supportsAllDrives + includeItemsFromAllDrives are always-on.
   */
  private async listAllPages(
    params: drive_v3.Params$Resource$Files$List,
    label: string,
  ): Promise<drive_v3.Schema$File[]> {
    const drive = this.getDrive()
    const out: drive_v3.Schema$File[] = []
    let pageToken: string | undefined
    do {
      const res = await withQuotaRetry(
        () =>
          drive.files.list({
            ...params,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            ...(pageToken ? { pageToken } : {}),
          }),
        `[drive-client] ${label}`,
      )
      for (const f of res.data.files ?? []) out.push(f)
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
    return out
  }

  /**
   * Find a named folder under `parentId`. Searches breadth-first up to maxDepth.
   * Returns the folder ID, or null if no match at any depth.
   */
  async findDescendantFolder(
    parentId: string,
    name: string,
    options: FindDescendantOptions = {},
  ): Promise<string | null> {
    const { fuzzy = false, maxDepth = 1 } = options

    // BFS — try each level fully before descending.
    let frontier: string[] = [parentId]
    const visited = new Set<string>([parentId])

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier: string[] = []
      for (const folderId of frontier) {
        const children = await this.listAllPages(
          {
            q: `'${escapeQ(folderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: 'nextPageToken, files(id,name)',
            pageSize: 200,
          },
          `findDescendantFolder list depth=${depth}`,
        )

        if (fuzzy) {
          const match = fuzzyFindFolder(children, name)
          if (match) return match.id
        } else {
          const exact = children.find((f) => f.name === name && f.id)
          if (exact?.id) return exact.id
        }

        // Queue children for the next depth iteration
        for (const c of children) {
          if (c.id && !visited.has(c.id)) {
            visited.add(c.id)
            nextFrontier.push(c.id)
          }
        }
      }
      frontier = nextFrontier
      if (frontier.length === 0) break
    }

    return null
  }

  /**
   * Find a folder named `name` directly under `parentId`. If not found, create it.
   * Returns the folder ID either way.
   */
  async ensureChildFolder(parentId: string, name: string): Promise<string> {
    const drive = this.getDrive()

    const existing = await this.listAllPages(
      {
        q: `name='${escapeQ(name)}' and '${escapeQ(parentId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: 'nextPageToken, files(id,name)',
        pageSize: 1,
      },
      'ensureChildFolder lookup',
    )
    const hit = existing.find((f) => f.id)
    if (hit?.id) return hit.id

    const created = await withQuotaRetry(
      () =>
        drive.files.create({
          requestBody: {
            name,
            mimeType: FOLDER_MIME,
            parents: [parentId],
          },
          supportsAllDrives: true,
          fields: 'id',
        }),
      '[drive-client] ensureChildFolder create',
    )
    if (!created.data.id) throw new Error(`drive.files.create returned no id for folder ${name}`)
    return created.data.id
  }

  /**
   * BFS-collect all spreadsheet IDs and shortcut targets that are spreadsheets,
   * starting from `rootId`. Deduplicates IDs. Bounded by `maxDepth` (depth 0 = root only).
   */
  async listSpreadsheetsUnder(
    rootId: string,
    options: ListSpreadsheetsOptions = {},
  ): Promise<Array<{ id: string; name: string }>> {
    const maxDepth = options.maxDepth // undefined = unbounded

    const seen = new Set<string>()
    const results: Array<{ id: string; name: string }> = []
    const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
    const visitedFolders = new Set<string>([rootId])

    while (queue.length > 0) {
      const { id: folderId, depth } = queue.shift()!

      // Spreadsheets directly in this folder
      const sheetFiles = await this.listAllPages(
        {
          q: `'${escapeQ(folderId)}' in parents and mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
          fields: 'nextPageToken, files(id,name)',
          pageSize: 200,
        },
        'listSpreadsheetsUnder sheets',
      )
      for (const f of sheetFiles) {
        if (f.id && !seen.has(f.id)) {
          seen.add(f.id)
          results.push({ id: f.id, name: f.name ?? '' })
        }
      }

      // Shortcuts pointing to spreadsheets
      const shortcutFiles = await this.listAllPages(
        {
          q: `'${escapeQ(folderId)}' in parents and mimeType = '${SHORTCUT_MIME}' and trashed = false`,
          fields: 'nextPageToken, files(id,name,shortcutDetails)',
          pageSize: 200,
        },
        'listSpreadsheetsUnder shortcuts',
      )
      for (const f of shortcutFiles) {
        const targetMime = f.shortcutDetails?.targetMimeType ?? ''
        const targetId = f.shortcutDetails?.targetId ?? ''
        if (targetMime === SPREADSHEET_MIME && targetId && !seen.has(targetId)) {
          seen.add(targetId)
          results.push({ id: targetId, name: f.name ?? '' })
        }
      }

      // Recurse into subfolders if we have depth budget
      if (maxDepth === undefined || depth < maxDepth) {
        const subFolders = await this.listAllPages(
          {
            q: `'${escapeQ(folderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: 'nextPageToken, files(id,name)',
            pageSize: 200,
          },
          'listSpreadsheetsUnder folders',
        )
        for (const sub of subFolders) {
          if (sub.id && !visitedFolders.has(sub.id)) {
            visitedFolders.add(sub.id)
            queue.push({ id: sub.id, depth: depth + 1 })
          }
        }
      }
    }

    return results
  }

  /**
   * BFS-collect non-folder files under `rootId`, with optional caps on count, depth,
   * and modification time. Files are deduplicated by ID. Folder traversal stops
   * when the per-call file cap is reached.
   */
  async listFilesUnder(
    rootId: string,
    options: ListFilesOptions = {},
  ): Promise<DriveFile[]> {
    const { maxFiles, modifiedAfter, maxDepth, followFolderShortcuts } = options

    const seen = new Set<string>()
    const results: DriveFile[] = []
    const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }]
    const visitedFolders = new Set<string>([rootId])

    while (queue.length > 0) {
      if (maxFiles !== undefined && results.length >= maxFiles) break

      const { id: folderId, depth } = queue.shift()!

      // Files (everything except folders and shortcuts) in this folder
      const filterClauses = [
        `'${escapeQ(folderId)}' in parents`,
        `mimeType != '${FOLDER_MIME}'`,
        `mimeType != '${SHORTCUT_MIME}'`,
        `trashed = false`,
      ]
      if (modifiedAfter) {
        filterClauses.push(`modifiedTime > '${modifiedAfter.toISOString()}'`)
      }
      const remaining =
        maxFiles !== undefined ? Math.max(1, maxFiles - results.length) : 100
      const files = await this.listAllPages(
        {
          q: filterClauses.join(' and '),
          fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,webViewLink)',
          pageSize: Math.min(100, remaining),
          orderBy: 'modifiedTime desc',
        },
        'listFilesUnder files',
      )
      for (const f of files) {
        if (!f.id || seen.has(f.id)) continue
        seen.add(f.id)
        results.push({
          id: f.id,
          name: f.name ?? '',
          mimeType: f.mimeType ?? '',
          modifiedTime: f.modifiedTime ?? undefined,
          webViewLink: f.webViewLink ?? undefined,
        })
        if (maxFiles !== undefined && results.length >= maxFiles) break
      }

      if (maxFiles !== undefined && results.length >= maxFiles) break

      // Recurse into subfolders if we have depth budget
      if (maxDepth === undefined || depth < maxDepth) {
        const subFolders = await this.listAllPages(
          {
            q: `'${escapeQ(folderId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
            fields: 'nextPageToken, files(id,name)',
            pageSize: 200,
          },
          'listFilesUnder folders',
        )

        let shortcutFolderIds: string[] = []
        if (followFolderShortcuts) {
          const shortcuts = await this.listAllPages(
            {
              q: `'${escapeQ(folderId)}' in parents and mimeType = '${SHORTCUT_MIME}' and trashed = false`,
              fields: 'nextPageToken, files(id,name,shortcutDetails)',
              pageSize: 200,
            },
            'listFilesUnder shortcuts',
          )
          for (const sc of shortcuts) {
            const targetMime = sc.shortcutDetails?.targetMimeType ?? ''
            const targetId   = sc.shortcutDetails?.targetId       ?? ''
            if (targetMime === FOLDER_MIME && targetId && !visitedFolders.has(targetId)) {
              visitedFolders.add(targetId)
              shortcutFolderIds.push(targetId)
            }
          }
        }

        for (const sub of subFolders) {
          if (sub.id && !visitedFolders.has(sub.id)) {
            visitedFolders.add(sub.id)
            queue.push({ id: sub.id, depth: depth + 1 })
          }
        }
        for (const targetId of shortcutFolderIds) {
          queue.push({ id: targetId, depth: depth + 1 })
        }
      }
    }

    return results
  }

  /**
   * Find a Google Sheet named `name` directly under `parentId`. Returns the sheet ID
   * on exact name match, or null if no match.
   */
  async findSheetByName(parentId: string, name: string): Promise<string | null> {
    const files = await this.listAllPages(
      {
        q: `name='${escapeQ(name)}' and '${escapeQ(parentId)}' in parents and mimeType='${SPREADSHEET_MIME}' and trashed=false`,
        fields: 'nextPageToken, files(id,name)',
        pageSize: 1,
      },
      'findSheetByName',
    )
    return files[0]?.id ?? null
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const driveClient = new DriveFolderClient(GOOGLE_UNIFIED_TOKEN_PATH)

/**
 * Test-only constructor — never use in production code. Lets unit tests
 * inject a stub Drive API instance instead of going through OAuth.
 */
export function makeDriveClientForTest(deps: DriveClientDeps): DriveFolderClient {
  return new DriveFolderClient(GOOGLE_UNIFIED_TOKEN_PATH, deps)
}
