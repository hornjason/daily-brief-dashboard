/**
 * src/lib/l3-csv-reader.ts — ADR-019: Dynamic L3 CSV discovery
 *
 * Discovers and reads L3 CSV files (SF-PIPELINE-*, CCSP-*) from Google Drive
 * during refresh, replacing static Google Sheet ID lookups. The L4 daemon
 * writes new CSV files daily; this module reads them directly.
 *
 * Drive API is injected for testability — no module-level auth needed.
 */

import type { drive_v3 } from 'googleapis'
import { withQuotaRetry } from '../google.ts'

type DriveApi = drive_v3.Drive

export interface L3CsvDiscoveryResult {
  fileId: string
  fileName: string
  modifiedTime: string
}

/**
 * Discover the most recent L3 CSV matching a name prefix and optional pod key.
 *
 * Query strategy:
 *   1. Search for `{namePrefix}` + `{podKey}` in the given folder.
 *   2. If pod-specific search returns nothing, retry without the pod key (fallback).
 *   3. Sort by modifiedTime desc, take the first match.
 *
 * Returns null when no CSV is found.
 */
export async function discoverL3Csv(
  folderId: string,
  namePrefix: string,
  podKey: string,
  driveApi: DriveApi,
): Promise<L3CsvDiscoveryResult | null> {
  // Pod-specific search first
  if (podKey) {
    const result = await searchCsv(folderId, namePrefix, podKey, driveApi)
    if (result) return result
    // Fallback: search without pod key
  }
  return searchCsv(folderId, namePrefix, '', driveApi)
}

async function searchCsv(
  folderId: string,
  namePrefix: string,
  podKey: string,
  driveApi: DriveApi,
): Promise<L3CsvDiscoveryResult | null> {
  const nameParts = [`name contains '${namePrefix}'`]
  if (podKey) {
    nameParts.push(`name contains '-${podKey}-'`)
  }
  const q = `${nameParts.join(' and ')} and '${folderId}' in parents and trashed = false`

  const res = await withQuotaRetry(
    () =>
      driveApi.files.list({
        q,
        fields: 'files(id,name,modifiedTime)',
        orderBy: 'modifiedTime desc',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    `discoverL3Csv(${namePrefix}${podKey ? '/' + podKey : ''})`,
  )

  const files = res.data.files ?? []
  if (files.length === 0) return null

  const f = files[0]
  return {
    fileId: f.id!,
    fileName: f.name ?? '',
    modifiedTime: f.modifiedTime ?? '',
  }
}

/**
 * Read the raw CSV text from a Drive file by ID.
 */
export async function readL3CsvRaw(
  fileId: string,
  driveApi: DriveApi,
): Promise<string> {
  const res = await withQuotaRetry(
    () =>
      driveApi.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'text' },
      ),
    `readL3CsvRaw(${fileId})`,
  )
  return res.data as unknown as string
}
