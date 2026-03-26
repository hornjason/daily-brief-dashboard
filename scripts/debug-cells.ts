#!/usr/bin/env bun
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_PATH = resolve(__dirname, '../config/.rh-session.json')
const accountNum = process.argv[2] ?? '5857069'
const url = `https://access.redhat.com/support/cases/#/case/list?query=accountNumber%3A%20(%22${accountNum}%22)%20orderBy%20severity%20asc&p=1&size=100&searchType=basic`

const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8'))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ storageState: session })
const page = await context.newPage()
await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
// Wait longer for Angular to render
await page.waitForTimeout(5000)

// Try waiting for table rows
await page.waitForSelector('table tbody tr', { timeout: 10_000 }).catch(() => {})

const debug = await page.evaluate(() => {
  const rowCount = document.querySelectorAll('table tbody tr').length
  const rows = document.querySelectorAll('table tbody tr')
  const out: string[][] = []
  for (const row of Array.from(rows).slice(0, 3)) {
    out.push(Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim().slice(0, 60) ?? ''))
  }

  // Also check what other row-like elements exist
  const allRows = document.querySelectorAll('tr').length
  const tbodyRows = document.querySelectorAll('tbody tr').length
  const url = window.location.href

  return { rowCount, allRows, tbodyRows, url, rows: out }
})

console.log(`\nDebug — account ${accountNum}:`)
console.log('URL:', debug.url)
console.log('table tbody tr:', debug.rowCount)
console.log('all tr:', debug.allRows)
console.log('tbody tr:', debug.tbodyRows)
for (const [ri, row] of debug.rows.entries()) {
  console.log(`--- Row ${ri} (${row.length} cells) ---`)
  row.forEach((val, i) => console.log(`  [${i}]: "${val}"`))
}
await browser.close()
