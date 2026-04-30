/**
 * scripts/sync-pod-l3.ts — BKL-SYNC-L3-01
 *
 * Per-run L3 sync loop. Iterates all configured regions/pods, runs CCSP and SF
 * pipeline syncs, writes a sync-status.json summary to Drive, and sends a summary
 * email to jhorn@redhat.com.
 *
 * Called by sync-l3-daemon.ts at 5:30am ET, or via `make sync-now` (daemon trigger).
 * Do NOT run standalone — requires initialized browser contexts from the daemon.
 * See ADR-006 and ARCHITECTURE.md §3a for the SingletonLock rationale.
 */

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { google } from 'googleapis'
import { normalizeSettings } from '../src/region-config.ts'
import type { RegionConfig } from '../src/region-config.ts'
import { scrapePodCcspRaw } from '../src/ccsp-scraper.ts'
import { initScrapeContext, getScrapeContext } from '../src/rh-scraper.ts'
import { runSfPodSync, initSfContext, getSfContext } from '../src/sf-scraper.ts'
import { sendBriefEmail } from '../src/email-sender.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PodResult {
  podKey: string
  status: 'ok' | 'skipped' | 'error'
  reason?: string
  ccspRows?: number
  sfRows?: number
}

export interface SyncRunResult {
  completedAt: string
  results: PodResult[]
}

// ── Config resolution ─────────────────────────────────────────────────────────

const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../data/config')
const SETTINGS_PATH = resolve(CONFIG_DIR, 'settings.json')

function loadSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
  } catch (e: any) {
    throw new Error(`[sync-pod-l3] Failed to load settings.json at ${SETTINGS_PATH}: ${e.message}`)
  }
}

// ── Drive helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a GSheet matching the pod key exists in the given Drive folder.
 * Uses listPodBookingSheets pattern: list spreadsheets in the folder and check names.
 */
async function checkBookingsGSheetExists(folderId: string, podKey: string, podLabel?: string): Promise<boolean> {
  if (!folderId) return false
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return false
    const drive = google.drive({ version: 'v3', auth })
    const res = await withQuotaRetry(
      () => drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      'sync: bookings GSheet check',
    )
    const files = res.data.files ?? []
    const podKeyLower = podKey.toLowerCase()
    // Also match against label keywords (e.g. "Northwest Corp" → ["northwest", "corp"])
    // because GSheets are named like "Northwest POD - Subscriptions", not with the pod key
    const labelWords = (podLabel ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3)
    return files.some(f => {
      const nameLower = f.name?.toLowerCase() ?? ''
      if (nameLower.includes(podKeyLower)) return true
      return labelWords.some(w => nameLower.includes(w))
    })
  } catch (e: any) {
    console.warn(`[sync-pod-l3] bookings GSheet check failed for ${podKey}: ${e.message} — assuming absent`)
    return false
  }
}

/**
 * Write sync-status.json to the first region's podBookingsFolderId in Drive.
 * Non-fatal — failure is logged but does not abort the sync cycle.
 */
async function writeSyncStatusToDrive(folderId: string, result: SyncRunResult): Promise<void> {
  if (!folderId) {
    console.warn('[sync-pod-l3] writeSyncStatusToDrive: no folderId — skipping')
    return
  }
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return
    const drive = google.drive({ version: 'v3', auth })
    const fileName = 'sync-status.json'
    const body = JSON.stringify(result, null, 2)

    // Delete existing sync-status.json if present
    try {
      const listRes = await withQuotaRetry(
        () => drive.files.list({
          q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
          fields: 'files(id)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
        'sync-status list',
      )
      for (const f of listRes.data.files ?? []) {
        if (f.id) await drive.files.delete({ fileId: f.id, supportsAllDrives: true }).catch(() => {})
      }
    } catch {
      // non-fatal
    }

    await withQuotaRetry(
      () => drive.files.create({
        requestBody: { name: fileName, mimeType: 'application/json', parents: [folderId] },
        media: { mimeType: 'application/json', body },
        supportsAllDrives: true,
        fields: 'id',
      }),
      'sync-status write',
    )
    console.log(`[sync-pod-l3] sync-status.json written to Drive (${folderId})`)
  } catch (e: any) {
    console.warn(`[sync-pod-l3] sync-status Drive write failed: ${e.message} — non-fatal`)
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendSyncEmail(result: SyncRunResult): Promise<void> {
  const okCount = result.results.filter(r => r.status === 'ok').length
  const skippedCount = result.results.filter(r => r.status === 'skipped').length
  const errorCount = result.results.filter(r => r.status === 'error').length
  const dateStr = result.completedAt.slice(0, 10)
  const hasErrors = errorCount > 0

  const subject = hasErrors
    ? `L3 Sync FAILED — ${dateStr} | ${okCount} synced, ${skippedCount} skipped, ${errorCount} errors`
    : `L3 Sync Complete — ${dateStr} | ${okCount} pods synced, ${skippedCount} skipped`

  const rows = result.results.map(r => {
    if (r.status === 'ok') {
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
        <td style="padding:4px 8px;text-align:center">${r.ccspRows ?? '—'}</td>
        <td style="padding:4px 8px;text-align:center">${r.sfRows ?? '—'}</td>
        <td style="padding:4px 8px;color:#16a34a">OK</td>
      </tr>`
    }
    if (r.status === 'skipped') {
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;color:#d97706">⚠️ SKIPPED — ${r.reason ?? ''}</td>
      </tr>`
    }
    return `<tr>
      <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
      <td style="padding:4px 8px;text-align:center">—</td>
      <td style="padding:4px 8px;text-align:center">—</td>
      <td style="padding:4px 8px;color:#dc2626">❌ ERROR — ${r.reason ?? ''}</td>
    </tr>`
  }).join('\n')

  const htmlBody = `
<html><body style="font-family:sans-serif;color:#111">
  <h2 style="margin-bottom:4px">${subject}</h2>
  <p style="color:#555;margin-top:0">Completed at ${result.completedAt}</p>
  <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:520px">
    <thead>
      <tr style="background:#f3f4f6">
        <th style="padding:6px 8px;text-align:left">Pod</th>
        <th style="padding:6px 8px">CCSP Rows</th>
        <th style="padding:6px 8px">SF Rows</th>
        <th style="padding:6px 8px;text-align:left">Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</body></html>`

  await sendBriefEmail('jhorn@redhat.com', subject, htmlBody)
}

// ── Main sync loop ─────────────────────────────────────────────────────────────

export async function syncAllPods(): Promise<SyncRunResult> {
  // ADR-006 §2 H1 — Precondition: both browser contexts must be initialized by the daemon.
  // syncAllPods() is a thin orchestrator; it does not initialize its own contexts.
  // Calling it without initialized contexts will fail with a Chromium SingletonLock error.
  if (!getScrapeContext() || !getSfContext()) {
    throw new Error(
      '[sync-pod] syncAllPods() called without initialized browser contexts — must be invoked through the sync daemon, not standalone',
    )
  }

  const raw = loadSettings()
  const normalized = normalizeSettings(raw)
  const regions: RegionConfig[] = normalized.regions

  console.log(`[sync-pod-l3] starting sync across ${regions.length} region(s)`)

  const results: PodResult[] = []
  let primaryFolderId = ''

  for (const region of regions) {
    if (!primaryFolderId && region.podBookingsFolderId) {
      primaryFolderId = region.podBookingsFolderId
    }

    for (const [podKey, pod] of Object.entries(region.pods)) {
      console.log(`[sync-pod-l3] processing ${podKey}…`)

      // Pod readiness: must have sfReportId
      if (!pod.sfReportId) {
        console.log(`[sync-pod-l3] ${podKey}: no sfReportId — skipping`)
        results.push({ podKey, status: 'skipped', reason: 'no sfReportId' })
        continue
      }

      // Pod readiness: must have a Bookings GSheet in Drive
      const bookingsPresent = await checkBookingsGSheetExists(region.podBookingsFolderId, podKey, pod.label)
      if (!bookingsPresent) {
        console.log(`[sync-pod-l3] ${podKey}: no Bookings GSheet found — skipping`)
        results.push({ podKey, status: 'skipped', reason: 'no Bookings GSheet' })
        continue
      }

      try {
        // CCSP sync — scrapePodCcspRaw handles its own Drive cache check + write
        let ccspRows = 0
        try {
          const seedTerr = `${podKey}_TERR01`
          const ccspResult = await scrapePodCcspRaw([seedTerr], region.podBookingsFolderId)
          ccspRows = ccspResult.rows.length
          console.log(`[sync-pod-l3] ${podKey}: CCSP rows=${ccspRows}`)
        } catch (ccspErr: any) {
          console.warn(`[sync-pod-l3] ${podKey}: CCSP failed: ${ccspErr.message} — continuing to SF sync`)
        }

        // SF pipeline sync
        const sfRows = await runSfPodSync(pod.sfReportId, podKey, region.podBookingsFolderId)
        console.log(`[sync-pod-l3] ${podKey}: SF rows=${sfRows}`)

        results.push({ podKey, status: 'ok', ccspRows, sfRows })
      } catch (e: any) {
        console.error(`[sync-pod-l3] ${podKey}: error: ${e.message}`)
        results.push({ podKey, status: 'error', reason: e.message })
      }
    }
  }

  const runResult: SyncRunResult = {
    completedAt: new Date().toISOString(),
    results,
  }

  // Write sync-status.json to Drive (first region's folder)
  if (primaryFolderId) {
    await writeSyncStatusToDrive(primaryFolderId, runResult)
  }

  // Send summary email
  try {
    await sendSyncEmail(runResult)
  } catch (e: any) {
    console.error(`[sync-pod-l3] email send failed: ${e.message}`)
  }

  const okCount = results.filter(r => r.status === 'ok').length
  const skippedCount = results.filter(r => r.status === 'skipped').length
  const errorCount = results.filter(r => r.status === 'error').length
  console.log(`[sync-pod-l3] done — ok=${okCount} skipped=${skippedCount} errors=${errorCount}`)

  return runResult
}

// ADR-006 §2 H2 — SYNC_NOW standalone path removed.
// Manual immediate sync is achieved exclusively via the daemon trigger mechanism:
//   make sync-now   (→ podman exec pai-sync-l3 touch /data/cache/sync-trigger)
// This prevents Chromium SingletonLock conflicts when the daemon is running.
