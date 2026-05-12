/**
 * ADR-018 — One-time migration: purge inactive customers.
 *
 * 1. Reads customers.json from CONFIG_DIR
 * 2. Separates active (no `inactive` flag) from inactive customers
 * 3. Archives inactive customers with driveFolderId to archived-customers.json
 * 4. Keeps only active customers in customers.json
 * 5. Deletes orphaned cache files for removed customers
 * 6. Logs what was archived, purged, and how many cache files deleted
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { resolve, join } from 'path'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { toSlug } from './cache-layer.ts'
import { CONFIG_DIR_PATH, CUSTOMERS_PATH, setCustomers } from './server-state.ts'
import type { Customer } from './types.ts'

interface ArchivedCustomer {
  name: string
  driveFolderId: string
  ae: string
  archivedAt: string
}

interface ArchiveFile {
  archived: ArchivedCustomer[]
}

export interface MigrationResult {
  archivedCount: number
  purgedCount: number
  cacheFilesDeleted: number
  activeRemaining: number
  archivedNames: string[]
  purgedNames: string[]
}

export function runPurgeInactiveMigration(cacheDir: string): MigrationResult {
  // 1. Read customers.json
  let raw: { customers?: Customer[] }
  try {
    raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
  } catch (e: any) {
    throw new Error(`Failed to read customers.json: ${e.message}`)
  }
  const allCustomers = raw.customers ?? []

  // 2. Separate active from inactive
  const active: Customer[] = []
  const inactive: Customer[] = []
  for (const c of allCustomers) {
    if (c.inactive) {
      inactive.push(c)
    } else {
      active.push(c)
    }
  }

  if (inactive.length === 0) {
    console.log('[migrate] No inactive customers found — nothing to do')
    return {
      archivedCount: 0,
      purgedCount: 0,
      cacheFilesDeleted: 0,
      activeRemaining: active.length,
      archivedNames: [],
      purgedNames: [],
    }
  }

  // 3. Archive inactive customers with driveFolderId
  const archivePath = resolve(CONFIG_DIR_PATH, 'archived-customers.json')
  let existingArchive: ArchiveFile = { archived: [] }
  try {
    existingArchive = JSON.parse(readFileSync(archivePath, 'utf-8'))
  } catch { /* first run — no archive yet */ }

  const archivedNames: string[] = []
  const purgedNames: string[] = []
  const now = new Date().toISOString()

  for (const c of inactive) {
    if (c.driveFolderId) {
      existingArchive.archived.push({
        name: c.name,
        driveFolderId: c.driveFolderId,
        ae: c.ae ?? '',
        archivedAt: now,
      })
      archivedNames.push(c.name)
    } else {
      purgedNames.push(c.name)
    }
  }

  if (archivedNames.length > 0) {
    writeFileSync(archivePath, JSON.stringify(existingArchive, null, 2))
    console.log(`[migrate] Archived ${archivedNames.length} customers with Drive folders: ${archivedNames.join(', ')}`)
  }

  // 4. Keep only active customers
  writeJsonAtomic(CUSTOMERS_PATH, { customers: active })
  setCustomers(active)
  console.log(`[migrate] Kept ${active.length} active customers in customers.json`)

  if (purgedNames.length > 0) {
    console.log(`[migrate] Purged ${purgedNames.length} customers (no Drive folder): ${purgedNames.join(', ')}`)
  }

  // 5. Delete orphaned cache files for removed customers
  const removedSlugs = new Set([...inactive].map(c => toSlug(c.name)))
  let cacheFilesDeleted = 0

  // Delete from top-level cache dir
  try {
    const cacheFiles = readdirSync(cacheDir).filter(f => f.endsWith('.json'))
    for (const file of cacheFiles) {
      // Match {slug}-YYYY-MM-DD.json (briefs)
      const briefMatch = file.match(/^(.+?)-20\d{2}-\d{2}-\d{2}\.json$/)
      if (briefMatch && removedSlugs.has(briefMatch[1])) {
        try { unlinkSync(resolve(cacheDir, file)); cacheFilesDeleted++ } catch { /* already gone */ }
        continue
      }
      // Match {slug}-meetings.json
      const meetingsMatch = file.match(/^(.+?)-meetings\.json$/)
      if (meetingsMatch && removedSlugs.has(meetingsMatch[1])) {
        try { unlinkSync(resolve(cacheDir, file)); cacheFilesDeleted++ } catch { /* already gone */ }
        continue
      }
      // Match {slug}-emails.json
      const emailsMatch = file.match(/^(.+?)-emails\.json$/)
      if (emailsMatch && removedSlugs.has(emailsMatch[1])) {
        try { unlinkSync(resolve(cacheDir, file)); cacheFilesDeleted++ } catch { /* already gone */ }
        continue
      }
      // Match {slug}-sheets.json
      const sheetsMatch = file.match(/^(.+?)-sheets\.json$/)
      if (sheetsMatch && removedSlugs.has(sheetsMatch[1])) {
        try { unlinkSync(resolve(cacheDir, file)); cacheFilesDeleted++ } catch { /* already gone */ }
        continue
      }
    }
  } catch (e: any) {
    console.warn(`[migrate] cache cleanup failed: ${e.message}`)
  }

  // Delete from product-intel/ subdirs
  cacheFilesDeleted += purgeSubdirForSlugs(resolve(cacheDir, 'product-intel'), removedSlugs)

  // Delete from industry-analysis/
  cacheFilesDeleted += purgeSubdirForSlugs(resolve(cacheDir, 'industry-analysis'), removedSlugs)

  console.log(`[migrate] Deleted ${cacheFilesDeleted} orphaned cache files`)

  return {
    archivedCount: archivedNames.length,
    purgedCount: purgedNames.length,
    cacheFilesDeleted,
    activeRemaining: active.length,
    archivedNames,
    purgedNames,
  }
}

/** Recursively delete files matching any of the given slugs in a subdirectory tree. */
function purgeSubdirForSlugs(dir: string, slugs: Set<string>): number {
  let deleted = 0
  if (!existsSync(dir)) return deleted
  try {
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const full = join(d, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        // Check if any slug is a prefix of the filename
        const lower = entry.name.toLowerCase()
        for (const slug of slugs) {
          if (lower.startsWith(slug)) {
            try { unlinkSync(full); deleted++ } catch { /* skip */ }
            break
          }
        }
      }
    }
    walk(dir)
  } catch { /* dir may not exist */ }
  return deleted
}
