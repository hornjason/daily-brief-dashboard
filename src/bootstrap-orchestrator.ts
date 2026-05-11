// ── Auto-bootstrap + Tableau routes (M03 — extracted from server.ts) ────────
import { Hono } from 'hono'
import { writeFileSync as writeFileSyncRaw, readFileSync, mkdirSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve, dirname } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from './google.ts'
import { driveClient } from './lib/drive-client.ts'
import { normalizeCustomerName } from './lib/customer-folder.ts'
import { aes, customers, saveAes, patchAe, CUSTOMERS_PATH } from './server-state.ts'
import { bootstrapAe as bootstrapAeL3, type AeBootstrapDeps } from './l3-bootstrap.ts'
import { runSfPipelineSync, runSfPipelineSyncFromData, scrapeSfReport, createPipelineSheet, type SfReportRow } from './sf-scraper.ts'
import { writeSubscriptionSheet } from './supportable-scraper.ts'
import { fetchSfBookingsRaw, deriveSfCustomersByTerritory, listPodBookingSheets, matchPodSheet } from './sf-bookings-reader.ts'
// BKL-ARCH-L4-SPLIT: ccsp-scraper and tableau-auth are L4-only modules — they belong
// in Dockerfile.l4, not the hero install image. These imports are intentionally replaced
// with no-op stubs so the hero module graph contains no browser-session code. The L4
// daemon container has its own paths into these scrapers; bootstrap-orchestrator routes
// in the hero image short-circuit through these stubs.
const runCcspScrape = async (..._args: any[]): Promise<any[]> => { throw new Error('[L4-stub] runCcspScrape invoked on hero install') }
const writeCcspSheet = async (..._args: any[]): Promise<string> => { throw new Error('[L4-stub] writeCcspSheet invoked on hero install') }
const consumeTableauSessionExpired = (): boolean => { console.warn('[L4-stub] consumeTableauSessionExpired invoked on hero install'); return false }
const parseTerritoryParts = (territory: string): {
  pod: string; subregion: string; segment: string; subsegment: string; region: string
} => {
  const parts = territory.split('_')
  return {
    pod: parts[0] ?? '',
    subregion: parts[3] ?? '',
    segment: parts[2] ?? '',
    subsegment: parts[4] ?? '',
    region: parts[0] ?? '',
  }
}
import { parseCsvToSfReport } from './csv-parse.ts'
import { fetchCustomerAccountNumbers, normalizeRows } from './sheets.ts'
import { writeSheetCache, readPipelineCache } from './cache-layer.ts'
import type { PipelineRecord } from './pipeline.ts'
// BKL-ARCH: removed `import { enqueueScraperTask } from './background-scheduler.ts'` —
// it was unused here (no call sites in this file) and created a circular import.
// We instead import setRunning from run-coordinator so this file can publish
// its bootstrap running-state to background-scheduler without the cycle.
import { setRunning as _coordSetRunning } from './lib/run-coordinator.ts'
import { getAiConfig } from './ai-config.ts'

import { getScrapeContext } from './rh-scraper.ts'
// BKL-ARCH-L4-SPLIT: tableau-auth stubbed (see comment above on ccsp-scraper)
const startTableauLoginBrowser = async (): Promise<void> => { console.warn('[L4-stub] startTableauLoginBrowser invoked on hero install') }
const waitForTableauLogin = async (_timeoutMs?: number): Promise<boolean> => { console.warn('[L4-stub] waitForTableauLogin invoked on hero install'); return false }
const checkTableauSessionFromCookies = async (): Promise<boolean> => { console.warn('[L4-stub] checkTableauSessionFromCookies invoked on hero install'); return false }
const probeTableauSession = async (): Promise<boolean> => { console.warn('[L4-stub] probeTableauSession invoked on hero install'); return false }
import { refreshPipeline, refreshSubscriptions } from './refresh-engine.ts'
import { inferCustomerDomain, isHighConfidenceDomain } from './domains.ts'
import { batchInferDomains, isPublicDomain, tier1Clearbit } from './domain-waterfall.ts'
import type { AE } from './types.ts'
import { sanitizeErr, isValidDriveFolderId } from './utils.ts'
import { loadProductIntelConfig, saveProductConfig, getProductIntelParentFolderId } from './product-release-radar.ts'
import { recordBootstrapRun } from './bootstrap-history.ts'
import { getBackupSheetId, setBackupSheetId, createBackupSheet } from './backup-config.ts'
import { normalizeSettings } from './region-config.ts'
import { emitCacheLevel } from './ingest-events.js'
import {
  autoBootstrapState,
  podBootstrapState,
  bootstrapFlags,
  lockState,
} from './bootstrap-state.ts'
import type { AutoBootstrapStep } from './bootstrap-state.ts'
export { autoBootstrapState, podBootstrapState } from './bootstrap-state.ts'
import { POD_CONFIG_PATH } from './config-reconciler.ts'
// BKL-ARCH-01: Extracted modules (ADR-005 — 500-line cap)
import {
  synthesizeSfReportFromPipelineRecords,
  podKeyFromTerritoryCode,
  readAEsFromTerritorySheet,
  isJunkCustomerName,
} from './bootstrap/territory-sheet.ts'
export {
  synthesizeSfReportFromPipelineRecords,
  podKeyFromTerritoryCode,
  readAEsFromTerritorySheet,
  isJunkCustomerName,
} from './bootstrap/territory-sheet.ts'
import { writeSfDriveCache, readSfDriveCache } from './bootstrap/sf-cache.ts'
export { writeSfDriveCache, readSfDriveCache } from './bootstrap/sf-cache.ts'
import {
  CACHE_HIER_FRESH_MS,
  isPipelineDiskCacheFreshForAe,
  isCcspDiskCacheFreshForAe,
  getSheetModifiedTime,
  readCcspFromAeSheet,
  readPipelineFromAeSheet,
  readSfBookingsFromAeSheet,
} from './lib/cache-hierarchy.ts'
// BKL-ARCH-01 (issue #54): per-step modules for the auto-bootstrap flow
import {
  ALL_STEPS,
  runBootstrapSteps,
  BootstrapCancelledError,
  type BootstrapContext,
} from './bootstrap/steps/index.ts'

// ── Constants ────────────────────────────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')
function getDataSourcesPath(): string {
  return resolve(process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config'), 'data-sources.json')
}
// SETTINGS_PATH moved to ./bootstrap/helpers.ts (BKL-ARCH-01) — re-exported here.
import { SETTINGS_PATH, findExistingSheet } from './bootstrap/helpers.ts'
export { SETTINGS_PATH, findExistingSheet } from './bootstrap/helpers.ts'
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'asa-command-center'

// ── POD config persistence ────────────────────────────────────────────────────
/** Save the POD bootstrap inputs to pod-config.json so they survive restarts. */
function savePodConfig(cfg: { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string }): void {
  try {
    let pod: Record<string, unknown> = {}
    try { pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8')) } catch { /* fresh file */ }
    writeJsonAtomic(POD_CONFIG_PATH, { ...pod, podConfig: cfg })
    console.log('[pod-bootstrap] POD config saved to pod-config.json')
  } catch (e: any) {
    console.warn('[pod-bootstrap] Could not save POD config:', e?.message)
  }
}

/** Read the last saved POD config from pod-config.json. Returns null if not saved. */
function readPodConfig(): { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string } | null {
  try {
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    return pod.podConfig ?? null
  } catch { return null }
}

// ── BKL-DRIVE-SCAFFOLD-CACHE-01: Drive scaffold ID cache ────────────────────

type ScaffoldEntry = {
  configFolderId: string
  productsFolderId: string
  // BKL-SCAFFOLD-STATUS-01: per-product slug → Drive folder ID map captured during
  // scaffolding so /api/bootstrap/scaffold-status can return it without a live Drive call.
  productSubfolders?: Record<string, string>
}

export function readScaffoldCache(): Record<string, ScaffoldEntry> {
  try {
    const pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8'))
    return (pod.scaffoldCache as Record<string, ScaffoldEntry>) ?? {}
  } catch { return {} }
}

export function writeScaffoldCache(parentFolderId: string, entry: ScaffoldEntry): void {
  // BKL-SEC-19: validate IDs before using them as JSON keys or persisting to disk
  if (!isValidDriveFolderId(parentFolderId)) return
  if (entry.configFolderId && !isValidDriveFolderId(entry.configFolderId)) return
  if (entry.productsFolderId && !isValidDriveFolderId(entry.productsFolderId)) return
  // Validate any per-slug subfolder IDs as well — silently drop invalid ones
  // rather than reject the whole entry (caller may legitimately have partial data).
  const safeSubfolders: Record<string, string> = {}
  if (entry.productSubfolders) {
    for (const [slug, id] of Object.entries(entry.productSubfolders)) {
      if (typeof id === 'string' && isValidDriveFolderId(id)) safeSubfolders[slug] = id
    }
  }
  try {
    let pod: Record<string, unknown> = {}
    try { pod = JSON.parse(readFileSync(POD_CONFIG_PATH, 'utf-8')) } catch { /* fresh */ }
    const cache = (pod.scaffoldCache as Record<string, ScaffoldEntry>) ?? {}
    const persisted: ScaffoldEntry = {
      configFolderId: entry.configFolderId,
      productsFolderId: entry.productsFolderId,
      productSubfolders: safeSubfolders,
    }
    writeJsonAtomic(POD_CONFIG_PATH, { ...pod, scaffoldCache: { ...cache, [parentFolderId]: persisted } })
  } catch (e: any) {
    console.warn('[auto-bootstrap:scaffold] cache write failed (non-blocking):', e?.message)
  }
}

// ── BKL-DRIVE-SCAFFOLD-01 ────────────────────────────────────────────────────
/**
 * Idempotently scaffold `Config/` and `Products/<slug>` folders under the
 * AE/POD parentFolderId. Runs once per bootstrap, before AE Drive folder
 * creation (Step 0). Non-fatal: any Drive API failure is logged and
 * swallowed so the wider bootstrap can continue.
 *
 * Note: folder IDs are logged only — they are NOT persisted to settings.json
 * or any config file in this pass. BKL-DRIVE-PRODUCTS-ROOT-01 will wire the
 * product folder IDs into products.json in a follow-up.
 */
async function ensureConfigAndProductsScaffold(parentFolderId: string): Promise<ScaffoldEntry | null> {
  if (!parentFolderId) return null
  // BKL-DRIVE-SCAFFOLD-CACHE-01: cache hit → skip all Drive list calls (saves ~9 calls per invocation)
  const cachedEntry = readScaffoldCache()[parentFolderId]
  if (cachedEntry?.configFolderId && cachedEntry?.productsFolderId) {
    console.log(`[auto-bootstrap:scaffold] cache hit for parentFolderId=${parentFolderId} — skipping Drive list calls`)
    return cachedEntry
  }
  // BKL-DRIVE-SCAFFOLD-SLUGS-01: derive slugs from products.json — single source of truth
  // BKL-SEC-SLUG-VALIDATE-01: validate slug shape before passing to Drive; deduplicate
  const SLUG_RE = /^[a-z0-9-]{1,64}$/
  const rawSlugs = loadProductIntelConfig().products.map(p => p.slug)
  const productSlugs = [...new Set(rawSlugs.filter(s => {
    if (!SLUG_RE.test(s)) {
      console.warn(`[auto-bootstrap:scaffold] skipping invalid slug "${s}" (must match /^[a-z0-9-]{1,64}$/)`)
      return false
    }
    return true
  }))]
  console.log(`[auto-bootstrap:scaffold] ensuring Config/ and Products/ under parentFolderId=${parentFolderId}`)
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const findOrCreateFolder = async (name: string, parentId: string): Promise<string | null> => {
      const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const existing = await withQuotaRetry(
        () => drive.files.list({
          q: `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id, name)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        })
      ).catch(() => ({ data: { files: [] as Array<{ id?: string | null }> } }))
      if (existing.data.files?.length) {
        return existing.data.files[0].id ?? null
      }
      const created = await withQuotaRetry(
        () => drive.files.create({
          requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
          supportsAllDrives: true,
          fields: 'id',
        })
      ).catch(() => null)
      return created?.data.id ?? null
    }

    const configFolderId = await findOrCreateFolder('Config', parentFolderId)
    const productsFolderId = await findOrCreateFolder('Products', parentFolderId)
    // BKL-SCAFFOLD-STATUS-01: capture per-slug folder IDs so the scaffold-status
    // endpoint can return them without a live Drive call.
    const productSubfolders: Record<string, string> = {}
    if (productsFolderId) {
      for (const slug of productSlugs) {
        const slugId = await findOrCreateFolder(slug, productsFolderId)
        if (!slugId) {
          console.warn(`[auto-bootstrap:scaffold] failed to ensure Products/${slug} (non-blocking)`)
        } else {
          productSubfolders[slug] = slugId
        }
      }
    }
    console.log(`[auto-bootstrap:scaffold] done — configFolderId=${configFolderId ?? 'null'} productsFolderId=${productsFolderId ?? 'null'} subfolders=${Object.keys(productSubfolders).length}`)
    if (!configFolderId || !productsFolderId) return null
    const result: ScaffoldEntry = { configFolderId, productsFolderId, productSubfolders }
    writeScaffoldCache(parentFolderId, result)  // BKL-DRIVE-SCAFFOLD-CACHE-01
    return result
  } catch (e: any) {
    console.warn('[auto-bootstrap:scaffold] failed (non-blocking):', e?.message ?? e)
    return null
  }
}

async function notify(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'default'): Promise<void> {
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: { 'Title': title, 'Priority': priority, 'Content-Type': 'text/plain' },
      body: message,
    })
  } catch (e: any) {
    console.warn('[ntfy] notification failed:', e?.message ?? e)
  }
}

// findExistingSheet moved to ./bootstrap/helpers.ts (BKL-ARCH-01) — see import above.

/** Salesforce report/object ID — alphanumeric only, 15-18 chars. */
function isValidSfId(value: unknown): boolean {
  if (typeof value !== 'string') return true
  if (value === '') return true
  return /^[A-Za-z0-9]{15,18}$/.test(value)
}

/**
 * BKL-F07: Extract a bare SF report ID from a full Salesforce URL or return as-is if already bare.
 */
function extractSfReportId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^[A-Za-z0-9]{15,18}$/.test(trimmed)) return trimmed
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^[A-Za-z0-9]{15,18}$/.test(segments[i])) return segments[i]
      }
    } catch { /* not a valid URL */ }
  }
  return trimmed
}

// isJunkCustomerName — moved to ./bootstrap/territory-sheet.ts (BKL-ARCH-01)

/** BKL-W2-17: Exposed so background-scheduler can include bootstrap in isAnyScraperRunning() guard.
 *  Note: background-scheduler no longer imports this directly — it reads run-coordinator's
 *  isAnyRunning() instead (BKL-ARCH circular-import break). This function is kept for any
 *  remaining intra-file/test callers and is also the canonical source the sync helper below uses. */
export function isBootstrapRunning(): boolean { return autoBootstrapState.running || podBootstrapState.running }

/** BKL-ARCH: Sync bootstrap running-state to the run-coordinator. Called after every mutation
 *  of autoBootstrapState.running / podBootstrapState.running so background-scheduler's
 *  isAnyScraperRunning() (which reads run-coordinator) stays consistent with bootstrap state. */
function syncBootstrapRunningToCoordinator(): void {
  _coordSetRunning('bootstrap', isBootstrapRunning())
}

/** Clear both bootstrap states — called by /api/setup/reset so UI doesn't show stale last-run details after a wipe. */
export function resetBootstrapStates(): void {
  Object.assign(autoBootstrapState, { running: false, steps: [], aeName: null, completedAt: null, error: null, resources: {} })
  Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
  syncBootstrapRunningToCoordinator()
  bootstrapFlags.autoBootstrapCancelRequested = false
}

// BKL-BOOTSTRAP-CANCEL-01: Per-step watchdog timeout — fires if a step hangs on a network call
const STEP_TIMEOUT_MS = 90_000

// ── POD Bootstrap ───────────────────────────────────────────────────────────

/** BKL-WIZ-02: Cancellation flag — checked between AE steps in the POD bootstrap loop. */
let podBootstrapCancelled = false

// BKL-PERF-01: Cache SF report data during POD bootstrap to avoid re-scraping per AE
let podSfDataCache: { reportId: string; data: SfReportRow; expiresAt: number } | null = null
const POD_SF_CACHE_TTL_MS = 30 * 60 * 1000  // 30 min — safe within a single bootstrap run

// BKL-TOKEN-07: When a fresh disk pipeline cache exists, skip the live SF pre-scrape
// during POD bootstrap. The disk cache is written by refreshPipeline() after prior
// runs parsed each AE's pipeline sheet. 4h is conservative — SF pipeline data changes
// slowly within a business day, and any AE-level refresh still runs refreshPipeline()
// after bootstrap to re-sync from Google Sheets.
const PIPELINE_DISK_TTL_MS = 4 * 60 * 60 * 1000  // 4h

// synthesizeSfReportFromPipelineRecords — moved to ./bootstrap/territory-sheet.ts (BKL-ARCH-01)


// writeSfDriveCache — moved to ./bootstrap/sf-cache.ts (BKL-ARCH-01)

// readSfDriveCache — moved to ./bootstrap/sf-cache.ts (BKL-ARCH-01)

export function requestPodBootstrapCancel(): boolean {
  if (!podBootstrapState.running) return false
  podBootstrapCancelled = true
  return true
}

// podKeyFromTerritoryCode, readAEsFromTerritorySheet — moved to ./bootstrap/territory-sheet.ts (BKL-ARCH-01)

/**
 * Check if an AE is considered "already bootstrapped" — has all 4 key sheet IDs
 * and a Drive folder.
 */
function isAEFullyBootstrapped(aeConfig: AE): boolean {
  return !!(
    aeConfig.driveFolderId &&
    aeConfig.subscriptionSheetId &&
    aeConfig.pipelineSheetId &&
    aeConfig.ccspSheetId
  )
}

/**
 * Bootstrap all AEs in the POD sequentially from a territory sheet.
 * Reads the AE list from the territory sheet URL/ID, then calls bootstrapAE() per AE
 * via the internal HTTP endpoint (fire-and-forget + poll pattern).
 *
 * Options:
 *   territorySheetId: the Google Sheet containing the AE list
 *   force: if true, re-bootstrap AEs that already have all 4 sheet IDs (normally skipped)
 *   onProgress: callback called after each AE completes
 */
async function bootstrapPOD(opts: {
  territorySheetId: string
  sfReportId: string
  parentFolderId: string
  podTabTitle?: string
  force?: boolean
  onProgress?: (info: { aeName: string; index: number; total: number; status: 'skipped' | 'ok' | 'error'; error?: string }) => void
}): Promise<{ succeeded: string[]; skipped: string[]; failed: Array<{ name: string; error: string }> }> {
  const { territorySheetId, sfReportId, parentFolderId, podTabTitle, force = false, onProgress } = opts
  const port = process.env.PORT ?? '7777'
  const baseUrl = `http://localhost:${port}`

  // Step 1: Read territory sheet to discover AEs + their customer lists
  console.log(`[pod-bootstrap] Reading territory sheet ${territorySheetId}…`)
  const aeEntries = await readAEsFromTerritorySheet(territorySheetId, podTabTitle)
  if (aeEntries.length === 0) {
    throw new Error('No AEs found in territory sheet — check that the sheet has "Account Executive" header rows')
  }
  console.log(`[pod-bootstrap] Found ${aeEntries.length} AEs in territory sheet: ${aeEntries.map(a => a.aeName).join(', ')}`)
  // Persist POD config so it survives server restarts and can seed future re-runs
  savePodConfig({ territorySheetId, sfReportId, parentFolderId, podTabTitle })

  // BKL-DRIVE-SCAFFOLD-01: Idempotently scaffold Config/ and Products/<slug> under parentFolderId.
  // Runs once per POD bootstrap, before per-AE Drive folder creation. Non-fatal.
  const scaffoldResult = await ensureConfigAndProductsScaffold(parentFolderId)

  // BKL-BACKUP-01 / BKL-DRIVE-APPBACKUP-01: Create config backup sheet in Config/ subfolder.
  // Fall back to parentFolderId if scaffold didn't run (no auth, existing install, etc.)
  const backupTargetFolder = scaffoldResult?.configFolderId ?? parentFolderId
  if (!getBackupSheetId() && parentFolderId) {
    try {
      const backupId = await createBackupSheet(backupTargetFolder)
      setBackupSheetId(backupId)
      console.log(`[backup] Config Backup sheet created: ${backupId}`)
    } catch (e: any) {
      console.warn('[backup] Could not create backup sheet during bootstrap:', e.message)
    }
  }

  const succeeded: string[] = []
  const skipped: string[] = []
  const failed: Array<{ name: string; error: string }> = []

  // Initialize POD bootstrap state for status endpoint
  const podStartedAt = new Date().toISOString()
  Object.assign(podBootstrapState, {
    running: true,
    total: aeEntries.length,
    completed: 0,
    currentAE: null,
    results: aeEntries.map(e => ({ name: e.aeName, status: 'pending' as const })),
    startedAt: podStartedAt,
    completedAt: null,
    error: null,
  })
  syncBootstrapRunningToCoordinator()

  // Dynamic timeout: 30 min per AE
  const podTimeoutMs = aeEntries.length * 30 * 60 * 1000
  const podTimeoutId = setTimeout(() => {
    if (podBootstrapState.running) {
      podBootstrapState.running = false
      syncBootstrapRunningToCoordinator()
      podBootstrapState.completedAt = new Date().toISOString()
      podBootstrapState.error = `POD bootstrap timed out after ${Math.round(podTimeoutMs / 60000)} minutes`
      console.error(`[pod-bootstrap] Hard timeout reached (${Math.round(podTimeoutMs / 60000)} min)`)
    }
  }, podTimeoutMs)

  // BKL-WIZ-02: Reset cancellation flag at start
  podBootstrapCancelled = false

  // ─── BKL-CACHE-HIER-01: 4-level cache hierarchy probe (per AE) ───────────────
  // Before the shared SF pre-scrape + per-AE CCSP scrape, log which cache level
  // each AE can satisfy. Opportunistically populate podSfDataCache from any AE
  // whose Pipeline sheet is fresh (L2) so the subsequent pre-scrape block can
  // skip the live SF scrape entirely.
  // L1 = on-disk pipeline/ccsp cache cachedAt<24h
  // L2 = AE Drive sheet modifiedTime<24h (already parsed + per-AE)
  // L3 = Subscription Data folder CSV <24h (handled inside scrapeOneAe / SF Drive cache)
  // L4 = live Tableau/SF scrape
  for (const preEntry of aeEntries) {
    const preAe = aes.find(a => a.name === preEntry.aeName)
    const ccspSheetId = preAe?.ccspSheetId
    const pipelineSheetId = preAe?.pipelineSheetId

    // -- SF pipeline probe --------------------------------------------------
    if (isPipelineDiskCacheFreshForAe(pipelineSheetId)) {
      console.log(`[bootstrap] ${preEntry.aeName}: SF cache L1 hit (disk)`)
      emitCacheLevel({ ae: preEntry.aeName, flow: 'sfPipeline', level: 1 })
    } else if (pipelineSheetId) {
      const sfMt = await getSheetModifiedTime(pipelineSheetId)
      const sfFresh = sfMt ? (Date.now() - sfMt.getTime()) < CACHE_HIER_FRESH_MS : false
      if (sfFresh) {
        console.log(`[bootstrap] ${preEntry.aeName}: SF cache L2 hit (AE sheet)`)
        emitCacheLevel({ ae: preEntry.aeName, flow: 'sfPipeline', level: 2 })
        // Opportunistically warm podSfDataCache if empty/stale — skips pre-scrape below.
        if (!podSfDataCache || podSfDataCache.reportId !== sfReportId || Date.now() > podSfDataCache.expiresAt) {
          const sheetData = await readPipelineFromAeSheet(pipelineSheetId)
          if (sheetData && sheetData.rows.length > 0) {
            podSfDataCache = { reportId: sfReportId, data: sheetData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
            console.log(`[bootstrap] ${preEntry.aeName}: SF L2 populated podSfDataCache — ${sheetData.rows.length} rows`)
          }
        }
      } else {
        console.log(`[bootstrap] ${preEntry.aeName}: SF cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
      }
    } else {
      console.log(`[bootstrap] ${preEntry.aeName}: SF cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
    }

    // -- CCSP probe ---------------------------------------------------------
    if (isCcspDiskCacheFreshForAe(ccspSheetId)) {
      console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L1 hit (disk)`)
      emitCacheLevel({ ae: preEntry.aeName, flow: 'ccsp', level: 1 })
    } else if (ccspSheetId) {
      const ccspMt = await getSheetModifiedTime(ccspSheetId)
      const ccspFresh = ccspMt ? (Date.now() - ccspMt.getTime()) < CACHE_HIER_FRESH_MS : false
      if (ccspFresh) {
        console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L2 hit (AE sheet)`)
        emitCacheLevel({ ae: preEntry.aeName, flow: 'ccsp', level: 2 })
      } else {
        console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
      }
    } else {
      console.log(`[bootstrap] ${preEntry.aeName}: CCSP cache L3 candidate (Subscription Data CSV) / L4 fresh scrape`)
    }
  }

  // BKL-PERF-01: Pre-scrape SF report once for all AEs — avoids N redundant browser sessions
  if (!podSfDataCache || podSfDataCache.reportId !== sfReportId || Date.now() > podSfDataCache.expiresAt) {
    // BKL-SFCACHE-01: Resolve podBookingsFolderId + podName for Drive-backed SF pipeline cache.
    // Mirrors the CCSP Drive cache pattern: 24h TTL keyed by SF-PIPELINE-<reportId>-<pod>-<date>.csv.
    // Non-fatal — any Drive failure falls through to the disk pipeline cache + live scrape.
    let podBookingsFolderId = ''
    let podName = ''
    try {
      const firstTerritory = aeEntries.find(e => e.territories.length > 0)?.territories[0]
      if (firstTerritory) podName = parseTerritoryParts(firstTerritory).pod
      const rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      const normalized = normalizeSettings(rawSettings)
      const podKey = firstTerritory?.replace(/_TERR\d+$/, '')
      const region = podKey
        ? (normalized.regions.find(r => podKey in r.pods) ?? normalized.regions[0])
        : normalized.regions[0]
      podBookingsFolderId = region?.podBookingsFolderId ?? ''
    } catch { /* no settings — skip Drive cache, fall through to disk + scrape */ }

    const today = new Date().toISOString().slice(0, 10)
    const sfCacheFileName = podName ? `SF-PIPELINE-${sfReportId}-${podName}-${today}.csv` : ''

    // BKL-SFCACHE-01: Drive cache read — skip scrape entirely if today's SF-PIPELINE CSV exists.
    let driveSfData: SfReportRow | null = null
    if (podBookingsFolderId && sfCacheFileName) {
      driveSfData = await readSfDriveCache(podBookingsFolderId, sfCacheFileName)
      if (driveSfData) {
        console.log(`[pod-bootstrap] SF Drive cache hit — ${driveSfData.rows.length} rows from ${sfCacheFileName}`)
      }
    }

    if (driveSfData) {
      podSfDataCache = { reportId: sfReportId, data: driveSfData, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
    } else {
      // BKL-TOKEN-07: Check disk pipeline cache before the live SF scrape. If a recent
      // parse exists (<4h), synthesize an SfReportRow from it and skip the browser-driven
      // scrape entirely. Saves one expensive SF browser session per POD bootstrap run.
      const diskPipeline = readPipelineCache()
      const diskPipelineAgeMs = diskPipeline?.cachedAt
        ? Date.now() - new Date(diskPipeline.cachedAt).getTime()
        : Infinity

      if (diskPipelineAgeMs < PIPELINE_DISK_TTL_MS && diskPipeline?.records?.length) {
        const synthesized = synthesizeSfReportFromPipelineRecords(diskPipeline.records)
        podSfDataCache = { reportId: sfReportId, data: synthesized, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
        console.log(
          `[pod-bootstrap] Reusing disk pipeline cache (${diskPipeline.records.length} records, ` +
          `${Math.round(diskPipelineAgeMs / 60000)}m old) — skipping live SF scrape ` +
          `(synthesized ${synthesized.rows.length} rows for ${aeEntries.length} AEs)`,
        )
      } else {
        console.log(`[pod-bootstrap] Pre-scraping SF report ${sfReportId} for ${aeEntries.length} AEs…`)
        try {
          const data = await scrapeSfReport(sfReportId, RH_PROFILE_DIR)
          podSfDataCache = { reportId: sfReportId, data, expiresAt: Date.now() + POD_SF_CACHE_TTL_MS }
          console.log(`[pod-bootstrap] SF report cached: ${data.rows.length} rows`)
          // BKL-SFCACHE-01: Write Drive cache so next bootstrap within 24h skips the browser scrape
          if (podBookingsFolderId && sfCacheFileName && data.rows.length > 0) {
            await writeSfDriveCache(data, podBookingsFolderId, sfReportId, podName, sfCacheFileName)
          }
        } catch (e: any) {
          console.warn(`[pod-bootstrap] SF pre-scrape failed — each AE will scrape individually: ${e?.message}`)
          podSfDataCache = null
        }
      }
    }
  } else {
    console.log(`[pod-bootstrap] Reusing cached SF report data (${aeEntries.length} AEs)`)
  }

  // Step 2: Sequential bootstrap per AE
  for (let i = 0; i < aeEntries.length; i++) {
    if (!podBootstrapState.running) break  // timeout triggered
    // BKL-WIZ-02: Check cancellation between AE steps
    if (podBootstrapCancelled) {
      console.log(`[pod-bootstrap] Cancelled by user after ${i} AE(s)`)
      podBootstrapState.error = `Cancelled by user after ${i} AE(s) completed`
      // Mark remaining AEs as skipped
      for (let j = i; j < aeEntries.length; j++) {
        if (podBootstrapState.results[j].status === 'pending') {
          podBootstrapState.results[j] = { name: aeEntries[j].aeName, status: 'skipped' }
        }
      }
      break
    }

    const entry = aeEntries[i]
    const { aeName, territories, customerNames } = entry

    podBootstrapState.currentAE = aeName
    const aeStartMs = Date.now()
    podBootstrapState.results[i] = { ...podBootstrapState.results[i], startedAt: new Date().toISOString() }

    // Check if AE exists in aes.json with required config
    let aeConfig = aes.find(a => a.name === aeName)

    // Idempotency: skip if already fully bootstrapped (unless force)
    if (aeConfig && isAEFullyBootstrapped(aeConfig) && !force) {
      console.log(`[pod-bootstrap] Skipping ${aeName} — already fully bootstrapped`)
      skipped.push(aeName)
      podBootstrapState.results[i] = { name: aeName, status: 'skipped' }
      podBootstrapState.completed++
      onProgress?.({ aeName, index: i, total: aeEntries.length, status: 'skipped' })
      continue
    }

    // Create or update AE in aes.json using POD-level sfReportId + parentFolderId
    // REG-CONN-02: pod config is always source of truth — always write sfReportId
    // regardless of whether the AE already has one. The old `else if (!aeConfig.sfReportId)`
    // guard prevented correcting wrong report IDs on existing AEs.
    if (!aeConfig) {
      const newAe = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories: territories, parentFolderId }
      saveAes([...aes, newAe])
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Created new AE entry for ${aeName}`)
    } else {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, parentFolderId } : a)
      saveAes(updated)
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Updated sfReportId for ${aeName}`)
    }

    // Wait for any in-progress single-AE bootstrap to finish before starting the next.
    // BKL-DOM-INF-01: also wait on the post-bootstrap domain inference IIFE — it mutates
    // customers.json and would race with the next AE's bootstrap if we let it overlap.
    while (autoBootstrapState.running || bootstrapFlags.inferenceRunning) {
      await new Promise(r => setTimeout(r, 3000))
    }

    // Fire the bootstrap for this AE via internal endpoint
    console.log(`[pod-bootstrap] Starting bootstrap for ${aeName} (${i + 1}/${aeEntries.length})…`)
    try {
      const MAX_409_RETRIES = 3
      let startRes: Response | null = null
      for (let attempt = 1; attempt <= MAX_409_RETRIES; attempt++) {
        startRes = await fetch(`${baseUrl}/api/bootstrap/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            aeName,
            sfReportId: aeConfig.sfReportId,
            tableauTerritories: territories.length > 0 ? territories : aeConfig.tableauTerritories,
            customerNames,
            parentFolderId: aeConfig.parentFolderId,
          }),
        })

        if (startRes.status === 409 && attempt < MAX_409_RETRIES) {
          console.log(`[bootstrap] 409 — scraper busy, waiting 30s (attempt ${attempt}/${MAX_409_RETRIES})`)
          await new Promise(r => setTimeout(r, 30_000))
          continue
        }
        break
      }

      if (!startRes!.ok) {
        const body = await startRes!.json().catch(() => ({ error: `HTTP ${startRes!.status}` }))
        throw new Error((body as any).error ?? `Bootstrap start failed: HTTP ${startRes!.status}`)
      }

      // Poll until this AE's bootstrap completes
      // BKL-POD-02: 30 min per AE (was 15) — AEs with 10+ accounts need more time
      const perAeTimeoutMs = 30 * 60 * 1000
      const deadline = Date.now() + perAeTimeoutMs
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000))
        if (!autoBootstrapState.running) break
      }

      if (autoBootstrapState.running) {
        // Still running after per-AE timeout — force-reset and record error
        autoBootstrapState.running = false
        syncBootstrapRunningToCoordinator()
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = `Timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes (POD bootstrap)`
        throw new Error(`Bootstrap for ${aeName} timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes`)
      }

      // Check if bootstrap had errors
      if (autoBootstrapState.error) {
        const err = autoBootstrapState.error
        console.warn(`[pod-bootstrap] ${aeName} completed with error: ${err}`)
        // Still count as succeeded if some steps completed — error might be non-fatal
        const hasAnySheet = !!(aes.find(a => a.name === aeName)?.subscriptionSheetId ||
                              aes.find(a => a.name === aeName)?.pipelineSheetId ||
                              aes.find(a => a.name === aeName)?.ccspSheetId)
        if (hasAnySheet) {
          succeeded.push(aeName)
          const aeCustomerCount = customers.filter(c => c.ae === aeName).length
          podBootstrapState.results[i] = { name: aeName, status: 'ok', customerCount: aeCustomerCount }
        } else {
          failed.push({ name: aeName, error: err })
          podBootstrapState.results[i] = { name: aeName, status: 'error', error: err }
        }
      } else {
        succeeded.push(aeName)
        const aeCustomerCount = customers.filter(c => c.ae === aeName).length
        podBootstrapState.results[i] = { name: aeName, status: 'ok', customerCount: aeCustomerCount }
        console.log(`[pod-bootstrap] ${aeName} bootstrap complete (${aeCustomerCount} customers)`)
      }
    } catch (e: any) {
      const err = e?.message ?? String(e)
      console.error(`[pod-bootstrap] ${aeName} failed: ${err}`)
      failed.push({ name: aeName, error: err })
      podBootstrapState.results[i] = { name: aeName, status: 'error', error: err }
    }

    const aeDurationMs = Date.now() - aeStartMs
    podBootstrapState.results[i] = {
      ...podBootstrapState.results[i],
      completedAt: new Date().toISOString(),
      durationMs: aeDurationMs,
    }
    podBootstrapState.completed++
    onProgress?.({
      aeName,
      index: i,
      total: aeEntries.length,
      status: podBootstrapState.results[i].status === 'ok' ? 'ok' : podBootstrapState.results[i].status === 'skipped' ? 'skipped' : 'error',
      error: podBootstrapState.results[i].error,
    })
  }

  // Step 3: Auto-retry pass for AEs with zero customers (one retry only)
  // Note: accountNumbers are populated by the RH scraper separately — not during bootstrap.
  // Only retry if no customers were discovered at all (SF sheet returned nothing).
  const zeroAccountAEs = succeeded.filter(aeName => {
    const aeCustomers = customers.filter(c => c.ae === aeName)
    return aeCustomers.length === 0
  })

  if (zeroAccountAEs.length > 0 && podBootstrapState.running) {
    console.log(`[pod-bootstrap] Auto-retry: ${zeroAccountAEs.length} AE(s) with zero accounts: ${zeroAccountAEs.join(', ')}`)

    for (const aeName of zeroAccountAEs) {
      if (!podBootstrapState.running) break

      const idx = aeEntries.findIndex(e => e.aeName === aeName)
      if (idx >= 0) podBootstrapState.results[idx] = { name: aeName, status: 'retrying' }
      podBootstrapState.currentAE = `${aeName} (retry)`

      const entry = aeEntries.find(e => e.aeName === aeName)
      const aeConfig = aes.find(a => a.name === aeName)
      if (!entry || !aeConfig?.sfReportId) continue

      // Wait for any in-progress bootstrap
      while (autoBootstrapState.running) {
        await new Promise(r => setTimeout(r, 3000))
      }

      try {
        console.log(`[pod-bootstrap] Retrying bootstrap for ${aeName}…`)
        const startRes = await fetch(`${baseUrl}/api/bootstrap/auto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            aeName,
            sfReportId: aeConfig.sfReportId,
            tableauTerritories: entry.territories.length > 0 ? entry.territories : aeConfig.tableauTerritories,
            customerNames: entry.customerNames,
            parentFolderId: aeConfig.parentFolderId,
          }),
        })

        if (!startRes.ok) {
          console.warn(`[pod-bootstrap] Retry for ${aeName} failed to start`)
          continue
        }

        const deadline = Date.now() + 30 * 60 * 1000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 5000))
          if (!autoBootstrapState.running) break
        }

        const retryCustomerCount = customers.filter(c => c.ae === aeName).length
        if (idx >= 0) {
          podBootstrapState.results[idx] = {
            name: aeName,
            status: retryCustomerCount > 0 ? 'ok' : 'error',
            customerCount: retryCustomerCount,
            error: retryCustomerCount === 0 ? 'Zero customers after retry' : undefined,
          }
        }
        console.log(`[pod-bootstrap] Retry for ${aeName}: ${retryCustomerCount} customers`)
      } catch (e: any) {
        console.warn(`[pod-bootstrap] Retry for ${aeName} failed: ${e?.message}`)
        if (idx >= 0) {
          podBootstrapState.results[idx] = { name: aeName, status: 'error', error: `Retry failed: ${e?.message}` }
        }
      }
    }
  }

  clearTimeout(podTimeoutId)
  const podTotalMs = Date.now() - new Date(podStartedAt).getTime()
  podBootstrapState.running = false
  syncBootstrapRunningToCoordinator()
  podBootstrapState.currentAE = null
  podBootstrapState.completedAt = new Date().toISOString()
  podBootstrapState.totalDurationMs = podTotalMs
  console.log(`[pod-bootstrap] Complete: ${succeeded.length} succeeded, ${skipped.length} skipped, ${failed.length} failed — total ${Math.round(podTotalMs / 60000)}min`)

  // BKL-TOKEN-03: Fire intelligence + brief pregen ONCE after the full AE loop completes.
  // Previously these fired from the per-AE /api/bootstrap/auto handler, so a POD with N AEs
  // triggered N pregen batches (each rescanning every customer). Now a single POD bootstrap
  // runs one pregen pass for all newly-bootstrapped customers.
  if (succeeded.length > 0) {
    if (getAiConfig().intelligenceEnabled) {
      fetch(`${baseUrl}/api/intelligence/generate-all`, { method: 'POST' })
        .then(r => console.log(`[pod-bootstrap] intelligence batch started: ${r.status}`))
        .catch(e => console.warn('[pod-bootstrap] intelligence batch trigger failed:', e?.message))
    } else {
      console.log('[pod-bootstrap] intelligence generation skipped — intelligenceEnabled=false')
    }

    fetch(`${baseUrl}/api/briefs/pregen-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[pod-bootstrap] brief pregen triggered: ${d?.message ?? 'ok'}`))
      .catch(e => console.warn('[pod-bootstrap] brief pregen trigger failed:', e?.message))

    // BKL-HERO-PRODUCT-PREREQ-01: Trigger product refresh after bootstrap completes
    // (OAuth keys now exist, products can synthesize with Gemini)
    fetch(`${baseUrl}/api/products/refresh-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[pod-bootstrap] product refresh triggered: ${d?.count ?? 0} products`))
      .catch(e => console.warn('[pod-bootstrap] product refresh trigger failed:', e?.message))

    // BKL-HERO-GCP-PROJECT-01: Trigger feature extraction after summaries refresh
    // (Both GOOGLE_CLOUD_PROJECT and OAuth keys now available)
    fetch(`${baseUrl}/api/products/features/refresh-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[pod-bootstrap] feature extraction triggered: ${d?.products?.length ?? 0} products`))
      .catch(e => console.warn('[pod-bootstrap] feature extraction trigger failed:', e?.message))
  }

  // BKL-BOOT-SCRAPE-ORDER-01: RH Cases is scheduled-only — it runs on its own timer
  // (background-scheduler), not during bootstrap. Triggering it here previously raced
  // SF/CCSP scrapes on the shared Chromium context. Account discovery and case fetch
  // will happen at the next scheduled RH cases run.
  // (Previously BKL-BOOT-06 / BKL-BOOT-07 enqueued two passes here — removed.)

  return { succeeded, skipped, failed }
}

// ── Tableau constant ─────────────────────────────────────────────────────────
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

// startAccountDiscovery() removed — account discovery now handled by RH Cases scraper
// (runRhScrapeWithState in scraper-manager.ts searches by customer name when accountNumbers is empty)

// ── Tableau status cache (module-scope for reset on wipe) ────────────────────

let _tableauStatusCache: { result: { reachable: boolean; sessionValid: boolean }; cachedAt: number } | null = null

/** BKL-UX-WIPE-CONN-RESET-02: Invalidate cached Tableau session status so the next
 *  /api/bootstrap/tableau/session-status call does a live probe rather than returning
 *  stale sessionValid:true after a wipe. */
export function resetTableauStatusCache(): void {
  _tableauStatusCache = null
}

// ── Auto-bootstrap flow (BKL-ARCH-01 / issue #54) ──────────────────────────
// Extracted from the inner IIFE in `createBootstrapRouter()`. Owns the per-AE
// scaffold pre-flight, the 5-step runner invocation, post-step domain
// inference, and final cleanup + history. The route handler now just sets up
// state and fires this function (await-free — fire-and-forget polling pattern).

interface AutoBootstrapInputs {
  aeName: string
  customerNames: string[]
  sfReportId: string
  tableauTerritories: string[]
  parentFolderId?: string
  podName?: string
  /** BKL-HERO-PARENT-REGION-BUG: for region-scoped settings validation */
  regionId?: string
}

function runAutoBootstrap(inputs: AutoBootstrapInputs): void {
  const { aeName, customerNames, sfReportId, tableauTerritories, parentFolderId, podName, regionId } = inputs

  const baseUrl = `http://localhost:${process.env.PORT ?? '7777'}`
  const bootstrapStartMs = Date.now()
  const stepStartMs: Record<number, number> = {}

  const setStep = (idx: number, status: AutoBootstrapStep['status'], detail?: string): void => {
    const now = Date.now()
    const existing = autoBootstrapState.steps[idx] ?? {} as AutoBootstrapStep
    if (status === 'running' && !stepStartMs[idx]) {
      stepStartMs[idx] = now
    }
    const isFinished = status === 'done' || status === 'error' || status === 'skipped'
    autoBootstrapState.steps[idx] = {
      ...existing,
      status,
      detail,
      ...(status === 'running' && !existing.startedAt ? { startedAt: new Date(now).toISOString() } : {}),
      ...(isFinished && stepStartMs[idx] ? {
        completedAt: new Date(now).toISOString(),
        durationMs: now - stepStartMs[idx],
      } : {}),
    }
  }

  // Hard timeout: scales with AE count (min 60 min, +30 min per AE)
  const autoTimeoutMin = Math.max(60, aes.length * 30)
  const bootstrapTimeoutId = setTimeout(() => {
    if (autoBootstrapState.running) {
      autoBootstrapState.running = false
      syncBootstrapRunningToCoordinator()
      autoBootstrapState.completedAt = new Date().toISOString()
      autoBootstrapState.error = `Bootstrap timed out after ${autoTimeoutMin} minutes`
      const stuck = autoBootstrapState.steps.findIndex(s => s.status === 'running')
      if (stuck >= 0) autoBootstrapState.steps[stuck] = { ...autoBootstrapState.steps[stuck], status: 'error', detail: 'Timed out' }
      console.error('[auto-bootstrap] Hard timeout reached — unsticking')
      notify('Bootstrap Timed Out', `Bootstrap did not complete within ${autoTimeoutMin} minutes — check dashboard`, 'urgent').catch(() => {})
    }
  }, autoTimeoutMin * 60 * 1_000)

  // BKL-WIZ-02: Cancellation predicate — runner throws BootstrapCancelledError
  // when this flips between steps; outer flow handles cleanup.
  const cancelRequested = (): boolean => bootstrapFlags.autoBootstrapCancelRequested

  // Fire async — caller polls /api/bootstrap/auto/status for progress.
  ;(async () => {
    // BKL-DRIVE-SCAFFOLD-01: Idempotently scaffold Config/ and Products/<slug>
    // under parentFolderId before AE Drive folder creation. Idempotent + non-fatal.
    let perAeScaffold: ScaffoldEntry | null = null
    if (parentFolderId) {
      perAeScaffold = await ensureConfigAndProductsScaffold(parentFolderId)
    }

    // Pre-flight — Ensure product intel Drive folders exist under Products/
    // (BKL-DRIVE-PRODUCTS-ROOT-01).
    try {
      const productIntelConfig = loadProductIntelConfig()
      // BKL-UX-PRODUCT-FOLDER-CONFIG-01: parent folder sourced from existing
      // AE records via the helper, not from product-intel-config.
      const parentId = getProductIntelParentFolderId()
      // BKL-DRIVE-PRODUCTS-ROOT-01: slug folders go under Products/ subfolder.
      const slugParentId = perAeScaffold?.productsFolderId ?? parentId
      // BKL-SEC-DRIVEID-VALIDATE-01: defense-in-depth — validate before Drive calls.
      if (parentId && isValidDriveFolderId(parentId)) {
        const drivePI = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
        const updatedProducts = [...productIntelConfig.products]
        let anyUpdated = false
        for (let i = 0; i < updatedProducts.length; i++) {
          const p = updatedProducts[i]
          if (p.driveFolder) {
            // BKL-UX-PRODUCT-FOLDER-REPARENT-01: verify existing folder is under
            // slugParentId; if not, add slugParentId as additional parent.
            const meta = await drivePI.files.get({
              fileId: p.driveFolder,
              fields: 'id,parents',
              supportsAllDrives: true,
            }).catch(() => null)
            if (meta?.data.parents && !meta.data.parents.includes(slugParentId ?? parentId)) {
              await drivePI.files.update({
                fileId: p.driveFolder,
                addParents: slugParentId ?? parentId,
                supportsAllDrives: true,
                fields: 'id',
              }).catch((e: any) => console.warn(`[auto-bootstrap] failed to re-parent ${p.slug}:`, e?.message))
              console.log(`[auto-bootstrap] Re-parented ${p.slug} under ${slugParentId ?? parentId}`)
            }
            continue
          }
          const safeSlug = p.slug.replace(/'/g, "\\'")
          const existing = await drivePI.files.list({
            q: `name='${safeSlug}' and '${slugParentId ?? parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          }).catch(() => ({ data: { files: [] } }))
          if (existing.data.files?.length) {
            updatedProducts[i] = { ...p, driveFolder: existing.data.files[0].id! }
            anyUpdated = true
            console.log(`[auto-bootstrap] Product folder found for ${p.slug}: ${existing.data.files[0].id}`)
          } else {
            const created = await drivePI.files.create({
              requestBody: { name: p.slug, mimeType: 'application/vnd.google-apps.folder', parents: [slugParentId ?? parentId] },
              supportsAllDrives: true,
              fields: 'id',
            }).catch(() => null)
            if (created?.data.id) {
              updatedProducts[i] = { ...p, driveFolder: created.data.id }
              anyUpdated = true
              console.log(`[auto-bootstrap] Product folder created for ${p.slug}: ${created.data.id}`)
            }
          }
        }
        if (anyUpdated) saveProductConfig(updatedProducts)
      }
    } catch (e: any) {
      console.warn('[auto-bootstrap] Product intel folder pre-flight failed (non-blocking):', e?.message)
    }

    // Build the BootstrapContext and run the 5 steps.
    const ctx: BootstrapContext = {
      aeName,
      customerNames,
      sfReportId,
      tableauTerritories,
      parentFolderId,
      podName,
      regionId,
      aeFolderId: '',
      podSheetId: null,
      setStep,
      cancelRequested,
      resources: autoBootstrapState.resources,
    }

    try {
      await runBootstrapSteps([...ALL_STEPS], ctx)
    } catch (e: any) {
      if (e instanceof BootstrapCancelledError) {
        // BKL-WIZ-02: Mark remaining pending steps as cancelled.
        for (const step of autoBootstrapState.steps) {
          if (step.status === 'pending') step.status = 'cancelled'
        }
        autoBootstrapState.running = false
        syncBootstrapRunningToCoordinator()
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = 'Cancelled by user'
        clearTimeout(bootstrapTimeoutId)
        bootstrapFlags.autoBootstrapCancelRequested = false
        console.log(`[auto-bootstrap] Cancelled by user after completing some steps for ${aeName}`)
        return
      }
      // Step error — already recorded on autoBootstrapState.error and the step
      // by the runner. Continue to cleanup so we still write completedAt.
      autoBootstrapState.error = autoBootstrapState.error ?? `Bootstrap failed: ${e?.message ?? String(e)}`
    }

    // BKL-F05 / BKL-DOM-INF-01 / BKL-DOM-BATCH-01: Auto-run domain inference
    // for bootstrapped customers after all steps complete. Single Gemini
    // Flash-Lite batch call per 20 names + retry pass for nulls + Clearbit
    // fallback. Awaited inline (not fire-and-forget) so the 409 gate and POD
    // wait loop see a consistent running flag through the whole inference pass.
    const capturedState = autoBootstrapState
    bootstrapFlags.inferenceRunning = true
    let inferenceTimedOut = false
    // BKL-DOM-INF-02: AbortController lets the 60s timeout cancel in-flight
    // fetch calls instead of orphaning them.
    const abortCtrl = new AbortController()
    try {
      await Promise.race([
        (async () => {
          const aeCustomers = customers.filter(cx => !cx.inactive && cx.ae === aeName && !cx.domain)
          if (aeCustomers.length === 0) return
          // BKL-DOMAIN-01: prefer legal entity name (aliases[0]) for inference
          const inferNames = aeCustomers.map(cu => cu.aliases?.[0] ?? cu.name)
          const nameToInferName = new Map(aeCustomers.map(cu => [cu.name, cu.aliases?.[0] ?? cu.name]))
          const names = inferNames
          console.log(`[auto-bootstrap] Domain inference: ${names.length} customers for ${aeName}…`)
          const inferenceResults: NonNullable<typeof capturedState.resources.domainInference> = []
          const highConfidenceSaves: { name: string; domain: string; ae: string }[] = []

          // Step 1: Gemini batch call
          let batchMap = await batchInferDomains(names, abortCtrl.signal).catch((e: any) => {
            console.warn(`[infer-domains] batch failed for ${aeName}:`, e?.message ?? e)
            return null
          })

          // Step 2: Gemini retry for nulls only
          if (batchMap) {
            const nulls = names.filter(n => !batchMap!.get(n))
            if (nulls.length > 0) {
              console.log(`[infer-domains] retry batch for ${nulls.length} nulls: ${nulls.join(', ')}`)
              const retryMap = await batchInferDomains(nulls, abortCtrl.signal).catch(() => null)
              if (retryMap) {
                for (const [name, domain] of retryMap) {
                  if (domain) batchMap.set(name, domain)
                }
              }
            }
          }

          // Step 3: Clearbit fallback for still-null
          const stillNull = names.filter(n => !batchMap?.get(n))
          for (const name of stillNull) {
            if (abortCtrl.signal.aborted) break
            const domain = await tier1Clearbit(name, abortCtrl.signal).catch(() => null)
            if (domain) {
              batchMap = batchMap ?? new Map()
              batchMap.set(name, domain)
            }
          }

          // Build results and collect saves
          for (const cu of aeCustomers) {
            const inferKey = nameToInferName.get(cu.name) ?? cu.name
            const domain = batchMap?.get(inferKey) ?? null
            if (!domain || !isPublicDomain(domain)) {
              // Step 4: signal fallback (last ditch — Gmail/Calendar headers)
              const r = await inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch((e: any) => {
                console.warn(`[infer-domains] signal fallback error for ${cu.name}:`, e?.message ?? e)
                return null
              })
              if (!r || r.candidates.length === 0) continue
              const top = r.candidates[0]
              const confidence = isHighConfidenceDomain(top) ? 'high' : 'low'
              inferenceResults.push({ customerName: r.customerName, domain: top.domain, confidence, sources: top.sources })
              if (confidence === 'high') highConfidenceSaves.push({ name: r.customerName, domain: top.domain, ae: aeName })
              continue
            }
            inferenceResults.push({ customerName: cu.name, domain, confidence: 'high', sources: ['llm'] })
            highConfidenceSaves.push({ name: cu.name, domain, ae: aeName })
          }

          // Auto-save high-confidence domains and apply needsManualDomain flags.
          // AE-scoped so a matching name under a different AE is never contaminated.
          // Serialized through lockState.customerWriteLock to prevent concurrent writes.
          if (!inferenceTimedOut) {
            const unresolvedNames = new Set(
              aeCustomers
                .filter(cu => !batchMap?.get(cu.name) && !inferenceResults.find(r => r.customerName === cu.name))
                .map(cu => cu.name)
            )
            lockState.customerWriteLock = lockState.customerWriteLock.then(async () => {
              let dirty = false
              for (const { name, domain, ae } of highConfidenceSaves) {
                const cu = customers.find(cx => cx.name === name && cx.ae === ae && !cx.inactive)
                if (cu && !cu.domain) { cu.domain = domain; dirty = true }
                // BKL-DOM-INF-13: clear flag once a domain resolves
                if (cu && cu.needsManualDomain) { cu.needsManualDomain = false; dirty = true }
              }
              // BKL-DOM-INF-13: flag customers with no domain after all tiers
              for (const name of unresolvedNames) {
                const cu = customers.find(cx => cx.name === name && cx.ae === aeName && !cx.inactive)
                if (cu && !cu.domain && !cu.needsManualDomain) { cu.needsManualDomain = true; dirty = true }
              }
              if (dirty) {
                try {
                  writeJsonAtomic(CUSTOMERS_PATH, { customers })
                  console.log(`[auto-bootstrap] Domain inference complete for ${aeName}: ${highConfidenceSaves.length} saved, ${unresolvedNames.size} flagged needsManualDomain`)
                } catch (e: any) { console.warn('[auto-bootstrap] domain auto-save failed:', e.message) }
              }
            })
            await lockState.customerWriteLock
          }

          if (!inferenceTimedOut && inferenceResults.length > 0) {
            capturedState.resources.domainInference = inferenceResults
          }

          // BKL-DOM-INF-05: Surface customers that remain domain-null after all
          // inference tiers (batch + retry + Clearbit + signal fallback).
          const unresolved = aeCustomers.filter(cu => !batchMap?.get(cu.name) && !inferenceResults.find(r => r.customerName === cu.name))
          if (!inferenceTimedOut && unresolved.length > 0) {
            capturedState.resources.inferenceWarning = `${unresolved.length} customer${unresolved.length > 1 ? 's' : ''} have no resolvable domain: ${unresolved.map(cu => cu.name).join(', ')}`
          }
        })(),
        new Promise<void>(resolve => setTimeout(() => { inferenceTimedOut = true; abortCtrl.abort(); resolve() }, 60_000)),
      ])
      if (inferenceTimedOut) {
        console.warn(`[auto-bootstrap] domain inference timed out after 60s for ${aeName}`)
      }
    } catch (e: any) {
      console.warn(`[auto-bootstrap] domain inference failed for ${aeName}:`, e?.message ?? e)
    } finally {
      bootstrapFlags.inferenceRunning = false
    }

    autoBootstrapState.running = false
    syncBootstrapRunningToCoordinator()
    autoBootstrapState.completedAt = new Date().toISOString()
    clearTimeout(bootstrapTimeoutId)

    // Record bootstrap history
    const aeCustomerCount = customers.filter(cx => !cx.inactive && cx.ae === aeName).length
    recordBootstrapRun({
      aeName,
      completedAt: autoBootstrapState.completedAt,
      success: !autoBootstrapState.error,
      customerCount: aeCustomerCount,
      accountsFound: customers.filter(cx => !cx.inactive && cx.ae === aeName).length,
      durationMs: Date.now() - bootstrapStartMs,
      source: 'single',
    })

    // BKL-TOKEN-03: intelligence + brief pregen triggers moved to POD-level
    // (bootstrapPOD), fired ONCE after the full AE loop completes.
    console.log(`[auto-bootstrap] All steps complete for ${aeName}`)

    // #113: Auto-trigger RH Cases scrape after bootstrap if token is configured
    if (process.env.REDHAT_OFFLINE_TOKEN && process.env.REDHAT_OFFLINE_TOKEN !== 'your_offline_token_here') {
      try {
        const { enqueueScraperTask } = await import('./background-scheduler.ts')
        const { runRhScrapeWithState } = await import('./scraper-manager.ts')
        enqueueScraperTask({ name: 'rh-cases (post-bootstrap)', run: runRhScrapeWithState, source: 'manual', enqueuedAt: Date.now() })
        console.log(`[auto-bootstrap] RH token configured — queued first RH Cases scrape`)
      } catch {}
    }

    // BKL-DASH-PRODUCTS-LICENSES-ZERO-01: Step 4 created the SF Bookings sheet
    // and wrote raw rows into it, but per-customer sheet caches (the source for
    // /api/accounts productCount + totalLicenses) are only populated by the
    // refresh engine. Without this call, every portfolio card shows 0 / 0
    // until the next scheduled subscription refresh runs (could be hours).
    // Force-refresh now so the cards have data the moment bootstrap finishes.
    refreshSubscriptions(true).catch(e => console.warn('[auto-bootstrap] post-bootstrap subscription cache refresh failed:', e?.message ?? e))

    // BKL-HERO-PRODUCT-PREREQ-01: Trigger product refresh after auto-bootstrap completes
    // (OAuth keys now exist from wizard, products can synthesize with Gemini)
    fetch(`${baseUrl}/api/products/refresh-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[auto-bootstrap] product refresh triggered: ${d?.count ?? 0} products`))
      .catch(e => console.warn('[auto-bootstrap] product refresh trigger failed:', e?.message))

    // BKL-HERO-GCP-PROJECT-01: Trigger feature extraction after summaries refresh
    // (Both GOOGLE_CLOUD_PROJECT and OAuth keys now available)
    fetch(`${baseUrl}/api/products/features/refresh-all`, { method: 'POST' })
      .then(r => r.json())
      .then((d: any) => console.log(`[auto-bootstrap] feature extraction triggered: ${d?.products?.length ?? 0} products`))
      .catch(e => console.warn('[auto-bootstrap] feature extraction trigger failed:', e?.message))

    // BKL-BOOT-SCRAPE-ORDER-01: RH Cases is scheduled-only — do not trigger
    // during bootstrap. The next scheduled run will pick up account discovery
    // for the new AE.

    notify('Bootstrap Complete', `All steps complete for ${aeName}`, 'high').catch(() => {})
  })()
}

// ── Route registration ───────────────────────────────────────────────────────

export function createBootstrapRouter(): Hono {
  const router = new Hono()

  router.get('/api/bootstrap/auto/status', (c) => {
    const sanitizeDetail = (s: string | null | undefined) =>
      s ? sanitizeErr(new Error(s)) : s
    const sanitized: Record<string, unknown> = {
      ...autoBootstrapState,
      error: sanitizeDetail(autoBootstrapState.error),
      steps: autoBootstrapState.steps.map(step => ({
        ...step,
        detail: sanitizeDetail(step.detail),
      })),
    }
    // Phase 3: Include POD bootstrap progress when a POD bootstrap is running or recently completed
    if (podBootstrapState.running || podBootstrapState.completedAt) {
      sanitized.podBootstrap = {
        running: podBootstrapState.running,
        total: podBootstrapState.total,
        completed: podBootstrapState.completed,
        currentAE: podBootstrapState.currentAE,
        startedAt: podBootstrapState.startedAt,
        completedAt: podBootstrapState.completedAt,
        totalDurationMs: podBootstrapState.totalDurationMs,
        results: podBootstrapState.results.map(r => ({
          name: r.name,
          status: r.status,
          ...(r.error ? { error: sanitizeDetail(r.error) } : {}),
          ...(r.customerCount !== undefined ? { customerCount: r.customerCount } : {}),
          ...(r.startedAt ? { startedAt: r.startedAt } : {}),
          ...(r.completedAt ? { completedAt: r.completedAt } : {}),
          ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        })),
        error: sanitizeDetail(podBootstrapState.error),
      }
    }
    return c.json(sanitized)
  })

  // BKL-WIZ-02: POST /api/bootstrap/cancel — request cancellation of a running POD bootstrap
  router.post('/api/bootstrap/cancel', (c) => {
    const cancelled = requestPodBootstrapCancel()
    if (!cancelled) {
      return c.json({ ok: false, error: 'No POD bootstrap is currently running' }, 400)
    }
    console.log('[pod-bootstrap] Cancellation requested by user')
    return c.json({ ok: true })
  })

  // POST /api/bootstrap/auto/reset — clear a stuck bootstrap state
  router.post('/api/bootstrap/auto/reset', (c) => {
    Object.assign(autoBootstrapState, { running: false, steps: [], aeName: '', completedAt: null, error: null, resources: {} })
    bootstrapFlags.autoBootstrapCancelRequested = false
    Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
    syncBootstrapRunningToCoordinator()
    console.log('[auto-bootstrap] State reset by user request')
    return c.json({ ok: true })
  })

  // BKL-WIZ-02: POST /api/bootstrap/auto/cancel — request graceful cancellation of single-AE bootstrap
  router.post('/api/bootstrap/auto/cancel', (c) => {
    if (!autoBootstrapState.running) {
      return c.json({ error: 'No single-AE bootstrap is currently running' }, 400)
    }
    bootstrapFlags.autoBootstrapCancelRequested = true
    console.log('[auto-bootstrap] Cancellation requested by user')
    return c.json({ ok: true, message: 'Cancellation requested — bootstrap will stop after the current step' })
  })

  // GET /api/bootstrap/pod/tabs — List corp tabs from a territory sheet
  router.get('/api/bootstrap/pod/tabs', async (c) => {
    const rawSheetId = (c.req.query('sheetId') ?? '').trim()
    const urlMatch = rawSheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/)
    const sheetId = urlMatch ? urlMatch[1] : rawSheetId
    if (!sheetId || !/^[a-zA-Z0-9_-]{10,}$/.test(sheetId)) {
      return c.json({ error: 'sheetId query parameter is required' }, 400)
    }
    try {
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      if (!auth) return c.json({ error: 'Google auth not configured' }, 500)
      const sheetsClient = google.sheets({ version: 'v4', auth })
      const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
      const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
      const tabs = tabNames.filter(t => {
        const lower = t.toLowerCase()
        return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
               !lower.includes('accounts a')
      })
      return c.json({ tabs })
    } catch (e: any) {
      console.error(`[pod-tabs] Error reading sheet ${sheetId}: ${e?.message ?? e}`)
      // Fallback: if we have a saved POD config with a tab title, return it as a cached hint
      const savedCfg = readPodConfig()
      if (savedCfg?.podTabTitle) {
        console.log(`[pod-tabs] Returning cached tab from saved POD config: ${savedCfg.podTabTitle}`)
        return c.json({ tabs: [savedCfg.podTabTitle], fromCache: true })
      }
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/bootstrap/pod/config — Return last saved POD bootstrap config
  router.get('/api/bootstrap/pod/config', (c) => {
    const cfg = readPodConfig()
    if (!cfg) return c.json({ config: null })
    return c.json({ config: cfg })
  })

  // POST /api/bootstrap/pod — Bootstrap all AEs in the POD from a territory sheet
  // Fire-and-forget: returns immediately, poll /api/bootstrap/auto/status for progress
  router.post('/api/bootstrap/pod', async (c) => {
    if (autoBootstrapState.running || podBootstrapState.running) {
      return c.json({ error: 'A bootstrap is already in progress' }, 409)
    }

    // Claim the lock SYNCHRONOUSLY before the first `await` (c.req.json yields the event loop).
    // Without this, two simultaneous POSTs both pass the guard above, then both set running=true
    // after the await — a TOCTOU race. Claiming here with total:0/results:[] is an "initializing"
    // marker; bootstrapPOD() overwrites these fields once it reads the territory sheet.
    Object.assign(podBootstrapState, { running: true, total: 0, completed: 0, currentAE: null, results: [], startedAt: new Date().toISOString(), completedAt: null, error: null })
    syncBootstrapRunningToCoordinator()

    const body = await c.req.json<{ territorySheetId?: string; sfReportId?: string; parentFolderId?: string; podTabTitle?: string; force?: boolean }>().catch(() => ({} as { territorySheetId?: string; sfReportId?: string; parentFolderId?: string; podTabTitle?: string; force?: boolean }))
    const rawTerritorySheet = (body.territorySheetId ?? '').trim()
    // Accept full Google Sheets URL — extract bare sheet ID
    const territorySheetId = rawTerritorySheet.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{44})/)?.[1] ?? rawTerritorySheet
    const rawSfReportId = (body.sfReportId ?? '').trim()
    const sfReportId = rawSfReportId ? extractSfReportId(rawSfReportId) : ''
    const rawParent = (body.parentFolderId ?? '').trim()
    const parentFolderId = rawParent
      ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
      : ''

    if (!territorySheetId) {
      Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
      syncBootstrapRunningToCoordinator()
      return c.json({ error: 'territorySheetId is required' }, 400)
    }
    // Validate sheet ID format (alphanumeric + hyphens + underscores, typical Google Sheet IDs)
    if (!/^[a-zA-Z0-9_-]{44}$/.test(territorySheetId)) {
      Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
      syncBootstrapRunningToCoordinator()
      return c.json({ error: 'Invalid territorySheetId format' }, 400)
    }
    if (!sfReportId || !isValidSfId(sfReportId)) {
      Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
      syncBootstrapRunningToCoordinator()
      return c.json({ error: 'sfReportId is required — provide a Salesforce report URL or bare ID' }, 400)
    }
    if (!parentFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) {
      Object.assign(podBootstrapState, { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null })
      syncBootstrapRunningToCoordinator()
      return c.json({ error: 'parentFolderId is required — provide a Google Drive folder URL or bare ID' }, 400)
    }

    const podTabTitle = (body.podTabTitle ?? '').trim() || undefined
    const force = body.force === true

    // Run async — fire-and-forget
    bootstrapPOD({
      territorySheetId,
      sfReportId,
      parentFolderId,
      podTabTitle,
      force,
      onProgress: (info) => {
        console.log(`[pod-bootstrap] Progress: ${info.aeName} (${info.index + 1}/${info.total}) — ${info.status}${info.error ? ': ' + info.error : ''}`)
      },
    }).then(result => {
      console.log(`[pod-bootstrap] Final: ${result.succeeded.length} succeeded, ${result.skipped.length} skipped, ${result.failed.length} failed`)
    }).catch(e => {
      console.error(`[pod-bootstrap] Fatal error: ${e?.message ?? e}`)
      podBootstrapState.running = false
      syncBootstrapRunningToCoordinator()
      podBootstrapState.error = `Fatal: ${e?.message ?? e}`
      podBootstrapState.completedAt = new Date().toISOString()
    })

    return c.json({ ok: true, message: `POD bootstrap started — poll /api/bootstrap/auto/status for progress` })
  })

  // POST /api/oauth/dismiss-downgrade — user has seen the reduce-permissions banner
  router.post('/api/oauth/dismiss-downgrade', (c) => {
    try {
      mkdirSync(dirname(OAUTH_STATE_PATH), { recursive: true })
      writeFileSyncRaw(OAUTH_STATE_PATH, JSON.stringify({ pendingDowngrade: false, dismissedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    } catch (e: any) { console.warn('[oauth] dismiss write failed:', e.message) }
    return c.json({ ok: true })
  })

  router.post('/api/bootstrap/auto', async (c) => {
    // BKL-DOM-INF-01: include inferenceRunning so a follow-up POD AE bootstrap can't
    // start while the previous AE's domain inference is still mutating customers.json.
    if (autoBootstrapState.running || bootstrapFlags.inferenceRunning) return c.json({ error: 'Auto-bootstrap already in progress' }, 409)

    const body = await c.req.json<{
      aeName?: string
      sfReportId?: string
      tableauTerritories?: string[]
      customerNames?: string[]
      parentFolderId?: string
      podName?: string  // BKL-DRIVE-01: optional POD display name for subfolder hierarchy
    }>().catch(() => ({} as { aeName?: string; sfReportId?: string; tableauTerritories?: string[]; customerNames?: string[]; parentFolderId?: string; podName?: string }))

    const aeName = (body.aeName ?? '').trim()
    // BKL-F07: Accept full Salesforce URLs — extract bare ID
    const sfReportId = extractSfReportId(body.sfReportId ?? '')
    const tableauTerritories = body.tableauTerritories ?? []
    const allCustomerNames = (body.customerNames ?? []).map(n => normalizeCustomerName(n)).filter(Boolean)
    const junkFiltered = allCustomerNames.filter(n => isJunkCustomerName(n))
    const customerNames = allCustomerNames.filter(n => !isJunkCustomerName(n))
    if (junkFiltered.length > 0) {
      console.log(`[auto-bootstrap] Filtered ${junkFiltered.length} junk name(s) from territory sheet: ${junkFiltered.join(', ')}`)
    }
    // BKL-DRIVE-01: optional POD display name for subfolder hierarchy
    const podName = (body.podName ?? '').trim() || undefined
    // Accept full Drive URL or bare folder ID — extract ID from URL if needed
    const rawParent = (body.parentFolderId ?? '').trim()
    let parentFolderId = rawParent
      ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
      : undefined

    // BKL-HERO-PARENT-REGION-BUG: Derive region context from territories (needed for both
    // parentFolderId fallback and regionId context). Single settings.json read consolidates
    // what was previously two separate reads (efficiency fix).
    let regionId: string | undefined
    if (tableauTerritories.length > 0) {
      try {
        const podPrefix = tableauTerritories[0].split('_TERR')[0]
        const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
        const normalized = normalizeSettings(settings)
        const region = normalized.regions.find(r =>
          Object.keys(r.pods).some(pod => pod === podPrefix)
        )
        if (region) {
          regionId = region.id
          // Fallback: when frontend state is stale, use settings.json parentFolderId
          if (!parentFolderId && region.parentFolderId) {
            parentFolderId = region.parentFolderId
            console.log(`[bootstrap] parentFolderId fallback from ${region.id} settings: ${parentFolderId}`)
          }
        }
      } catch (e: any) {
        console.warn(`[bootstrap] region context derivation failed: ${e?.message}`)
      }
    }

    if (!aeName) return c.json({ error: 'aeName is required' }, 400)
    if (aeName.length > 200) return c.json({ error: 'aeName exceeds 200 characters' }, 400)
    if (/<[^>]*>/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
    if (!sfReportId) return c.json({ error: 'sfReportId is required' }, 400)
    if (!isValidSfId(sfReportId)) return c.json({ error: 'sfReportId must be a valid Salesforce report URL or 15-18 character ID' }, 400)
    if (!tableauTerritories.length) return c.json({ error: 'tableauTerritories is required' }, 400)
    if (junkFiltered.length > 0 && allCustomerNames.length > 0 && !customerNames.length) {
      // All provided names were junk-filtered — reject with a clear error
      return c.json({ error: `customerNames contains invalid characters — only letters, numbers, spaces, and basic punctuation allowed (${junkFiltered.length} names filtered)` }, 400)
    }
    if (customerNames.some(n => /<[^>]*>/.test(n))) return c.json({ error: 'customerNames contains invalid characters' }, 400)
    if (parentFolderId && !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) return c.json({ error: 'Invalid parentFolderId format' }, 400)

    // Upsert AE into aes.json immediately with basic fields
    let aeConfig = aes.find(a => a.name === aeName)
    if (!aeConfig) {
      aeConfig = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories, ...(parentFolderId ? { parentFolderId } : {}) }
      saveAes([...aes, aeConfig])
    } else {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, tableauTerritories, ...(parentFolderId ? { parentFolderId } : {}) } : a)
      saveAes(updated)
      aeConfig = aes.find(a => a.name === aeName)!
    }

    // BKL-WIZ-02: Reset cancellation flag at the start of each new bootstrap run
    bootstrapFlags.autoBootstrapCancelRequested = false

    Object.assign(autoBootstrapState, {
      running: true,
      aeName,
      steps: ALL_STEPS.map(s => ({ name: s.name, status: 'pending' as const })),
      error: null,
      completedAt: null,
      resources: { junkFiltered: junkFiltered.length > 0 ? junkFiltered : undefined },
    })
    syncBootstrapRunningToCoordinator()

    // Run async — client polls /api/bootstrap/auto/status. The full flow
    // (per-AE scaffold pre-flight, 5 step runner, post-step domain inference,
    // cleanup + history) lives in runAutoBootstrap below — extracted as part
    // of BKL-ARCH-01 (issue #54) so the route handler stays slim.
    runAutoBootstrap({
      aeName,
      customerNames,
      sfReportId,
      tableauTerritories,
      parentFolderId,
      podName,
      regionId,
    })

    return c.json({ started: true })
  })

  // ── Tableau login helper ────────────────────────────────────────────────────

  // GET /api/bootstrap/tableau/session-status — probe Tableau reachability + session validity
  // Returns { reachable: boolean, sessionValid: boolean }
  // reachable=false → not on VPN or Tableau is down — don't show login prompt
  // reachable=true, sessionValid=false → on VPN but needs login — show prompt
  // reachable=true, sessionValid=true → already logged in — no action needed
  //
  // Cached for 5 minutes — the live browser probe takes ~6s (SSO redirect settle).
  // Pass ?force=true to bypass cache (used by Connect button after login).
  // _tableauStatusCache promoted to module scope (BKL-UX-WIPE-CONN-RESET-02) for reset on wipe.
  const TABLEAU_STATUS_TTL_MS = 60 * 1000  // BKL-SEC-CONN-02: reduced from 5min to 60s
  // BKL-CONN-TABLEAU-CTX-01: Tableau login uses a dedicated Interactive Auth Page (IAP)
  // — see src/interactive-auth-page.ts. _livePage is reserved for the scraper SSO anchor;
  // driving cross-domain SSO chains through it corrupted the renderer and hung sister scrapers.

  router.get('/api/bootstrap/tableau/session-status', async (c) => {
    const force = c.req.query('force') === 'true'
    // BKL-UX79: If scraper detected an expired session since last status check, invalidate cache immediately
    if (consumeTableauSessionExpired()) {
      _tableauStatusCache = null
    }
    if (!force && _tableauStatusCache && Date.now() - _tableauStatusCache.cachedAt < TABLEAU_STATUS_TTL_MS) {
      return c.json(_tableauStatusCache.result)
    }
    // BKL-CONN-TABLEAU-CTX-01: probe via Node-side HEAD + cookie freshness.
    // No browser opened — zero shared-context risk. HEAD probe determines reachability
    // (VPN check); cookie freshness determines session validity.
    let reachable = true
    try {
      await fetch('https://10ay.online.tableau.com', {
        method: 'HEAD',
        signal: AbortSignal.timeout(3_000),
      })
    } catch {
      reachable = false
    }
    const sessionValid = reachable ? await checkTableauSessionFromCookies() : false
    const result = { reachable, sessionValid }
    _tableauStatusCache = { result, cachedAt: Date.now() }
    return c.json(result)
  })

  // GET /api/bootstrap/tableau/wait-for-login — long-poll that resolves when the live page
  // lands on the Tableau dashboard (logged-in URL, no login form). Uses a two-phase
  // check: first waits for the Tableau hostname, then waits for the SAML redirect
  // chain to settle (6s) before re-verifying. Without the settle delay, the initial
  // domcontentloaded on 10ay.online.tableau.com fires BEFORE SSO redirects the page
  // to the login form — causing a false-positive that closes the VNC window immediately.
  router.get('/api/bootstrap/tableau/wait-for-login', async (c) => {
    // BKL-CONN-TABLEAU-CTX-01: waitForTableauLogin polls the isolated Chromium context.
    // On success, it harvests cookies to TABLEAU_SESSION_PATH and closes the isolated
    // context — VNC clears automatically when the context closes.
    // BKL-CONN-TABLEAU-CTX-01: 90s timeout stays safely under Bun's idleTimeout=120s.
    // The client re-polls wait-for-login if it times out — no 5-minute HTTP hang.
    const sessionValid = await waitForTableauLogin(90_000)
    if (sessionValid) {
      _tableauStatusCache = { result: { reachable: true, sessionValid: true }, cachedAt: Date.now() }
      console.log('[tableau] login confirmed — cookies harvested, isolated context closed')
    } else {
      console.warn('[tableau] wait-for-login: timed out or failed')
    }
    return c.json({ sessionValid })
  })

  // POST /api/bootstrap/tableau/open-login — opens a dedicated IAP for Tableau
  // login so the user can complete SSO via the VNC viewer at localhost:6080.
  // BKL-CONN-TABLEAU-CTX-01: uses the IAP (not _livePage) so the SSO redirect
  // chain cannot corrupt the scraper anchor page or hang sister scrapers.
  router.post('/api/bootstrap/tableau/open-login', async (c) => {
    // BKL-CONN-TABLEAU-CTX-01: isolated context — no longer requires active RH session
    _tableauStatusCache = null  // force fresh probe on next status check
    try {
      await startTableauLoginBrowser()
      console.log('[tableau] isolated Chromium launched for Tableau login — visible at localhost:6080')
      return c.json({ ok: true })
    } catch (e: any) {
      console.error('[tableau] open-login failed:', e?.message ?? e)
      return c.json({ error: 'Could not open Tableau — check VPN connection' }, 500)
    }
  })

  // ── Tableau territory discovery ────────────────────────────────────────────

  router.get('/api/bootstrap/tableau/territories', async (c) => {
    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)

    let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null
    try {
      page = await ctx.newPage()
      const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'
      await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
        console.warn('[territories] networkidle timed out — continuing anyway')
      })

      // Inline applyFilter helper for territory discovery
      const applyFilterLocal = async (label: string, values: string[]) => {
        const trigger = await page!.$(`[aria-label="${label}"], select[title*="${label}"]`)
        if (!trigger) {
          const byText = await page!.$(`text="${label}"`)
          if (!byText) { console.warn(`[territories] filter "${label}" not found`); return }
          const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
          if (!parent) { console.warn(`[territories] filter "${label}" parent not found`); return }
          await parent.click()
        } else {
          await trigger.click()
        }
        await page!.waitForTimeout(800)

        const allOption = await page!.$('text="(All)"')
        if (allOption) {
          const checkbox = await allOption.$('xpath=preceding-sibling::input[@type="checkbox"] | ancestor::label/input')
          const checked = await checkbox?.isChecked()
          if (checked) await allOption.click()
          await page!.waitForTimeout(300)
        }

        for (const val of values) {
          const opt = await page!.$(`text="${val}"`)
          if (opt) { await opt.click(); await page!.waitForTimeout(300) }
        }

        const applyBtn = await page!.$('button:has-text("Apply"), input[value="Apply"]')
        if (applyBtn) await applyBtn.click()
        await page!.waitForTimeout(1_500)
      }

      // Apply prerequisite filters
      await applyFilterLocal('Super Geo', ['AMERICAS'])
      await applyFilterLocal('Geo', ['NA_COMM'])
      await applyFilterLocal('Region', ['NA_COMM_COMMERCIAL'])
      await applyFilterLocal('Segment', ['Commercial'])

      // Open the Account Territory filter dropdown
      const trigger = await page.$(`[aria-label="Account Territory"], select[title*="Account Territory"]`)
      if (!trigger) {
        const byText = await page.$('text="Account Territory"')
        if (byText) {
          const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
          if (parent) await parent.click()
        }
      } else {
        await trigger.click()
      }
      await page.waitForTimeout(800)

      // Scrape all option text values
      const options = await page.$$eval(
        '[role="option"], [role="listbox"] label, .FICheckRadio label, [class*="filter"] label',
        (els: Element[]) => els.map(el => el.textContent?.trim() ?? '').filter(t => t && t !== '(All)')
      )

      // Dedupe and sort
      const territories = [...new Set(options)].sort()

      return c.json({ territories })
    } catch (e: any) {
      console.error('[territories] Discovery failed:', e.message)
      return c.json({ error: `Territory discovery failed: ${sanitizeErr(e)}` }, 500)
    } finally {
      if (page) await page.close().catch(() => {})
    }
  })

  // ── Initial Load (BKL-M44) ────────────────────────────────────────────────
  // Crash-safe, resume-capable full Supportable load for new instances.
  // Runs sequentially (council decision 2026-04-03), writes incrementally.

  const initialLoadState = {
    running: false,
    currentCustomer: null as string | null,
    completedCount: 0,
    totalCount: 0,
    errors: [] as { customer: string; message: string }[],
    startedAt: null as string | null,
    completedAt: null as string | null,
  }

  // BKL-SCAFFOLD-STATUS-01: GET /api/bootstrap/scaffold-status
  // Returns the cached Drive scaffold (Config/, Products/<slug>) for the
  // current parentFolderId. Reads from data-sources.json scaffoldCache —
  // populated by ensureConfigAndProductsScaffold() during bootstrap.
  // Returns 200 with all-null fields when no parentFolderId is configured
  // or no scaffold cache entry exists for it.
  router.get('/api/bootstrap/scaffold-status', (c) => {
    const empty = {
      configFolderId: null as string | null,
      productsFolderId: null as string | null,
      productSubfolders: {} as Record<string, string>,
    }
    const cache = readScaffoldCache()
    // Primary: look up by podConfig.parentFolderId (set during POD-level bootstrap).
    // Fallback: look up by the first AE's parentFolderId (set during single-AE bootstrap).
    const podCfg = readPodConfig()
    const parentFolderId = podCfg?.parentFolderId
      ?? aes.find(a => a.parentFolderId && cache[a.parentFolderId as string])?.parentFolderId
      ?? null
    if (!parentFolderId) return c.json(empty)
    const entry = cache[parentFolderId as string]
    if (!entry) return c.json(empty)
    return c.json({
      configFolderId: entry.configFolderId ?? null,
      productsFolderId: entry.productsFolderId ?? null,
      productSubfolders: entry.productSubfolders ?? {},
    })
  })

  router.get('/api/bootstrap/initial-load/status', (c) => {
    return c.json({
      ...initialLoadState,
      errors: initialLoadState.errors.map(e => ({
        customer: e.customer,
        message: sanitizeErr(e),
      })),
    })
  })

  router.post('/api/bootstrap/initial-load', (c) => {
    return c.json({ error: 'Supportable initial-load is no longer supported — account discovery uses RH Portal sidebar autocomplete' }, 410)
  })

  return router
}
