#!/usr/bin/env bun
/**
 * refresh-all.ts — Force-refresh briefs + sheet data for every customer.
 * Run manually: bun run scripts/refresh-all.ts
 * Scheduled:    daily via crontab (see README)
 */

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:7777'
const CUSTOMERS_PATH = new URL('../config/customers.json', import.meta.url)

interface Customer { name: string }

const { customers }: { customers: Customer[] } = JSON.parse(
  await Bun.file(CUSTOMERS_PATH).text()
)

const pad = (s: string, n: number) => s.padEnd(n)
const ts = () => new Date().toLocaleTimeString()

console.log(`\n🔄 Daily refresh — ${new Date().toLocaleDateString()} — ${customers.length} accounts\n`)

let briefOk = 0, briefFail = 0, sheetOk = 0, sheetFail = 0

for (const { name } of customers) {
  process.stdout.write(`  ${pad(name, 30)} `)

  // Sheet data first (briefs depend on product context)
  let sheetStatus = '✓'
  try {
    const r = await fetch(`${BASE}/customer/${encodeURIComponent(name)}/sheetdata?force=true`)
    const j = await r.json() as any
    if (!r.ok || j.error) { sheetStatus = '✗ sheet:' + (j.error ?? r.status); sheetFail++ }
    else sheetOk++
  } catch (e: any) {
    sheetStatus = '✗ sheet:' + e.message.slice(0, 40)
    sheetFail++
  }

  // Brief generation (slow — calls AI)
  let briefStatus = '✓'
  try {
    const r = await fetch(`${BASE}/customer/${encodeURIComponent(name)}/brief?force=true`)
    const j = await r.json() as any
    if (!r.ok || j.error) { briefStatus = '✗ brief:' + (j.error ?? r.status); briefFail++ }
    else briefOk++
  } catch (e: any) {
    briefStatus = '✗ brief:' + e.message.slice(0, 40)
    briefFail++
  }

  const ok = sheetStatus === '✓' && briefStatus === '✓'
  console.log(ok ? '✅' : `❌  ${sheetStatus !== '✓' ? sheetStatus : briefStatus}`)
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Briefs:  ${briefOk}/${customers.length} ok  ${briefFail > 0 ? `(${briefFail} failed)` : ''}
  Sheets:  ${sheetOk}/${customers.length} ok  ${sheetFail > 0 ? `(${sheetFail} failed)` : ''}
  Done at: ${ts()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
