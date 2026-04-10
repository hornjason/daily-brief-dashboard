/**
 * scripts/sf-bookings-reconcile.ts
 *
 * Full reconciliation between our customers.json and the SF bookings GSheet.
 * Uses ACCOUNT_GLOBAL_SALES_GROUP_NAME as the canonical customer name per Jason's direction.
 *
 * Reports:
 *   1. Matched customers (our name → sheet canonical name)
 *   2. Our customers NOT in sheet — with fuzzy alias suggestions
 *   3. Sheet accounts with active subs NOT in our system — potential new customers
 *
 * Usage: bun scripts/sf-bookings-reconcile.ts
 */

import { makeAuth } from '../src/google.js'
import { google } from 'googleapis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHEET_ID = '1DfLXqKIlnJosxncYd-RJpV1fVo5776mX6w8mW9cNMDc'
const CUSTOMERS_PATH = join(import.meta.dir, '..', 'data', 'config', 'customers.json')
const GOOGLE_TOKEN_PATH = process.env.GOOGLE_UNIFIED_TOKEN_PATH ?? '/data/tokens/google-unified-token.json'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize a name to lowercase, strip legal entity suffixes + noise words, trim */
function normalize(s: string): string {
  return s
    .toLowerCase()
    // Strip legal entity abbreviations before removing punctuation
    .replace(/\bl\.?l\.?c\.?\b|\bl\.?p\.?\b|\bp\.?l\.?c\.?\b/g, '')
    // Strip common corporate noise words
    .replace(/\binc\.?\b|\bcorp\.?\b|\bcorporation\b|\bltd\.?\b|\bco\.?\b|\bholding[s]?\b|\binternational\b|\bcompany\b|\bthe\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Simple token overlap similarity [0..1], ignoring single-letter noise tokens */
function similarity(a: string, b: string): number {
  const tokens = (s: string) => new Set(normalize(s).split(' ').filter(t => t.length > 1))
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let overlap = 0
  for (const t of ta) if (tb.has(t)) overlap++
  return overlap / Math.max(ta.size, tb.size)
}

/** Find best fuzzy match in candidates, returns { match, score } */
function bestMatch(name: string, candidates: string[]): { match: string; score: number } {
  let best = { match: '', score: 0 }
  for (const c of candidates) {
    const s = similarity(name, c)
    if (s > best.score) best = { match: c, score: s }
  }
  return best
}

// ── Main ─────────────────────────────────────────────────────────────────────

const auth = await makeAuth(GOOGLE_TOKEN_PATH)
const sheets = google.sheets({ version: 'v4', auth })

// Load sheet (all 31 columns)
console.log('Reading SF bookings sheet…')
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: 'A1:AE3035',
})
const rows = res.data.values ?? []
const headers = rows[0] as string[]
const dataRows = rows.slice(1)

// Column indices
const colIdx = (name: string) => headers.findIndex(h => h === name)
const globalSalesGroupIdx = colIdx('ACCOUNT_GLOBAL_SALES_GROUP_NAME')
const salesGroupIdx = colIdx('ACCOUNT_SALES_GROUP_NAME')
const endDateIdx = colIdx('OPPORTUNITY_LINE_END_DATE')
const podIdx = colIdx('ACCOUNT_POD')

console.log(`Sheet: ${dataRows.length} data rows`)
console.log(`ACCOUNT_GLOBAL_SALES_GROUP_NAME col: ${globalSalesGroupIdx}`)

// Column indices
const accountNameIdx = colIdx('ACCOUNT_NAME')

// Build sheet account sets at each level for three-tier matching
// tier1: ACCOUNT_GLOBAL_SALES_GROUP_NAME
// tier2: ACCOUNT_SALES_GROUP_NAME
// tier3: ACCOUNT_NAME
const today = new Date()

interface AccountEntry { active: boolean; totalRows: number; latestEnd: string; tier: number }
const sheetAccounts = new Map<string, AccountEntry>()

function addEntry(name: string, isActive: boolean, endDateStr: string, tier: number) {
  if (!name) return
  const existing = sheetAccounts.get(name)
  if (!existing) {
    sheetAccounts.set(name, { active: isActive, totalRows: 1, latestEnd: endDateStr, tier })
  } else {
    existing.totalRows++
    if (isActive) existing.active = true
    if (endDateStr > existing.latestEnd) existing.latestEnd = endDateStr
    if (tier < existing.tier) existing.tier = tier
  }
}

for (const row of dataRows) {
  const globalName = (row[globalSalesGroupIdx] ?? '').trim()
  const salesName  = (row[salesGroupIdx] ?? '').trim()
  const acctName   = (row[accountNameIdx] ?? '').trim()
  const endDateStr = (row[endDateIdx] ?? '').trim()
  const endDate = endDateStr ? new Date(endDateStr) : null
  const isActive = endDate ? endDate > today : false

  addEntry(globalName, isActive, endDateStr, 1)
  if (salesName && salesName !== globalName) addEntry(salesName, isActive, endDateStr, 2)
  if (acctName && acctName !== globalName && acctName !== salesName) addEntry(acctName, isActive, endDateStr, 3)
}

const activeSheetAccounts = [...sheetAccounts.entries()].filter(([, v]) => v.active).map(([k]) => k)
const allSheetNames = [...sheetAccounts.keys()]
console.log(`Sheet: ${sheetAccounts.size} unique names across all tiers, ${activeSheetAccounts.length} active\n`)

// Load our customers
const customersRaw = JSON.parse(readFileSync(CUSTOMERS_PATH, 'utf8'))
const ourCustomers: string[] = customersRaw.customers.map((c: any) => c.name as string)
console.log(`Our customers: ${ourCustomers.length}\n`)

// ── Match our customers against sheet ────────────────────────────────────────

const matched: Array<{ ours: string; sheet: string; exact: boolean; tier: number }> = []
const notFound: Array<{ ours: string; bestGuess: string; score: number }> = []

for (const name of ourCustomers) {
  // Exact match first (across all tiers)
  const exactMatch = allSheetNames.find(k => normalize(k) === normalize(name))
  if (exactMatch) {
    const tier = sheetAccounts.get(exactMatch)?.tier ?? 1
    matched.push({ ours: name, sheet: exactMatch, exact: true, tier })
    continue
  }

  // Fuzzy match
  const { match, score } = bestMatch(name, allSheetNames)
  if (score >= 0.5) {
    const tier = sheetAccounts.get(match)?.tier ?? 1
    matched.push({ ours: name, sheet: match, exact: false, tier })
  } else {
    notFound.push({ ours: name, bestGuess: match, score })
  }
}

// ── Sheet accounts with active subs NOT in our customers ─────────────────────
// Only look at tier-1 (global) accounts to avoid noise from subsidiary names

const matchedSheetNames = new Set(matched.map(m => normalize(m.sheet)))
const genuinelyNew: Array<{ sheet: string; bestGuess: string; score: number }> = []

// Only report tier-1 (ACCOUNT_GLOBAL_SALES_GROUP_NAME) to avoid subsidiary noise
const tier1Active = [...sheetAccounts.entries()]
  .filter(([, v]) => v.active && v.tier === 1)
  .map(([k]) => k)

for (const sheetName of tier1Active) {
  if (matchedSheetNames.has(normalize(sheetName))) continue
  const { match, score } = bestMatch(sheetName, ourCustomers)
  genuinelyNew.push({ sheet: sheetName, bestGuess: match, score })
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log('═'.repeat(70))
console.log(`MATCHED: ${matched.length}/${ourCustomers.length} customers found in sheet`)
console.log('═'.repeat(70))

const exactMatches = matched.filter(m => m.exact)
const fuzzyMatches = matched.filter(m => !m.exact)

console.log(`\n✅ Exact matches (${exactMatches.length}):`)
for (const m of exactMatches.sort((a, b) => a.ours.localeCompare(b.ours))) {
  console.log(`   ${m.ours}`)
}

const tierLabel = (t: number) => t === 1 ? 'global' : t === 2 ? 'sales-group' : 'acct-name'

console.log(`\n🔶 Fuzzy matches — name differs (${fuzzyMatches.length}):`)
for (const m of fuzzyMatches.sort((a, b) => a.ours.localeCompare(b.ours))) {
  console.log(`   ${m.ours.padEnd(40)} → "${m.sheet}"  [${tierLabel(m.tier)}]`)
}

console.log('\n' + '═'.repeat(70))
console.log(`NOT FOUND IN SHEET: ${notFound.length} our customers with no sheet match`)
console.log('═'.repeat(70))
for (const n of notFound.sort((a, b) => a.ours.localeCompare(b.ours))) {
  const hint = n.score > 0.2 ? `  (closest: "${n.bestGuess}", score=${n.score.toFixed(2)})` : ''
  console.log(`   ❌ ${n.ours}${hint}`)
}

console.log('\n' + '═'.repeat(70))
console.log(`ACTIVE IN SHEET BUT NOT OUR CUSTOMERS: ${genuinelyNew.length}`)
console.log('═'.repeat(70))
for (const g of genuinelyNew.sort((a, b) => a.sheet.localeCompare(b.sheet))) {
  const hint = g.score > 0.3 ? `  → alias of: ${g.bestGuess} (score=${g.score.toFixed(2)})` : ''
  console.log(`   📋 ${g.sheet}${hint}`)
}

console.log('\n' + '═'.repeat(70))
console.log('SUMMARY')
console.log('═'.repeat(70))
console.log(`  Matched (exact):  ${exactMatches.length}`)
console.log(`  Matched (fuzzy):  ${fuzzyMatches.length}`)
console.log(`  Not found:        ${notFound.length}`)
console.log(`  New in sheet:     ${genuinelyNew.length} active accounts not in our system`)
console.log('═'.repeat(70))
