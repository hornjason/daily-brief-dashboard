/**
 * Test: search cases by accountName SOLR query instead of the two-step
 * accounts-API → per-account cases-page approach.
 *
 * Usage: bun scripts/test-accountname-search.ts
 *
 * Requires an active RH portal session (run from inside the container or
 * with the same profile dir the server uses).
 */

import { chromium } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const PROFILE_DIR  = process.env.RH_PROFILE_DIR ?? resolve(import.meta.dir, '../data/rh-profile')
const SESSION_FILE = process.env.RH_SESSION      ?? resolve(import.meta.dir, '../data/config/.rh-session')
const CASES_BASE   = 'https://access.redhat.com/support/cases/#/case/list'

const TEST_CUSTOMERS = [
  'A10 Networks',
  'Dropbox',
  'Crowdstrike',
]

async function searchByAccountName(page: any, customerName: string) {
  // SOLR query: accountName exact match, skip closed cases
  const query = `accountName: "${customerName}" and NOT status: "Closed"`
  const url = `${CASES_BASE}?query=${encodeURIComponent(query)}&p=1&size=100&searchType=advanced`

  console.log(`\n─── ${customerName} ───`)
  console.log(`URL: ${url}`)

  // Intercept the hydra API response to get raw JSON (includes accountNumber)
  const apiResponses: any[] = []
  const responseHandler = async (response: any) => {
    if (response.url().includes('/hydra/rest/') && response.url().includes('case')) {
      try {
        const json = await response.json()
        apiResponses.push({ url: response.url(), data: json })
      } catch {}
    }
  }
  page.on('response', responseHandler)

  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })

  // Allow SSO transparent renewal
  if (!page.url().includes('access.redhat.com/support')) {
    await page.waitForURL('**/access.redhat.com/support/**', { timeout: 15_000 }).catch(() => {})
  }

  if (!page.url().includes('access.redhat.com/support')) {
    console.log('  ✗ Session expired or redirect failed')
    page.off('response', responseHandler)
    return
  }

  await page.waitForSelector('table tbody tr', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(4_000)  // let Angular finish rendering

  // Extract account numbers + case numbers from DOM
  const domResults = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr')
    const found: Array<{ caseNumber: string; status: string; accountNumber: string }> = []
    for (const row of rows) {
      const caseLink = row.querySelector('a[href*="/case/"]') as HTMLAnchorElement | null
      if (!caseLink) continue
      const caseNumber = caseLink.textContent?.trim() ?? ''
      if (!/^\d{7,10}$/.test(caseNumber)) continue

      const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '')
      const status = cells[6] ?? ''

      // Try to find account number — look in all cells for an 8-10 digit number
      let accountNumber = ''
      for (const cell of cells) {
        if (/^\d{6,10}$/.test(cell)) { accountNumber = cell; break }
      }
      // Also check data attributes on the row
      const dataAcct = (row as HTMLElement).dataset?.accountNumber ?? ''
      if (!accountNumber && dataAcct) accountNumber = dataAcct

      found.push({ caseNumber, status, accountNumber })
    }
    return found
  })

  page.off('response', responseHandler)

  // Summary
  console.log(`  DOM rows: ${domResults.length}`)
  const accountsFromDom = [...new Set(domResults.map(r => r.accountNumber).filter(Boolean))]
  console.log(`  Account numbers in DOM: ${accountsFromDom.length > 0 ? accountsFromDom.join(', ') : 'none found in cells'}`)
  if (domResults.length > 0) {
    console.log(`  Sample rows:`)
    for (const r of domResults.slice(0, 3)) {
      console.log(`    Case ${r.caseNumber} | status: ${r.status} | acct: ${r.accountNumber || '?'}`)
    }
  }

  // Check intercepted API responses
  if (apiResponses.length > 0) {
    console.log(`  Intercepted ${apiResponses.length} hydra API response(s):`)
    for (const resp of apiResponses.slice(0, 3)) {
      console.log(`    ${resp.url}`)
      // Look for accountNumber in response data
      const accountNums = extractAccountNumbers(resp.data)
      if (accountNums.length > 0) {
        console.log(`    → account numbers: ${[...new Set(accountNums)].slice(0, 5).join(', ')}`)
      }
    }
  } else {
    console.log(`  No hydra API responses intercepted`)
  }
}

function extractAccountNumbers(obj: any, depth = 0): string[] {
  if (depth > 5 || !obj) return []
  const results: string[] = []
  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'accountNumber' && typeof val === 'string') results.push(val)
      else if (key === 'accountNumber' && typeof val === 'number') results.push(String(val))
      else results.push(...extractAccountNumbers(val, depth + 1))
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) results.push(...extractAccountNumbers(item, depth + 1))
  }
  return results
}

async function main() {
  if (!existsSync(SESSION_FILE)) {
    console.error('No RH session file found — run from inside the container or set RH_SESSION env var')
    process.exit(1)
  }

  // Clear singleton locks from previous runs
  const { unlink } = await import('fs/promises')
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    await unlink(`${PROFILE_DIR}/${f}`).catch(() => {})
  }

  console.log('Opening browser with saved profile...')
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--headless=new', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  // Restore session cookies
  const sessionStateFile = `${PROFILE_DIR}/session-state.json`
  if (existsSync(sessionStateFile)) {
    try {
      const { cookies } = JSON.parse(readFileSync(sessionStateFile, 'utf-8'))
      if (cookies?.length) {
        await context.addCookies(cookies)
        console.log(`Restored ${cookies.length} session cookies`)
      }
    } catch {}
  }

  const page = await context.newPage()

  // Navigate to portal first to establish session
  await page.goto('https://access.redhat.com/support/cases/#/case/list', {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  })
  await page.waitForTimeout(3_000)

  if (!page.url().includes('access.redhat.com/support')) {
    console.error('Session not active — please reconnect RH Portal first')
    await context.close()
    process.exit(1)
  }

  console.log('Session active. Testing accountName SOLR queries...')

  for (const customer of TEST_CUSTOMERS) {
    await searchByAccountName(page, customer)
  }

  await context.close()
  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
