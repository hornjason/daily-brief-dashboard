#!/usr/bin/env bun
/**
 * scripts/scrape-cases.ts
 * Scrapes open support cases from access.redhat.com for all accounts in
 * customers.json (or specific account numbers passed as CLI args).
 * Writes results to cache/cases.json which the server reads via fetchCases().
 *
 * Usage:
 *   bun scripts/scrape-cases.ts              # all accounts in customers.json
 *   bun scripts/scrape-cases.ts 901532       # specific account number(s)
 *
 * Prerequisites:
 *   Run login-rh.ts once to save config/.rh-session.json
 */

import { chromium } from '@playwright/test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SESSION_PATH  = resolve(__dirname, '../config/.rh-session.json')
const CACHE_DIR     = resolve(__dirname, '../cache')
const CASES_PATH    = resolve(__dirname, '../cache/cases.json')
const CUSTOMERS_PATH = resolve(__dirname, '../config/customers.json')

interface SupportCase {
  caseNumber: string
  summary: string
  status: string
  severity: string
  accountNumber: string
  daysOpen: number
  product?: string
}

// ── Determine which accounts to scrape ────────────────────────────────────

let accountNumbers: string[] = process.argv.slice(2)

if (accountNumbers.length === 0) {
  try {
    const raw = JSON.parse(await readFile(CUSTOMERS_PATH, 'utf-8'))
    const customers: Array<{ accountNumbers?: (string | number)[] }> =
      raw.customers ?? raw
    accountNumbers = customers
      .flatMap((c) => (c.accountNumbers ?? []).map(String))
      .filter(Boolean)
  } catch {
    console.error('No accounts specified and could not read customers.json')
    process.exit(1)
  }
}

if (accountNumbers.length === 0) {
  console.error('No account numbers found. Pass them as CLI args or add them to customers.json')
  process.exit(1)
}

console.log(`Scraping cases for accounts: ${accountNumbers.join(', ')}\n`)

// ── Session check ──────────────────────────────────────────────────────────

if (!existsSync(SESSION_PATH)) {
  console.error('❌  No session found. Run:  bun scripts/login-rh.ts')
  process.exit(1)
}

const sessionState = JSON.parse(await readFile(SESSION_PATH, 'utf-8'))

// ── Browser setup ──────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true })
const context  = await browser.newContext({ storageState: sessionState })
const page     = await context.newPage()

const allCases: SupportCase[] = []

for (const accountNum of accountNumbers) {
  const url =
    `https://access.redhat.com/support/cases/#/case/list` +
    `?query=accountNumber%3A%20(%22${accountNum}%22)%20orderBy%20severity%20asc` +
    `&p=1&size=100&searchType=basic`

  console.log(`→ Fetching account ${accountNum}...`)

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

    // Detect expired session — wait for portal URL; transparent SSO renewal is allowed
    if (!page.url().includes('access.redhat.com/support')) {
      await page.waitForURL('**/access.redhat.com/support/**', { timeout: 20_000 }).catch(() => {})
    }
    if (!page.url().includes('access.redhat.com/support')) {
      await browser.close()
      console.error('\n❌  Session expired. Run:  bun scripts/login-rh.ts')
      process.exit(2)
    }

    // Wait for Angular table to fully render (partial row appears quickly, rest loads over ~6-7s)
    await page.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(7000)

    const rowCount = await page.locator('table tbody tr').count()
    console.log(`   Found ${rowCount} table rows`)

    const cases = await page.evaluate((acctNum: string) => {
      const results: Array<{
        caseNumber: string
        summary: string
        status: string
        severity: string
        accountNumber: string
        createdDate: string
        product: string
      }> = []

      const rows = document.querySelectorAll('table tbody tr')
      for (const row of rows) {
        // Case number is always a link with /case/ in href
        const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
        if (!caseLink) continue

        const caseNumber = caseLink.textContent?.trim() ?? ''
        if (!/^\d{7,10}$/.test(caseNumber)) continue

        const cells = Array.from(row.querySelectorAll('td')).map(
          (td) => td.textContent?.trim() ?? ''
        )

        // Portal columns (verified, 14 total):
        // [0]=checkbox [1]=case# [2]=summary [3]=opened-by [4]=modified [5]=severity [6]=status [8]=product [12]=date
        results.push({
          caseNumber,
          summary:     cells[2] ?? '',
          status:      cells[6] ?? '',
          severity:    cells[5] ?? '',
          product:     cells[8] ?? '',
          createdDate: cells[12] ?? '',
          accountNumber: acctNum,
        })
      }

      return results
    }, accountNum)

    // Convert to SupportCase shape
    for (const c of cases) {
      const severityNum = String(c.severity).match(/^(\d)/)?.[1] ?? c.severity
      // daysOpen from lastModified isn't the same as created, but it's the best we have from the table
      // The server uses createdDate internally; we'll approximate daysOpen as 0 and let server recalc
      allCases.push({
        caseNumber:    c.caseNumber,
        summary:       c.summary,
        status:        c.status,
        severity:      severityNum,
        accountNumber: c.accountNumber,
        daysOpen:      0,
        product:       c.product || undefined,
      })
    }

    console.log(`   Extracted ${cases.length} cases`)
  } catch (err: any) {
    console.warn(`   ⚠️  Failed for account ${accountNum}: ${err.message}`)
  }
}

await browser.close()

// ── Write cache ────────────────────────────────────────────────────────────

await mkdir(CACHE_DIR, { recursive: true })
const output = {
  scrapedAt: new Date().toISOString(),
  accounts: accountNumbers,
  cases: allCases,
}
await writeFile(CASES_PATH, JSON.stringify(output, null, 2))

console.log(`\n✅  ${allCases.length} total cases written to cache/cases.json`)
console.log(`    (${allCases.filter(c => !['closed','resolved'].includes(c.status.toLowerCase())).length} non-closed)`)
