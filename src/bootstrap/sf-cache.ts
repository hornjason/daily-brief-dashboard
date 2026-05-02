/**
 * src/bootstrap/sf-cache.ts
 *
 * BKL-ARCH-01: Extracted from bootstrap-orchestrator.ts (ADR-005 — 500-line cap).
 * Google Drive-backed SF pipeline cache — read and write helpers.
 *
 * Exports:
 *   writeSfDriveCache — write SfReportRow to Drive as SF-PIPELINE-<reportId>-<pod>-<date>.csv
 *   readSfDriveCache  — read SF-PIPELINE-<reportId>-<pod>-<today>.csv from Drive (null on miss)
 */

import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { parseCsvToSfReport } from '../csv-parse.ts'
import type { SfReportRow } from '../sf-scraper.ts'

/**
 * BKL-SFCACHE-01: Write an SfReportRow to Google Drive as SF-PIPELINE-<reportId>-<pod>-<date>.csv
 * inside the podBookingsFolderId. Mirrors the CCSP Drive cache write pattern:
 *   1. List and delete any existing SF-PIPELINE-<reportId>-<pod>-*.csv for this POD (stale cleanup)
 *   2. Create the new file with today's filename
 * All failures are non-fatal — caller falls through to live scrape on retry.
 */
export async function writeSfDriveCache(
  data: SfReportRow,
  podBookingsFolderId: string,
  sfReportId: string,
  podName: string,
  cacheFileName: string,
): Promise<void> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return
    const drive = google.drive({ version: 'v3', auth })

    // Delete stale SF-PIPELINE-<reportId>-<pod>-*.csv files for this POD
    try {
      const staleRes = await withQuotaRetry(
        () => drive.files.list({
          q: `name contains 'SF-PIPELINE-${sfReportId}-${podName}-' and '${podBookingsFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        'SF Drive stale cache list',
      )
      const staleFiles = staleRes.data.files ?? []
      for (const oldFile of staleFiles) {
        if (!oldFile.id || !oldFile.name) continue
        if (!oldFile.name.startsWith(`SF-PIPELINE-${sfReportId}-${podName}-`) || !oldFile.name.endsWith('.csv')) continue
        try {
          await drive.files.delete({ fileId: oldFile.id, supportsAllDrives: true })
          console.log(`[pod-bootstrap] deleted stale SF Drive cache ${oldFile.name}`)
        } catch (delErr: any) {
          console.warn(`[pod-bootstrap] stale SF cache delete failed for ${oldFile.name}: ${delErr.message} — non-fatal`)
        }
      }
    } catch (listErr: any) {
      console.warn(`[pod-bootstrap] stale SF cache list failed: ${listErr.message} — non-fatal, proceeding to write`)
    }

    // Build CSV — escape commas, quotes, newlines same as CCSP writer
    const escape = (val: string): string =>
      val.includes(',') || val.includes('"') || val.includes('\n')
        ? `"${val.replace(/"/g, '""')}"` : val
    const csvLines = [data.headers.map(escape).join(',')]
    for (const row of data.rows) {
      csvLines.push(row.map(c => escape(c ?? '')).join(','))
    }

    await withQuotaRetry(
      () => drive.files.create({
        requestBody: { name: cacheFileName, mimeType: 'text/csv', parents: [podBookingsFolderId] },
        media: { mimeType: 'text/csv', body: csvLines.join('\n') },
        supportsAllDrives: true,
        fields: 'id',
      }),
      'SF Drive cache write',
    )
    console.log(`[pod-bootstrap] SF Drive cache written: ${cacheFileName} (${data.rows.length} rows)`)
  } catch (e: any) {
    console.warn(`[pod-bootstrap] SF Drive cache write failed: ${e?.message} — non-fatal`)
  }
}

/**
 * BKL-SFCACHE-01: Read SF-PIPELINE-<reportId>-<pod>-<today>.csv from podBookingsFolderId.
 * Returns parsed SfReportRow on hit, null on miss or error (non-fatal).
 */
export async function readSfDriveCache(
  podBookingsFolderId: string,
  cacheFileName: string,
): Promise<SfReportRow | null> {
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return null
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${cacheFileName}' and '${podBookingsFolderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      'SF Drive cache check',
    )
    const cacheFile = listRes.data.files?.[0]
    if (!cacheFile?.id) return null
    const dlRes = await withQuotaRetry(
      () => drive.files.get({ fileId: cacheFile.id!, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
      'SF Drive cache download',
    )
    const csvText = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
    const parsed = parseCsvToSfReport(csvText)
    return parsed.rows.length > 0 ? parsed : null
  } catch (e: any) {
    console.warn(`[pod-bootstrap] SF Drive cache read failed: ${e?.message} — non-fatal`)
    return null
  }
}
