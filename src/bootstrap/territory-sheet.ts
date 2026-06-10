/**
 * src/bootstrap/territory-sheet.ts
 *
 * BKL-ARCH-01: Extracted from bootstrap-orchestrator.ts (ADR-005 — 500-line cap).
 * Pure functions and Google Sheets helpers for territory sheet parsing.
 *
 * Exports:
 *   synthesizeSfReportFromPipelineRecords — adapt PipelineRecord[] → SfReportRow
 *   podKeyFromTerritoryCode               — derive pod key from East-style territory code
 *   readAEsFromTerritorySheet             — read AE map from Google Sheets territory tab
 *   isJunkCustomerName                    — filter junk customer names from territory cells
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { normalizeCustomerName } from '../lib/customer-folder.ts'
import { podPrefixFromTabTitle } from '../territory-sync.ts'
import { normalizeSettings, type RegionConfig } from '../region-config.ts'
import type { PipelineRecord } from '../pipeline.ts'
import type { SfReportRow } from '../sf-scraper.ts'

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Filter junk customer names that appear in territory sheet cells.
 * These include dates, billing keywords, and CCSP billing rows.
 */
export function isJunkCustomerName(name: string): boolean {
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

// BKL-TOKEN-07: Adapt parsed PipelineRecord[] back into an SfReportRow shape that
// writePipelineSheet() + parsePipelineRows() both understand. Emits one row per
// product so the downstream round-trip through parsePipelineRows re-aggregates
// products identically. Header set matches the columns parsePipelineRows reads.
export function synthesizeSfReportFromPipelineRecords(records: PipelineRecord[]): SfReportRow {
  const headers = [
    'Opportunity ID',
    'Opportunity Number',
    'Opportunity Name',
    'Account Name',
    'Close Date',
    'Forecast Category',
    'ACV Opportunity',
    'Opportunity Owner',
    'Renewal',
    'Offering Group',
    'Probability (%)',
    'Product Description',
    'Opportunity Territory Name',
  ]
  const rows: string[][] = []
  for (const r of records) {
    // Expand each product to its own row (mirrors how scrapeSfReport emits raw SF rows)
    const prods = r.products.length > 0 ? r.products : ['']
    for (const prod of prods) {
      rows.push([
        r.oppId ?? '',
        r.oppNumber ?? '',
        r.oppName ?? '',
        r.accountName ?? '',
        r.closeDate ?? '',
        r.forecastCategory ?? '',
        r.acv != null ? String(r.acv) : '',
        r.owner ?? '',
        r.renewal ? 'true' : 'false',
        r.offeringGroup ?? '',
        r.probability != null ? String(r.probability) : '',
        prod,
        r.territory ?? '',
      ])
    }
  }
  return { headers, rows }
}

/**
 * Derive a pod key from an East-style territory code embedded in an AE cell.
 * East codes: "East_Comm_Corp_Pod1_Terr01" → "EAST_COMM_CORP_POD01"
 * Returns empty string if the code doesn't contain a recognizable pod prefix.
 */
export function podKeyFromTerritoryCode(terrCode: string): string {
  const withoutTerr = terrCode.replace(/_?Terr?\d+$/i, '')
  if (!withoutTerr) return ''
  let key = withoutTerr.toUpperCase().replace(/-/g, '_')
  key = key.replace(/POD(\d)$/, (_, d) => `POD0${d}`)
  return key
}

/**
 * Read the territory sheet and extract a map of AE name → { territories, customerNames }.
 * Reuses the same parsing logic as territory-sync.ts but returns raw AE-level data
 * rather than a diff against the current customer list.
 */
export async function readAEsFromTerritorySheet(
  territorySheetId: string,
  podTabTitle?: string,
): Promise<Array<{ aeName: string; territories: string[]; customerNames: string[] }>> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  if (!auth) throw new Error('Google auth not configured')

  const sheetsClient = google.sheets({ version: 'v4', auth })
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: territorySheetId })
  const tabNames = (meta.data.sheets ?? [])
    .filter(s => !s.properties?.hidden)
    .map(s => s.properties?.title ?? '')

  // When a specific POD tab is requested, skip the pre-filter so
  // enterprise tabs (e.g. "TOLA") are not excluded before the pod-name filter runs.
  const candidateTabs = podTabTitle
    ? tabNames
    : tabNames.filter(t => !t.toLowerCase().includes('accounts a') && !t.toLowerCase().includes('territory pods'))

  // When a POD is selected, restrict to matching tab using word-level match.
  // Accepts either an exact tab name OR a Drive sheet displayName (e.g. "Northwest", "TOLA").
  const filteredTabs = podTabTitle
    ? candidateTabs.filter(t => {
        const words = podTabTitle.toLowerCase().split(/[\W_]+/).filter(w => w.length > 3)
        return t.toLowerCase() === podTabTitle.toLowerCase() ||
               words.every(w => t.toLowerCase().includes(w))
      })
    : candidateTabs

  // Resolve region from settings by matching the territory sheet ID (#734)
  let matchedRegion: RegionConfig | undefined
  try {
    const CONFIG_DIR = process.env.CONFIG_DIR ?? 'data/config'
    const settingsRaw = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'settings.json'), 'utf-8'))
    const settings = normalizeSettings(settingsRaw)
    matchedRegion = settings.regions.find(r => {
      const m = r.territorySheetUrl?.match(/spreadsheets\/d\/([^/]+)/)
      return m && m[1] === territorySheetId
    })
  } catch { /* settings not available — podPrefixFromTabTitle will be skipped */ }

  // Accumulate per-AE data: name → { territories, customerNames }
  const aeMap = new Map<string, { territories: Set<string>; customerNames: Set<string> }>()

  for (const tabTitle of filteredTabs) {
    const tabFallbackPodKey = matchedRegion ? podPrefixFromTabTitle(tabTitle, matchedRegion) : ''
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
        const terrMatch = aeCell.match(/Terr(\d+)/i)
        if (terrMatch) terrCode = terrMatch[0]
      }

      // Derive pod key from territory code (works for East-style full codes).
      // Falls back to tab-title-derived West key for bare "TerrNN" cells.
      const derivedPodKey = podKeyFromTerritoryCode(terrCode) || tabFallbackPodKey
      if (!derivedPodKey) continue
      const terrNumMatch = terrCode.match(/(\d+)/)
      if (!terrNumMatch) continue
      const terrNum = terrNumMatch[1].padStart(2, '0')
      const tableauTerritory = `${derivedPodKey}_TERR${terrNum}`

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
