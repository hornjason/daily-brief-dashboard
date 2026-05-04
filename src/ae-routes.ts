/**
 * BKL-ARCH-10 — AE management route module.
 *
 * Extracts the 3 AE route handlers from server.ts into a standalone module
 * following the established initXRoutes(opts) + createXRouter(): Hono factory pattern.
 *
 * Routes registered:
 *   GET  /api/aes                — list all AEs
 *   POST /api/aes                — add/update AEs with Drive validation and aes.json write
 *   POST /api/aes/validate-folder — validate a Drive folder ID, create Config subfolder,
 *                                   distribute settings.json
 *
 * Pure structural refactor — zero behavior changes from the in-server versions.
 * Private helpers (normalizeCustomerName, isValidSfId, extractSfReportId) moved here
 * from server.ts to follow the logic they serve.
 */
import { Hono } from 'hono'
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { AE, Customer } from './types.ts'
import { aes, customers, saveAes, setCustomers, CUSTOMERS_PATH } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr, sanitizeText } from './utils.ts'
import { normalizeSettings, getRegionById } from './region-config.ts'
import { writeSettingsToDrive, resolveConfigFolderId } from './drive-config-sync.ts'

// ── Module state ─────────────────────────────────────────────────────────────
let CACHE_DIR = ''
let SETTINGS_PATH = ''

export function initAeRoutes(opts: { cacheDir: string; settingsPath: string }): void {
  CACHE_DIR = opts.cacheDir
  SETTINGS_PATH = opts.settingsPath
}

// ── Private helpers (moved from server.ts) ───────────────────────────────────

/**
 * BKL-M05: Display-oriented normalizer — differs from normalizeForMatch by stripping state codes,
 * parentheticals, and applying title case (needed for Drive folder names).
 *
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
 * Handles Lightning URLs (/lightning/r/Report/ID/view), Classic (/ID), and path variants.
 * Returns the extracted ID or the original string if no URL pattern matched.
 */
function extractSfReportId(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  // Already a bare ID — return as-is
  if (/^[A-Za-z0-9]{15,18}$/.test(trimmed)) return trimmed
  // URL pattern — extract last path segment that looks like a SF ID
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      // Walk segments in reverse to find the ID (handles /view suffix, etc.)
      for (let i = segments.length - 1; i >= 0; i--) {
        if (/^[A-Za-z0-9]{15,18}$/.test(segments[i])) return segments[i]
      }
    } catch { /* not a valid URL — fall through */ }
  }
  // Not a URL and not a bare ID — return as-is (will fail validation downstream)
  return trimmed
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function createAeRouter(): Hono {
  const r = new Hono()

  // GET /api/aes — list all AEs
  r.get('/api/aes', (c) => c.json({ aes }))

  // POST /api/aes — add/update AEs with Drive validation and aes.json write (~100-line handler)
  r.post('/api/aes', async (c) => {
    try {
      const body = await c.req.json() as { aes: AE[] }
      if (!Array.isArray(body.aes)) return c.json({ error: 'aes must be an array' }, 400)
      if (body.aes.length > 50) return c.json({ error: 'aes array exceeds maximum of 50 entries' }, 400)

      // Validate each AE entry
      for (let i = 0; i < body.aes.length; i++) {
        const ae = body.aes[i]
        const name = sanitizeText(ae.name)
        if (!name) return c.json({ error: `aes[${i}].name is invalid or contains disallowed characters` }, 400)
        // BKL-F07: Accept full Salesforce URLs — extract bare ID before validation
        if (ae.sfReportId) ae.sfReportId = extractSfReportId(ae.sfReportId)
        if (ae.sfReportId && !isValidSfId(ae.sfReportId)) return c.json({ error: `aes[${i}].sfReportId must be a valid Salesforce report URL or 15-18 character ID` }, 400)
        if (Array.isArray(ae.tableauTerritories)) {
          for (const t of ae.tableauTerritories) {
            if (typeof t !== 'string' || t.length > 100) return c.json({ error: `aes[${i}].tableauTerritories entry exceeds 100 characters` }, 400)
          }
        }
        // Extract folder ID from full Google Drive URL if provided
        const rawFolderId = ae.driveFolderId ?? ''
        const folderIdMatch = rawFolderId.match(/\/folders\/([a-zA-Z0-9_-]{20,})/)
        const driveFolderId = folderIdMatch ? folderIdMatch[1] : rawFolderId.trim()
        // Write whitelisted fields only — drop anything not in the schema
        body.aes[i] = {
          name,
          driveFolderId,
          parentFolderId:       ae.parentFolderId       ?? undefined,
          sfReportId:           ae.sfReportId           ?? '',
          tableauTerritories:   ae.tableauTerritories   ?? [],
          tableauUrl:           ae.tableauUrl           ?? undefined,
          subscriptionSheetId:   ae.subscriptionSheetId   ?? undefined,
          pipelineSheetId:      ae.pipelineSheetId      ?? undefined,
          ccspSheetId:          ae.ccspSheetId          ?? undefined,
        }
        // Strip undefined values to keep JSON clean
        Object.keys(body.aes[i]).forEach(k => (body.aes[i] as any)[k] === undefined && delete (body.aes[i] as any)[k])
      }

      // Detect removed AEs and invalidate their customer caches
      const newAeNames = new Set(body.aes.map((a: AE) => a.name))
      const removedAeNames = aes.filter(a => !newAeNames.has(a.name)).map(a => a.name)
      const removedCustomerNames = removedAeNames.length > 0
        ? customers.filter(c => c.ae && removedAeNames.includes(c.ae)).map(c => c.name)
        : []

      saveAes(body.aes)
      // Mark customers belonging to deleted AEs as inactive (preserve if they have data)
      if (removedAeNames.length > 0) {
        try {
          const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
          const updated = (raw.customers ?? []).map((c: Customer) => {
            if (!c.ae || !removedAeNames.includes(c.ae)) return c
            // Preserve if customer has account numbers or a Drive folder — mark inactive
            if ((c.accountNumbers?.length ?? 0) > 0 || c.driveFolderId) {
              return { ...c, inactive: true }
            }
            return null // no data — drop entirely
          }).filter(Boolean)
          writeJsonAtomic(CUSTOMERS_PATH, { customers: updated })
          setCustomers(updated)
          const markedInactive = updated.filter((c: Customer) => c.inactive && removedAeNames.includes(c.ae ?? '')).length
          const dropped = (raw.customers ?? []).length - updated.length
          console.log(`[wizard] AE removal: ${markedInactive} customers marked inactive, ${dropped} dropped (no data) for AEs: ${removedAeNames.join(', ')}`)
        } catch (e: any) { console.warn('[wizard] customer cleanup after AE removal failed:', e.message) }
      } else {
        // No AEs removed — just reload customers in case other changes happened
        try {
          const raw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf-8'))
          setCustomers(raw.customers ?? [])
        } catch (e: any) { console.warn('[wizard] customers reload failed:', e.message) }
      }

      // Purge per-customer cache files for removed AEs
      if (removedCustomerNames.length > 0) {
        try {
          const cacheFiles = readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'))
          const removedSlugs = new Set(removedCustomerNames.map(toSlug))
          for (const file of cacheFiles) {
            const match = file.match(/^(.+?)-(sheets|\d{4}-\d{2}-\d{2})\.json$/)
            if (!match) continue
            if (removedSlugs.has(match[1])) {
              try { unlinkSync(resolve(CACHE_DIR, file)) } catch { /* already gone */ }
              console.log(`[wizard] purged cache file for removed AE customer: ${file}`)
            }
          }
          // AE-level caches are stale after AE removal — delete so next sync rebuilds clean
          for (const aeCache of ['ccsp-data.json', 'pipeline-data.json']) {
            try { unlinkSync(resolve(CACHE_DIR, aeCache)) } catch { /* ok if absent */ }
            console.log(`[wizard] purged ${aeCache} after removing AEs: ${removedAeNames.join(', ')}`)
          }
          // Morning synthesis is stale after AE removal
          try { unlinkSync(resolve(CACHE_DIR, 'morning-synthesis.json')) } catch { /* ok */ }
          console.log(`[wizard] invalidated morning-synthesis.json after removing AEs: ${removedAeNames.join(', ')}`)
        } catch (e: any) { console.warn('[wizard] cache cleanup after AE removal failed:', e.message) }
      }

      return c.json({ ok: true, count: aes.length })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // POST /api/aes/validate-folder — validate Drive folder ID, create Config subfolder,
  //   distribute settings.json (~98-line handler)
  r.post('/api/aes/validate-folder', async (c) => {
    try {
      const { folderUrl } = await c.req.json() as { folderUrl: string }
      const match = folderUrl?.match(/\/folders\/([\w-]+)/)
      if (!match) return c.json({ error: 'Could not extract folder ID from URL' }, 400)
      const folderId = match[1]
      const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
      const drive = google.drive({ version: 'v3', auth })
      const res = await drive.files.get({
        fileId: folderId,
        supportsAllDrives: true,
        fields: 'id,name,mimeType',
      })
      if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
        return c.json({ error: 'URL does not point to a folder' }, 400)
      }
      const folderName = res.data.name ?? folderId

      // ── Config subfolder + settings.json distribution (BKL-UX84) ─────────
      // 1. Create Config/ subfolder inside the validated folder (idempotent).
      // 2. Write current settings.json to Config/settings.json in Drive.
      // 3. Save parentFolderId to local settings.json for the first region.
      let configFolderId: string | undefined
      try {
        // Look up Config/ via shared helper (consults scaffold cache + Drive list).
        configFolderId = (await resolveConfigFolderId(folderId)) ?? undefined
        if (!configFolderId) {
          // Not present yet — create it. Ownership of the create-if-absent step
          // stays in ae-routes; drive-config-sync only resolves existing folders.
          const createRes = await drive.files.create({
            requestBody: { name: 'Config', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] },
            supportsAllDrives: true,
            fields: 'id',
          })
          configFolderId = createRes.data.id!
        }

        // Save parentFolderId to local settings.json FIRST (before Drive write)
        try {
          let rawSettings: Record<string, unknown> = {}
          try { rawSettings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) } catch { /* new file */ }
          const normalized = normalizeSettings(rawSettings)
          if (normalized.regions.length > 0) {
            normalized.regions[0].parentFolderId = folderId
            const out = rawSettings.regions
              ? { ...rawSettings, regions: normalized.regions }
              : rawSettings
            writeJsonAtomic(SETTINGS_PATH, out)
          }
        } catch (e) {
          console.warn('[validate-folder] Could not save parentFolderId to settings.json:', (e as Error).message)
        }

        // Write updated settings.json to Drive Config/ folder via shared helper.
        // (writeSettingsToDrive will re-resolve the Config/ folder id; the find/create
        // above guarantees it exists, so the inner list is a cheap roundtrip.)
        await writeSettingsToDrive(folderId)
      } catch (e) {
        // Config subfolder / settings distribution is best-effort; don't fail the validate
        console.warn('[validate-folder] Config subfolder setup error:', (e as Error).message)
        configFolderId = undefined
      }

      return c.json({ folderId, folderName, configFolderId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 400)
    }
  })

  return r
}
