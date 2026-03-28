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
 *   5. Set rows per page to All
 *   6. Scrape table rows directly from page (active subscriptions only)
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
  await page.waitForLoadState('networkidle', { timeout: 30_000 })
  await page.waitForTimeout(2_000)
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
      const sel = document.querySelector(`select#${id}`) as HTMLSelectElement | null
      const opt = Array.from(sel?.options ?? []).find(o =>
        o.text.toLowerCase().includes('sales export') || o.text.toLowerCase().includes('sales')
      )
      return opt?.value ?? null
    }, reportSelId)
    if (salesVal) {
      await page.selectOption(`select#${reportSelId}`, salesVal)
      await page.waitForLoadState('networkidle', { timeout: 20_000 })
      await page.waitForTimeout(2_000)
      console.log(`[supportable] selected Sales Export Format report`)
    }
  }

  // ── Actions → Filter → Status = Active ────────────────────────────────────
  const actionsBtn = await page.$('button.a-IRR-button--actions')
  if (actionsBtn) {
    await actionsBtn.click()
    const filterLink = await page.waitForSelector(
      '.a-Menu a:has-text("Filter"), .t-Menu a:has-text("Filter"), [role="menuitem"]:has-text("Filter"), li a:has-text("Filter")',
      { timeout: 5_000 }
    ).catch(() => null)

    if (filterLink) {
      await filterLink.click()
      await page.waitForTimeout(1_500)

      // Find Column select (has "Status" as an option) and set it
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
          await page.selectOption(`select#${colSel.id}`, statusOpt.value)
          await page.waitForTimeout(800)
        }
      }

      // Find operator select (has "=" option) and set it
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
          await page.selectOption(`select#${opSel.id}`, eqOpt.value)
          await page.waitForTimeout(800)
        }
      }

      // Find expression select (has "Active" option) and set it
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
          await page.selectOption(`select#${exprSel.id}`, activeOpt.value)
          await page.waitForTimeout(500)
        }
      }

      // Click Apply
      const applyBtn = await page.$('button:has-text("Apply"), input[value="Apply"]')
      if (applyBtn) {
        await applyBtn.click()
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
        await page.waitForTimeout(2_000)
        console.log(`[supportable] applied Status=Active filter`)
      }
    } else {
      console.warn(`[supportable] Filter menu item not found — proceeding without filter`)
    }
  } else {
    console.warn(`[supportable] Actions button not found — proceeding without filter`)
  }

  // ── Actions → Rows Per Page → All ─────────────────────────────────────────
  const actionsBtn2 = await page.$('button.a-IRR-button--actions')
  if (actionsBtn2) {
    await actionsBtn2.click()
    const rowsPerPageLink = await page.waitForSelector(
      'li a:has-text("Rows Per Page"), [role="menuitem"]:has-text("Rows Per Page"), li:has-text("Rows Per Page") > a',
      { timeout: 5_000 }
    ).catch(() => null)
    if (rowsPerPageLink) {
      await rowsPerPageLink.hover()
      await page.waitForTimeout(800)
      const allLink = await page.waitForSelector(
        'li a:has-text("All"), [role="menuitem"]:has-text("All")',
        { timeout: 3_000 }
      ).catch(() => null)
      if (allLink) {
        await allLink.click()
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
        await page.waitForTimeout(2_000)
        console.log(`[supportable] set rows per page to All`)
      } else {
        console.warn(`[supportable] All submenu item not found`)
      }
    } else {
      // Fallback: use the row select element directly
      const rowSelId = await page.evaluate(() => {
        const sel = document.querySelector('select[id*="_row_select"]') as HTMLSelectElement | null
        return sel?.id ?? null
      })
      if (rowSelId) {
        const allVal = await page.evaluate((id: string) => {
          const sel = document.querySelector(`select#${id}`) as HTMLSelectElement | null
          const opt = Array.from(sel?.options ?? []).find(o => o.text.trim().toLowerCase() === 'all')
          return opt?.value ?? null
        }, rowSelId)
        if (allVal) {
          await page.selectOption(`select#${rowSelId}`, allVal)
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
          await page.waitForTimeout(2_000)
          console.log(`[supportable] set rows per page to All (via select fallback)`)
        }
      }
    }
  }

  // ── Scrape table rows ──────────────────────────────────────────────────────
  // The Sales Report data is a nested table inside the page layout.
  // Identify it by finding the table whose direct <th> children include our key headers.
  const rows = await page.evaluate(() => {
    const REQUIRED = ['Name', 'Status', 'Internal Sku']
    const tables = Array.from(document.querySelectorAll('table'))
    let dataTable: HTMLTableElement | null = null

    for (const t of tables) {
      // Only consider tables where the first row uses <th> elements (not layout tables)
      const firstRowThs = Array.from(t.querySelectorAll('tr:first-child > th'))
        .map(th => th.textContent?.trim() ?? '')
      if (REQUIRED.every(h => firstRowThs.includes(h))) {
        dataTable = t; break
      }
    }
    if (!dataTable) return { error: 'data table not found', tableCount: tables.length }

    const headerCols = Array.from(dataTable.querySelectorAll('tr:first-child > th'))
      .map(th => th.textContent?.trim() ?? '')

    const dataRows = Array.from(dataTable.querySelectorAll('tr')).slice(1).map(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')
      if (!cells.some(c => c)) return null
      const obj: Record<string, string> = {}
      headerCols.forEach((h, i) => { obj[h] = cells[i] ?? '' })
      return obj
    }).filter(Boolean) as Record<string, string>[]

    return { rows: dataRows, headers: headerCols }
  })

  if ('error' in rows) {
    await dumpDom(page, 'scrape-failed')
    throw new Error(`table scrape failed: ${rows.error}`)
  }

  // Filter to active subscriptions only
  const activeRows = rows.rows.filter(r => (r['Status'] ?? '').toLowerCase() === 'active')
  console.log(`[supportable] account ${accountNumber}: ${activeRows.length} active rows (${rows.rows.length} total)`)

  // ── Reset for next account ────────────────────────────────────────────────
  // Navigate back to the landing page so next account starts fresh
  await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1_500)

  return { rows: activeRows, page }
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
