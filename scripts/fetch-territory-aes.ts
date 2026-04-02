/**
 * Fetch AE → territory → account mappings from the commercial territory sheet.
 * Sheet: 1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8
 *
 * Structure per tab:
 *   Row 3 (index 3): "Account Executive" headers in every-other-column
 *   Row 4 (index 4): "AE Name\nTerrXX" cells at those same positions
 *   Rows 5+: accounts, one per cell, in the AE's column
 *
 * Usage: bun scripts/fetch-territory-aes.ts
 */
import { google } from 'googleapis'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const CONFIG     = resolve(import.meta.dir, '../config')
const KEYS_PATH  = `${CONFIG}/gcp-oauth.keys.json`
const TOKEN_PATH = `${CONFIG}/.sheets-token.json`
const SHEET_ID   = '1wblku7v2dsnZ-DAlAq2yPkBiWsIxA6EvTcxblhjZwb8'

const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf-8'))
const { client_id, client_secret } = keys.installed ?? keys.web
const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))

const auth = new google.auth.OAuth2(client_id, client_secret)
auth.setCredentials(token)

const sheets = google.sheets({ version: 'v4', auth })

function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  if (!name) return ''
  // Strip state suffix (e.g. "- CA", "- WA/OR")
  name = name.replace(/\s*-\s*[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal suffixes
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i, /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,     /,?\s+INC\.?$/i,              /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,       /,?\s+CORP\.?$/i,              /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case — preserve digits, internal dots, or already-mixed-case words
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}

function parsePodCode(tabTitle: string): string {
  const t = tabTitle.toLowerCase()
  if (t.includes('northwest') || t.includes('nw')) return 'WEST_COMM_CORP_NORTHWEST'
  if (t.includes('southwest') || t.includes('sw')) return 'WEST_COMM_CORP_SOUTHWEST'
  if (t.includes('north central') || t.includes('nc corp')) return 'WEST_COMM_CORP_NORTHCENTRAL'
  if (t.includes('south central') || t.includes('sc corp')) return 'WEST_COMM_CORP_SOUTHCENTRAL'
  return 'WEST_COMM_CORP_UNKNOWN'
}

async function main() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const allSheets = meta.data.sheets ?? []
  const tabNames = allSheets.map(s => s.properties?.title ?? '')
  console.error('Tabs found:', tabNames)

  // Exclude the accounts A-Z tab, process Corp tabs
  const corpTabs = tabNames.filter(t => {
    const lower = t.toLowerCase()
    return (lower.includes('corp') || lower.includes('northwest') || lower.includes('southwest')) &&
           !lower.includes('accounts a')
  })
  console.error('Processing:', corpTabs)

  const allAes: any[] = []

  for (const tabTitle of corpTabs) {
    const podPrefix = parsePodCode(tabTitle)
    console.error(`\n─── ${tabTitle} (${podPrefix}) ───`)

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${tabTitle}'!A1:Z60`,
    })

    const rows: string[][] = (resp.data.values ?? []).map(r =>
      r.map(c => String(c ?? '').trim())
    )

    // Find the row where "Account Executive" appears (the AE header row)
    let headerRowIdx = -1
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      if (row.some(cell => cell === 'Account Executive')) {
        headerRowIdx = r
        break
      }
    }

    if (headerRowIdx === -1) {
      console.error(`  → no "Account Executive" row found`)
      continue
    }

    const aeNameRowIdx = headerRowIdx + 1
    const accountsStartIdx = aeNameRowIdx + 1

    const headerRow = rows[headerRowIdx] ?? []
    const aeNameRow = rows[aeNameRowIdx] ?? []

    console.error(`  Header row [${headerRowIdx}]:`, headerRow.slice(0, 8))
    console.error(`  AE name row [${aeNameRowIdx}]:`, aeNameRow.slice(0, 8))

    // Find columns with "Account Executive" in header row
    const aeCols = headerRow
      .map((cell, idx) => ({ cell, idx }))
      .filter(({ cell }) => cell === 'Account Executive')
      .map(({ idx }) => idx)

    console.error(`  AE columns:`, aeCols)

    for (const col of aeCols) {
      const aeCell = aeNameRow[col] ?? ''
      if (!aeCell) continue

      // Cell format: "AE Name\nTerrXX" or "AE Name Terr01" or just "AE Name"
      // Split on \n first, then fallback to matching "Terr\d+" at end
      let aeName = aeCell
      let terrCode = ''

      if (aeCell.includes('\n')) {
        const parts = aeCell.split('\n')
        aeName = parts[0].trim()
        terrCode = parts[1].trim()
      } else {
        // Try to find TBH or "Terr##" at end
        const terrMatch = aeCell.match(/\bTerr(\d+)\b/i)
        if (terrMatch) {
          aeName = aeCell.replace(/\s*Terr\d+\s*/i, '').trim()
          terrCode = terrMatch[0]
        }
      }

      // Skip TBH (to be hired) and empty
      if (!aeName || /^TBH$/i.test(aeName.trim())) {
        console.error(`  col ${col}: TBH / empty — skip`)
        continue
      }

      // Parse territory number
      const terrNumMatch = terrCode.match(/(\d+)/)
      if (!terrNumMatch) {
        console.error(`  col ${col}: "${aeName}" — no territory number in "${terrCode}", skip`)
        continue
      }
      const terrNum = terrNumMatch[1].padStart(2, '0')
      const tableauTerritory = `${podPrefix}_TERR${terrNum}`

      // Extract accounts from this column, starting after the AE name row
      const accounts: string[] = []
      for (let r = accountsStartIdx; r < rows.length; r++) {
        const cell = rows[r][col] ?? ''
        if (!cell) continue
        // Stop on count numbers (1-3 digit standalone), count expressions, or role labels
        if (/^\d{1,3}$/.test(cell)) break
        if (/^Account\s+S[Aa]/i.test(cell)) break  // Account SA / Account Sa / Account Sa TBH
        if (/^(Support|Partner Sales|[0-9]+\s+of\s+[0-9]+|\d+ of \d+)$/i.test(cell)) break
        if (/^(Openshift|Ansible|Rhel|Ai)\s+(SSP|SSA)/i.test(cell)) break
        const normalized = normalizeCustomerName(cell)
        if (normalized) accounts.push(normalized)
      }

      console.error(`  col ${col}: ${aeName} | ${tableauTerritory} | ${accounts.length} accounts`)

      allAes.push({
        name: aeName,
        driveFolderId: '',
        sfReportId: '',
        tableauTerritories: [tableauTerritory],
        supportableSheetId: '',
        pipelineSheetId: '',
        ccspSheetId: '',
        accounts,
      })
    }
  }

  console.log(JSON.stringify({ aes: allAes }, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
