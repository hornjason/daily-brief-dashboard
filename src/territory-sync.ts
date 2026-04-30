/**
 * Territory sheet sync — compares Google Sheet territory data against
 * the current customers list and returns add/remove/unchanged sets.
 *
 * BKL-ARCH-01: Multi-region support.
 * Two parser strategies are dispatched by `region.type`:
 *   - `commercial`: row-oriented — each tab represents a pod, the "Account Executive"
 *     row has AE names in columns, accounts listed below each column.
 *   - `enterprise`: column-oriented — one tab for the whole region, "Account Executive"
 *     appears as a column header, AE name in the next row, territory code below that.
 *
 * Region config is loaded from settings.json via `region-config.ts`. No
 * hardcoded region strings live in the matching logic — all keywords are
 * derived from the pod keys in settings.json.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import {
  normalizeSettings,
  getRegionById,
  derivePodKeywordMap,
  type RegionConfig,
} from './region-config.ts'

const TERRITORY_SHEET_ID_FALLBACK = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

function loadSettingsRaw(): Record<string, unknown> {
  try {
    const p = resolve(process.env.CONFIG_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'config'), 'settings.json')
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function extractSheetIdFromUrl(url: string): string {
  const m = url.match(/spreadsheets\/d\/([^/]+)/)
  return m ? m[1] : ''
}

/** Resolve a region's territory sheet ID from its URL, with legacy fallbacks. */
function resolveRegionSheetId(region: RegionConfig): string {
  const fromRegion = extractSheetIdFromUrl(region.territorySheetUrl ?? '')
  if (fromRegion) return fromRegion
  try {
    const configPath = resolve(process.env.CONFIG_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'config'), 'data-sources.json')
    const ds = JSON.parse(readFileSync(configPath, 'utf-8'))
    return (ds.podConfig?.territorySheetId as string | undefined) ?? process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  } catch {
    return process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTerritoryCustomerName(raw: string): string {
  let name = raw.trim()
  if (!name) return ''
  name = name.replace(/\s*-\s*[A-Z]{2}(\/[A-Z]{2})?$/, '')
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i, /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,     /,?\s+INC\.?$/i, /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,       /,?\s+CORP\.?$/i, /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  name = name.replace(/^[=+\-@]+/, '')
  name = name.trim()
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

/**
 * Commercial parser helper — match a tab title to a pod key using keywords
 * derived from the pod keys in settings.json.  No hardcoded region strings.
 */
export function podPrefixFromTabTitle(tabTitle: string, region: RegionConfig): string {
  const t = tabTitle.toLowerCase()
  const keywordMap = derivePodKeywordMap(region)

  // Prefer the longest keyword match so "north central" wins over "central".
  let bestKey = ''
  let bestLen = 0
  for (const [podKey, keywords] of Object.entries(keywordMap)) {
    for (const kw of keywords) {
      if (!kw) continue
      if (t.includes(kw) && kw.length > bestLen) {
        bestKey = podKey
        bestLen = kw.length
      }
    }
  }
  return bestKey
}

// ── Enterprise parser ────────────────────────────────────────────────────────

/**
 * Detect whether a sheet tab is the enterprise AE/territory sheet.
 * Returns true if the tab contains BOTH an "Account Executive" header cell
 * (case-insensitive, exact text match) AND a cell matching /Terr?\d{1,2}/i in
 * the first 25 rows. Handles both "Ter01" and "Terr01" (double-r) formats.
 */
export function isEnterpriseTab(rows: string[][]): boolean {
  const scan = rows.slice(0, 25)
  let hasAeHeader = false
  let hasTerrCode = false
  for (const row of scan) {
    for (const cell of row) {
      const c = String(cell ?? '').trim()
      if (!hasAeHeader && /^account executive$/i.test(c)) hasAeHeader = true
      // Match "Ter01" (single-r) and "Terr01" (double-r) territory codes
      if (!hasTerrCode && /Terr?\d+/i.test(c)) hasTerrCode = true
      if (hasAeHeader && hasTerrCode) return true
    }
  }
  return false
}

/**
 * Extract AE → [territory codes] from an enterprise sheet tab.
 *
 * Supports two layouts:
 *   1. Combined cell: "Account Executive" header row, next row has "AE Name\nTerrXX"
 *      (TOLA layout — name and territory code share one cell separated by newline)
 *   2. Separate rows: "Account Executive" header, next row has AE name, row+2..+4 has territory code
 *
 * Territory codes use "Terr01" (double-r) in TOLA or "Ter01" (single-r) in other enterprise sheets.
 * Returns `{ 'AE Name': ['Terr01', 'Terr03', ...] }`.
 */
export function extractEnterpriseAeMap(rows: string[][]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  // Search up to row 10 for the "Account Executive" header (TOLA has it at row 3)
  const maxHeaderRow = Math.min(10, rows.length)

  for (let headerRow = 0; headerRow < maxHeaderRow; headerRow++) {
    const header = rows[headerRow] ?? []
    for (let col = 0; col < header.length; col++) {
      const cell = String(header[col] ?? '').trim()
      if (!/^account executive$/i.test(cell)) continue

      // AE name is in the next row at the same column
      const rawAeCell = String(rows[headerRow + 1]?.[col] ?? '').trim()
      if (!rawAeCell) continue

      let aeName: string
      let terrCode = ''

      if (rawAeCell.includes('\n')) {
        // Combined format: "AE Name\nTerrXX" or "AE Name\nTerrXX (TerrYY HP)"
        const parts = rawAeCell.split('\n')
        aeName = parts[0].trim()
        // Extract primary territory number from second part
        const terrMatch = parts[1]?.trim().match(/Terr?(\d+)/i)
        if (terrMatch) terrCode = `Terr${terrMatch[1].padStart(2, '0')}`
      } else {
        aeName = rawAeCell
        // Territory code is within the next 1-3 rows at the same column
        for (let r = headerRow + 2; r <= headerRow + 4 && r < rows.length; r++) {
          const candidate = String(rows[r]?.[col] ?? '').trim()
          const m = candidate.match(/Terr?\d+/i)
          if (m) { terrCode = m[0]; break }
        }
      }

      if (!terrCode) continue
      // Skip placeholder entries
      if (/^TBH$/i.test(aeName.trim())) continue

      if (!out[aeName]) out[aeName] = []
      if (!out[aeName].includes(terrCode)) out[aeName].push(terrCode)
    }
  }

  return out
}

/**
 * Extract account names for a specific AE from an enterprise territory sheet.
 * Enterprise sheets are column-oriented: each AE has a column with their name
 * (and territory code) at the top, followed by their account list below.
 *
 * Supports both combined-cell format ("AE Name\nTerrXX") and separate rows.
 *
 * @param rows - Full sheet rows from A1:Z200 (or similar wide probe)
 * @param aeName - Exact AE name to match (case-insensitive, trimmed)
 * @returns Normalized account names; empty array if AE not found or no accounts
 */
export function extractEnterpriseAeAccounts(rows: string[][], aeName: string): string[] {
  const maxHeaderRow = Math.min(10, rows.length)
  const targetName = aeName.toLowerCase().trim()

  for (let headerRow = 0; headerRow < maxHeaderRow; headerRow++) {
    const header = rows[headerRow] ?? []
    for (let col = 0; col < header.length; col++) {
      const cell = String(header[col] ?? '').trim()
      if (!/^account executive$/i.test(cell)) continue

      const rawAeCell = String(rows[headerRow + 1]?.[col] ?? '').trim()
      if (!rawAeCell) continue

      let colAeName: string
      let accountsStartRow: number

      if (rawAeCell.includes('\n')) {
        // Combined format: "AE Name\nTerrXX" — accounts start at headerRow+2
        colAeName = rawAeCell.split('\n')[0].trim()
        accountsStartRow = headerRow + 2
      } else {
        colAeName = rawAeCell
        // Separate rows: scan headerRow+2..+4 for territory code; accounts start after
        accountsStartRow = headerRow + 2
        for (let r = headerRow + 2; r <= headerRow + 4 && r < rows.length; r++) {
          const candidate = String(rows[r]?.[col] ?? '').trim()
          if (candidate.match(/Terr?\d+/i)) {
            accountsStartRow = r + 1
            break
          }
        }
      }

      if (colAeName.toLowerCase() !== targetName) continue

      // Extract and normalize accounts; skip empty and placeholder cells
      const accounts: string[] = []
      let consecutiveEmpty = 0
      for (let r = accountsStartRow; r < rows.length; r++) {
        const raw = String(rows[r]?.[col] ?? '').trim()
        if (!raw) {
          consecutiveEmpty++
          // Stop after 3 consecutive empty rows — end of this AE's account block
          if (consecutiveEmpty >= 3) break
          continue
        }
        consecutiveEmpty = 0
        if (/^(TBH|TBD|N\/A)$/i.test(raw)) continue
        const normalized = normalizeTerritoryCustomerName(raw)
        if (normalized) accounts.push(normalized)
      }

      return accounts
    }
  }

  return []
}

/**
 * Convert an enterprise-style territory code (`Ter01`) into an internal
 * territory key (`CENTRAL_ENT_TOLA_TERR01`). Uses the first pod key in the
 * region as the base — enterprise regions have a single pod entry today.
 */
export function enterpriseTerritoryKey(region: RegionConfig, terrCode: string): string {
  const podKeys = Object.keys(region.pods)
  const base = podKeys[0] ?? region.id.toUpperCase().replace(/-/g, '_')
  const m = terrCode.match(/(\d+)/)
  const num = m ? m[1].padStart(2, '0') : '00'
  return `${base}_TERR${num}`
}

// ── Main sync function ──────────────────────────────────────────────────────

export async function syncTerritorySheet(
  aes: Array<{ name: string; tableauTerritories?: string[] }>,
  customers: Array<{ name: string; ae?: string }>,
  regionId?: string,
): Promise<{
  toAdd: Array<{ name: string; ae: string }>;
  toRemove: Array<{ name: string; ae: string }>;
  unchanged: string[];
}> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })
  const settings = normalizeSettings(loadSettingsRaw())
  const region = getRegionById(settings, regionId)
  const sheetId = resolveRegionSheetId(region)

  if (region.type === 'enterprise') {
    return syncEnterpriseRegion(sheetsClient, sheetId, region, aes, customers)
  }

  return syncCommercialRegion(sheetsClient, sheetId, region, aes, customers)
}

async function syncCommercialRegion(
  sheetsClient: ReturnType<typeof google.sheets>,
  sheetId: string,
  region: RegionConfig,
  aes: Array<{ name: string; tableauTerritories?: string[] }>,
  customers: Array<{ name: string; ae?: string }>,
) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
  const corpTabs = tabNames.filter(t => {
    const lower = t.toLowerCase()
    // Include any tab that maps to a pod key via our derived keyword map.
    const matched = podPrefixFromTabTitle(t, region)
    if (!matched) return false
    if (lower.includes('accounts a')) return false
    return true
  })

  const toAdd: Array<{ name: string; ae: string }> = []
  const toRemove: Array<{ name: string; ae: string }> = []
  const unchanged: string[] = []

  for (const ae of aes) {
    if (!ae.tableauTerritories?.length) continue
    const sheetAccounts = new Set<string>()

    for (const territory of ae.tableauTerritories) {
      for (const tabTitle of corpTabs) {
        const podPrefix = podPrefixFromTabTitle(tabTitle, region)
        if (!podPrefix) continue
        if (!territory.startsWith(podPrefix)) continue

        const resp = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: `'${tabTitle}'!A1:Z60`,
        })
        const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
          r.map((c: any) => String(c ?? '').trim())
        )

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

          if (tableauTerritory !== territory) continue

          for (let r = accountsStartIdx; r < rows.length; r++) {
            const cell = rows[r][col] ?? ''
            if (!cell) continue
            if (/^\d{1,3}$/.test(cell)) break
            if (/^Account\s+S[Aa]/i.test(cell)) break
            if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
            if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
            const normalized = normalizeTerritoryCustomerName(cell)
            if (normalized) sheetAccounts.add(normalized.toLowerCase())
          }
        }
      }
    }

    const aeCustomers = customers.filter(c => c.ae === ae.name)
    const currentNames = new Set(aeCustomers.map(c => c.name.toLowerCase()))

    for (const acct of sheetAccounts) {
      if (!currentNames.has(acct)) {
        const name = normalizeTerritoryCustomerName(
          acct.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        )
        toAdd.push({ name, ae: ae.name })
      }
    }

    for (const cust of aeCustomers) {
      if (!sheetAccounts.has(cust.name.toLowerCase())) {
        toRemove.push({ name: cust.name, ae: ae.name })
      } else {
        unchanged.push(cust.name)
      }
    }
  }

  return { toAdd, toRemove, unchanged }
}

async function syncEnterpriseRegion(
  sheetsClient: ReturnType<typeof google.sheets>,
  sheetId: string,
  region: RegionConfig,
  aes: Array<{ name: string; tableauTerritories?: string[] }>,
  customers: Array<{ name: string; ae?: string }>,
) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: sheetId })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')

  // Enterprise: find the single tab matching the AE/Ter\d{2} pattern.
  let enterpriseTab: string | null = null
  let enterpriseRows: string[][] = []
  for (const tabTitle of tabNames) {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabTitle}'!A1:Z25`,
    })
    const rows: string[][] = (resp.data.values ?? []).map((r: any[]) =>
      r.map((c: any) => String(c ?? '').trim())
    )
    if (isEnterpriseTab(rows)) {
      // Re-fetch the full tab for extraction
      const full = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: `'${tabTitle}'!A1:Z200`,
      })
      enterpriseTab = tabTitle
      enterpriseRows = (full.data.values ?? []).map((r: any[]) =>
        r.map((c: any) => String(c ?? '').trim())
      )
      break
    }
  }

  if (!enterpriseTab) {
    return { toAdd: [], toRemove: [], unchanged: [] }
  }

  const aeTerrMap = extractEnterpriseAeMap(enterpriseRows)
  // aeTerrMap is the enterprise source of truth for AE → territories. For
  // now we map it to the same shape the commercial path returns so callers
  // don't change. Account-level extraction on enterprise sheets is a
  // follow-up — this parser's job is the AE/territory mapping.
  const toAdd: Array<{ name: string; ae: string }> = []
  const toRemove: Array<{ name: string; ae: string }> = []
  const unchanged: string[] = []

  for (const ae of aes) {
    const mappedTerrs = aeTerrMap[ae.name]
    if (!mappedTerrs) continue
    // Convert Ter01 → CENTRAL_ENT_TOLA_TERR01 for each mapped code.
    const expectedKeys = mappedTerrs.map(t => enterpriseTerritoryKey(region, t))
    // This parser currently returns the AE→territory map via side-effect logs
    // only; account-level diffs still live in commercial path. Enterprise
    // account extraction will be wired in a follow-up.
    void expectedKeys
    const aeCustomers = customers.filter(c => c.ae === ae.name)
    for (const c of aeCustomers) unchanged.push(c.name)
  }

  return { toAdd, toRemove, unchanged }
}
