/**
 * src/ccsp-cache.ts — Issue #15 Step 2
 *
 * Two-tier cache for CCSP POD CSV data, extracted from `scrapeOneAe`
 * in src/ccsp-scraper.ts.
 *
 * Tier 1 — In-memory cache:
 *   - Module-level mutable singleton (one POD's worth of rows at a time).
 *   - 24h TTL (matches all other ingestion-flow TTLs).
 *   - Pod-keyed: cross-POD lookups miss (BKL-PERF-04).
 *   - Drive modifiedTime gate: if the underlying L3 CSV has aged past TTL,
 *     the in-memory cache invalidates (BKL-INGEST-03).
 *
 * Tier 2 — Drive cache:
 *   - File `CCSP-<pod>-<YYYY-MM-DD>.csv` in the POD bookings folder.
 *   - On hit, populates Tier 1 for subsequent AEs in the same run.
 *
 * Write-back:
 *   - Caches the unfiltered POD-wide CSV after a successful live Tableau fetch.
 *   - REG-CCSP-DUP-01: deletes any stale `CCSP-<pod>-*.csv` siblings before
 *     writing today's file so duplicate dated copies don't accumulate.
 *
 * Filtering (territory + quarter) is the caller's responsibility — see
 * `filterRowsForAe` in src/ccsp-row-filter.ts. This module deals only in
 * full POD-wide row sets.
 */

import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import { parseCsvToObjects } from './csv-parse.ts'

// -- Public types -------------------------------------------------------------

export interface PodCsvCacheEntry {
  rows: Record<string, string>[]
  period: string
  pod: string
  driveFileId?: string
}

export interface CacheLookupResult {
  hit: boolean
  rows?: Record<string, string>[]
  period?: string
  source?: 'memory' | 'drive'
}

// -- Module state (private) ---------------------------------------------------

// BKL-PERF-02: Lazy cache — populated after first AE's CSV download, reused for subsequent AEs.
// BKL-INGEST-03: TTL changed from 30 min to 24h to match all other flow TTLs (ingestion-flow.md).
//   L3 Drive CSV freshness is also checked via modifiedTime before trusting in-memory cache.
let _podCsvCache:
  | { rows: Record<string, string>[]; period: string; expiresAt: number; pod: string; driveFileId?: string }
  | null = null

const POD_CSV_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h — matches all other flow TTLs

// -- Tier 1: in-memory cache --------------------------------------------------

/**
 * Look up the in-memory POD CSV cache for `pod`.
 *
 * Returns `{ hit: false }` when:
 *   - cache is empty, or
 *   - cache has expired (TTL), or
 *   - cache holds a different POD (BKL-PERF-04), or
 *   - the underlying Drive CSV (driveFileId) has aged past TTL (BKL-INGEST-03).
 *
 * On Drive modifiedTime check failure, defaults to trusting the in-memory entry
 * (fail-open for the freshness check; live Tableau remains the ultimate fallback).
 */
export async function tryMemoryCache(pod: string): Promise<CacheLookupResult> {
  if (!_podCsvCache || Date.now() >= _podCsvCache.expiresAt) {
    return { hit: false }
  }
  if (!pod || _podCsvCache.pod !== pod) {
    return { hit: false }
  }

  // BKL-INGEST-03: Drive modifiedTime check — verify underlying L3 CSV is < TTL old.
  if (_podCsvCache.driveFileId) {
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const metaRes = await drive.files.get({
        fileId: _podCsvCache.driveFileId,
        fields: 'modifiedTime',
        supportsAllDrives: true,
      })
      const modifiedTime = metaRes.data.modifiedTime
      if (modifiedTime) {
        const ageMs = Date.now() - new Date(modifiedTime).getTime()
        if (ageMs >= POD_CSV_CACHE_TTL_MS) {
          console.log(
            `[ccsp-cache] Drive CSV modifiedTime is ${Math.round(ageMs / 3_600_000)}h old — invalidating in-memory cache (BKL-INGEST-03)`,
          )
          _podCsvCache = null
          return { hit: false }
        }
      }
    } catch (e: any) {
      // Fail-open: trust the in-memory cache when the freshness check itself fails.
      console.warn(`[ccsp-cache] Drive modifiedTime check failed: ${e.message} — trusting in-memory cache`)
    }
  }

  if (!_podCsvCache) return { hit: false }
  return {
    hit: true,
    rows: _podCsvCache.rows,
    period: _podCsvCache.period,
    source: 'memory',
  }
}

// -- Tier 2: Drive cache ------------------------------------------------------

/**
 * Look up today's POD CSV in the Drive bookings folder
 * (`CCSP-<pod>-<YYYY-MM-DD>.csv`).
 *
 * On hit, also populates the in-memory cache for subsequent AEs in the same
 * run (BKL-PERF-04 + BKL-INGEST-03: pod and driveFileId are stamped).
 *
 * On any Drive API error, returns `{ hit: false }` so the caller falls
 * through to the live Tableau path.
 */
export async function tryDriveCache(
  pod: string,
  podBookingsFolderId: string,
): Promise<CacheLookupResult> {
  if (!pod || !podBookingsFolderId) return { hit: false }

  const today = new Date().toISOString().slice(0, 10)
  const cacheFileName = `CCSP-${pod}-${today}.csv`

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await withQuotaRetry(
      () =>
        drive.files.list({
          q: `name = '${cacheFileName}' and '${podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      'CCSP Drive cache check',
    )
    const cacheFile = listRes.data.files?.[0]
    if (!cacheFile?.id) return { hit: false }

    const dlRes = await withQuotaRetry(
      () =>
        drive.files.get(
          { fileId: cacheFile.id!, alt: 'media', supportsAllDrives: true },
          { responseType: 'text' },
        ),
      'CCSP Drive cache download',
    )
    const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
    const cachedRows = parseCsvToObjects(csvText)
    if (cachedRows.length === 0) return { hit: false }

    console.log(`[ccsp-cache] Drive cache hit — ${cachedRows.length} rows from ${cacheFileName}`)

    // Populate in-memory cache for subsequent AEs in same run.
    // BKL-PERF-04: Include pod so subsequent AEs with different POD don't get a stale hit.
    // BKL-INGEST-03: Store driveFileId so in-memory cache can check Drive modifiedTime on next hit.
    if (!_podCsvCache || Date.now() > _podCsvCache.expiresAt) {
      // period is unknown from the Drive file alone — caller passes its own period
      // string back via writeCaches() on live fetch. For Drive-cache hits, the
      // period stored is the one we return now, derived from the rolling window
      // computed by the caller. We stash an empty period here and let the caller
      // pair the rows with its own label via the returned CacheLookupResult.
      _podCsvCache = {
        rows: cachedRows,
        period: '', // overwritten by caller path; CacheLookupResult.period below is what's used
        expiresAt: Date.now() + POD_CSV_CACHE_TTL_MS,
        pod,
        driveFileId: cacheFile.id!,
      }
    }

    return {
      hit: true,
      rows: cachedRows,
      // No period stored in the Drive CSV itself — caller derives label from
      // getRollingFyWindow() and uses that. We surface an empty string here;
      // the caller's existing pattern returns its own `label` for Drive hits.
      period: undefined,
      source: 'drive',
    }
  } catch (e: any) {
    console.warn(`[ccsp-cache] Drive cache check failed: ${e.message} — falling through`)
    return { hit: false }
  }
}

// -- Write-back ---------------------------------------------------------------

/**
 * Write the freshly-fetched POD CSV rows to both cache tiers.
 *
 * In-memory: populates only when empty/expired (does not stomp a live entry).
 *
 * Drive: writes `CCSP-<pod>-<YYYY-MM-DD>.csv` into `podBookingsFolderId`
 * after deleting any stale `CCSP-<pod>-*.csv` siblings (REG-CCSP-DUP-01).
 * Drive write is best-effort — any failure logs and returns; in-memory tier
 * remains valid.
 *
 * After Drive write succeeds, the new file's id is stamped onto the
 * in-memory entry so the next BKL-INGEST-03 freshness check can verify it.
 */
export async function writeCaches(
  pod: string,
  rows: Record<string, string>[],
  period: string,
  podBookingsFolderId: string | undefined,
): Promise<void> {
  if (rows.length === 0) return

  // BKL-PERF-02: cache full unfiltered rows for subsequent AEs in the same run.
  // BKL-PERF-04: include pod so cross-POD AEs don't get stale hits.
  // BKL-INGEST-03: driveFileId is populated below after Drive write succeeds.
  if (!_podCsvCache || Date.now() > _podCsvCache.expiresAt) {
    _podCsvCache = {
      rows,
      period,
      expiresAt: Date.now() + POD_CSV_CACHE_TTL_MS,
      pod,
    }
    console.log(`[ccsp-cache] POD CSV cached — ${rows.length} rows available for remaining AEs (pod: ${pod})`)
  }

  if (!podBookingsFolderId || !pod) return

  const today = new Date().toISOString().slice(0, 10)
  const cacheFileName = `CCSP-${pod}-${today}.csv`

  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // REG-CCSP-DUP-01: delete any stale CCSP-<pod>-<date>.csv files for this POD before writing today's.
    try {
      const staleRes = await withQuotaRetry(
        () =>
          drive.files.list({
            q: `name contains 'CCSP-${pod}-' and '${podBookingsFolderId}' in parents and trashed = false`,
            fields: 'files(id, name)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }),
        'CCSP Drive stale cache list',
      )
      const staleFiles = staleRes.data.files ?? []
      for (const oldFile of staleFiles) {
        if (!oldFile.id || !oldFile.name) continue
        if (!oldFile.name.startsWith(`CCSP-${pod}-`) || !oldFile.name.endsWith('.csv')) continue
        try {
          await drive.files.delete({ fileId: oldFile.id, supportsAllDrives: true })
          console.log(`[ccsp-cache] deleted stale Drive cache ${oldFile.name}`)
        } catch (delErr: any) {
          console.warn(
            `[ccsp-cache] stale cache delete failed for ${oldFile.name}: ${delErr.message} — non-fatal`,
          )
        }
      }
    } catch (listErr: any) {
      console.warn(`[ccsp-cache] stale cache list failed: ${listErr.message} — non-fatal, proceeding to write`)
    }

    const headers = Object.keys(rows[0])
    const csvLines = [headers.join(',')]
    for (const row of rows) {
      csvLines.push(
        headers
          .map(h => {
            const val = row[h] ?? ''
            return val.includes(',') || val.includes('"') || val.includes('\n')
              ? `"${val.replace(/"/g, '""')}"`
              : val
          })
          .join(','),
      )
    }

    const createRes = await withQuotaRetry(
      () =>
        drive.files.create({
          requestBody: { name: cacheFileName, mimeType: 'text/csv', parents: [podBookingsFolderId] },
          media: { mimeType: 'text/csv', body: csvLines.join('\n') },
          supportsAllDrives: true,
          fields: 'id',
        }),
      'CCSP Drive cache write',
    )

    // BKL-INGEST-03: stamp Drive file ID onto in-memory entry for next freshness check.
    const newId = createRes.data.id ?? undefined
    if (newId && _podCsvCache && _podCsvCache.pod === pod) {
      _podCsvCache = { ..._podCsvCache, driveFileId: newId }
    }
    console.log(
      `[ccsp-cache] wrote Drive cache ${cacheFileName} (${rows.length} rows) to subscription folder`,
    )
  } catch (e: any) {
    console.warn(`[ccsp-cache] Drive cache write failed: ${e.message} — non-fatal`)
  }
}

// -- Test helper --------------------------------------------------------------

/** Reset the module-level in-memory cache. Test-only. */
export function _resetMemoryCacheForTests(): void {
  _podCsvCache = null
}
