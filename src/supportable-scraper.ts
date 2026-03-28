/**
 * src/supportable-scraper.ts
 *
 * Scrapes subscription entitlement data from the Supportable portal
 * (https://supportable.corp.redhat.com — requires VPN).
 *
 * Flow per account number:
 *   1. Navigate to the APEX app (first account only)
 *   2. If SSO popup appears → wait for user to complete via VNC, then close
 *   3. Fill Account Number input → click Go
 *   4. Click Export tab → Actions dropdown → Download → confirm CSV
 *   5. Parse downloaded CSV
 *   6. Click Reset → ready for next account number
 *
 * All account numbers for a customer are aggregated into a single tab.
 * The final Google Sheet has an "Accounts" summary tab (first) followed
 * by one tab per customer containing their aggregated subscription rows.
 */

import type { BrowserContext, Page } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'

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

// ── CSV parser ────────────────────────────────────────────────────────────────

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      cells.push(current.trim()); current = ''
    } else {
      current += ch
    }
  }
  cells.push(current.trim())
  return cells
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0])
  return lines.slice(1)
    .map(line => {
      const vals = splitCsvLine(line)
      const obj: Record<string, string> = {}
      headers.forEach((h, i) => { obj[h.trim()] = (vals[i] ?? '').trim() })
      return obj
    })
    .filter(row => Object.values(row).some(v => v))
}

// ── DOM explorer (first-run diagnostics) ─────────────────────────────────────

async function dumpDom(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('input, button, a, [role="tab"]'))
        .slice(0, 40)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          type:  (el as HTMLInputElement).type ?? '',
          name:  (el as HTMLInputElement).name ?? '',
          id:    el.id ?? '',
          value: ((el as HTMLInputElement).value ?? '').slice(0, 50),
          text:  (el.textContent ?? '').trim().slice(0, 50),
          cls:   el.className.slice(0, 80),
        }))
      return { url: location.href, title: document.title, els }
    })
    console.log(`[supportable:dom] ${label} — ${info.url}\n` +
      info.els.map(e => `  <${e.tag}> id="${e.id}" name="${e.name}" type="${e.type}" value="${e.value}" text="${e.text}" class="${e.cls}"`).join('\n'))
  } catch (e: any) {
    console.warn(`[supportable:dom] dump failed (${label}): ${e.message}`)
  }
}

// ── Click helper — tries selectors in order, logs which one matched ───────────

async function tryClick(page: Page, label: string, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null)
    if (el && await el.isVisible().catch(() => false)) {
      await el.click()
      console.log(`[supportable] ${label} → "${sel}"`)
      return true
    }
  }
  console.warn(`[supportable] ${label} — no selector matched: ${selectors.join(' | ')}`)
  return false
}

async function tryFill(page: Page, label: string, value: string, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null)
    if (el && await el.isVisible().catch(() => false)) {
      await el.fill(value)
      console.log(`[supportable] ${label} → "${sel}"`)
      return true
    }
  }
  console.warn(`[supportable] ${label} — no selector matched: ${selectors.join(' | ')}`)
  return false
}

// ── Per-account scrape ────────────────────────────────────────────────────────

async function scrapeOneAccount(
  page: Page,
  accountNumber: string,
  isFirst: boolean,
): Promise<Record<string, string>[]> {

  if (isFirst) {
    console.log(`[supportable] navigating to portal…`)
    await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(3_000)
    await dumpDom(page, 'landing')

    // SSO popup — only expected on first-ever login; subsequent runs skip this
    const popup = await page.waitForEvent('popup', { timeout: 8_000 }).catch(() => null)
    if (popup) {
      console.log(`[supportable] SSO popup detected (${popup.url()}) — waiting for user to complete via VNC at :6080`)
      await popup.waitForEvent('close', { timeout: 300_000 }).catch(() => {})
      console.log('[supportable] SSO popup closed — continuing')
      await page.waitForTimeout(2_000)
      await dumpDom(page, 'post-sso')
    } else {
      console.log('[supportable] no SSO popup — session active')
    }
  }

  // ── Fill account number ───────────────────────────────────────────────────
  const filled = await tryFill(page, `fill account# ${accountNumber}`, accountNumber, [
    'input#P1_ACCOUNT_NUMBER',
    'input[name="P1_ACCOUNT_NUMBER"]',
    'input[name*="ACCOUNT_NUM" i]',
    'input[placeholder*="account" i]',
    'td.formlabel + td input[type="text"]',
    'input[type="text"]:first-of-type',
  ])
  if (!filled) {
    await dumpDom(page, 'fill-failed')
    throw new Error(`could not find account number input for ${accountNumber}`)
  }

  // ── Click Go ──────────────────────────────────────────────────────────────
  const wentGo = await tryClick(page, 'Go button', [
    'input[value="Go"]',
    'button:has-text("Go")',
    'input[type="submit"]',
    '#B_GO',
  ])
  if (!wentGo) {
    await dumpDom(page, 'go-failed')
    throw new Error('could not find Go button')
  }

  await page.waitForLoadState('networkidle', { timeout: 30_000 })
  await page.waitForTimeout(2_000)

  if (isFirst) await dumpDom(page, 'after-go')

  // ── Click Export tab ──────────────────────────────────────────────────────
  await tryClick(page, 'Export tab', [
    'a:has-text("Export")',
    '[role="tab"]:has-text("Export")',
    'li:has-text("Export") a',
    'td:has-text("Export") a',
    'span:has-text("Export")',
  ])

  await page.waitForLoadState('networkidle', { timeout: 15_000 })
  await page.waitForTimeout(2_000)

  if (isFirst) await dumpDom(page, 'export-tab')

  // ── Actions dropdown ──────────────────────────────────────────────────────
  await tryClick(page, 'Actions dropdown', [
    'button.t-Button--IR-btn',
    '.t-Button--IR-btn',
    'button[data-menu]',
    'button:has-text("Actions")',
    'a:has-text("Actions")',
  ])

  await page.waitForTimeout(1_000)
  if (isFirst) await dumpDom(page, 'actions-open')

  // ── Download menu item ────────────────────────────────────────────────────
  await tryClick(page, 'Download menu item', [
    '.t-Menu a:has-text("Download")',
    'li:has-text("Download") a',
    'a:has-text("Download")',
    '[data-action="download"]',
  ])

  await page.waitForTimeout(1_500)
  if (isFirst) await dumpDom(page, 'download-dialog')

  // ── Confirm CSV download ──────────────────────────────────────────────────
  console.log(`[supportable] waiting for CSV download (account ${accountNumber})…`)
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    tryClick(page, 'Confirm download button', [
      'button.t-Button--hot:has-text("Download")',
      'button:has-text("Download")',
      'input[value="Download"]',
      '.t-IRR-dialog__buttons button',
    ]).then(clicked => {
      if (!clicked) return page.keyboard.press('Enter')
    }),
  ])

  const downloadPath = await download.path()
  if (!downloadPath) throw new Error('download path was null')

  const csvText = await Bun.file(downloadPath).text()
  const rows = parseCsv(csvText)
  console.log(`[supportable] account ${accountNumber}: ${rows.length} rows`)

  // ── Reset for next account ────────────────────────────────────────────────
  await tryClick(page, 'Reset button', [
    'input[value="Reset"]',
    'button:has-text("Reset")',
    '#B_RESET',
    'input[type="reset"]',
  ])

  await page.waitForLoadState('networkidle', { timeout: 15_000 })
  await page.waitForTimeout(1_500)

  return rows
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

  const page = await _ctx.newPage()
  const results: SupportableResult[] = []
  let isFirst = true

  try {
    for (const customer of customers) {
      const allRows: Record<string, string>[] = []

      for (const accountNumber of customer.accountNumbers) {
        try {
          const rows = await scrapeOneAccount(page, accountNumber, isFirst)
          allRows.push(...rows)
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

// ── Google Sheets writer ──────────────────────────────────────────────────────

// Exact column order from the Supportable CSV export
const CSV_HEADERS = [
  'Name', 'Customer Number', 'Account Number', 'Country',
  'First Name', 'Last Name', 'Login', 'Email', 'Phone Num',
  'Internal Sku', 'Ordered Item', 'Product Description', 'Quantity',
  'Status', 'Start Date', 'End Date', 'Contract#', 'Cust PO Number', 'End Customer PO',
]

/**
 * Creates a new Google Sheet for the AE with:
 *   Tab 1 — "Accounts": Account Name | Account ID(s) | Alias
 *   Tab N — "{Customer Name}": all subscription rows for that customer
 *
 * Returns the spreadsheet ID.
 */
export async function writeSupportableSheet(
  results: SupportableResult[],
  aeName: string,
): Promise<string> {
  const auth   = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })

  // Create the spreadsheet with all tabs in one call
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Supportable — ${aeName}` },
      sheets: [
        { properties: { title: 'Accounts', index: 0 } },
        ...results.map((r, i) => ({
          properties: { title: r.customerName.slice(0, 100), index: i + 1 },
        })),
      ],
    },
  })

  const spreadsheetId = createRes.data.spreadsheetId!
  console.log(`[supportable] created spreadsheet: ${spreadsheetId}`)

  // Write Accounts summary tab
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

  // Write per-customer subscription tabs
  for (const result of results) {
    const tab = result.customerName.slice(0, 100)
    if (!result.rows.length) {
      console.log(`[supportable] ${result.customerName}: no rows — writing headers only`)
    }
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
