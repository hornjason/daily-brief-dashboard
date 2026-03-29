/**
 * scripts/test-supportable-csv.ts — Standalone CSV download test for Supportable
 *
 * Tests the CSV download approach as an alternative to DOM scraping.
 * Uses a persistent Chromium profile (same as the running container) so
 * an existing SSO session is reused automatically.
 *
 * Flow:
 *   1. Launch persistent context using the RH profile directory
 *   2. Navigate to Supportable for account 627962 (REI)
 *   3. Click Export tab → select Sales Export Format
 *   4. Actions → Download → CSV → Download (intercept Playwright download event)
 *   5. Read CSV text, parse, print headers + row count + first 3 rows as JSON
 *
 * VPN required. Usage: bun scripts/test-supportable-csv.ts
 */

import { chromium } from '@playwright/test'
import type { Page } from '@playwright/test'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// ── Config ───────────────────────────────────────────────────────────────────

const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'

// Test customers — covers the four scenarios Quinn flagged:
//   - Single account + active rows       (REI, Dropbox)
//   - Multi-account customer             (A10 Networks: 3 accounts)
//   - Zero active rows, account exists   (Fred Hutchinson: should PASS not FAIL)
//   - No Supportable match               (Lynden Logistics: should WARN not FAIL)
const TEST_CUSTOMERS: Array<{ name: string; searchTerm: string; expectNoMatch?: boolean }> = [
  { name: 'Recreational Equipment (REI)', searchTerm: 'Recreational Equipment' },
  { name: 'Dropbox',                      searchTerm: 'Dropbox' },
  { name: 'A10 Networks',                 searchTerm: 'A10 Networks' },
  { name: 'Fred Hutchinson Cancer Center', searchTerm: 'Fred Hutchinson Cancer Center' },
  { name: 'Lynden Logistics',             searchTerm: 'Lynden Logistics', expectNoMatch: true },
]

// Profile directory — inside container it's /data/rh-profile, on host it's relative
const PROFILE_DIR = existsSync('/data/rh-profile')
  ? '/data/rh-profile'
  : join(import.meta.dir, '..', 'data', 'rh-profile')

// ── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Parse CSV text into an array of objects keyed by header names.
 * Handles quoted fields with embedded commas, newlines, and escaped quotes.
 */
function parseCsv(text: string): Record<string, string>[] {
  // Strip UTF-8 BOM — Oracle APEX sometimes prepends it; without this the first
  // header becomes "\uFEFFName" instead of "Name", breaking all column lookups.
  const clean = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = splitCsvLines(clean)
  if (lines.length < 2) return []

  const headers = parseCsvRow(lines[0])
  const rows: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i])
    if (cells.length === 0 || cells.every(c => !c.trim())) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => { obj[h] = cells[idx] ?? '' })
    rows.push(obj)
  }

  return rows
}

/**
 * Split CSV text into logical lines, handling quoted fields that span newlines.
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++ // skip \r\n
      if (current.trim()) lines.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) lines.push(current)
  return lines
}

/**
 * Parse a single CSV row into an array of field values.
 * Handles double-quoted fields and escaped quotes ("").
 */
function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i++ // skip escaped quote
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
  }
  fields.push(current.trim())
  return fields
}

// ── DOM diagnostics ──────────────────────────────────────────────────────────

async function dumpDom(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, button, a, select, [role="menuitem"], [role="dialog"]'))
        .slice(0, 50)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          id:    el.id ?? '',
          text:  (el.textContent ?? '').trim().slice(0, 60),
          cls:   el.className.slice(0, 80),
        }))
      return { url: location.href, els }
    })
    console.log(`[dom:${label}] ${info.url}`)
    for (const e of info.els) {
      console.log(`  <${e.tag}> id="${e.id}" text="${e.text}" class="${e.cls}"`)
    }
  } catch (e: any) {
    console.warn(`[dom:${label}] dump failed: ${e.message}`)
  }
}

// ── Account discovery via customer name search ────────────────────────────────

/**
 * Search Supportable by customer name (wildcard appended), return discovered
 * account numbers. Handles both results-list and direct-match (inline panel).
 */
async function discoverAccountNumbers(page: Page, searchTerm: string): Promise<string[]> {
  // Navigate to landing and fill P0_CUSTOMER_NAME
  await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2_000)

  // Field ID candidates match production scraper exactly
  const nameFieldId = await page.evaluate(() => {
    const candidates = ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']
    for (const id of candidates) {
      if (document.getElementById(id)) return id
    }
    const inp = document.querySelector('input[id*="CUSTOMER_NAME"], input[id*="CUST_NAME"]') as HTMLInputElement | null
    return inp?.id ?? null
  })

  if (!nameFieldId) {
    await dumpDom(page, 'no-name-field')
    throw new Error(`Customer name input not found for search "${searchTerm}"`)
  }

  await page.fill(`input#${nameFieldId}`, `${searchTerm}%`)
  await page.click('button.button-alt1')
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(3_000)
  console.log(`[csv-test] Name search "${searchTerm}%" → ${page.url()}`)

  // Probe stability
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await page.evaluate(() => 'PROBE_OK'); break }
    catch {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(2_000)
    }
  }

  // Case 1: Results table — find the table with Customer Number / Party Number headers
  // and extract the "Customer Number" column only (same logic as production scraper).
  const tableAccounts = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'))
    for (const t of tables) {
      const ths = Array.from(t.querySelectorAll('th'))
        .map(el => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
      if (!ths.some(h => /party.?number|customer.?number|entl/i.test(h))) continue

      const custNumHeader = ths.find(h => /customer.?number/i.test(h)) ?? ''
      const custNumIdx = ths.indexOf(custNumHeader)
      const rownumIdx = ths.indexOf('Rownum')
      if (custNumIdx < 0) continue

      const accountNumbers: string[] = []
      const rows = Array.from(t.querySelectorAll('tr')).slice(1)
      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll('td'))
          .map(td => td.textContent?.trim().replace(/\s+/g, ' ') ?? '')
        if (!cells.some(c => c)) continue
        if (rownumIdx >= 0 && !/^\d+$/.test(cells[rownumIdx] ?? '')) continue
        // Filter: only USA/Web accounts with active entitlements (same as production)
        const countryIdx = ths.findIndex(h => /country/i.test(h))
        const entlIdx = ths.findIndex(h => /entl.*active/i.test(h))
        const country = countryIdx >= 0 ? (cells[countryIdx] ?? '').trim() : ''
        const entlActive = entlIdx >= 0 ? parseInt(cells[entlIdx] ?? '0', 10) : 1
        if (country && country !== 'USA' && country !== 'Web') continue
        if (entlIdx >= 0 && entlActive === 0) continue

        const acct = (cells[custNumIdx] ?? '').trim()
        // Match production regex: 4-12 digits (was 4-10, missing 11-12 digit accounts)
        if (/^\d{4,12}$/.test(acct) && !accountNumbers.includes(acct)) {
          accountNumbers.push(acct)
        }
      }
      return accountNumbers
    }
    return []
  })

  if (tableAccounts.length > 0) {
    console.log(`[csv-test] Found ${tableAccounts.length} account(s) for "${searchTerm}": ${tableAccounts.join(', ')}`)
    return tableAccounts
  }

  // Case 2: Direct match — when the name search returns exactly one result,
  // Supportable shows the Customer Information panel inline on the same page
  // instead of a results list. Scan td cells for the "Account Number:" label.
  const directAccountNumber = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('td'))
    for (let i = 0; i < cells.length; i++) {
      const label = (cells[i].textContent ?? '').trim()
      if (/^account\s*number:?$/i.test(label)) {
        const val = (cells[i + 1]?.textContent ?? '').trim()
        if (/^\d{5,10}$/.test(val)) return val
      }
    }
    return ''
  }).catch(() => '')

  if (directAccountNumber) {
    console.log(`[csv-test] Direct match for "${searchTerm}": account# ${directAccountNumber}`)
    return [directAccountNumber]
  }

  await dumpDom(page, `no-accounts-${searchTerm}`)
  console.warn(`[csv-test] No accounts found for "${searchTerm}"`)
  return []
}

// ── CSV download for a single account number ──────────────────────────────────

async function downloadCsvForAccount(page: Page, accountNumber: string): Promise<{ rows: Record<string, string>[]; filename: string; bytes: number }> {
  // Navigate to landing and fill P0_ACCOUNT_NUMBER
  await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(2_000)

  await page.fill('input#P0_ACCOUNT_NUMBER', accountNumber)
  await page.click('button.button-alt1')
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(2_000)

  for (let attempt = 0; attempt < 5; attempt++) {
    try { await page.evaluate(() => 'PROBE_OK'); break }
    catch {
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
    }
  }

  // Click Export tab
  const exportLinks = await page.$$('a:has-text("Export")')
  if (exportLinks.length === 0) {
    await dumpDom(page, 'no-export-tab')
    throw new Error(`Export tab not found for account ${accountNumber}`)
  }
  await exportLinks[exportLinks.length - 1].click()
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2_000)

  // Select Sales Export Format
  const reportSelId = await page.evaluate(() => {
    const sel = document.querySelector('select[id*="_saved_reports"]') as HTMLSelectElement | null
    return sel?.id ?? null
  })
  if (reportSelId) {
    const salesVal = await page.evaluate((id: string) => {
      const sel = document.querySelector(`select#${id}`) as HTMLSelectElement | null
      const opt = Array.from(sel?.options ?? []).find(o =>
        o.text.toLowerCase().includes('sales export') || o.text.toLowerCase().includes('sales')
      )
      return opt ? { value: opt.value, text: opt.text } : null
    }, reportSelId)
    if (salesVal) {
      await page.selectOption(`select#${reportSelId}`, salesVal.value)
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      await page.waitForTimeout(2_000)
      console.log(`[csv-test] account ${accountNumber}: selected "${salesVal.text}"`)
    }
  }

  // Register download listener BEFORE clicking Actions
  const downloadPromise = page.waitForEvent('download', { timeout: 60_000 })

  const actionsBtn = await page.$('button.a-IRR-button--actions')
  if (!actionsBtn) throw new Error(`Actions button not found for account ${accountNumber}`)
  await actionsBtn.click()
  await page.waitForTimeout(1_000)

  const downloadLink = await page.waitForSelector(
    'li a:has-text("Download"), [role="menuitem"]:has-text("Download")',
    { timeout: 5_000 }
  ).catch(() => null)
  if (!downloadLink) throw new Error(`Download menu item not found for account ${accountNumber}`)
  await downloadLink.click()
  await page.waitForTimeout(2_000)

  const csvFormatOk = await selectCsvFormat(page)
  if (!csvFormatOk) throw new Error(`Could not select CSV format for account ${accountNumber}`)

  // Check if APEX already fired the download from the CSV icon click
  let download
  const quickCheck = await Promise.race([
    downloadPromise.then(d => ({ d, fired: true as const })),
    page.waitForTimeout(500).then(() => ({ d: null as null, fired: false as const })),
  ])
  if (quickCheck.fired && quickCheck.d) {
    download = quickCheck.d
  } else {
    const dlButton = await page.waitForSelector(
      'button.ui-button--hot, button.a-Button--hot, ' +
      '.ui-dialog-buttonpane button:has-text("Download"), ' +
      '.a-IRR-dlg button:has-text("Download")',
      { timeout: 5_000 }
    ).catch(() => null)
    if (!dlButton) {
      await dumpDom(page, `no-dl-button-${accountNumber}`)
      throw new Error(`Download dialog button not found for account ${accountNumber}`)
    }
    await dlButton.click()
    download = await downloadPromise
  }

  const filename = download.suggestedFilename()
  const readable = await download.createReadStream()
  if (!readable) throw new Error(`Could not read download stream for account ${accountNumber}`)

  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const csvText = Buffer.concat(chunks).toString('utf-8')
  const rows = parseCsv(csvText)
  // Case-insensitive status key lookup — matches production scraper behavior
  const statusKey = Object.keys(rows[0] ?? {}).find(k => k.toLowerCase() === 'status') ?? 'Status'
  const activeRows = rows.filter(r => (r[statusKey] ?? '').toLowerCase() === 'active')

  console.log(`[csv-test] account ${accountNumber}: ${activeRows.length} active / ${rows.length} total rows (${csvText.length} bytes)`)
  return { rows: activeRows, filename, bytes: csvText.length }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[csv-test] Profile dir: ${PROFILE_DIR}`)
  console.log(`[csv-test] Testing ${TEST_CUSTOMERS.length} customers: ${TEST_CUSTOMERS.map(c => c.name).join(', ')}`)

  if (!existsSync(PROFILE_DIR)) {
    console.error(`[csv-test] ERROR: Profile directory not found at ${PROFILE_DIR}`)
    process.exit(1)
  }

  try { unlinkSync(join(PROFILE_DIR, 'SingletonLock')) } catch { /* fine */ }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--ignore-certificate-errors'],
  })

  let page = await context.newPage()

  try {
    // ── SSO ────────────────────────────────────────────────────────────────
    console.log('\n[csv-test] Navigating to Supportable...')
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    if (!page.url().includes('supportable.corp.redhat.com')) {
      console.log(`[csv-test] SSO redirect — waiting (up to 3 min)...`)
      let pageClosedByApex = false
      const closePromise = new Promise<void>(r => { page.once('close', () => { pageClosedByApex = true; r() }) })
      await Promise.race([
        page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 180_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) {
        console.log('[csv-test] Page closed by APEX after SSO — opening fresh page')
        page = await context.newPage()
      }
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      throw new Error(`SSO did not complete — still at ${page.url()}`)
    }
    console.log(`[csv-test] SSO OK: ${page.url()}`)

    // ── Per-customer loop ──────────────────────────────────────────────────
    interface CustomerResult {
      customer: string
      accounts: string[]
      activeRows: number
      scrapeError: boolean
      expectNoMatch: boolean
    }
    const summary: CustomerResult[] = []

    for (const customer of TEST_CUSTOMERS) {
      console.log(`\n${'─'.repeat(72)}`)
      console.log(`[csv-test] Customer: ${customer.name}`)
      console.log(`${'─'.repeat(72)}`)

      // Step 1: Discover account numbers via name search
      const accountNumbers = await discoverAccountNumbers(page, customer.searchTerm)
      if (accountNumbers.length === 0) {
        const label = customer.expectNoMatch ? '[expected no match]' : '[WARNING: no accounts found]'
        console.log(`[csv-test] ${label} "${customer.name}"`)
        summary.push({ customer: customer.name, accounts: [], activeRows: 0, scrapeError: false, expectNoMatch: !!customer.expectNoMatch })
        continue
      }

      // Step 2: Download CSV for each account and collect active rows
      let totalActive = 0
      let scrapeError = false
      for (const accountNumber of accountNumbers) {
        try {
          const result = await downloadCsvForAccount(page, accountNumber)
          totalActive += result.rows.length
          if (result.rows.length > 0) {
            console.log(`\n[csv-test] ${customer.name} / account ${accountNumber} — first active row:`)
            console.log(JSON.stringify(result.rows[0], null, 2))
          }
        } catch (e: any) {
          console.warn(`[csv-test] ${customer.name} / account ${accountNumber}: FAILED — ${e.message}`)
          scrapeError = true
        }
      }

      summary.push({ customer: customer.name, accounts: accountNumbers, activeRows: totalActive, scrapeError, expectNoMatch: false })
    }

    // ── Final summary ──────────────────────────────────────────────────────
    // Pass/fail logic:
    //   PASS  — accounts found, scrape succeeded (0 active rows is legitimate: expired subs)
    //   WARN  — no accounts found but expectNoMatch=true (Lynden Logistics scenario)
    //   FAIL  — scrape error, OR no accounts found when match was expected
    console.log('\n' + '='.repeat(72))
    console.log('E2E TEST SUMMARY')
    console.log('='.repeat(72))
    let allPassed = true
    for (const s of summary) {
      let status: string
      if (s.expectNoMatch && s.accounts.length === 0) {
        status = '⚠ WARN '  // expected — no Supportable match
      } else if (s.scrapeError) {
        status = '✗ FAIL '; allPassed = false
      } else if (s.accounts.length === 0) {
        status = '✗ FAIL '; allPassed = false  // unexpected no-match
      } else {
        status = '✓ PASS '  // accounts found + scrape succeeded (even if 0 active rows)
      }
      const rowNote = s.accounts.length > 0
        ? `${s.accounts.length} account(s), ${s.activeRows} active rows`
        : 'no accounts found'
      console.log(`${status}  ${s.customer}: ${rowNote}`)
      if (s.accounts.length > 0) console.log(`        accounts: ${s.accounts.join(', ')}`)
    }
    console.log('='.repeat(72))

    if (!allPassed) {
      console.error('[csv-test] One or more customers failed')
      await context.close().catch(() => {})
      process.exit(1)
    }
    console.log('[csv-test] ALL PASS')

  } catch (err: any) {
    console.error(`\n[csv-test] FATAL: ${err.message}`)
    console.error(err.stack)
    await context.close().catch(() => {})
    process.exit(1)
  }

  await context.close()
  process.exit(0)
}

// ── CSV format selection helpers ─────────────────────────────────────────────

/**
 * Try multiple strategies to select CSV format in the APEX download dialog.
 * Returns true if CSV was successfully selected.
 */
async function selectCsvFormat(page: Page): Promise<boolean> {
  // Strategy 1: Click a radio/button/link with text "CSV"
  const csvEl = await page.$('.a-IRR-dlg-dlType-CSV, [data-type="CSV"]')
  if (csvEl) {
    await csvEl.click()
    await page.waitForTimeout(500)
    return true
  }

  // Strategy 2: Look for a label or clickable element containing "CSV"
  const csvLabel = await page.$('label:has-text("CSV"), span:has-text("CSV"), a:has-text("CSV")')
  if (csvLabel) {
    await csvLabel.click()
    await page.waitForTimeout(500)
    return true
  }

  // Strategy 3: Radio input with value CSV
  const csvRadio = await page.$('input[type="radio"][value="CSV"], input[type="radio"][value="csv"]')
  if (csvRadio) {
    await csvRadio.click()
    await page.waitForTimeout(500)
    return true
  }

  // Strategy 4: Select element with CSV option
  const selectWithCsv = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'))
    for (const sel of selects) {
      const csvOpt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes('csv') || o.value.toLowerCase().includes('csv')
      )
      if (csvOpt) return { id: sel.id, value: csvOpt.value }
    }
    return null
  })
  if (selectWithCsv && selectWithCsv.id) {
    await page.selectOption(`select#${selectWithCsv.id}`, selectWithCsv.value)
    await page.waitForTimeout(500)
    return true
  }

  // Strategy 5: Any element matching common APEX download dialog patterns
  const anyCSV = await page.$('text=CSV')
  if (anyCSV) {
    await anyCSV.click()
    await page.waitForTimeout(500)
    return true
  }

  return false
}

// ── Run ──────────────────────────────────────────────────────────────────────

main()
