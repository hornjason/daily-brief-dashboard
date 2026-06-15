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
import { scrapePodCcspRaw, peekTableauSessionExpired } from '../src/ccsp-scraper.ts'
import { initScrapeContext, getScrapeContext } from '../src/rh-scraper.ts'
import { withCcspRetry } from './ccsp-retry.ts'
import { CcspAuthExpiredError } from '../src/scraper-errors.ts'
import { runSfPodSync, initSfContext, getSfContext } from '../src/sf-scraper.ts'
import { sendBriefEmail } from '../src/email-sender.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../src/google.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PodResult {
  podKey: string
  status: 'ok' | 'warn' | 'skipped' | 'error'
  reason?: string
  ccspRows?: number
  sfRows?: number
  ccspDelta?: number   // current - previous ccspRows; undefined if no prior data
  sfDelta?: number     // current - previous sfRows; undefined if no prior data
  /** BKL-CCSP-RETRY-01: true when CCSP succeeded only after a retry. */
  recovered?: boolean
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
 * Normalize a string for fuzzy matching by removing underscores and spaces.
 * Enables matching pod keys (EAST_COMM_CORP_POD01) against GSheet names
 * ("East Comm Corp POD01 - Subscriptions").
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[_\s]/g, '')
}

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
    const podKeyNorm = normalizeForMatch(podKey)
    // Also match against label keywords (e.g. "Northwest Corp" → ["northwest", "corp"])
    // because GSheets are named like "Northwest POD - Subscriptions", not with the pod key
    const labelWords = (podLabel ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3)
    return files.some(f => {
      const nameNorm = normalizeForMatch(f.name ?? '')
      if (nameNorm.includes(podKeyNorm)) return true
      return labelWords.some(w => nameNorm.includes(w))
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

// ── Retry-status writer (BKL-CCSP-RETRY-01) ───────────────────────────────────

/**
 * Write a partial sync-status.json to Drive while a CCSP retry back-off is
 * pending, so the dashboard / observers can see retry progress without
 * waiting for the whole run to finish.
 *
 * Non-fatal: any failure is logged and swallowed.
 */
async function writeRetryStatus(
  folderId: string,
  podKey: string,
  attempt: number,
  nextRetryAt: string,
): Promise<void> {
  if (!folderId) return
  const partial: SyncRunResult & { status: string; podKey: string; attempt: number; nextRetryAt: string } = {
    completedAt: new Date().toISOString(),
    results: [],
    status: 'retry_in_progress',
    podKey,
    attempt,
    nextRetryAt,
  }
  await writeSyncStatusToDrive(folderId, partial as unknown as SyncRunResult)
}

// ── Prev sync-status loader ───────────────────────────────────────────────────

/**
 * Load the previous sync-status.json from Drive and return a map of
 * podKey → { ccspRows, sfRows } for delta computation. Non-fatal: returns
 * empty map on any failure.
 */
async function loadPrevSyncStatus(folderId: string): Promise<Map<string, { ccspRows?: number; sfRows?: number }>> {
  const result = new Map<string, { ccspRows?: number; sfRows?: number }>()
  if (!folderId) return result
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    if (!auth) return result
    const drive = google.drive({ version: 'v3', auth })
    const listRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = 'sync-status.json' and '${folderId}' in parents and trashed = false`,
        fields: 'files(id)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
      'prev sync-status list',
    )
    const fileId = listRes.data.files?.[0]?.id
    if (!fileId) return result
    const dlRes = await withQuotaRetry(
      () => drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'text' }),
      'prev sync-status download',
    )
    const text = typeof dlRes.data === 'string' ? dlRes.data : JSON.stringify(dlRes.data)
    const parsed = JSON.parse(text) as { results?: Array<{ podKey: string; ccspRows?: number; sfRows?: number }> }
    for (const r of parsed.results ?? []) {
      result.set(r.podKey, { ccspRows: r.ccspRows, sfRows: r.sfRows })
    }
  } catch {
    // non-fatal — no prior data is fine
  }
  return result
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendSyncEmail(result: SyncRunResult): Promise<void> {
  const okCount = result.results.filter(r => r.status === 'ok').length
  const warnCount = result.results.filter(r => r.status === 'warn').length
  const skippedCount = result.results.filter(r => r.status === 'skipped').length
  const errorCount = result.results.filter(r => r.status === 'error').length
  const dateStr = result.completedAt.slice(0, 10)
  const hasErrors = errorCount > 0

  const subject = hasErrors
    ? `L3 Sync FAILED - ${dateStr} | ${okCount} synced, ${warnCount} warned, ${skippedCount} skipped, ${errorCount} errors`
    : warnCount > 0
      ? `L3 Sync Complete - ${dateStr} | ${okCount} pods synced, ${warnCount} warned, ${skippedCount} skipped`
      : `L3 Sync Complete - ${dateStr} | ${okCount} pods synced, ${skippedCount} skipped`

  const fmtDelta = (d: number | undefined): string => {
    if (d == null) return '—'
    if (d === 0) return '<span style="color:#6b7280">0</span>'
    if (d > 0) return `<span style="color:#16a34a">+${d}</span>`
    return `<span style="color:#d97706">${d}</span>`
  }

  const rows = result.results.map(r => {
    if (r.status === 'ok') {
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
        <td style="padding:4px 8px;text-align:center">${r.ccspRows ?? '—'}</td>
        <td style="padding:4px 8px;text-align:center">${r.sfRows == null || r.sfRows < 0 ? '—' : r.sfRows}</td>
        <td style="padding:4px 8px;text-align:center">${fmtDelta(r.ccspDelta)}</td>
        <td style="padding:4px 8px;text-align:center">${fmtDelta(r.sfDelta)}</td>
        <td style="padding:4px 8px;color:#16a34a">OK</td>
      </tr>`
    }
    if (r.status === 'warn') {
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
        <td style="padding:4px 8px;text-align:center;color:#d97706">${r.ccspRows ?? '—'}</td>
        <td style="padding:4px 8px;text-align:center">${r.sfRows == null || r.sfRows < 0 ? '—' : r.sfRows}</td>
        <td style="padding:4px 8px;text-align:center">${fmtDelta(r.ccspDelta)}</td>
        <td style="padding:4px 8px;text-align:center">${fmtDelta(r.sfDelta)}</td>
        <td style="padding:4px 8px;color:#d97706">⚠️ WARN — CCSP returned 0 rows</td>
      </tr>`
    }
    if (r.status === 'skipped') {
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;text-align:center">—</td>
        <td style="padding:4px 8px;color:#d97706">⚠️ SKIPPED — ${r.reason ?? ''}</td>
      </tr>`
    }
    return `<tr>
      <td style="padding:4px 8px;font-family:monospace">${r.podKey}</td>
      <td style="padding:4px 8px;text-align:center">—</td>
      <td style="padding:4px 8px;text-align:center">—</td>
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
        <th style="padding:6px 8px">CCSP &#916;</th>
        <th style="padding:6px 8px">SF &#916;</th>
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

  // Determine primary folder for prev-status lookup (first region with a podBookingsFolderId)
  const primaryFolderId = regions.find(r => r.podBookingsFolderId)?.podBookingsFolderId ?? ''
  const prevStatus = await loadPrevSyncStatus(primaryFolderId)

  const results: PodResult[] = []

  for (const region of regions) {
    for (const [podKey, pod] of Object.entries(region.pods)) {
      console.log(`[sync-pod-l3] processing ${podKey}…`)

      // Pod readiness: must have sfReportId
      if (!pod.sfReportId) {
        console.log(`[sync-pod-l3] ${podKey}: no sfReportId — skipping`)
        results.push({ podKey, status: 'skipped', reason: 'no sfReportId' })
        continue
      }

      // #818: Bookings check is informational only — CCSP and SF pipeline are independent
      const bookingsPresent = await checkBookingsGSheetExists(region.podBookingsFolderId, podKey, pod.label)
      if (!bookingsPresent) {
        console.warn(`[sync-pod-l3] ${podKey}: no Bookings GSheet — subscription data via master ingest`)
      }

      try {
        // CCSP sync — scrapePodCcspRaw handles its own Drive cache check + write.
        // BKL-CCSP-RETRY-01: wrap in withCcspRetry so transient timeouts retry
        // with back-off + fresh context, and Tableau-auth-expired aborts the run.
        let ccspRows = 0
        let ccspRecovered = false
        let ccspAuthExpired = false
        try {
          const seedTerr = `${podKey}_TERR01`
          const retryResult = await withCcspRetry(
            () => scrapePodCcspRaw([seedTerr], region.podBookingsFolderId),
            podKey,
            {
              peekTableauSessionExpired,
              rebuildContext: async () => {
                const profileDir = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
                await initScrapeContext(profileDir)
              },
              sleep: (ms: number) => new Promise(res => setTimeout(res, ms)),
              writeRetryStatus: async ({ podKey: pk, attempt, nextRetryAt }) => {
                await writeRetryStatus(primaryFolderId, pk, attempt, nextRetryAt)
              },
            },
          )
          ccspRows = retryResult.value.rows.length
          ccspRecovered = retryResult.recovered
          console.log(
            `[sync-pod-l3] ${podKey}: CCSP rows=${ccspRows}` +
            (ccspRecovered ? ` (recovered after ${retryResult.attempts} attempts)` : ''),
          )
        } catch (ccspErr: any) {
          if (ccspErr instanceof CcspAuthExpiredError) {
            ccspAuthExpired = true
            console.error(`[sync-pod-l3] ${podKey}: ${ccspErr.message} — halting remaining PODs`)
          } else {
            console.warn(`[sync-pod-l3] ${podKey}: CCSP failed after retries: ${ccspErr.message} — continuing to SF sync`)
          }
        }

        if (ccspAuthExpired) {
          // Auth state is shared across all PODs; remaining work would also fail.
          results.push({ podKey, status: 'error', reason: 'auth_expired' })
          break
        }

        // SF pipeline sync
        const sfRows = await runSfPodSync(pod.sfReportId, podKey, region.podBookingsFolderId)
        console.log(`[sync-pod-l3] ${podKey}: SF rows=${sfRows}`)

        const prev = prevStatus.get(podKey)
        const ccspDelta = (prev?.ccspRows != null && ccspRows != null) ? ccspRows - prev.ccspRows : undefined
        const sfDelta = (prev?.sfRows != null && sfRows != null && sfRows >= 0) ? sfRows - prev.sfRows : undefined
        const podStatus: PodResult['status'] = (ccspRows === 0) ? 'warn' : 'ok'
        const podResult: PodResult = { podKey, status: podStatus, ccspRows, sfRows, ccspDelta, sfDelta }
        if (ccspRecovered) podResult.recovered = true
        results.push(podResult)
      } catch (e: any) {
        console.error(`[sync-pod-l3] ${podKey}: error: ${e.message}`)
        results.push({ podKey, status: 'error', reason: e.message })
      }
    }
    // Outer break propagation: if inner loop broke due to auth_expired,
    // halt all remaining regions too (auth is process-wide).
    if (results.some(r => r.reason === 'auth_expired')) break
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
  const warnCount = results.filter(r => r.status === 'warn').length
  const skippedCount = results.filter(r => r.status === 'skipped').length
  const errorCount = results.filter(r => r.status === 'error').length
  console.log(`[sync-pod-l3] done — ok=${okCount} warn=${warnCount} skipped=${skippedCount} errors=${errorCount}`)

  return runResult
}

// ADR-006 §2 H2 — SYNC_NOW standalone path removed.
// Manual immediate sync is achieved exclusively via the daemon trigger mechanism:
//   make sync-now   (→ podman exec pai-sync-l3 touch /data/cache/sync-trigger)
// This prevents Chromium SingletonLock conflicts when the daemon is running.
