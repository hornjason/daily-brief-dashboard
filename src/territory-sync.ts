/**
 * Territory sheet sync — compares Google Sheet territory data against
 * the current customers list and returns add/remove/unchanged sets.
 *
 * Parsing logic extracted from the /api/territory-lookup handler in server.ts.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer } from './types.ts'

// Local alias — the design spec referenced "CustomerRecord"; project uses Customer.
export type CustomerRecord = Customer

const TERRITORY_SHEET_ID_FALLBACK = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

function getTerritorySheetId(): string {
  try {
    const configPath = resolve(process.env.CONFIG_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'config'), 'data-sources.json')
    const ds = JSON.parse(readFileSync(configPath, 'utf-8'))
    return (ds.podConfig?.territorySheetId as string | undefined) ?? process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  } catch {
    return process.env.TERRITORY_SHEET_ID ?? TERRITORY_SHEET_ID_FALLBACK
  }
}

// ── Helpers (duplicated from server.ts — these are local non-exported functions there) ──

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

function podPrefixFromTabTitle(tabTitle: string): string {
  const t = tabTitle.toLowerCase()
  if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
  if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTHCENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTHCENTRAL'
  return ''
}

// ── Main sync function ──────────────────────────────────────────────────────

export async function syncTerritorySheet(
  aes: Array<{ name: string; tableauTerritories?: string[] }>,
  customers: Array<{ name: string; ae?: string }>,
): Promise<{
  toAdd: Array<{ name: string; ae: string }>;
  toRemove: Array<{ name: string; ae: string }>;
  unchanged: string[];
}> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })

  // Get all tab names
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: getTerritorySheetId() })
  const tabNames = (meta.data.sheets ?? []).map(s => s.properties?.title ?? '')
  const corpTabs = tabNames.filter(t => {
    const lower = t.toLowerCase()
    return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
           !lower.includes('accounts a')
  })

  const toAdd: Array<{ name: string; ae: string }> = []
  const toRemove: Array<{ name: string; ae: string }> = []
  const unchanged: string[] = []

  for (const ae of aes) {
    if (!ae.tableauTerritories?.length) continue

    // Collect all accounts from territory sheet for this AE
    const sheetAccounts = new Set<string>()

    for (const territory of ae.tableauTerritories) {
      for (const tabTitle of corpTabs) {
        const podPrefix = podPrefixFromTabTitle(tabTitle)
        if (!podPrefix) continue
        if (!territory.startsWith(podPrefix)) continue

        const resp = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: getTerritorySheetId(),
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

          // Extract accounts for this column
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

    // Compare against current customers for this AE
    const aeCustomers = customers.filter(c => c.ae === ae.name)
    const currentNames = new Set(aeCustomers.map(c => c.name.toLowerCase()))

    // Accounts in sheet but not in customers = toAdd
    for (const acct of sheetAccounts) {
      if (!currentNames.has(acct)) {
        // Find the original-case version from the sheet parse
        // We need to re-derive it; use title-case normalization
        const name = normalizeTerritoryCustomerName(
          // Re-normalize from the lowercase — this gives us the title-cased version
          acct.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        )
        toAdd.push({ name, ae: ae.name })
      }
    }

    // Customers for this AE not in sheet = toRemove
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

/**
 * Extract accounts for one AE from a column-oriented enterprise/TOLA territory sheet.
 *
 * Standard corp pod sheets put each AE in a column underneath a repeated
 * "Account Executive" header row, with accounts listed downward. The TOLA /
 * enterprise sheet follows the same column-oriented layout but is fed in here
 * as a raw 2D array so callers can drive the Sheets API once and reuse the data.
 *
 * Matching is by AE display name (case-insensitive, trimmed) found in the row
 * directly below the header — the same row used by syncTerritorySheet.
 */
export function extractEnterpriseAeAccounts(
  sheetData: any[][],
  aeSlug: string,
): CustomerRecord[] {
  if (!Array.isArray(sheetData) || sheetData.length === 0) return []
  const target = aeSlug.trim().toLowerCase()
  if (!target) return []

  const rows: string[][] = sheetData.map(r =>
    Array.isArray(r) ? r.map(c => String(c ?? '').trim()) : []
  )

  // Find "Account Executive" header row
  let headerRowIdx = -1
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].some(cell => cell === 'Account Executive')) { headerRowIdx = r; break }
  }
  if (headerRowIdx === -1) return []

  const aeNameRowIdx = headerRowIdx + 1
  const accountsStartIdx = aeNameRowIdx + 1
  const headerRow = rows[headerRowIdx] ?? []
  const aeNameRow = rows[aeNameRowIdx] ?? []

  const aeCols = headerRow
    .map((cell, idx) => ({ cell, idx }))
    .filter(({ cell }) => cell === 'Account Executive')
    .map(({ idx }) => idx)

  const found: CustomerRecord[] = []
  const seen = new Set<string>()

  for (const col of aeCols) {
    const aeCell = aeNameRow[col] ?? ''
    if (!aeCell) continue

    // Strip embedded territory code like "Jane Doe\nTerr07" or "Jane Doe Terr07"
    let aeName = aeCell
    if (aeCell.includes('\n')) aeName = aeCell.split('\n')[0].trim()
    else aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim()

    if (!aeName) continue
    if (aeName.toLowerCase() !== target) continue

    for (let r = accountsStartIdx; r < rows.length; r++) {
      const cell = rows[r][col] ?? ''
      if (!cell) continue
      if (/^\d{1,3}$/.test(cell)) break
      if (/^Account\s+S[Aa]/i.test(cell)) break
      if (/^(Support|Partner Sales|\d+ of \d+)$/i.test(cell)) break
      if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
      const normalized = normalizeTerritoryCustomerName(cell)
      if (!normalized) continue
      const key = normalized.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ name: normalized, ae: aeName, importedFrom: 'territory-sheet' })
    }
  }

  return found
}
