import { google } from 'googleapis'
import { makeAuth } from './src/google.ts'

const CI_CONFIG = '/Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard/config'
const GDRIVE_TOKEN = `${CI_CONFIG}/.gdrive-server-credentials.json`
const SHEETS_TOKEN = `${CI_CONFIG}/.sheets-token.json`

const driveAuth = makeAuth(GDRIVE_TOKEN)
const sheetsAuth = makeAuth(SHEETS_TOKEN)
const drive = google.drive({ version: 'v3', auth: driveAuth })
const sheets = google.sheets({ version: 'v4', auth: sheetsAuth })

// The two spreadsheet IDs we found
const targets = [
  { name: 'Elmer Alvarez accounts', id: '1mAGR8PziW_D9g66I5RaPm5IKGoyUu6xVliG_IQFO3sM', tab: 'CCSP Raw Data' },
  { name: 'Carolanne Supportable 26\'', id: '1fMjuc-Flp9rD0pyvSXlBMHRBBET674laUOx0zC8MJ9U', tab: 'CCSP  Raw Data' },
]

interface CCSPRow {
  accountName: string
  quarter: string
  closeDate: string
  cloudPartner: string
  acvPlus: number
}

const allRows: CCSPRow[] = []

for (const target of targets) {
  console.log(`\n=== ${target.name} ===`)
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: target.id,
    range: `'${target.tab}'!A:Z`
  })
  const raw = dataRes.data.values ?? []
  if (raw.length < 2) continue
  const headers = (raw[0] ?? []).map(String)
  console.log('Headers:', headers.join(' | '))
  
  // Find key column indices
  const acctCol = headers.findIndex(h => h.toLowerCase().includes('account name'))
  const qtrCol = headers.findIndex(h => h.toLowerCase().includes('fiscal year quarter'))
  const closeDateCol = headers.findIndex(h => h.toLowerCase().includes('close date') && !h.toLowerCase().includes('opportunity close date') || h.toLowerCase() === 'opportunity close date')
  const partnerCol = headers.findIndex(h => h.toLowerCase().includes('financial partner'))
  const acvPlusCol = headers.findIndex(h => h.toLowerCase().includes('acv plus') || h.toLowerCase() === 'acv plus')
  
  console.log(`Cols: acct=${acctCol} qtr=${qtrCol} partner=${partnerCol} acvPlus=${acvPlusCol}`)
  
  const dataRows = raw.slice(1).filter(r => r.some(v => v?.toString().trim()))
  
  for (const row of dataRows) {
    const acvStr = (row[acvPlusCol] ?? '').toString().replace(/[$,]/g, '').trim()
    const acv = parseFloat(acvStr) || 0
    if (acv === 0) continue
    allRows.push({
      accountName: (row[acctCol] ?? '').toString().trim(),
      quarter: (row[qtrCol] ?? '').toString().trim(),
      closeDate: (row[closeDateCol] ?? '').toString().trim(),
      cloudPartner: (row[partnerCol] ?? '').toString().trim(),
      acvPlus: acv,
    })
  }
}

console.log(`\n=== AGGREGATED ANALYSIS ===`)
console.log(`Total rows with ACV: ${allRows.length}`)

// By customer
const byCustomer = new Map<string, number>()
for (const r of allRows) {
  byCustomer.set(r.accountName, (byCustomer.get(r.accountName) ?? 0) + r.acvPlus)
}
const sortedCustomers = [...byCustomer.entries()].sort((a, b) => b[1] - a[1])
console.log('\nTop customers by ACV:')
for (const [name, acv] of sortedCustomers.slice(0, 15)) {
  console.log(`  ${name.padEnd(50)} $${acv.toFixed(2).padStart(12)}`)
}

// By quarter
const byQuarter = new Map<string, number>()
for (const r of allRows) {
  if (!r.quarter) continue
  byQuarter.set(r.quarter, (byQuarter.get(r.quarter) ?? 0) + r.acvPlus)
}
const sortedQuarters = [...byQuarter.entries()].sort((a, b) => a[0].localeCompare(b[0]))
console.log('\nBy quarter:')
for (const [q, acv] of sortedQuarters) {
  console.log(`  ${q}: $${acv.toFixed(2)}`)
}

// By cloud partner
const byPartner = new Map<string, number>()
for (const r of allRows) {
  const partner = r.cloudPartner.includes('Amazon') ? 'AWS' 
    : r.cloudPartner.includes('Microsoft') ? 'Microsoft'
    : r.cloudPartner || 'Other'
  byPartner.set(partner, (byPartner.get(partner) ?? 0) + r.acvPlus)
}
console.log('\nBy cloud partner:')
for (const [p, acv] of [...byPartner.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p}: $${acv.toFixed(2)}`)
}

// Grand total
const total = allRows.reduce((s, r) => s + r.acvPlus, 0)
console.log(`\nGrand total ACV: $${total.toFixed(2)}`)

// Unique quarters
const quarters = [...new Set(allRows.map(r => r.quarter).filter(Boolean))].sort()
console.log('\nAll quarters:', quarters.join(', '))
