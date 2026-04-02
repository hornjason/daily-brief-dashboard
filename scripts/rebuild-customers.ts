#!/usr/bin/env bun
/**
 * rebuild-customers.ts
 *
 * Reads each AE's Supportable Google Sheet "Accounts" tab to discover
 * customer names and account numbers. The Accounts tab is the master
 * account list — the source of truth from the Supportable scrape.
 *
 * Writes a fresh customers.json grouped by customer name.
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'

const CONFIG_DIR = resolve(import.meta.dir, '../data/config')
const TOKEN_PATH = resolve(CONFIG_DIR, '.google-token.json')
const KEYS_PATH  = resolve(CONFIG_DIR, 'gcp-oauth.keys.json')
const AES_PATH   = resolve(CONFIG_DIR, 'aes.json')
const OUT_PATH   = resolve(CONFIG_DIR, 'customers.json')

// ── Auth ─────────────────────────────────────────────────────────────────────
function makeAuth() {
  const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf-8'))
  const { client_id, client_secret } = keys.installed ?? keys.web
  const auth = new google.auth.OAuth2(client_id, client_secret)
  auth.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, 'utf-8')))
  return auth
}

// ── Header detection ─────────────────────────────────────────────────────────
// Normalizes a header cell for matching: lowercase, strip whitespace/punctuation
function normalizeHeader(val: string): string {
  return val.toLowerCase().replace(/[\s_\-#.]+/g, '')
}

// Patterns that indicate a "customer name" column
const NAME_PATTERNS = [
  'name', 'customername', 'customer', 'companyname', 'company',
  'accountname', 'account',
]

// Patterns that indicate an "account number" column
const ACCT_PATTERNS = [
  'accountnumber', 'accountnum', 'acctnum', 'acctnumber',
  'customernumber', 'customernum', 'accountno', 'acctno',
  'account', 'number',
]

function findColumnIndex(headers: string[], patterns: string[], exclude?: number): number {
  // Exact match first
  for (const pattern of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (i === exclude) continue
      if (normalizeHeader(headers[i]) === pattern) return i
    }
  }
  // Substring match
  for (const pattern of patterns) {
    for (let i = 0; i < headers.length; i++) {
      if (i === exclude) continue
      if (normalizeHeader(headers[i]).includes(pattern)) return i
    }
  }
  return -1
}

// ── Main ─────────────────────────────────────────────────────────────────────
interface CustomerEntry {
  name: string
  ae: string
  accountNumbers: string[]
}

async function main() {
  const auth = makeAuth()
  const sheets = google.sheets({ version: 'v4', auth })
  const aesData = JSON.parse(readFileSync(AES_PATH, 'utf-8'))
  const aes: Array<{ name: string; supportableSheetId?: string }> = aesData.aes

  // customerMap: key = "customerName|aeName" => CustomerEntry
  const customerMap = new Map<string, CustomerEntry>()
  const skippedRows: Array<{ ae: string; reason: string; row: string[] }> = []

  for (const ae of aes) {
    if (!ae.supportableSheetId) {
      console.log(`[skip] ${ae.name} — no supportableSheetId`)
      continue
    }

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`AE: ${ae.name}`)
    console.log(`Sheet: ${ae.supportableSheetId}`)
    console.log(`${'═'.repeat(60)}`)

    // Read the Accounts tab
    let rows: string[][]
    try {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: ae.supportableSheetId,
        range: 'Accounts',
      })
      rows = (resp.data.values ?? []) as string[][]
    } catch (e: any) {
      console.error(`  ERROR reading Accounts tab: ${e.message}`)
      continue
    }

    if (rows.length === 0) {
      console.log(`  Accounts tab is empty`)
      continue
    }

    // First row = headers
    const headers = rows[0].map(h => String(h ?? ''))
    console.log(`\n  HEADERS (${headers.length} columns):`)
    headers.forEach((h, i) => console.log(`    [${i}] "${h}"`))

    // Find the name column and account number column
    const nameColIdx = findColumnIndex(headers, NAME_PATTERNS)
    const acctColIdx = findColumnIndex(headers, ACCT_PATTERNS, nameColIdx)

    if (nameColIdx < 0) {
      console.error(`  Could not find a customer name column in headers: ${JSON.stringify(headers)}`)
      continue
    }

    console.log(`\n  Name column:    [${nameColIdx}] "${headers[nameColIdx]}"`)
    if (acctColIdx >= 0) {
      console.log(`  Account column: [${acctColIdx}] "${headers[acctColIdx]}"`)
    } else {
      console.log(`  Account column: NOT FOUND — will collect names only`)
    }

    // Process data rows
    let rowCount = 0
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      const customerName = String(row[nameColIdx] ?? '').trim()

      if (!customerName) {
        skippedRows.push({ ae: ae.name, reason: 'blank name', row })
        continue
      }

      const rawAcct = acctColIdx >= 0 ? String(row[acctColIdx] ?? '').trim() : ''
      const key = `${customerName}|${ae.name}`

      if (!customerMap.has(key)) {
        customerMap.set(key, { name: customerName, ae: ae.name, accountNumbers: [] })
      }

      const entry = customerMap.get(key)!
      // Split comma-separated account numbers and add each one
      const acctParts = rawAcct ? rawAcct.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : []
      for (const accountNum of acctParts) {
        if (!entry.accountNumbers.includes(accountNum)) {
          entry.accountNumbers.push(accountNum)
        }
      }

      rowCount++
    }

    console.log(`\n  Processed ${rowCount} data rows`)
    console.log(`  Unique customers for ${ae.name}: ${[...customerMap.values()].filter(c => c.ae === ae.name).length}`)
  }

  // Build output
  const customers = [...customerMap.values()]

  // Write
  const output = { customers }
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2))

  // Summary
  console.log(`\n\n${'═'.repeat(60)}`)
  console.log(`RESULTS`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`Total customers written: ${customers.length}`)
  console.log(`Output: ${OUT_PATH}`)

  console.log(`\nPer-AE breakdown:`)
  for (const ae of aes) {
    const aeCustomers = customers.filter(c => c.ae === ae.name)
    console.log(`\n  ${ae.name}: ${aeCustomers.length} customers`)
    for (const c of aeCustomers) {
      console.log(`    - ${c.name} [${c.accountNumbers.length > 0 ? c.accountNumbers.join(', ') : 'no account #'}]`)
    }
  }

  if (skippedRows.length > 0) {
    console.log(`\nSkipped rows (${skippedRows.length}):`)
    for (const s of skippedRows) {
      console.log(`  [${s.ae}] ${s.reason}: ${JSON.stringify(s.row)}`)
    }
  }
}

main().catch(e => {
  console.error('FATAL:', e)
  process.exit(1)
})
