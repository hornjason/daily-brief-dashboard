/**
 * src/supportable-scraper.ts
 *
 * Scrapes subscription entitlement data from the Supportable portal
 * (https://supportable.corp.redhat.com — requires VPN).
 *
 * Flow per account number:
 *   1. Navigate to the APEX app (first account only — handles SSO redirect)
 *   2. Fill Account Number input (P0_ACCOUNT_NUMBER) → click Go
 *   3. Click Export tab → navigates to page 22 (SalesReport layout)
 *   4. Select "Sales Export Format" saved report
 *   5. Actions → Download → CSV → intercept Playwright download event
 *   6. Parse CSV, filter to Status=Active rows
 *   7. Navigate back to landing page for next account number
 *
 * All account numbers for a customer are aggregated into a single tab.
 * The final Google Sheet has an "Accounts" summary tab (first) followed
 * by one tab per customer containing their aggregated subscription rows.
 */

import type { BrowserContext, Page } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { AE } from './types.ts'

const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'

// ── Module state ──────────────────────────────────────────────────────────────

export let lastSupportableScrape: string | null = null
export let lastSupportableError:  string | null = null
export let supportableScrapeRunning = false

let _ctx: BrowserContext | null = null

export function adoptSupportableContext(ctx: BrowserContext): void {
  _ctx = ctx
  console.log('[supportable] adopted shared browser context')
}

// ── DOM diagnostics ───────────────────────────────────────────────────────────

async function dumpDom(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, button, a, [role="tab"]'))
        .slice(0, 40)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          id:    el.id ?? '',
          value: ((el as HTMLInputElement).value ?? '').slice(0, 50),
          text:  (el.textContent ?? '').trim().slice(0, 50),
          cls:   el.className.slice(0, 80),
        }))
      return { url: location.href, els }
    })
    console.log(`[supportable:dom] ${label} — ${info.url}\n` +
      info.els.map(e => `  <${e.tag}> id="${e.id}" value="${e.value}" text="${e.text}" class="${e.cls}"`).join('\n'))
  } catch (e: any) {
    console.warn(`[supportable:dom] dump failed (${label}): ${e.message}`)
  }
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

/**
 * Split CSV text into logical lines, keeping quoted fields that contain
 * embedded newlines intact (RFC 4180 multi-line field support).
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') { inQuotes = !inQuotes; current += ch }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (current.trim()) lines.push(current)
      current = ''
    } else { current += ch }
  }
  if (current.trim()) lines.push(current)
  return lines
}

/** Parse one CSV line into field values, handling double-quoted fields and escaped quotes (""). */
function parseCsvRow(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++ } else { inQuotes = false }
      } else { current += ch }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { fields.push(current.trim()); current = '' }
      else { current += ch }
    }
  }
  fields.push(current.trim())
  return fields
}

/** Parse full CSV text into an array of objects keyed by the header row values. */
function parseCsvToObjects(text: string): Record<string, string>[] {
  const lines = splitCsvLines(text)
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
 * Try multiple strategies to select CSV format in the APEX download dialog.
 * Returns true if a CSV format element was clicked.
 */
async function selectCsvFormat(page: Page): Promise<boolean> {
  const csvEl = await page.$('.a-IRR-dlg-dlType-CSV, [data-type="CSV"]')
  if (csvEl) { await csvEl.click(); await page.waitForTimeout(500); return true }

  const csvLabel = await page.$('label:has-text("CSV"), span:has-text("CSV"), a:has-text("CSV")')
  if (csvLabel) { await csvLabel.click(); await page.waitForTimeout(500); return true }

  const csvRadio = await page.$('input[type="radio"][value="CSV"], input[type="radio"][value="csv"]')
  if (csvRadio) { await csvRadio.click(); await page.waitForTimeout(500); return true }

  const selectWithCsv = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'))
    for (const sel of selects) {
      const opt = Array.from(sel.options).find(o =>
        o.text.toLowerCase().includes('csv') || o.value.toLowerCase().includes('csv')
      )
      if (opt) return { id: sel.id, value: opt.value }
    }
    return null
  })
  if (selectWithCsv?.id) {
    // Use attribute selector to handle APEX IDs that may contain colons or other special chars
    await page.selectOption(`select[id="${selectWithCsv.id}"]`, selectWithCsv.value)
    await page.waitForTimeout(500)
    return true
  }

  const anyCSV = await page.$('text=CSV')
  if (anyCSV) { await anyCSV.click(); await page.waitForTimeout(500); return true }

  return false
}

// ── Per-account scrape ────────────────────────────────────────────────────────

async function scrapeOneAccount(
  page: Page,
  accountNumber: string,
  isFirst: boolean,
): Promise<{ rows: Record<string, string>[]; page: Page }> {

  if (isFirst) {
    console.log(`[supportable] navigating to portal…`)
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)
    await dumpDom(page, 'landing')

    const onSso = !page.url().includes('supportable.corp.redhat.com')
    if (onSso) {
      console.log(`[supportable] SSO redirect detected (${page.url()}) — waiting for SSO to resolve…`)

      // The APEX SSO callback may call window.close() on the page after completing auth.
      // Race: either the page navigates back to Supportable, OR the page closes.
      let pageClosedByApex = false
      const pageClosePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      const urlResolvedPromise = page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 300_000 }).catch(() => {})
      await Promise.race([urlResolvedPromise, pageClosePromise])

      if (pageClosedByApex) {
        console.log('[supportable] page closed by APEX after SSO — opening fresh page from context')
        page = await _ctx!.newPage()
      }

      // Navigate fresh to the Supportable landing page (session is now in profile)
      console.log('[supportable] navigating fresh to portal after SSO')
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
      await dumpDom(page, 'post-sso-fresh')
    } else {
      // SSO popup (legacy path)
      const popup = await page.waitForEvent('popup', { timeout: 3_000 }).catch(() => null)
      if (popup) {
        console.log(`[supportable] SSO popup detected — waiting for user to complete via VNC at :6080`)
        await popup.waitForEvent('close', { timeout: 300_000 }).catch(() => {})
        console.log('[supportable] SSO popup closed — navigating fresh to portal')
        await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(3_000)
        await dumpDom(page, 'post-sso-fresh')
      } else {
        console.log('[supportable] no SSO — session active')
      }
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      throw new Error(`SSO login did not complete — still at ${page.url()}`)
    }
  }

  // ── Fill account number ───────────────────────────────────────────────────
  await page.fill('input#P0_ACCOUNT_NUMBER', accountNumber)
  console.log(`[supportable] filled account# ${accountNumber}`)

  // ── Click Go ──────────────────────────────────────────────────────────────
  await page.click('button.button-alt1')
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(2_000)

  // APEX does JS redirects after Go — probe evaluate before touching DOM
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await page.evaluate(() => 'PROBE_OK')
      break
    } catch {
      console.log(`[supportable] account Go: page still navigating (attempt ${attempt + 1}) — waiting…`)
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
    }
  }
  console.log(`[supportable] Go clicked — on ${page.url()}`)

  // ── Click Export tab → navigates to page 22 (SalesReport layout) ──────────
  // The Export tab link is the last "Export" anchor in the page navigation
  const exportLinks = await page.$$('a:has-text("Export")')
  if (exportLinks.length === 0) {
    await dumpDom(page, 'no-export-tab')
    throw new Error('Export tab not found')
  }
  await exportLinks[exportLinks.length - 1].click()
  await page.waitForLoadState('networkidle', { timeout: 20_000 })
  await page.waitForTimeout(2_000)
  console.log(`[supportable] Export tab clicked — on ${page.url()}`)

  // ── Select "Sales Export Format" saved report ─────────────────────────────
  const reportSelId = await page.evaluate(() => {
    const sel = document.querySelector('select[id*="_saved_reports"]') as HTMLSelectElement | null
    return sel?.id ?? null
  })
  if (reportSelId) {
    const salesVal = await page.evaluate((id: string) => {
      const sel = document.getElementById(id) as HTMLSelectElement | null
      const opt = Array.from(sel?.options ?? []).find(o =>
        o.text.toLowerCase().includes('sales export') || o.text.toLowerCase().includes('sales')
      )
      return opt?.value ?? null
    }, reportSelId)
    if (salesVal) {
      await page.selectOption(`select[id="${reportSelId}"]`, salesVal)
      await page.waitForLoadState('networkidle', { timeout: 20_000 })
      await page.waitForTimeout(2_000)
      console.log(`[supportable] selected Sales Export Format report`)
    }
  }

  // ── Actions → Filter → Status = Active ────────────────────────────────────
  // Apply the filter BEFORE downloading so the CSV only contains Active rows.
  // This is more efficient than downloading all rows and filtering in code.
  // Non-fatal: if filter fails we still download all rows and filter in code.
  const filterActionsBtn = await page.$('button.a-IRR-button--actions')
  if (filterActionsBtn) {
    await filterActionsBtn.click()
    const filterLink = await page.waitForSelector(
      '.a-Menu a:has-text("Filter"), li a:has-text("Filter"), [role="menuitem"]:has-text("Filter")',
      { timeout: 5_000 }
    ).catch(() => null)
    if (filterLink) {
      await filterLink.click()
      await page.waitForTimeout(1_500)

      // Set column = Status
      const selects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select'))
          .filter((el: any) => el.offsetParent !== null)
          .map((el: any) => ({
            id: el.id,
            options: Array.from((el as HTMLSelectElement).options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
          }))
      )
      const colSel = selects.find(s => s.options.some((o: any) => o.text.toLowerCase() === 'status'))
      if (colSel) {
        const statusOpt = colSel.options.find((o: any) => o.text.toLowerCase() === 'status')
        if (statusOpt) {
          await page.selectOption(`select[id="${colSel.id}"]`, statusOpt.value)
          await page.waitForTimeout(800)
        }
      }

      // Set operator = "="
      const updatedSelects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select'))
          .filter((el: any) => el.offsetParent !== null)
          .map((el: any) => ({
            id: el.id,
            options: Array.from((el as HTMLSelectElement).options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
          }))
      )
      const opSel = updatedSelects.find(s => s.options.some((o: any) => o.text === '=' || o.value === 'eq'))
      if (opSel) {
        const eqOpt = opSel.options.find((o: any) => o.text === '=' || o.value === 'eq')
        if (eqOpt) {
          await page.selectOption(`select[id="${opSel.id}"]`, eqOpt.value)
          await page.waitForTimeout(800)
        }
      }

      // Set expression = Active
      const exprSelects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select'))
          .filter((el: any) => el.offsetParent !== null)
          .map((el: any) => ({
            id: el.id,
            options: Array.from((el as HTMLSelectElement).options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
          }))
      )
      const exprSel = exprSelects.find(s => s.options.some((o: any) => o.text.toLowerCase() === 'active'))
      if (exprSel) {
        const activeOpt = exprSel.options.find((o: any) => o.text.toLowerCase() === 'active')
        if (activeOpt) {
          await page.selectOption(`select[id="${exprSel.id}"]`, activeOpt.value)
          await page.waitForTimeout(500)
        }
      }

      // Apply filter — APEX fires an AJAX refresh; wait for it before proceeding to download
      const applyBtn = await page.$('button:has-text("Apply"), input[value="Apply"]')
      if (applyBtn) {
        await applyBtn.click()
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
        await page.waitForTimeout(3_000)  // extra buffer for APEX AJAX re-render
        console.log(`[supportable] account ${accountNumber}: Status=Active filter applied`)
      }
    } else {
      console.warn(`[supportable] account ${accountNumber}: Filter menu item not found — will filter in code`)
    }
  } else {
    console.warn(`[supportable] account ${accountNumber}: Actions button not found for filter — will filter in code`)
  }

  // ── Download Active rows as CSV via Actions → Download ────────────────────
  // Register the download listener BEFORE clicking Actions — APEX may fire
  // the download event immediately when the CSV format icon is clicked.
  // 120s budget: UI navigation takes ~10-15s, leaving ~105s for the actual download.
  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 })

  const actionsBtn = await page.$('button.a-IRR-button--actions')
  if (!actionsBtn) {
    await dumpDom(page, 'no-actions-btn')
    throw new Error(`Actions button not found for account ${accountNumber}`)
  }
  await actionsBtn.click()
  await page.waitForTimeout(1_000)

  const downloadLink = await page.waitForSelector(
    'li a:has-text("Download"), [role="menuitem"]:has-text("Download")',
    { timeout: 5_000 }
  ).catch(() => null)
  if (!downloadLink) {
    await dumpDom(page, 'no-download-menuitem')
    throw new Error(`Download menu item not found for account ${accountNumber}`)
  }
  await downloadLink.click()
  await page.waitForTimeout(2_000)

  const csvFormatSelected = await selectCsvFormat(page)
  if (!csvFormatSelected) {
    await dumpDom(page, 'csv-format-selection')
    throw new Error(`Could not select CSV format for account ${accountNumber}`)
  }

  // APEX sometimes fires the download immediately on CSV icon click — check quickly
  let download
  const quickCheck = await Promise.race([
    downloadPromise.then(d => ({ d, fired: true as const })),
    page.waitForTimeout(500).then(() => ({ d: null as null, fired: false as const })),
  ])
  if (quickCheck.fired && quickCheck.d) {
    download = quickCheck.d
  } else {
    // Dialog Download button — jQuery UI primary button, class "ui-button--hot"
    const dlButton = await page.waitForSelector(
      'button.ui-button--hot, button.a-Button--hot, ' +
      '.ui-dialog-buttonpane button:has-text("Download"), ' +
      '.a-IRR-dlg button:has-text("Download")',
      { timeout: 5_000 }
    ).catch(() => null)
    if (!dlButton) {
      await dumpDom(page, 'no-download-button')
      throw new Error(`Download dialog button not found for account ${accountNumber}`)
    }
    await dlButton.click()
    download = await downloadPromise
  }
  console.log(`[supportable] account ${accountNumber}: CSV download — ${download.suggestedFilename()}`)

  // Check for server-side download failure before attempting to stream
  const dlFailure = await download.failure()
  if (dlFailure) throw new Error(`Download failed for account ${accountNumber}: ${dlFailure}`)

  // Read the download stream into a buffer
  const readable = await download.createReadStream()
  if (!readable) throw new Error(`Could not create read stream for account ${accountNumber}`)
  const chunks: Buffer[] = []
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const csvText = Buffer.concat(chunks).toString('utf-8')
  console.log(`[supportable] account ${accountNumber}: CSV ${csvText.length} bytes`)

  // Parse CSV and filter to active subscriptions
  // Use case-insensitive header lookup in case Supportable changes capitalisation
  const allCsvRows = parseCsvToObjects(csvText)
  const statusKey = Object.keys(allCsvRows[0] ?? {}).find(k => k.toLowerCase() === 'status') ?? 'Status'
  const activeRows = allCsvRows.filter(r => (r[statusKey] ?? '').toLowerCase() === 'active')
  console.log(`[supportable] account ${accountNumber}: ${activeRows.length} active rows (${allCsvRows.length} total)`)

  // ── Navigate back to landing for next account ────────────────────────────
  // Full navigation clears all APEX state — no need to click the Reset button first.
  await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1_500)

  return { rows: activeRows, page }
}

// ── Customer name search (account discovery via P0_CUSTOMER_NAME) ─────────────

/**
 * Strip trailing legal suffixes so "Recreational Equipment, Inc." becomes
 * "Recreational Equipment" — Supportable often indexes without the suffix,
 * so searching "Recreational Equipment%" succeeds where the full name fails.
 * When supportableName override is set we skip this — the override is exact.
 */
function stripLegalSuffix(name: string): string {
  return name
    .replace(/,?\s+(Inc\.?|LLC\.?|L\.L\.C\.?|Corp\.?|Ltd\.?|Incorporated|Limited|Co\.?|Company)\s*$/i, '')
    .trim()
}

/**
 * Search Supportable by customer name using the P0_CUSTOMER_NAME wildcard field.
 * Appends % to the name for LIKE matching. Filters results to rows where
 * Country = USA or Web AND Entl Active Cnt > 0.
 *
 * Assumes page is already on the Supportable landing page (SSO already resolved).
 * Returns unique Customer Number values (RH account numbers).
 */
async function discoverAccountNumbersByName(
  page: Page,
  customerName: string,
  supportableName?: string,
): Promise<string[]> {
  // Fill Customer Name with wildcard — try known field IDs
  let fieldId = 'P0_CUSTOMER_NAME'
  for (const candidate of ['P0_CUSTOMER_NAME', 'P0_CUST_NAME', 'P0_CUSTOMER']) {
    const el = await page.$(`input#${candidate}`).catch(() => null)
    if (el) { fieldId = candidate; break }
  }
  // Use supportableName override when set — it matches exactly how Supportable indexes the account.
  // Otherwise strip trailing legal suffixes (Inc., LLC, etc.) so "Recreational Equipment, Inc."
  // becomes "Recreational Equipment%" — Supportable often omits suffixes from indexed names.
  const searchTerm = supportableName?.trim()
    ? supportableName.trim()
    : stripLegalSuffix(customerName)
  await page.fill(`input#${fieldId}`, `${searchTerm}%`)
  console.log(`[supportable] name-search: filled #${fieldId} with "${searchTerm}%" (source: ${supportableName ? `supportableName override` : `customerName → stripped suffix`})`)

  await page.click('button.button-alt1')
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(5_000)

  // APEX does multiple JS redirects after submit — probe evaluate before scraping
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.evaluate(() => 'PROBE_OK')
      break
    } catch {
      console.log(`[supportable] name-search: results page still navigating (attempt ${attempt + 1}) — waiting…`)
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
    }
  }

  const tableData = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'))
    for (const t of tables) {
      const ths = Array.from(t.querySelectorAll('th'))
        .map(el => el.textContent?.trim().replace(/\s+/g, ' ') ?? '')
      if (!ths.some(h => /party.?number|customer.?number|entl/i.test(h))) continue

      // Find column indices by regex so header capitalisation/spacing variations don't break us
      const custNumIdx  = ths.findIndex(h => /customer.?number/i.test(h))
      const countryIdx  = ths.findIndex(h => /^country$/i.test(h))
      const entlIdx     = ths.findIndex(h => /entl.*active/i.test(h))
      const rownumIdx   = ths.findIndex(h => /^rownum$/i.test(h))
      if (custNumIdx < 0) continue

      const accountNumbers: string[] = []
      Array.from(t.querySelectorAll('tr')).slice(1).forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('td'))
          .map(td => td.textContent?.trim().replace(/\s+/g, ' ') ?? '')
        if (!cells.some(c => c)) return
        if (rownumIdx >= 0 && !/^\d+$/.test(cells[rownumIdx] ?? '')) return
        if (cells.length < ths.length - 2) return
        const country    = countryIdx >= 0 ? cells[countryIdx] : ''
        const entlActive = entlIdx    >= 0 ? parseInt(cells[entlIdx] ?? '0', 10) : 1
        if (country && country !== 'Web' && country !== 'USA') return
        if (entlIdx >= 0 && entlActive === 0) return
        const acct = cells[custNumIdx]
        if (acct && /^\d{4,12}$/.test(acct) && !accountNumbers.includes(acct)) {
          accountNumbers.push(acct)
        }
      })
      return { accountNumbers }
    }
    return { accountNumbers: [] }
  })

  const accountNumbers = [...new Set(tableData.accountNumbers ?? [])]

  // Direct-match fallback: when the name matches exactly one record Supportable
  // renders the Customer Information panel inline on the same page (URL stays at
  // page 1) instead of showing a results list. The subscription table has different
  // headers so accountNumbers is empty. Scan for the "Account Number:" label cell.
  if (accountNumbers.length === 0) {
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
      console.log(`[supportable] name-search: "${searchTerm}%" → direct match, account# ${directAccountNumber}`)
      return [directAccountNumber]
    }
  }

  console.log(`[supportable] name-search: "${searchTerm}%" → ${accountNumbers.length} account(s): [${accountNumbers.join(', ')}]`)
  return accountNumbers
}

// ── Public scrape entry point ─────────────────────────────────────────────────

export interface SupportableCustomer {
  name: string
  accountNumbers: string[]
}

export interface SupportableResult {
  customerName:   string
  accountNumbers: string[]
  rows:           Record<string, string>[]
}

export async function runSupportableScrape(
  customers: SupportableCustomer[],
): Promise<SupportableResult[]> {
  if (supportableScrapeRunning) throw new Error('Supportable scrape already in progress')
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  supportableScrapeRunning = true
  lastSupportableError = null

  let page = await _ctx.newPage()
  const results: SupportableResult[] = []
  let isFirst = true

  try {
    for (const customer of customers) {
      const allRows: Record<string, string>[] = []

      for (const accountNumber of customer.accountNumbers) {
        try {
          const result = await scrapeOneAccount(page, accountNumber, isFirst)
          allRows.push(...result.rows)
          page = result.page  // may be a fresh page after SSO
          isFirst = false
        } catch (e: any) {
          console.warn(`[supportable] ${customer.name}/${accountNumber}: ${e.message}`)
        }
      }

      console.log(`[supportable] ${customer.name}: ${allRows.length} total rows across ${customer.accountNumbers.length} account(s)`)
      results.push({ customerName: customer.name, accountNumbers: customer.accountNumbers, rows: allRows })
    }

    lastSupportableScrape = new Date().toISOString()
    return results

  } catch (e: any) {
    lastSupportableError = e.message
    throw e
  } finally {
    await page.close().catch(() => {})
    supportableScrapeRunning = false
  }
}

/**
 * Combined bootstrap flow: for each customer name, discover account numbers via
 * P0_CUSTOMER_NAME wildcard search, then immediately scrape subscriptions for
 * those accounts — all in a single Supportable session.
 *
 * Returns SupportableResult[] with both accountNumbers and subscription rows populated.
 * The caller can write account numbers to customers.json and pass results directly
 * to writeSupportableSheet() without a second Supportable visit.
 *
 * onProgress callback fires after each customer completes.
 */
export async function runSupportableDiscoverAndScrape(
  customers: Array<{ name: string; supportableName?: string }>,
  onProgress?: (done: number, total: number, name: string, accountNumbers: string[], rowCount: number) => void,
): Promise<SupportableResult[]> {
  if (supportableScrapeRunning) throw new Error('Supportable scrape already in progress')
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  supportableScrapeRunning = true
  lastSupportableError = null

  let page = await _ctx.newPage()
  const results: SupportableResult[] = []

  try {
    // ── First navigation: go to Supportable landing, handle SSO ──────────────
    console.log(`[supportable] discover+scrape: navigating to portal…`)
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)

    if (!page.url().includes('supportable.corp.redhat.com')) {
      let pageClosedByApex = false
      const closePromise = new Promise<void>(resolve => { page.once('close', () => { pageClosedByApex = true; resolve() }) })
      await Promise.race([
        page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 300_000 }).catch(() => {}),
        closePromise,
      ])
      if (pageClosedByApex) page = await _ctx.newPage()
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(3_000)
    }

    if (!page.url().includes('supportable.corp.redhat.com')) {
      throw new Error(`SSO login did not complete — still at ${page.url()}`)
    }

    console.log(`[supportable] discover+scrape: session active, processing ${customers.length} customers`)

    for (let i = 0; i < customers.length; i++) {
      const { name: customerName, supportableName } = customers[i]

      // ── 0. Ensure we're on the landing page before each customer ──────────
      // Prevents page state corruption from a prior failed account scrape
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e: any) => {
        console.warn(`[supportable] discover+scrape: pre-customer nav failed for "${customerName}": ${e.message}`)
      })
      await page.waitForTimeout(1_500)

      // ── 1. Discover account numbers via name search ───────────────────────
      let accountNumbers: string[] = []
      try {
        accountNumbers = await discoverAccountNumbersByName(page, customerName, supportableName)
      } catch (e: any) {
        console.warn(`[supportable] discover+scrape: name search failed for "${customerName}": ${e.message}`)
        results.push({ customerName, accountNumbers: [], rows: [] })
        onProgress?.(i + 1, customers.length, customerName, [], 0)
        continue
      }

      if (accountNumbers.length === 0) {
        console.log(`[supportable] discover+scrape: "${customerName}" — no matching accounts`)
        results.push({ customerName, accountNumbers: [], rows: [] })
        onProgress?.(i + 1, customers.length, customerName, [], 0)
        // Navigate back to landing for next customer
        await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(1_500)
        continue
      }

      // ── 2. Navigate back to landing for account number entry ─────────────
      await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(1_500)

      // ── 3. Scrape subscriptions for each account number ───────────────────
      const allRows: Record<string, string>[] = []
      let isFirstScrape = false  // SSO already handled above — never re-trigger it
      for (const accountNumber of accountNumbers) {
        try {
          const result = await scrapeOneAccount(page, accountNumber, isFirstScrape)
          allRows.push(...result.rows)
          page = result.page
        } catch (e: any) {
          console.warn(`[supportable] discover+scrape: ${customerName}/${accountNumber}: ${e.message}`)
          // Recovery: navigate back to landing so the next account starts clean
          await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          await page.waitForTimeout(1_500)
        }
      }

      console.log(`[supportable] discover+scrape: ✓ "${customerName}": ${accountNumbers.length} acct(s), ${allRows.length} subscription rows`)
      results.push({ customerName, accountNumbers, rows: allRows })
      onProgress?.(i + 1, customers.length, customerName, accountNumbers, allRows.length)
    }

    lastSupportableScrape = new Date().toISOString()
    return results

  } catch (e: any) {
    lastSupportableError = e.message
    throw e
  } finally {
    await page.close().catch(() => {})
    supportableScrapeRunning = false
  }
}

// ── Google Sheets writer ──────────────────────────────────────────────────────

// Exact column order from the Supportable CSV export
const CSV_HEADERS = [
  'Name', 'Customer Number', 'Account Number', 'Country',
  'First Name', 'Last Name', 'Login', 'Email', 'Phone Num',
  'Internal Sku', 'Ordered Item', 'Product Description', 'Quantity',
  'Status', 'Start Date', 'End Date', 'Contract#', 'Cust PO Number', 'End Customer PO',
]

/**
 * Creates or updates the AE's Supportable Google Sheet.
 *
 * First run (no existingSheetId): creates sheet via Drive API in driveFolderId so it
 * lands in the correct folder. Returns the new spreadsheet ID.
 *
 * Subsequent runs (existingSheetId provided): clears and rewrites data without
 * recreating the file — preserves the sheet ID so bookmarks stay valid.
 *
 * Tabs: "Accounts" summary + one tab per customer with their subscription rows.
 */
export async function writeSupportableSheet(
  results: SupportableResult[],
  aeName: string,
  driveFolderId?: string,
  existingSheetId?: string,
): Promise<string> {
  const auth   = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })

  let spreadsheetId: string

  if (existingSheetId) {
    // ── Subsequent run: clear and rewrite existing sheet ──────────────────────
    spreadsheetId = existingSheetId
    console.log(`[supportable] reusing existing sheet ${spreadsheetId}`)

    // Get current sheet tabs to diff against results
    const metaRes = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' })
    const existingTabs = (metaRes.data.sheets ?? []).map(s => s.properties?.title ?? '')
    const requiredTabs = ['Accounts', ...results.map(r => r.customerName.slice(0, 100))]

    // Add missing tabs
    const tabsToAdd = requiredTabs.filter(t => !existingTabs.includes(t))
    // Remove stale tabs (not in required set)
    const tabsToDel = existingTabs.filter(t => !requiredTabs.includes(t))

    if (tabsToAdd.length || tabsToDel.length) {
      const sheetMeta = metaRes.data.sheets ?? []
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            ...tabsToAdd.map(title => ({ addSheet: { properties: { title } } })),
            ...tabsToDel.map(title => {
              const sh = sheetMeta.find(s => s.properties?.title === title)
              return sh ? { deleteSheet: { sheetId: sh.properties!.sheetId! } } : null
            }).filter(Boolean) as object[],
          ],
        },
      })
    }

    // Clear all data tabs (keep header rows)
    for (const tab of requiredTabs) {
      await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range: `'${tab}'!A1:ZZ`,
      }).catch(() => {})
    }
  } else {
    // ── First run: create sheet via Drive API with correct parent folder ───────
    const drive = google.drive({ version: 'v3', auth })
    const created = await drive.files.create({
      requestBody: {
        name: `Supportable — ${aeName}`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        ...(driveFolderId ? { parents: [driveFolderId] } : {}),
      },
      supportsAllDrives: true,
      fields: 'id',
    })
    spreadsheetId = created.data.id!
    console.log(`[supportable] created spreadsheet in folder: ${spreadsheetId}`)

    // Add all tabs in one batchUpdate (sheet starts with one default tab)
    const tabTitles = ['Accounts', ...results.map(r => r.customerName.slice(0, 100))]
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          // Rename the default Sheet1 to Accounts
          { updateSheetProperties: { properties: { sheetId: 0, title: 'Accounts' }, fields: 'title' } },
          // Add remaining tabs
          ...tabTitles.slice(1).map(title => ({ addSheet: { properties: { title } } })),
        ],
      },
    })
  }

  // ── Write Accounts summary tab ─────────────────────────────────────────────
  const accountRows: string[][] = [
    ['Account Name', 'Account ID(s)', 'Alias'],
    ...results.map(r => [r.customerName, r.accountNumbers.join(', '), '']),
  ]
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Accounts!A1',
    valueInputOption: 'RAW',
    requestBody: { values: accountRows },
  })
  console.log(`[supportable] wrote Accounts tab (${results.length} customers)`)

  // ── Write per-customer subscription tabs ───────────────────────────────────
  for (const result of results) {
    const tab = result.customerName.slice(0, 100)
    const dataRows: string[][] = [
      CSV_HEADERS,
      ...result.rows.map(row => CSV_HEADERS.map(h => row[h] ?? '')),
    ]
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: dataRows },
    })
    console.log(`[supportable] wrote ${result.rows.length} rows → "${tab}"`)
  }

  return spreadsheetId
}
