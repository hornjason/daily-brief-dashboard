// ── Auto-bootstrap + Tableau routes (M03 — extracted from server.ts) ────────
import { Hono } from 'hono'
import { writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
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

// ── Constants ────────────────────────────────────────────────────────────────
const SRV_CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const RH_PROFILE_DIR = process.env.RH_PROFILE_DIR ?? resolve(SRV_CONFIG_DIR, '.rh-chrome-profile')
const OAUTH_STATE_PATH = resolve(SRV_CONFIG_DIR, 'oauth-state.json')
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? 'pai-notifications'

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

/** Strip internal file paths and cap length before returning error strings to clients. */
const sanitizeErr = (e: any): string =>
  String(e?.message ?? e).slice(0, 200).replace(/\/[^\s:]+\.(ts|js)/g, '[file]')

// ── Interfaces ───────────────────────────────────────────────────────────────

interface AutoBootstrapStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  detail?: string
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
    const sanitized = {
      ...autoBootstrapState,
      error: sanitizeDetail(autoBootstrapState.error),
      steps: autoBootstrapState.steps.map(step => ({
        ...step,
        detail: sanitizeDetail(step.detail),
      })),
    }
    return c.json(sanitized)
  })

  // POST /api/bootstrap/auto/reset — clear a stuck bootstrap state
  app.post('/api/bootstrap/auto/reset', (c) => {
    autoBootstrapState = { running: false, steps: [], aeName: '', completedAt: null, error: null, resources: {} }
    console.log('[auto-bootstrap] State reset by user request')
    return c.json({ ok: true })
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
    if (!customerNames.length) return c.json({ error: 'customerNames is required' }, 400)
    if (customerNames.some(n => /<[^>]*>/.test(n))) return c.json({ error: 'customerNames contains invalid characters' }, 400)
    if (parentFolderId && !/^[a-zA-Z0-9_-]{10,}$/.test(parentFolderId)) return c.json({ error: 'Invalid parentFolderId format' }, 400)

    // Upsert AE into aes.json immediately with basic fields
    let aeConfig = aes.find(a => a.name === aeName)
    if (!aeConfig) {
      aeConfig = { name: aeName, driveFolderId: '', sfReportId, tableauTerritories }
      saveAes([...aes, aeConfig])
    } else {
      const updated = aes.map(a => a.name === aeName ? { ...a, sfReportId, tableauTerritories } : a)
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

    const setStep = (idx: number, status: AutoBootstrapStep['status'], detail?: string) => {
      autoBootstrapState.steps[idx] = { ...autoBootstrapState.steps[idx], status, detail }
    }

    // Hard timeout: if bootstrap is still running after 60 minutes, unstick it
    const bootstrapTimeoutId = setTimeout(() => {
      if (autoBootstrapState.running) {
        autoBootstrapState.running = false
        autoBootstrapState.completedAt = new Date().toISOString()
        autoBootstrapState.error = 'Bootstrap timed out after 60 minutes'
        const stuck = autoBootstrapState.steps.findIndex(s => s.status === 'running')
        if (stuck >= 0) autoBootstrapState.steps[stuck] = { ...autoBootstrapState.steps[stuck], status: 'error', detail: 'Timed out' }
        console.error('[auto-bootstrap] Hard timeout reached — unsticking')
        notify('Bootstrap Timed Out', 'Bootstrap did not complete within 60 minutes — check dashboard', 'urgent').catch(() => {})
      }
    }, 60 * 60 * 1_000)

    // Run async — client polls /api/bootstrap/auto/status
    ;(async () => {
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
                  customers.push({ name: cname, ae: aeName, driveFolderId: folderId })
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
              customers.push({ name, ae: aeName, accountNumbers })
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
            customers.push({ name: canonicalName, ae: aeName, accountNumbers: r.accountNumbers })
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
        // Non-fatal: partial results may have been saved to customers.json via the progress callback.
        // Rebuild supportableScrapeResults from whatever customers were persisted so Step 4 can still write them.
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
          const pipelineSheetId = await createPipelineSheet(aeName, driveFolderId || aes.find(a => a.name === aeName)?.driveFolderId || '')
          await runSfPipelineSync(sfReportId, RH_PROFILE_DIR, pipelineSheetId)
          patchAe(aeName, { pipelineSheetId })
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
        const aeCustomers = customers.filter(cx => cx.ae === aeName)
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
  app.get('/api/bootstrap/tableau/session-status', async (c) => {
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
      const hasLoginForm = !!(await page.$('input[type="password"], #username, [data-testid="login"]').catch(() => null))
      const onLoginPage = !url.startsWith('https://10ay.online.tableau.com') || hasLoginForm
      return c.json({ reachable: true, sessionValid: !onLoginPage })
    } catch {
      return c.json({ reachable: false, sessionValid: false })
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
    if (!livePage) return c.json({ sessionValid: false })

    // ── Initial settle delay ────────────────────────────────────────────────
    // open-login navigates the live page to Tableau. The initial domcontentloaded
    // fires on 10ay.online.tableau.com BEFORE the SSO redirect chain completes.
    // Without this delay, checkTableauLoggedIn sees the Tableau hostname with no
    // login form (not rendered yet) and returns a false-positive — which causes
    // the frontend to close the VNC window before the user can interact.
    // Wait 8s for the SSO redirect chain to fully settle before starting to watch.
    await livePage.waitForTimeout(8_000)

    // After settling, check current state — if already on Tableau with no login
    // form, SSO auto-completed (valid shared-context cookies) and we're done.
    const alreadyValid = await livePage.evaluate(() => {
      const onTableau = window.location.hostname.includes('10ay.online.tableau.com')
      const noLoginForm = !document.querySelector('input[type="password"], #username, [data-testid="login"]')
      return onTableau && noLoginForm
    }).catch(() => false)

    if (alreadyValid) {
      setLivePageBusy(false)
      return c.json({ sessionValid: true })
    }

    // Not yet logged in — wait for the user to complete login in the VNC window.
    // At this point we know the SSO redirect has happened and a login form is
    // showing (or we're on an SSO provider page). Watch for the page to land
    // back on Tableau with no login form — that signals successful login.
    const checkTableauLoggedIn = () => {
      const onTableau = window.location.hostname.includes('10ay.online.tableau.com')
      const noLoginForm = !document.querySelector('input[type="password"], #username, [data-testid="login"]')
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
        const noLoginForm = !document.querySelector('input[type="password"], #username, [data-testid="login"]')
        return onTableau && noLoginForm
      }).catch(() => false)

      setLivePageBusy(false)
      return c.json({ sessionValid: finalValid })
    } catch {
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
  // Runs sequentially (PARALLEL_PAGES=1 constraint), writes incrementally.

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
