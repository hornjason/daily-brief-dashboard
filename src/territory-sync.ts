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

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { DATA_DIR, CACHE_DIR, CONFIG_DIR } from './lib/paths.ts'
import {
  normalizeSettings,
  getRegionById,
  derivePodKeywordMap,
  type RegionConfig,
} from './region-config.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'

const TERRITORY_SHEET_ID_FALLBACK = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'
const TERRITORY_NOTIFICATIONS_PATH = resolve(CACHE_DIR, 'territory-notifications.json')

interface TerritoryNotification {
  type: 'removal' | 'reassignment'
  customer: string
  ae: string
  detectedAt: string
}

function loadSettingsRaw(): Record<string, unknown> {
  try {
    const p = resolve(CONFIG_DIR, 'settings.json')
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
    const configPath = resolve(CONFIG_DIR, 'data-sources.json')
    const ds = JSON.parse(readFileSync(configPath, 'utf-8'))
    return (ds.podConfig?.territorySheetId as string | undefined) ?? process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  } catch {
    return process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  }
}

// ── Team Member Extraction ───────────────────────────────────────────────────

/**
 * Extract team member data from territory sheet rows.
 *
 * Scans from accountsStartIdx onwards for team member role labels followed by
 * person names. Skips account names, count rows, and blank rows.
 *
 * @param rows - Full sheet rows from the tab
 * @param col - Column index to scan
 * @param accountsStartIdx - Row index where accounts start (first row after AE name row)
 * @returns Object with asa, specialists, partnerSales, consultingManager
 */
export function extractTeamMembers(
  rows: string[][],
  col: number,
  accountsStartIdx: number,
): {
  additionalRoles: Array<{ label: string; name: string }>
  asa?: { name: string }
  specialists: Array<{ product: string; role: 'ssp' | 'ssa'; name: string }>
  partnerSales?: { name: string }
  consultingManager?: { name: string }
} {
  const specialists: Array<{ product: string; role: 'ssp' | 'ssa'; name: string }> = []
  let asa: { name: string } | undefined
  let partnerSales: { name: string } | undefined
  let consultingManager: { name: string } | undefined
  const additionalRoles: Array<{ label: string; name: string }> = []

  const maxRow = rows.length

  // Phase 1: Skip past account names to find where team data begins.
  // Account names end at the first break condition (count row, blank gap, or known label).
  let teamStartRow = accountsStartIdx
  for (let r = accountsStartIdx; r < maxRow; r++) {
    const cell = String(rows[r]?.[col] ?? '').trim()
    if (!cell) { teamStartRow = r; break }
    if (/^\d{1,3}$/.test(cell) || /^\d+\s+of\s+\d+$/i.test(cell)) { teamStartRow = r; break }
    if (/^Account\s+S[Aa]/i.test(cell)) { teamStartRow = r; break }
    if (/\b(SSP|SSA|PSE|TSM)\b/i.test(cell)) { teamStartRow = r; break }
  }

  // Phase 2: Scan for role label → name pairs.
  // Labels are detected by keyword patterns. A label may be in ANY column (centered/merged).
  // The name row is directly below the label row.
  // If names appear in multiple columns → per-territory assignment.
  // If name appears in only one column → that person covers all territories.
  const isLikelyRoleLabel = (s: string) =>
    /^Account\s+S[Aa]/i.test(s) ||
    /\b(SSP|SSA)\b/i.test(s) ||
    /^[A-Z]{2,4}$/.test(s) ||
    /\b(Partner Sales|Consulting Services|Training Specialist|Cloud Sales|Sales Executive|Manager|Specialist|Lead)\b/i.test(s)

  const isCountOrNoise = (s: string) =>
    /^\d{1,3}$/.test(s) || /^\d+\s+of\s+\d+$/i.test(s)

  for (let r = teamStartRow; r < maxRow; r++) {
    // Look for a role label in ANY column of this row
    let label: string | null = null
    const row = rows[r] ?? []
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] ?? '').trim()
      if (cell && isLikelyRoleLabel(cell)) { label = cell; break }
    }
    if (!label) continue

    // Name row is directly below the label row — read THIS column
    const nameRow = rows[r + 1] ?? []
    const personName = String(nameRow[col] ?? '').trim()

    // If this column has no name, check if only ONE column has a name (shared role).
    // If so, that person covers all territories including this one.
    let resolvedName = personName
    if (!resolvedName || isLikelyRoleLabel(resolvedName) || isCountOrNoise(resolvedName)) {
      // Count how many columns have a real name in the name row
      let sharedName: string | null = null
      let nameCount = 0
      for (let c = 0; c < nameRow.length; c++) {
        const cell = String(nameRow[c] ?? '').trim()
        if (cell && !isLikelyRoleLabel(cell) && !isCountOrNoise(cell)) {
          nameCount++
          sharedName = cell
        }
      }
      // If exactly one name found across all columns → shared role for all territories
      if (nameCount === 1 && sharedName) {
        resolvedName = sharedName
      } else {
        resolvedName = ''
      }
    }

    if (!resolvedName) continue

    // Classify the role from the label text
    if (/^Account\s+S[Aa]/i.test(label)) {
      asa = { name: resolvedName }
    } else if (/\b(SSP|SSA)\b/i.test(label)) {
      const sspSsaMatch = label.match(/\b(SSP|SSA)\b/i)
      const role = sspSsaMatch![1].toLowerCase() as 'ssp' | 'ssa'
      let product = label.replace(/\s*(SSP|SSA)\s*/i, '').trim()
      if (/^App Plat$/i.test(product)) product = 'App Platform'
      specialists.push({ product, role, name: resolvedName })
    } else if (/\b(Partner Sales|PSE)\b/i.test(label)) {
      partnerSales = { name: resolvedName }
    } else if (/\b(Consulting Services|TSM)\b/i.test(label)) {
      consultingManager = { name: resolvedName }
    } else {
      additionalRoles.push({ label, name: resolvedName })
    }
  }

  return { asa, specialists, partnerSales, consultingManager, additionalRoles }
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
        // Combined format: "AE Name\nTerrXX" or "AE Name\nHigh_Plains_Terr03"
        const parts = rawAeCell.split('\n')
        aeName = parts[0].trim()
        // Preserve full territory string including prefix (e.g., "High_Plains_Terr03", "TOLA_Terr01")
        const rawTerr = parts[1]?.trim() ?? ''
        const terrMatch = rawTerr.match(/((?:[A-Za-z_]+_)?Terr?\d+)/i)
        if (terrMatch) terrCode = terrMatch[1]
      } else {
        aeName = rawAeCell
        // Territory code is within the next 1-3 rows at the same column
        // Preserve prefix (e.g., "High_Plains_Terr03")
        for (let r = headerRow + 2; r <= headerRow + 4 && r < rows.length; r++) {
          const candidate = String(rows[r]?.[col] ?? '').trim()
          const m = candidate.match(/((?:[A-Za-z_]+_)?Terr?\d+)/i)
          if (m) { terrCode = m[1]; break }
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
  const fallbackBase = region.id.toUpperCase().replace(/-/g, '_')

  // Declarative prefix routing: match terrCode against pod prefixes
  let base = fallbackBase
  for (const [key, pod] of Object.entries(region.pods)) {
    if (pod.prefixes?.some(p => terrCode.toLowerCase().startsWith(p.toLowerCase() + '_'))) {
      base = key
      break
    }
  }
  // If no prefix matched, use the first pod without prefixes (the default/primary pod)
  if (base === fallbackBase) {
    base = Object.entries(region.pods).find(([_, p]) => !p.prefixes?.length)?.[0]
      ?? Object.keys(region.pods)[0] ?? fallbackBase
  }

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
  teamData?: Record<string, import('./types.ts').TerritoryTeamEntry>;
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
  const teamDataByTerritory: Record<string, import('./types.ts').TerritoryTeamEntry> = {}

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

          // Extract account names
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

          // Extract team member data for this territory
          const teamData = extractTeamMembers(rows, col, accountsStartIdx)
          teamDataByTerritory[tableauTerritory] = {
            territory: tableauTerritory,
            aeName: ae.name,
            asa: teamData.asa,
            specialists: teamData.specialists,
            partnerSales: teamData.partnerSales,
            consultingManager: teamData.consultingManager,
            additionalRoles: teamData.additionalRoles.length > 0 ? teamData.additionalRoles : undefined,
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

  return { toAdd, toRemove, unchanged, teamData: teamDataByTerritory }
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
    return { toAdd: [], toRemove: [], unchanged: [], teamData: undefined }
  }

  const aeTerrMap = extractEnterpriseAeMap(enterpriseRows)
  const toAdd: Array<{ name: string; ae: string }> = []
  const toRemove: Array<{ name: string; ae: string }> = []
  const unchanged: string[] = []

  // Extract team member data from enterprise sheet (same label->name pattern as commercial)
  const teamDataByTerritory: Record<string, import('./types.ts').TerritoryTeamEntry> = {}

  // Find the "Account Executive" header row to determine accountsStartIdx
  let aeHeaderRow = -1
  for (let r = 0; r < Math.min(10, enterpriseRows.length); r++) {
    if (enterpriseRows[r].some(c => /^account executive$/i.test(c))) { aeHeaderRow = r; break }
  }

  if (aeHeaderRow >= 0) {
    const headerRow = enterpriseRows[aeHeaderRow] ?? []
    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => /^account executive$/i.test(cell))
      .map(({ idx }) => idx)

    const aeNameRowIdx = aeHeaderRow + 1
    const accountsStartIdx = aeNameRowIdx + 1

    for (const col of aeCols) {
      const rawAeCell = String(enterpriseRows[aeNameRowIdx]?.[col] ?? '').trim()
      if (!rawAeCell) continue

      const aeName = rawAeCell.split('\n')[0].trim()
      let terrCode = ''
      const terrMatch = rawAeCell.match(/Terr?(\d+)/i)
      if (terrMatch) terrCode = `Terr${terrMatch[1].padStart(2, '0')}`
      if (!terrCode) continue

      const fullTerrKey = enterpriseTerritoryKey(region, terrCode)
      const teamData = extractTeamMembers(enterpriseRows, col, accountsStartIdx)

      teamDataByTerritory[fullTerrKey] = {
        territory: fullTerrKey,
        aeName,
        asa: teamData.asa,
        specialists: teamData.specialists,
        partnerSales: teamData.partnerSales,
        consultingManager: teamData.consultingManager,
        additionalRoles: teamData.additionalRoles.length > 0 ? teamData.additionalRoles : undefined,
      }
    }
  }

  // Extract customer accounts per AE and diff against current customers (#731)
  for (const [aeName, _terrCodes] of Object.entries(aeTerrMap)) {
    const accounts = extractEnterpriseAeAccounts(enterpriseRows, aeName)
    // Find which AE config this maps to (by name match)
    const matchedAe = aes.find(a => a.name.toLowerCase().trim() === aeName.toLowerCase().trim())
    if (!matchedAe) continue

    const sheetAccountsLower = new Set(accounts.map(a => a.toLowerCase()))
    const aeCustomers = customers.filter(c => c.ae === matchedAe.name)
    const currentNamesLower = new Set(aeCustomers.map(c => c.name.toLowerCase()))

    // New accounts in sheet but not in current customers
    for (const account of accounts) {
      if (!currentNamesLower.has(account.toLowerCase())) {
        toAdd.push({ name: account, ae: matchedAe.name })
      }
    }

    // Current customers not in sheet = removals
    for (const cust of aeCustomers) {
      if (!sheetAccountsLower.has(cust.name.toLowerCase())) {
        toRemove.push({ name: cust.name, ae: matchedAe.name })
      } else {
        unchanged.push(cust.name)
      }
    }
  }

  return { toAdd, toRemove, unchanged, teamData: Object.keys(teamDataByTerritory).length > 0 ? teamDataByTerritory : undefined }
}

// ── Territory Sync Orchestration ────────────────────────────────────────────

/**
 * Run the full territory sync orchestration flow.
 *
 * Executes all territory sync business logic:
 * 1. Pre-flight checks (Google auth, AE config)
 * 2. Calls syncTerritorySheet() to compare sheet vs current state
 * 3. Auto-adds new customers to customers.json
 * 4. Writes removal/reassignment notifications (never auto-deletes)
 * 5. Cleans old notifications (30-day retention)
 * 6. Persists team cache
 *
 * Returns counts for added, flagged, and unchanged customers.
 */
export async function runTerritorySyncOrchestration(): Promise<{
  added: number
  flagged: number
  unchanged: number
}> {
  console.log('[territory-sync] starting territory sheet sync…')

  // Pre-flight: check Google auth token exists
  const tokenPath = process.env.GOOGLE_UNIFIED_TOKEN_PATH
  if (tokenPath && !existsSync(tokenPath)) {
    console.warn('[territory-sync] Google auth token missing — skipping')
    return { added: 0, flagged: 0, unchanged: 0 }
  }

  const { aes, customers: currentCustomers, CUSTOMERS_PATH } = await import('./server-state.ts')
  if (!aes.length) {
    console.log('[territory-sync] no AEs configured — skipping')
    return { added: 0, flagged: 0, unchanged: 0 }
  }

  // Iterate ALL configured regions and merge results (#732)
  const settings = normalizeSettings(loadSettingsRaw())
  const allToAdd: Array<{ name: string; ae: string }> = []
  const allToRemove: Array<{ name: string; ae: string }> = []
  const allUnchanged: string[] = []
  let mergedTeamData: Record<string, import('./types.ts').TerritoryTeamEntry> = {}

  for (const region of settings.regions) {
    console.log(`[territory-sync] Syncing region: ${region.label} (${region.id})`)
    const result = await syncTerritorySheet(aes, currentCustomers, region.id)
    allToAdd.push(...result.toAdd)
    allToRemove.push(...result.toRemove)
    allUnchanged.push(...result.unchanged)
    if (result.teamData) mergedTeamData = { ...mergedTeamData, ...result.teamData }
  }

  console.log(`[territory-sync] All regions synced: ${settings.regions.length} region(s)`)

  // Dry-run mode: log proposed changes without applying (#731)
  const isDryRun = process.env.TERRITORY_SYNC_DRY_RUN === 'true'
  if (isDryRun) {
    console.log(`[territory-sync] DRY RUN — would add ${allToAdd.length} customers, remove ${allToRemove.length}`)
    for (const c of allToAdd) console.log(`  + ${c.name} (${c.ae})`)
    for (const c of allToRemove) console.log(`  - ${c.name} (${c.ae})`)
    console.log(`[territory-sync] DRY RUN complete — no changes applied`)
    return { added: allToAdd.length, flagged: allToRemove.length, unchanged: allUnchanged.length }
  }

  // Auto-add new customers
  if (allToAdd.length > 0) {
    console.log(`[territory-sync] adding ${allToAdd.length} new customers`)
    const updated = [...currentCustomers, ...allToAdd]
    writeJsonAtomic(CUSTOMERS_PATH, { customers: updated })
    // Update in-memory state
    const { setCustomers } = await import('./server-state.ts')
    setCustomers(updated)
    console.log(`[territory-sync] customers updated: ${allToAdd.map((c: any) => c.name).join(', ')}`)
  }

  // Write removal/reassignment notifications (never auto-delete)
  if (allToRemove.length > 0) {
    let existing: { updatedAt: string; pending: TerritoryNotification[] } = { updatedAt: '', pending: [] }
    try {
      if (existsSync(TERRITORY_NOTIFICATIONS_PATH)) {
        existing = JSON.parse(readFileSync(TERRITORY_NOTIFICATIONS_PATH, 'utf-8'))
      }
    } catch {}
    const newNotifications: TerritoryNotification[] = allToRemove.map((c: any) => ({
      type: 'removal' as const,
      customer: c.name,
      ae: c.ae,
      detectedAt: new Date().toISOString(),
    }))
    // Dedup: don't add notifications already pending for same customer
    const existingKeys = new Set(existing.pending.map((n: any) => `${n.customer}::${n.ae}`))
    const fresh = newNotifications.filter((n: any) => !existingKeys.has(`${n.customer}::${n.ae}`))
    const updated = {
      updatedAt: new Date().toISOString(),
      pending: [...existing.pending, ...fresh],
    }
    writeFileSync(TERRITORY_NOTIFICATIONS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 })
    console.log(`[territory-sync] ${fresh.length} new removal notifications written`)
  }

  // Clean old notifications (30 day retention)
  try {
    if (existsSync(TERRITORY_NOTIFICATIONS_PATH)) {
      const notifications = JSON.parse(readFileSync(TERRITORY_NOTIFICATIONS_PATH, 'utf-8'))
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
      const cleaned = notifications.pending.filter((n: any) => {
        const detectedTime = new Date(n.detectedAt).getTime()
        return detectedTime > thirtyDaysAgo
      })
      if (cleaned.length < notifications.pending.length) {
        const updated = { ...notifications, pending: cleaned }
        writeFileSync(TERRITORY_NOTIFICATIONS_PATH, JSON.stringify(updated, null, 2), { mode: 0o600 })
        console.log(`[territory-sync] cleaned ${notifications.pending.length - cleaned.length} old notifications (>30 days)`)
      }
    }
  } catch (e: any) {
    console.warn(`[territory-sync] notification cleanup failed: ${e.message}`)
  }

  // Persist team data to cache
  if (Object.keys(mergedTeamData).length > 0) {
    const { persistTeamCache } = await import('./account-team.ts')
    persistTeamCache(mergedTeamData)
  }

  console.log(`[territory-sync] complete: +${allToAdd.length} added, ${allToRemove.length} flagged for review, ${allUnchanged.length} unchanged`)

  return {
    added: allToAdd.length,
    flagged: allToRemove.length,
    unchanged: allUnchanged.length,
  }
}
