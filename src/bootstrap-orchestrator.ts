// ── Auto-bootstrap + Tableau routes (M03 — extracted from server.ts) ────────
import { Hono } from 'hono'
import { writeFileSync as writeFileSyncRaw, readFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { aes, customers, saveAes, patchAe, CUSTOMERS_PATH } from './server-state.ts'
import { runSfPipelineSync, createPipelineSheet } from './sf-scraper.ts'
import { runSupportableDiscoverAndScrape, writeSupportableSheet } from './supportable-scraper.ts'
import { runCcspScrape, writeCcspSheet } from './ccsp-scraper.ts'
import { fetchCustomerAccountNumbers } from './sheets.ts'
import { runRhScrapeWithState } from './scraper-manager.ts'

import { getScrapeContext, getLivePage, setLivePageBusy } from './rh-scraper.ts'
import { refreshPipeline } from './refresh-engine.ts'
import { inferCustomerDomain, isHighConfidenceDomain } from './domains.ts'
import type { AE } from './types.ts'
import { sanitizeErr } from './utils.ts'
import { loadProductIntelConfig, saveProductConfig } from './product-release-radar.ts'
import { recordBootstrapRun } from './bootstrap-history.ts'

// ── Constants ────────────────────────────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')
const DATA_SOURCES_PATH = resolve(SRV_CONFIG_DIR, 'data-sources.json')
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'asa-command-center'

// ── POD config persistence ────────────────────────────────────────────────────
/** Save the POD bootstrap inputs to data-sources.json so they survive restarts. */
function savePodConfig(cfg: { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string }): void {
  try {
    let ds: Record<string, unknown> = {}
    try { ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8')) } catch { /* fresh file */ }
    const tmp = DATA_SOURCES_PATH + '.tmp'
    writeFileSyncRaw(tmp, JSON.stringify({ ...ds, podConfig: cfg }, null, 2), { mode: 0o600 })
    renameSync(tmp, DATA_SOURCES_PATH)
    console.log('[pod-bootstrap] POD config saved to data-sources.json')
  } catch (e: any) {
    console.warn('[pod-bootstrap] Could not save POD config:', e?.message)
  }
}

/** Read the last saved POD config from data-sources.json. Returns null if not saved. */
function readPodConfig(): { territorySheetId: string; sfReportId: string; parentFolderId: string; podTabTitle?: string } | null {
  try {
    const ds = JSON.parse(readFileSync(DATA_SOURCES_PATH, 'utf-8'))
    return ds.podConfig ?? null
  } catch { return null }
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

// BKL-M05: Display-oriented normalizer — differs from normalizeForMatch by stripping state codes, parentheticals, and applying title case (needed for Drive folder names).
/**
 * Normalize a customer name for use as a Drive folder name and search key.
 * Strips state suffixes, legal entity suffixes, and parentheticals; applies title case.
 * Input:  "DROPBOX, INC. - CA"  →  Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  →  Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  →  Output: "A10 Networks"
 */
function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

// BKL-W2-12: Search for an existing Google Sheet by name inside a Drive folder before creating a new one.
async function findExistingSheet(drive: any, folderId: string, name: string): Promise<string | null> {
  try {
    const q = `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
    const res = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 })
    return res.data.files?.[0]?.id ?? null
  } catch {
    return null
  }
}

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

/**
 * BKL-F06: Reject names that are clearly territory sheet junk — deal rows, billing rows,
 * CCSP charges, opportunity rows, etc. Conservative by design: only rejects obvious patterns.
 */
function isJunkCustomerName(name: string): boolean {
  if (name.length < 3) return true
  if (name.includes('~')) return true
  // Opportunity/deal/billing keywords
  if (/\b(DSOR|Renewal|Royalty|billing|deal|opportunity)\b/i.test(name)) return true
  // Date patterns in the name (e.g. "2024-01 Something" or "01/2024")
  if (/\b\d{4}-\d{2}\b/.test(name) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(name)) return true
  // CCSP billing rows (e.g. "Global Royalty-CCSP")
  if (/-CCSP\b/i.test(name)) return true
  return false
}

// ── Interfaces ───────────────────────────────────────────────────────────────

interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

interface AutoBootstrapResources {
  driveFolder?: { id: string; url: string }
  customerFolders?: Record<string, { id: string; url: string }>
  supportableSheet?: { id: string; url: string }
  ccspSheet?: { id: string; url: string }
  pipelineSheet?: { id: string; url: string }
  unmatchedCustomers?: string[]  // customer names with 0 Supportable account matches
  junkFiltered?: string[]        // names rejected by junk filter before bootstrap
  domainInference?: { customerName: string; domain: string; confidence: 'high' | 'low'; sources: string[] }[]  // BKL-F05: auto-inferred domains
}

interface AutoBootstrapState {
  running: boolean
  aeName: string | null
  steps: AutoBootstrapStep[]
  error: string | null
  completedAt: string | null
  resources: AutoBootstrapResources
}

export let autoBootstrapState: AutoBootstrapState = {
  running: false, aeName: null, steps: [], error: null, completedAt: null, resources: {}
}

/** BKL-W2-17: Exposed so background-scheduler can include bootstrap in isAnyScraperRunning() guard. */
export function isBootstrapRunning(): boolean { return autoBootstrapState.running || podBootstrapState.running }

// ── POD Bootstrap ───────────────────────────────────────────────────────────

interface PodAeResult {
  name: string
  status: 'skipped' | 'ok' | 'error' | 'pending' | 'retrying'
  error?: string
  customerCount?: number
  startedAt?: string
  completedAt?: string
  durationMs?: number
}

interface PodBootstrapState {
  running: boolean
  total: number
  completed: number
  currentAE: string | null
  results: PodAeResult[]
  startedAt: string | null
  completedAt: string | null
  totalDurationMs?: number
  error: string | null
}

export let podBootstrapState: PodBootstrapState = {
  running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null,
}

/**
 * Read the territory sheet and extract a map of AE name → { territories, customerNames }.
 * Reuses the same parsing logic as territory-sync.ts but returns raw AE-level data
 * rather than a diff against the current customer list.
 */
async function readAEsFromTerritorySheet(
  territorySheetId: string,
  podTabTitle?: string,
): Promise<Array<{ aeName: string; territories: string[]; customerNames: string[] }>> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: territorySheetId })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  // Same filtering as territory-sync.ts — corp/regional tabs
  const corpTabs = tabNames.filter(t => {
    const lower = t.toLowerCase()
    return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
           !lower.includes('accounts a')
  })

  // When a specific POD tab is selected, restrict to just that tab
  const filteredTabs = podTabTitle
    ? corpTabs.filter(t => t === podTabTitle)
    : corpTabs

  // Same pod-prefix logic as territory-sync.ts
  const podPrefixFromTab = (tabTitle: string): string => {
    const t = tabTitle.toLowerCase()
    if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
    if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
    if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTHCENTRAL'
    if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTHCENTRAL'
    return ''
  }

  // Accumulate per-AE data: name → { territories, customerNames }
  const aeMap = new Map<string, { territories: Set<string>; customerNames: Set<string> }>()

  for (const tabTitle of filteredTabs) {
    const podPrefix = podPrefixFromTab(tabTitle)
    if (!podPrefix) continue

    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: territorySheetId,
      range: `'${tabTitle}'!A1:Z60`,
    })
    const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
      r.map((c: any) => String(c ?? '').trim())
    )

    // Find "Account Executive" header row
    let headerRowIdx = -1
    for (let r = 0; r < rows.length; r++) {
      if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
    }
    if (headerRowIdx === -1) continue

    const aeNameRowIdx = headerRowIdx + 1
    const accountsStartIdx = aeNameRowIdx + 1
    const headerRow = rows[headerRowIdx] ?? []
    const aeNameRow = rows[aeNameRowIdx] ?? []

    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => cell === 'Account Executive')
      .map(({ idx }) => idx)

    for (const col of aeCols) {
      const aeCell = aeNameRow[col] ?? ''
      if (!aeCell) continue

      // Extract AE name (first line) and territory code
      const aeName = aeCell.split('\n')[0].trim()
      if (!aeName) continue

      let terrCode = ''
      if (aeCell.includes('\n')) {
        terrCode = aeCell.split('\n')[1].trim()
      } else {
        const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
        if (terrMatch) terrCode = terrMatch[0]
      }

      const terrNumMatch = terrCode.match(/(\d+)/)
      if (!terrNumMatch) continue
      const terrNum = terrNumMatch[1].padStart(2, '0')
      const tableauTerritory = `${podPrefix}_TERR${terrNum}`

      // Ensure AE entry exists in map
      if (!aeMap.has(aeName)) {
        aeMap.set(aeName, { territories: new Set(), customerNames: new Set() })
      }
      const entry = aeMap.get(aeName)!
      entry.territories.add(tableauTerritory)

      // Extract customer names from column
      for (let r = accountsStartIdx; r < rows.length; r++) {
        const cell = rows[r][col] ?? ''
        if (!cell) continue
        if (/^\d{1,3}$/.test(cell)) break
        if (/^Account\s+S[Aa]/i.test(cell)) break
        if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
        if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
        const normalized = normalizeCustomerName(cell)
        if (normalized && !isJunkCustomerName(normalized)) {
          entry.customerNames.add(normalized)
        }
      }
    }
  }

  return Array.from(aeMap.entries()).map(([aeName, data]) => ({
    aeName,
    territories: [...data.territories],
    customerNames: [...data.customerNames],
  }))
}

/**
 * Check if an AE is considered "already bootstrapped" — has all 4 key sheet IDs
 * and a Drive folder.
 */
function isAEFullyBootstrapped(aeConfig: AE): boolean {
  return !!(
    aeConfig.driveFolderId &&
    aeConfig.supportableSheetId &&
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
export async function bootstrapPOD(opts: {
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

  const succeeded: string[] = []
  const skipped: string[] = []
  const failed: Array<{ name: string; error: string }> = []

  // Initialize POD bootstrap state for status endpoint
  const podStartedAt = new Date().toISOString()
  podBootstrapState = {
    running: true,
    total: aeEntries.length,
    completed: 0,
    currentAE: null,
    results: aeEntries.map(e => ({ name: e.aeName, status: 'pending' as const })),
    startedAt: podStartedAt,
    completedAt: null,
    error: null,
  }

  // Dynamic timeout: 30 min per AE
  const podTimeoutMs = aeEntries.length * 30 * 60 * 1000
  const podTimeoutId = setTimeout(() => {
    if (podBootstrapState.running) {
      podBootstrapState.running = false
      podBootstrapState.completedAt = new Date().toISOString()
      podBootstrapState.error = `POD bootstrap timed out after ${Math.round(podTimeoutMs / 60000)} minutes`
      console.error(`[pod-bootstrap] Hard timeout reached (${Math.round(podTimeoutMs / 60000)} min)`)
    }
  }, podTimeoutMs)

  // Step 2: Sequential bootstrap per AE
  for (let i = 0; i < aeEntries.length; i++) {
    if (!podBootstrapState.running) break  // timeout triggered

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
    if (!aeConfig) {
      const newAe = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories: territories, parentFolderId }
      saveAes([...aes, newAe])
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Created new AE entry for ${aeName}`)
    } else if (!aeConfig.sfReportId) {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, parentFolderId } : a)
      saveAes(updated)
      aeConfig = aes.find(a => a.name === aeName)!
      console.log(`[pod-bootstrap] Updated sfReportId for ${aeName}`)
    }

    // Wait for any in-progress single-AE bootstrap to finish before starting the next
    while (autoBootstrapState.running) {
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
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = `Timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes (POD bootstrap)`
        throw new Error(`Bootstrap for ${aeName} timed out after ${Math.round(perAeTimeoutMs / 60000)} minutes`)
      }

      // Check if bootstrap had errors
      if (autoBootstrapState.error) {
        const err = autoBootstrapState.error
        console.warn(`[pod-bootstrap] ${aeName} completed with error: ${err}`)
        // Still count as succeeded if some steps completed — error might be non-fatal
        const hasAnySheet = !!(aes.find(a => a.name === aeName)?.supportableSheetId ||
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

  // Step 3: Auto-retry pass for zero-account AEs (one retry only)
  const zeroAccountAEs = succeeded.filter(aeName => {
    const aeCustomers = customers.filter(c => c.ae === aeName)
    return aeCustomers.length === 0 || aeCustomers.every(c => !c.accountNumbers?.length)
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

        const retryCustomerCount = customers.filter(c => c.ae === aeName && (c.accountNumbers?.length ?? 0) > 0).length
        if (idx >= 0) {
          podBootstrapState.results[idx] = {
            name: aeName,
            status: retryCustomerCount > 0 ? 'ok' : 'error',
            customerCount: retryCustomerCount,
            error: retryCustomerCount === 0 ? 'Zero accounts after retry' : undefined,
          }
        }
        console.log(`[pod-bootstrap] Retry for ${aeName}: ${retryCustomerCount} customers with accounts`)
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
  podBootstrapState.currentAE = null
  podBootstrapState.completedAt = new Date().toISOString()
  podBootstrapState.totalDurationMs = podTotalMs
  console.log(`[pod-bootstrap] Complete: ${succeeded.length} succeeded, ${skipped.length} skipped, ${failed.length} failed — total ${Math.round(podTotalMs / 60000)}min`)

  return { succeeded, skipped, failed }
}

// ── Tableau constant ─────────────────────────────────────────────────────────
const TABLEAU_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumption'

// ── Account discovery startup IIFE (extracted as callable function) ──────────

export function startAccountDiscovery(): void {
  ;(async () => {
    const missing = customers.filter((c) => !c.accountNumbers?.length && !c.skipAccountDiscovery)
    if (!missing.length) return

    console.log(`[account-discovery] discovering account numbers for ${missing.length} customers…`)
    let discovered = 0

    for (const customer of missing) {
      try {
        // Scope to the customer's own AE sheet — prevents cross-AE tab name collisions
        const aeMatch = customer.ae ? aes.find(a => a.name === customer.ae) : undefined
        const supportableIds = aeMatch?.supportableSheetId
          ? [aeMatch.supportableSheetId]
          : aes.map(a => a.supportableSheetId).filter((id): id is string => Boolean(id))
        const nums = await fetchCustomerAccountNumbers(customer, supportableIds.length ? supportableIds : undefined)
        if (!nums.length) continue
        customer.accountNumbers = nums
        const updated = customers.map((cu) =>
          cu.name === customer.name ? { ...cu, accountNumbers: nums } : cu
        )
        writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers: updated }, null, 2), { mode: 0o600 })
        renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
        customers.splice(0, customers.length, ...updated)
        console.log(`[account-discovery] ${customer.name}: ${nums.join(', ')}`)
        discovered++
      } catch (e: any) {
        console.warn(`[account-discovery] ${customer.name}: ${e.message}`)
      }
    }

    if (discovered > 0) {
      console.log(`[account-discovery] done — ${discovered} customers updated`)
      // Trigger a fresh scrape now that more account numbers are available
      runRhScrapeWithState().catch((e: any) => console.error("[rh-scraper] unhandled error:", e?.message ?? e))
    } else {
      console.log('[account-discovery] no new account numbers found')
    }
  })()
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerBootstrapRoutes(app: Hono): void {

  app.get('/api/bootstrap/auto/status', (c) => {
    const sanitizeDetail = (s: string | null | undefined) =>
      s ? s.slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]') : s
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

  // POST /api/bootstrap/auto/reset — clear a stuck bootstrap state
  app.post('/api/bootstrap/auto/reset', (c) => {
    autoBootstrapState = { running: false, steps: [], aeName: '', completedAt: null, error: null, resources: {} }
    podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
    console.log('[auto-bootstrap] State reset by user request')
    return c.json({ ok: true })
  })

  // GET /api/bootstrap/pod/tabs — List corp tabs from a territory sheet
  app.get('/api/bootstrap/pod/tabs', async (c) => {
    const rawSheetId = (c.req.query('sheetId') ?? '').trim()
    const sheetId = rawSheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{44})/)?.[1] ?? rawSheetId
    if (!sheetId || !/^[a-zA-Z0-9_-]{44}$/.test(sheetId)) {
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
  app.get('/api/bootstrap/pod/config', (c) => {
    const cfg = readPodConfig()
    if (!cfg) return c.json({ config: null })
    return c.json({ config: cfg })
  })

  // POST /api/bootstrap/pod — Bootstrap all AEs in the POD from a territory sheet
  // Fire-and-forget: returns immediately, poll /api/bootstrap/auto/status for progress
  app.post('/api/bootstrap/pod', async (c) => {
    if (autoBootstrapState.running || podBootstrapState.running) {
      return c.json({ error: 'A bootstrap is already in progress' }, 409)
    }

    // Claim the lock SYNCHRONOUSLY before the first `await` (c.req.json yields the event loop).
    // Without this, two simultaneous POSTs both pass the guard above, then both set running=true
    // after the await — a TOCTOU race. Claiming here with total:0/results:[] is an "initializing"
    // marker; bootstrapPOD() overwrites these fields once it reads the territory sheet.
    podBootstrapState = { running: true, total: 0, completed: 0, currentAE: null, results: [], completedAt: null, error: null }

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
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'territorySheetId is required' }, 400)
    }
    // Validate sheet ID format (alphanumeric + hyphens + underscores, typical Google Sheet IDs)
    if (!/^[a-zA-Z0-9_-]{44}$/.test(territorySheetId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'Invalid territorySheetId format' }, 400)
    }
    if (!sfReportId || !isValidSfId(sfReportId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
      return c.json({ error: 'sfReportId is required — provide a Salesforce report URL or bare ID' }, 400)
    }
    if (!parentFolderId || !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) {
      podBootstrapState = { running: false, total: 0, completed: 0, currentAE: null, results: [], startedAt: null, completedAt: null, error: null }
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
      podBootstrapState.error = `Fatal: ${e?.message ?? e}`
      podBootstrapState.completedAt = new Date().toISOString()
    })

    return c.json({ ok: true, message: `POD bootstrap started — poll /api/bootstrap/auto/status for progress` })
  })

  // POST /api/oauth/dismiss-downgrade — user has seen the reduce-permissions banner
  app.post('/api/oauth/dismiss-downgrade', (c) => {
    try {
      writeFileSyncRaw(OAUTH_STATE_PATH, JSON.stringify({ pendingDowngrade: false, dismissedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    } catch (e: any) { console.warn('[oauth] dismiss write failed:', e.message) }
    return c.json({ ok: true })
  })

  app.post('/api/bootstrap/auto', async (c) => {
    if (autoBootstrapState.running) return c.json({ error: 'Auto-bootstrap already in progress' }, 409)

    const body = await c.req.json<{
      aeName?: string
      sfReportId?: string
      tableauTerritories?: string[]
      customerNames?: string[]
      parentFolderId?: string
    }>().catch(() => ({}))

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
    // Accept full Drive URL or bare folder ID — extract ID from URL if needed
    const rawParent = (body.parentFolderId ?? '').trim()
    const parentFolderId = rawParent
      ? (rawParent.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)?.[1] ?? rawParent)
      : undefined

    if (!aeName) return c.json({ error: 'aeName is required' }, 400)
    if (aeName.length > 200) return c.json({ error: 'aeName exceeds 200 characters' }, 400)
    if (/<[^>]*>/.test(aeName)) return c.json({ error: 'aeName contains invalid characters' }, 400)
    if (!sfReportId) return c.json({ error: 'sfReportId is required' }, 400)
    if (!isValidSfId(sfReportId)) return c.json({ error: 'sfReportId must be a valid Salesforce report URL or 15-18 character ID' }, 400)
    if (!tableauTerritories.length) return c.json({ error: 'tableauTerritories is required' }, 400)
    if (!customerNames.length) {
      // Distinguish between empty input and fully-filtered junk input
      if (junkFiltered.length > 0 && allCustomerNames.length > 0) {
        return c.json({ error: `customerNames contains invalid characters — only letters, numbers, spaces, and basic punctuation allowed (${junkFiltered.length} names filtered)` }, 400)
      }
      return c.json({ error: 'customerNames is required' }, 400)
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

    autoBootstrapState = {
      running: true,
      aeName,
      steps: [
        { name: 'Create Drive Folder', status: 'pending' },
        { name: 'Create Customer Folders', status: 'pending' },
        { name: 'Discover Account Numbers', status: 'pending' },
        { name: 'Create Supportable Sheet', status: 'pending' },
        { name: 'Create CCSP Sheet', status: 'pending' },
        { name: 'Sync Pipeline Sheet', status: 'pending' },
      ],
      error: null,
      completedAt: null,
      resources: { junkFiltered: junkFiltered.length > 0 ? junkFiltered : undefined },
    }

    const bootstrapStartMs = Date.now()
    const stepStartMs: Record<number, number> = {}
    const setStep = (idx: number, status: AutoBootstrapStep['status'], detail?: string) => {
      const now = Date.now()
      const existing = autoBootstrapState.steps[idx] ?? {}
      // Record startedAt when transitioning to 'running'
      if (status === 'running' && !stepStartMs[idx]) {
        stepStartMs[idx] = now
      }
      // Record completedAt + durationMs when finishing
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
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = `Bootstrap timed out after ${autoTimeoutMin} minutes`
        const stuck = autoBootstrapState.steps.findIndex(s => s.status === 'running')
        if (stuck >= 0) autoBootstrapState.steps[stuck] = { ...autoBootstrapState.steps[stuck], status: 'error', detail: 'Timed out' }
        console.error('[auto-bootstrap] Hard timeout reached — unsticking')
        notify('Bootstrap Timed Out', `Bootstrap did not complete within ${autoTimeoutMin} minutes — check dashboard`, 'urgent').catch(() => {})
      }
    }, autoTimeoutMin * 60 * 1_000)

    // Run async — client polls /api/bootstrap/auto/status
    ;(async () => {
      // Pre-flight — Ensure product intel Drive folders exist under parent (silent, idempotent)
      try {
        const productIntelConfig = loadProductIntelConfig()
        const parentId = productIntelConfig.driveParentFolderId
        if (parentId) {
          const drivePI = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
          const updatedProducts = [...productIntelConfig.products]
          let anyUpdated = false
          for (let i = 0; i < updatedProducts.length; i++) {
            const p = updatedProducts[i]
            if (p.driveFolder) continue  // already set — skip
            const safeSlug = p.slug.replace(/'/g, "\\'")
            const existing = await drivePI.files.list({
              q: `name='${safeSlug}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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
                requestBody: { name: p.slug, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
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

      // Check if AE already has a Drive folder from a previous run — skip creation if so
      const existingAe = aes.find(a => a.name === aeName)
      let driveFolderId = existingAe?.driveFolderId ?? ''

      // Step 1 — Create Drive Folder (skip if already exists)
      try {
        setStep(0, 'running')
        if (driveFolderId) {
          autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: `https://drive.google.com/drive/folders/${driveFolderId}` }
          setStep(0, 'done', `Folder: ${driveFolderId}`)
          console.log(`[auto-bootstrap] Drive folder already exists, reusing: ${driveFolderId}`)
        } else {
          const drive = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })

          // BKL-M27: Check if folder already exists in parent before creating
          if (parentFolderId) {
            const safeName = aeName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            const existing = await drive.files.list({
              q: `name='${safeName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
              fields: 'files(id, name, webViewLink)',
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
            }).catch(() => ({ data: { files: [] } }))
            if (existing.data.files?.length) {
              driveFolderId = existing.data.files[0].id!
              autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: existing.data.files[0].webViewLink ?? `https://drive.google.com/drive/folders/${driveFolderId}` }
              const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
              saveAes(updated)
              setStep(0, 'done', `Folder: ${driveFolderId} (reused existing)`)
              console.log(`[auto-bootstrap] Reusing existing folder: ${aeName} (${driveFolderId})`)
            }
          }

          if (!driveFolderId) {
            const folder = await drive.files.create({
              requestBody: {
                name: aeName,
                mimeType: 'application/vnd.google-apps.folder',
                ...(parentFolderId ? { parents: [parentFolderId] } : {}),
              },
              supportsAllDrives: true,
              fields: 'id,webViewLink',
            })
            driveFolderId = folder.data.id!
            autoBootstrapState.resources.driveFolder = { id: driveFolderId, url: folder.data.webViewLink ?? `https://drive.google.com/drive/folders/${driveFolderId}` }
            const updated = aes.map(a => a.name === aeName ? { ...a, driveFolderId } : a)
            saveAes(updated)
            setStep(0, 'done', `Folder: ${driveFolderId}`)
            console.log(`[auto-bootstrap] Drive folder created: ${driveFolderId}`)
          }
        }
      } catch (e: any) {
        setStep(0, 'error', e.message)
        autoBootstrapState.error = `Drive folder creation failed: ${e.message}`
        console.error('[auto-bootstrap] Drive folder creation failed:', e.message)
      }

      // Step 2 — Create Customer Folders (one subfolder per customer inside AE folder)
      if (!driveFolderId) {
        setStep(1, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping customer folders — no Drive folder')
      } else {
        try {
          setStep(1, 'running', `0/${customerNames.length} folders…`)
          const drive2 = google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) })
          const folderResources: Record<string, { id: string; url: string }> = {}
          for (let i = 0; i < customerNames.length; i++) {
            const cname = customerNames[i]
            try {
              const existingCustomer = customers.find(cx => cx.name === cname)
              let folderId = existingCustomer?.driveFolderId ?? ''
              if (!folderId) {
                // BKL-M27: Check if customer folder already exists before creating
                const safeCname = cname.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
                const existingFolder = await drive2.files.list({
                  q: `name='${safeCname}' and '${driveFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
                  fields: 'files(id, name)',
                  supportsAllDrives: true,
                  includeItemsFromAllDrives: true,
                }).catch(() => ({ data: { files: [] } }))

                if (existingFolder.data.files?.length) {
                  folderId = existingFolder.data.files[0].id!
                  console.log(`[bootstrap] Reusing existing folder: ${cname} (${folderId})`)
                } else {
                  const res = await drive2.files.create({
                    requestBody: {
                      name: cname,
                      mimeType: 'application/vnd.google-apps.folder',
                      parents: [driveFolderId],
                    },
                    supportsAllDrives: true,
                    fields: 'id',
                  })
                  folderId = res.data.id!
                }
                if (existingCustomer) {
                  existingCustomer.driveFolderId = folderId
                } else {
                  customers.push({ name: cname, ae: aeName, driveFolderId: folderId, importedFrom: 'territory-sheet' })
                }
                try {
                  const tmpPath = CUSTOMERS_PATH + '.tmp'
                  writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
                  renameSync(tmpPath, CUSTOMERS_PATH)
                } catch (e: any) { console.warn('[bootstrap] customer folder ID persist failed:', e.message) }
              }
              folderResources[cname] = { id: folderId, url: `https://drive.google.com/drive/folders/${folderId}` }
              setStep(1, 'running', `${i + 1}/${customerNames.length} folders…`)
              console.log(`[auto-bootstrap] Customer folder ready for ${cname}: ${folderId}`)
            } catch (e: any) {
              console.warn(`[auto-bootstrap] Customer folder creation failed for ${cname}: ${e.message}`)
            }
          }
          autoBootstrapState.resources.customerFolders = folderResources
          setStep(1, 'done', `${Object.keys(folderResources).length}/${customerNames.length} folders created`)
          console.log(`[auto-bootstrap] Customer folders done: ${Object.keys(folderResources).length}/${customerNames.length}`)
        } catch (e: any) {
          setStep(1, 'error', e.message)
          autoBootstrapState.error = `Customer folder creation failed: ${e.message}`
          console.error('[auto-bootstrap] Customer folder creation failed:', e.message)
        }
      }

      // Steps 3 + 4 — Discover Account Numbers via Supportable name search, then
      // immediately scrape subscriptions for each account in the same session.
      // Account numbers are saved to customers.json after each customer completes.
      // Scraped subscription data is held in memory and written to sheet in Step 4.
      let supportableScrapeResults: Awaited<ReturnType<typeof runSupportableDiscoverAndScrape>> = []
      try {
        setStep(2, 'running', `0/${customerNames.length} — starting Supportable…`)
        setStep(3, 'running', 'waiting for discovery…')

        // Build customer objects — include supportableName override from customers.json if present
        const discoverCustomers = customerNames.map(name => {
          const existing = customers.find(cx => cx.name === name)
          return { name, supportableName: existing?.supportableName }
        })
        supportableScrapeResults = await runSupportableDiscoverAndScrape(
          discoverCustomers,
          (done, total, name, accountNumbers, rowCount) => {
            // Save account numbers to customers array immediately after each customer
            const existing = customers.find(cx => cx.name === name)
            if (existing) {
              const merged = new Set([...(existing.accountNumbers ?? []), ...accountNumbers])
              existing.accountNumbers = [...merged]
            } else {
              customers.push({ name, ae: aeName, accountNumbers, importedFrom: 'territory-sheet' })
            }
            // Persist to disk after each customer so progress survives a hard timeout
            try {
              const tmpPath = CUSTOMERS_PATH + '.tmp'
              writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
              renameSync(tmpPath, CUSTOMERS_PATH)
            } catch (e: any) { console.warn('[bootstrap] customer progress write failed:', e.message) }
            const acctCount = accountNumbers.length
            const summary = acctCount > 0
              ? `✓ ${acctCount} acct${acctCount !== 1 ? 's' : ''}, ${rowCount} rows`
              : 'no match'
            setStep(2, 'running', `${done}/${total} — ${name}: ${summary}`)
            setStep(3, 'running', `${done}/${total} — ${name}: ${summary}`)
            console.log(`[auto-bootstrap] ${done}/${total} ${name}: ${acctCount} accounts, ${rowCount} rows`)
          },
          (msg) => {
            // Pipe SSO/startup status into the step detail so user sees what's happening
            setStep(2, 'running', `0/${customerNames.length} — ${msg}`)
          },
        )

        // Sync any remaining customers to customers.json (handles customers with 0 accounts)
        // Use canonical name from Supportable CSV (rows[0].Name) as source of truth for display name.
        for (const r of supportableScrapeResults) {
          const canonicalName = (r.rows[0] as Record<string, string> | undefined)?.['Name'] ?? r.customerName
          const existing = customers.find(cx => cx.name === r.customerName)
          if (existing) {
            if (canonicalName !== r.customerName) {
              console.log(`[auto-bootstrap] Renaming "${r.customerName}" → "${canonicalName}" (Supportable canonical)`)
              existing.name = canonicalName
            }
          } else {
            customers.push({ name: canonicalName, ae: aeName, accountNumbers: r.accountNumbers, importedFrom: 'territory-sheet' })
          }
        }
        const tmpPath = CUSTOMERS_PATH + '.tmp'
        writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
        renameSync(tmpPath, CUSTOMERS_PATH)

        const withAccounts = supportableScrapeResults.filter(r => r.accountNumbers.length > 0).length
        const unmatched = supportableScrapeResults
          .filter(r => r.accountNumbers.length === 0)
          .map(r => r.customerName)
        if (unmatched.length > 0) autoBootstrapState.resources.unmatchedCustomers = unmatched
        setStep(2, 'done', `${withAccounts}/${customerNames.length} customers matched`)
        console.log(`[auto-bootstrap] Supportable discovery complete: ${withAccounts}/${customerNames.length} matched`)
      } catch (e: any) {
        // FIX N2: supportableScrapeResults holds whatever partial results were yielded before
        // the throw (via onProgress). Use them as-is for the sheet write below rather than
        // reconstructing from customers (which lack subscription rows and would write bad data).
        // If no partial results were collected, the array stays empty and Step 4 is skipped.
        const partialCustomers = customers.filter(cx => cx.ae === aeName && (cx.accountNumbers?.length ?? 0) > 0)
        if (partialCustomers.length > 0) {
          setStep(2, 'error', `${e.message} (${partialCustomers.length} partial results saved)`)
          console.error(`[auto-bootstrap] Supportable discovery+scrape failed midway: ${e.message} — ${partialCustomers.length} customers already saved`)
        } else {
          setStep(2, 'error', e.message)
          setStep(3, 'error', 'discovery failed — no results to write')
          console.error('[auto-bootstrap] Supportable discovery+scrape failed:', e.message)
        }
        autoBootstrapState.error = `Supportable discovery failed: ${e.message}`
      }

      // Step 4 — Write Supportable Sheet (data already scraped in Step 3)
      if (!driveFolderId) {
        setStep(3, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping Supportable sheet — no Drive folder')
      } else if (supportableScrapeResults.length > 0 && supportableScrapeResults.some(r => r.accountNumbers.length > 0)) {
        try {
          setStep(3, 'running', 'writing to Google Sheet…')
          const existingSupportableId = aes.find(a => a.name === aeName)?.supportableSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `Supportable — ${aeName}`) : null)
            ?? null
          if (existingSupportableId) console.log(`[auto-bootstrap] Supportable sheet found/reusing: ${existingSupportableId}`)
          const sheetId = await writeSupportableSheet(supportableScrapeResults, aeName, driveFolderId || undefined, existingSupportableId || undefined)
          patchAe(aeName, { supportableSheetId: sheetId })
          autoBootstrapState.resources.supportableSheet = { id: sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }
          setStep(3, 'done', `Sheet: ${sheetId}`)
          console.log(`[auto-bootstrap] Supportable sheet ${existingSupportableId ? 'updated' : 'created'}: ${sheetId}`)
        } catch (e: any) {
          setStep(3, 'error', e.message)
          autoBootstrapState.error = `Supportable sheet failed: ${e.message}`
          console.error('[auto-bootstrap] Supportable sheet write failed:', e.message)
        }
      }

      // Step 5 — Create CCSP Sheet
      if (!driveFolderId) {
        setStep(4, 'skipped', 'Skipped: Drive folder creation failed')
        console.log('[auto-bootstrap] Skipping CCSP sheet — no Drive folder')
      } else {
        try {
          setStep(4, 'running')
          const currentAe = aes.find(a => a.name === aeName)!
          const ccspAe = { ...currentAe, tableauTerritories, driveFolderId: driveFolderId || currentAe.driveFolderId } as AE
          const ccspResults = await runCcspScrape([ccspAe])
          const existingCcspId = aes.find(a => a.name === aeName)?.ccspSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `${aeName} CCSP`) : null)
            ?? null
          if (existingCcspId) console.log(`[auto-bootstrap] CCSP sheet found/reusing: ${existingCcspId}`)
          const sheetId = await writeCcspSheet(ccspResults, aeName, ccspAe.driveFolderId, existingCcspId || undefined)
          patchAe(aeName, { ccspSheetId: sheetId })
          autoBootstrapState.resources.ccspSheet = { id: sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }
          setStep(4, 'done', `Sheet: ${sheetId}`)
          console.log(`[auto-bootstrap] CCSP sheet ${existingCcspId ? 'updated' : 'created'}: ${sheetId}`)
        } catch (e: any) {
          setStep(4, 'error', e.message)
          autoBootstrapState.error = `CCSP sheet failed: ${e.message}`
          console.error('[auto-bootstrap] CCSP sheet failed:', e.message)
        }
      }

      // Step 6 — Sync Pipeline Sheet
      if (!driveFolderId) {
        setStep(5, 'error', 'Pipeline sheet skipped: Drive folder was not created in step 1')
        console.log('[auto-bootstrap] Skipping Pipeline sheet — no Drive folder')
      } else {
        try {
          setStep(5, 'running')
          const existingPipelineId = aes.find(a => a.name === aeName)?.pipelineSheetId
            ?? (driveFolderId ? await findExistingSheet(google.drive({ version: 'v3', auth: makeAuth(GOOGLE_UNIFIED_TOKEN_PATH) }), driveFolderId, `${aeName} Pipeline`) : null)
            ?? null
          if (existingPipelineId) console.log(`[auto-bootstrap] Pipeline sheet found/reusing: ${existingPipelineId}`)
          const pipelineSheetId = existingPipelineId ?? await createPipelineSheet(aeName, driveFolderId || aes.find(a => a.name === aeName)?.driveFolderId || '')
          if (existingPipelineId) console.log(`[auto-bootstrap] Reusing existing pipeline sheet for ${aeName}: ${existingPipelineId}`)
          // FIX N3: Persist pipelineSheetId immediately so AE retains the sheet link even if sync fails
          patchAe(aeName, { pipelineSheetId })
          await runSfPipelineSync(sfReportId, RH_PROFILE_DIR, pipelineSheetId)
          autoBootstrapState.resources.pipelineSheet = { id: pipelineSheetId, url: `https://docs.google.com/spreadsheets/d/${pipelineSheetId}/edit` }
          setStep(5, 'done', `Sheet: ${pipelineSheetId}`)
          console.log(`[auto-bootstrap] Pipeline sheet synced: ${pipelineSheetId}`)
          // Populate local pipeline cache immediately so dashboard shows data without waiting for 2am scheduler (BKL-M18)
          refreshPipeline().catch(e => console.warn('[auto-bootstrap] post-bootstrap pipeline cache refresh failed:', e.message))
        } catch (e: any) {
          setStep(5, 'error', e.message)
          autoBootstrapState.error = `Pipeline sync failed: ${e.message}`
          console.error('[auto-bootstrap] Pipeline sync failed:', e.message)
        }
      }

      // BKL-F05: Auto-run domain inference for bootstrapped customers after all steps complete.
      // Non-blocking — runs after bootstrap marks complete, stores results in resources.
      ;(async () => {
        const aeCustomers = customers.filter(cx => !cx.inactive && cx.ae === aeName)
        if (aeCustomers.length === 0) return
        console.log(`[auto-bootstrap] Running domain inference for ${aeCustomers.length} customers…`)
        const inferenceResults: NonNullable<typeof autoBootstrapState.resources.domainInference> = []
        const highConfidenceSaves: { name: string; domain: string }[] = []

        for (let i = 0; i < aeCustomers.length; i += 3) {
          const batch = aeCustomers.slice(i, i + 3)
          const batchResults = await Promise.all(
            batch.map(cu => inferCustomerDomain(cu, GOOGLE_UNIFIED_TOKEN_PATH).catch(() => null))
          )
          for (const r of batchResults) {
            if (!r || r.candidates.length === 0) continue
            const top = r.candidates[0]
            const confidence = isHighConfidenceDomain(top) ? 'high' : 'low'
            inferenceResults.push({ customerName: r.customerName, domain: top.domain, confidence, sources: top.sources })
            if (confidence === 'high') highConfidenceSaves.push({ name: r.customerName, domain: top.domain })
          }
        }

        // Auto-save high-confidence domains to customers.json
        if (highConfidenceSaves.length > 0) {
          for (const { name, domain } of highConfidenceSaves) {
            const cu = customers.find(cx => cx.name === name)
            if (cu && !cu.domain) cu.domain = domain
          }
          try {
            writeFileSyncRaw(CUSTOMERS_PATH + '.tmp', JSON.stringify({ customers }, null, 2), { mode: 0o600 })
            renameSync(CUSTOMERS_PATH + '.tmp', CUSTOMERS_PATH)
            console.log(`[auto-bootstrap] Auto-saved ${highConfidenceSaves.length} high-confidence domain(s)`)
          } catch (e: any) { console.warn('[auto-bootstrap] domain auto-save failed:', e.message) }
        }

        if (inferenceResults.length > 0) {
          autoBootstrapState.resources.domainInference = inferenceResults
          console.log(`[auto-bootstrap] Domain inference complete: ${highConfidenceSaves.length} auto-saved, ${inferenceResults.length - highConfidenceSaves.length} need review`)
        }
      })().catch((e: any) => console.warn('[auto-bootstrap] domain inference failed:', e.message))

      autoBootstrapState.running = false
      autoBootstrapState.completedAt = new Date().toISOString()
      clearTimeout(bootstrapTimeoutId)

      // Record bootstrap history
      const aeCustomerCount = customers.filter(cx => !cx.inactive && cx.ae === aeName).length
      recordBootstrapRun({
        aeName,
        completedAt: autoBootstrapState.completedAt,
        success: !autoBootstrapState.error,
        customerCount: aeCustomerCount,
        accountsFound: customers.filter(cx => !cx.inactive && cx.ae === aeName && (cx.accountNumbers?.length ?? 0) > 0).length,
        durationMs: Date.now() - bootstrapStartMs,
        source: 'single',
      })

      // BKL-AI07: Auto-generate account intelligence for all customers after bootstrap.
      // Non-blocking — bootstrap completes first; generation runs in background via batch endpoint.
      const port = process.env.PORT ?? '7777'
      fetch(`http://localhost:${port}/api/intelligence/generate-all`, { method: 'POST' })
        .then(r => console.log(`[auto-bootstrap] intelligence batch started: ${r.status}`))
        .catch(e => console.warn('[auto-bootstrap] intelligence batch trigger failed:', e?.message))
      console.log(`[auto-bootstrap] All steps complete for ${aeName}`)
      notify('Bootstrap Complete', `All steps complete for ${aeName}`, 'high').catch(() => {})
    })()

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
  let _tableauStatusCache: { result: { reachable: boolean; sessionValid: boolean }; cachedAt: number } | null = null
  const TABLEAU_STATUS_TTL_MS = 5 * 60 * 1000

  app.get('/api/bootstrap/tableau/session-status', async (c) => {
    const force = c.req.query('force') === 'true'
    if (!force && _tableauStatusCache && Date.now() - _tableauStatusCache.cachedAt < TABLEAU_STATUS_TTL_MS) {
      return c.json(_tableauStatusCache.result)
    }
    const ctx = getScrapeContext()
    if (!ctx) return c.json({ reachable: false, sessionValid: false })
    let page: Awaited<ReturnType<typeof ctx.newPage>> | null = null
    try {
      page = await ctx.newPage()
      await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      // Wait for SAML redirect chain to settle — SSO relay pages fire domcontentloaded
      // mid-redirect; 6s gives the full chain time to land on the final Tableau URL
      await page.waitForTimeout(6_000)
      const url = page.url()
      // Only flag as login page if we didn't land on the Tableau domain,
      // or if there's actually a password/login form visible (not just /auth in the URL)
      const hasLoginForm = !!(await page.$('input[type="password"], input#username, [data-testid="login"]').catch(() => null))
      const onLoginPage = !url.startsWith('https://10ay.online.tableau.com') || hasLoginForm
      const result = { reachable: true, sessionValid: !onLoginPage }
      _tableauStatusCache = { result, cachedAt: Date.now() }
      return c.json(result)
    } catch {
      const result = { reachable: false, sessionValid: false }
      _tableauStatusCache = { result, cachedAt: Date.now() }
      return c.json(result)
    } finally {
      await page?.close().catch(() => {})
    }
  })

  // GET /api/bootstrap/tableau/wait-for-login — long-poll that resolves when the live page
  // lands on the Tableau dashboard (logged-in URL, no login form). Uses a two-phase
  // check: first waits for the Tableau hostname, then waits for the SAML redirect
  // chain to settle (6s) before re-verifying. Without the settle delay, the initial
  // domcontentloaded on 10ay.online.tableau.com fires BEFORE SSO redirects the page
  // to the login form — causing a false-positive that closes the VNC window immediately.
  app.get('/api/bootstrap/tableau/wait-for-login', async (c) => {
    const livePage = getLivePage()
    if (!livePage) {
      console.log('[tableau] wait-for-login: no live page available')
      return c.json({ sessionValid: false })
    }

    await livePage.waitForTimeout(8_000)

    const settledUrl = livePage.url()
    console.log(`[tableau] wait-for-login: settled on ${settledUrl}`)

    const alreadyValid = await livePage.evaluate(() => {
      const onTableau = window.location.hostname.includes('10ay.online.tableau.com')
      const noLoginForm = !document.querySelector('input[type="password"], input#username, [data-testid="login"]')
      return onTableau && noLoginForm
    }).catch(() => false)

    if (alreadyValid) {
      console.log('[tableau] wait-for-login: already valid after settle')
      setLivePageBusy(false)
      return c.json({ sessionValid: true })
    }
    console.log('[tableau] wait-for-login: not yet valid — watching for login completion (120s timeout)')

    // Not yet logged in — wait for the user to complete login in the VNC window.
    // At this point we know the SSO redirect has happened and a login form is
    // showing (or we're on an SSO provider page). Watch for the page to land
    // back on Tableau with no login form — that signals successful login.
    const checkTableauLoggedIn = () => {
      const onTableau = window.location.hostname.includes('10ay.online.tableau.com')
      const noLoginForm = !document.querySelector('input[type="password"], input#username, [data-testid="login"]')
      return onTableau && noLoginForm
    }

    try {
      await livePage.waitForFunction(checkTableauLoggedIn, { timeout: 120_000 })

      // Post-login settle: wait 6s for any final redirects after SSO completes,
      // then re-verify. This catches the case where SSO landing on Tableau fires
      // domcontentloaded before a secondary redirect (e.g. consent page).
      await livePage.waitForTimeout(6_000)
      const finalValid = await livePage.evaluate(() => {
        const onTableau = window.location.hostname.includes('10ay.online.tableau.com')
        const noLoginForm = !document.querySelector('input[type="password"], input#username, [data-testid="login"]')
        return onTableau && noLoginForm
      }).catch(() => false)

      console.log(`[tableau] wait-for-login: login detected, finalValid=${finalValid}`)
      setLivePageBusy(false)
      return c.json({ sessionValid: finalValid })
    } catch (e: any) {
      console.warn(`[tableau] wait-for-login: timed out or failed — ${e?.message ?? e}`)
      setLivePageBusy(false)
      return c.json({ sessionValid: false })
    }
  })

  // POST /api/bootstrap/tableau/open-login — opens a Playwright browser page to
  // Tableau Cloud so the user can log in via the VNC viewer at localhost:6080.
  // Sets the livePageBusy flag to prevent the RH keep-alive timer from navigating
  // the page away from Tableau while the user is logging in.
  app.post('/api/bootstrap/tableau/open-login', async (c) => {
    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'No RH session — connect Red Hat Portal first' }, 400)
    try {
      // Mark live page as busy so the keep-alive timer doesn't steal it
      setLivePageBusy(true)
      // Navigate the live VNC-visible page so the user can actually see Tableau in the VNC window
      const livePage = getLivePage()
      const page = livePage ?? await ctx.newPage()
      await page.goto(TABLEAU_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.bringToFront()
      console.log('[tableau] opened Tableau in live VNC page — visible at localhost:6080')
      return c.json({ ok: true })
    } catch (e: any) {
      setLivePageBusy(false)
      return c.json({ error: 'Could not open Tableau — check VPN connection' }, 500)
    }
  })

  // ── Tableau territory discovery ────────────────────────────────────────────

  app.get('/api/bootstrap/tableau/territories', async (c) => {
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

  app.get('/api/bootstrap/initial-load/status', (c) => {
    return c.json({
      ...initialLoadState,
      errors: initialLoadState.errors.map(e => ({
        customer: e.customer,
        message: String(e.message ?? '').slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]'),
      })),
    })
  })

  app.post('/api/bootstrap/initial-load', async (c) => {
    const { supportableScrapeRunning } = await import('./supportable-scraper.ts')
    if (initialLoadState.running) return c.json({ error: 'Initial load already running' }, 409)
    if (supportableScrapeRunning) return c.json({ error: 'Supportable scrape already in progress — wait for it to finish' }, 409)

    const ctx = getScrapeContext()
    if (!ctx) return c.json({ error: 'No browser context — connect Red Hat Portal first' }, 400)

    // Snapshot customer list at start time
    const allCustomers = [...customers]
    if (!allCustomers.length) return c.json({ error: 'No customers configured' }, 400)

    // Determine which customers to run: skip those with existing supportableSheetId + cached rows
    const toRun: typeof allCustomers = []
    const skipped: string[] = []
    for (const cu of allCustomers) {
      const ae = aes.find(a => a.name === cu.ae)
      if (ae?.supportableSheetId) {
        // Try to check if sheet has rows via account number cache
        const hasAccounts = (cu.accountNumbers?.length ?? 0) > 0
        if (hasAccounts) { skipped.push(cu.name); continue }
      }
      toRun.push(cu)
    }

    initialLoadState.running = true
    initialLoadState.completedCount = 0
    initialLoadState.totalCount = toRun.length
    initialLoadState.errors = []
    initialLoadState.currentCustomer = null
    initialLoadState.startedAt = new Date().toISOString()
    initialLoadState.completedAt = null

    console.log(`[initial-load] starting: ${toRun.length} to run, ${skipped.length} skipped (already have data)`)

    // Hard timeout: 3 hours max — unsticks the lock if a customer scrape hangs indefinitely
    const initialLoadTimeoutId = setTimeout(() => {
      if (initialLoadState.running) {
        initialLoadState.running = false
        initialLoadState.currentCustomer = null
        initialLoadState.completedAt = new Date().toISOString()
        initialLoadState.errors.push({ customer: '(timeout)', message: 'Initial load timed out after 3 hours' })
        console.error('[initial-load] Hard timeout reached — unsticking lock')
      }
    }, 3 * 60 * 60 * 1_000)

    ;(async () => {
      for (const cu of toRun) {
        initialLoadState.currentCustomer = cu.name
        try {
          const ae = aes.find(a => a.name === cu.ae)
          const results = await runSupportableDiscoverAndScrape(
            [cu],
            () => {},
            (msg) => console.log(`[initial-load:${cu.name}] ${msg}`)
          )
          if (results.length && results[0].accountNumbers.length > 0) {
            // Persist account numbers incrementally
            const r = results[0]
            const idx = customers.findIndex(c => c.name === cu.name)
            if (idx >= 0) {
              customers[idx] = { ...customers[idx], accountNumbers: r.accountNumbers }
              const tmpPath = CUSTOMERS_PATH + '.tmp'
              writeFileSyncRaw(tmpPath, JSON.stringify({ customers }, null, 2), { mode: 0o600 })
              renameSync(tmpPath, CUSTOMERS_PATH)
            }
            // Write Supportable sheet incrementally
            if (ae) {
              const sheetId = await writeSupportableSheet(
                results,
                cu.ae,
                ae.driveFolderId || undefined,
                ae.supportableSheetId || undefined
              ).catch((e: any) => { console.warn(`[initial-load:${cu.name}] sheet write failed: ${sanitizeErr(e)}`); return null })
              if (sheetId && !ae.supportableSheetId) {
                saveAes(aes.map(a => a.name === cu.ae ? { ...a, supportableSheetId: sheetId } : a))
              }
            }
          }
          initialLoadState.completedCount++
        } catch (e: any) {
          const msg = sanitizeErr(e)
          console.warn(`[initial-load:${cu.name}] error: ${msg}`)
          initialLoadState.errors.push({ customer: cu.name, message: msg })
          initialLoadState.completedCount++
        }
      }
      clearTimeout(initialLoadTimeoutId)
      initialLoadState.running = false
      initialLoadState.currentCustomer = null
      initialLoadState.completedAt = new Date().toISOString()
      console.log(`[initial-load] complete: ${initialLoadState.completedCount} processed, ${initialLoadState.errors.length} errors`)
    })().catch((e: any) => {
      clearTimeout(initialLoadTimeoutId)
      console.error('[initial-load] fatal:', sanitizeErr(e))
      initialLoadState.running = false
      initialLoadState.currentCustomer = null
      initialLoadState.completedAt = new Date().toISOString()
    })

    return c.json({ started: true, total: toRun.length, skipped: skipped.length })
  })
}
