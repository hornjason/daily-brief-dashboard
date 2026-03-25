import { fetchCCSPData } from '../src/sheets.ts'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

console.log('Fetching CCSP data from Google Sheets...')
const records = await fetchCCSPData()
console.log(`Got ${records.length} records`)

const cacheDir = resolve(import.meta.dir, '../cache')
mkdirSync(cacheDir, { recursive: true })
const cachePath = resolve(cacheDir, 'ccsp-data.json')
writeFileSync(cachePath, JSON.stringify({ records, cachedAt: new Date().toISOString() }))
console.log(`✅ Cached ${records.length} CCSP records to ${cachePath}`)

// Show summary
const byCustomer = new Map<string, number>()
for (const r of records) byCustomer.set(r.accountName, (byCustomer.get(r.accountName) ?? 0) + r.acvPlus)
const total = records.reduce((s, r) => s + r.acvPlus, 0)
console.log(`\nTotal ACV: $${total.toLocaleString()}`)
console.log(`Top customers:`)
for (const [name, acv] of [...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${name}: $${acv.toLocaleString()}`)
}
