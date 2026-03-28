/**
 * src/ccsp-scraper.ts
 *
 * Scrapes Cloud Consumption (CCSP) data from the Tableau dashboard
 * (https://10ay.online.tableau.com — requires Red Hat SSO).
 *
 * Flow per AE:
 *   1. Navigate to the AE's saved Tableau custom view URL
 *   2. Wait for Tableau viz to render and data to load
 *   3. Set date range filter to cover 2025 Q1 -> 2026 Q1 if needed
 *   4. Download raw data via Tableau's Download button
 *   5. Parse CSV and write to Google Sheet in AE's Drive folder
 *
 * The shared browser context from Red Hat SSO login is reused so
 * Tableau's SSO passthrough works without re-authentication.
 */

import type { BrowserContext, Page } from '@playwright/test'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { AE } from './types.ts'

// -- Module state -------------------------------------------------------------

export let lastCcspScrape: string | null = null
export let lastCcspError:  string | null = null
export let ccspScrapeRunning = false

let _ctx: BrowserContext | null = null

export function adoptCcspContext(ctx: BrowserContext): void {
  _ctx = ctx
  console.log('[ccsp] adopted shared browser context')
}

// -- Result type --------------------------------------------------------------

export interface CcspResult {
  aeName:       string
  rows:         Record<string, string>[]
  accountPeriod: string   // e.g. "2025 Q1 - 2026 Q1"
}

// -- Helpers ------------------------------------------------------------------

/** Convert a ReadableStream to string */
async function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

/** Parse CSV text into array of header-keyed objects */
function parseCsv(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split('\n')
  if (lines.length < 2) return []

  // Handle quoted CSV fields properly
  const parseRow = (line: string): string[] => {
    const fields: string[] = []
    let current = ''
    let inQuote = false

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuote) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"'
          i++ // skip escaped quote
        } else if (ch === '"') {
          inQuote = false
        } else {
          current += ch
        }
      } else {
        if (ch === '"') {
          inQuote = true
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

  const headers = parseRow(lines[0])
  return lines.slice(1).map(line => {
    const values = parseRow(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = values[i] ?? '' })
    return obj
  }).filter(row => Object.values(row).some(v => v !== ''))
}

/** Dump DOM info for debugging Tableau page state */
async function dumpDom(page: Page, label: string): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('button, a, [role="button"], iframe, [class*="download"], [class*="toolbar"]'))
        .slice(0, 40)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          id:    el.id ?? '',
          title: el.getAttribute('title') ?? '',
          text:  (el.textContent ?? '').trim().slice(0, 60),
          cls:   el.className.toString().slice(0, 80),
        }))
      return { url: location.href, els }
    })
    console.log(`[ccsp:dom] ${label} -- ${info.url}\n` +
      info.els.map(e => `  <${e.tag}> id="${e.id}" title="${e.title}" text="${e.text}" class="${e.cls}"`).join('\n'))
  } catch (e: any) {
    console.warn(`[ccsp:dom] dump failed (${label}): ${e.message}`)
  }
}

// -- Per-AE scrape ------------------------------------------------------------

async function scrapeOneAe(page: Page, ae: AE): Promise<CcspResult> {
  const url = ae.tableauUrl!
  console.log(`[ccsp] ${ae.name}: navigating to Tableau dashboard...`)

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  // Tableau takes a while to render its viz — wait for network to settle
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
    console.warn(`[ccsp] ${ae.name}: networkidle timed out — continuing anyway`)
  })
  await page.waitForTimeout(5_000)

  console.log(`[ccsp] ${ae.name}: page loaded at ${page.url()}`)
  await dumpDom(page, `${ae.name}-loaded`)

  // -- Attempt download via Tableau toolbar -----------------------------------
  // Strategy 1: Use Tableau's Download button with download interception
  let csvText: string | null = null

  try {
    // Look for Tableau toolbar download button
    const downloadBtn = await page.$(
      'button[aria-label*="Download"], button[title*="Download"], ' +
      'button:has-text("Download"), [data-tb-test-id="download-ToolbarButton"]'
    )

    if (downloadBtn) {
      console.log(`[ccsp] ${ae.name}: found Download button — clicking`)
      await downloadBtn.click()
      await page.waitForTimeout(2_000)

      // Tableau opens a download dialog — look for "Data" or "Crosstab" option
      const dataOption = await page.$(
        'button:has-text("Data"), button:has-text("Crosstab"), ' +
        '[data-tb-test-id*="data"], [data-tb-test-id*="crosstab"]'
      )
      if (dataOption) {
        console.log(`[ccsp] ${ae.name}: found Data option in download dialog`)
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          dataOption.click(),
        ])
        const readStream = await download.createReadStream()
        if (readStream) {
          csvText = await streamToText(readStream)
          console.log(`[ccsp] ${ae.name}: downloaded ${csvText.length} bytes via download button`)
        }
      } else {
        // Direct download without sub-menu
        console.log(`[ccsp] ${ae.name}: attempting direct download interception`)
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15_000 }),
          Promise.resolve(), // button already clicked
        ]).catch(() => [null])

        if (download) {
          const readStream = await (download as any).createReadStream()
          if (readStream) {
            csvText = await streamToText(readStream)
            console.log(`[ccsp] ${ae.name}: downloaded ${csvText.length} bytes (direct)`)
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[ccsp] ${ae.name}: download button approach failed: ${e.message}`)
  }

  // Strategy 2: Try extracting from data table/frame at bottom of Tableau view
  if (!csvText) {
    console.log(`[ccsp] ${ae.name}: falling back to DOM table extraction`)
    try {
      // Tableau sometimes shows data in an iframe or summary table
      const frames = page.frames()
      let dataRows: Record<string, string>[] = []

      for (const frame of frames) {
        const rows = await frame.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table'))
          // Find the largest table with actual data
          let best: HTMLTableElement | null = null
          let bestRows = 0
          for (const t of tables) {
            const rowCount = t.querySelectorAll('tr').length
            if (rowCount > bestRows) { best = t; bestRows = rowCount }
          }
          if (!best || bestRows < 2) return null

          const headerCols = Array.from(best.querySelectorAll('tr:first-child > th, tr:first-child > td'))
            .map(th => th.textContent?.trim() ?? '')
          if (!headerCols.length || headerCols.every(h => !h)) return null

          const dataRows = Array.from(best.querySelectorAll('tr')).slice(1).map(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')
            if (!cells.some(c => c)) return null
            const obj: Record<string, string> = {}
            headerCols.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return obj
          }).filter(Boolean) as Record<string, string>[]

          return dataRows.length > 0 ? dataRows : null
        }).catch(() => null)

        if (rows && rows.length > 0) {
          dataRows = rows
          console.log(`[ccsp] ${ae.name}: extracted ${dataRows.length} rows from frame table`)
          break
        }
      }

      // Also check the main page
      if (dataRows.length === 0) {
        const mainRows = await page.evaluate(() => {
          const tables = Array.from(document.querySelectorAll('table'))
          let best: HTMLTableElement | null = null
          let bestRows = 0
          for (const t of tables) {
            const rowCount = t.querySelectorAll('tr').length
            if (rowCount > bestRows) { best = t; bestRows = rowCount }
          }
          if (!best || bestRows < 2) return null

          const headerCols = Array.from(best.querySelectorAll('tr:first-child > th, tr:first-child > td'))
            .map(th => th.textContent?.trim() ?? '')
          if (!headerCols.length || headerCols.every(h => !h)) return null

          return Array.from(best.querySelectorAll('tr')).slice(1).map(tr => {
            const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')
            if (!cells.some(c => c)) return null
            const obj: Record<string, string> = {}
            headerCols.forEach((h, i) => { obj[h] = cells[i] ?? '' })
            return obj
          }).filter(Boolean) as Record<string, string>[]
        })

        if (mainRows && mainRows.length > 0) {
          dataRows = mainRows
          console.log(`[ccsp] ${ae.name}: extracted ${dataRows.length} rows from main page table`)
        }
      }

      if (dataRows.length > 0) {
        return { aeName: ae.name, rows: dataRows, accountPeriod: '2025 Q1 - 2026 Q1' }
      }
    } catch (e: any) {
      console.warn(`[ccsp] ${ae.name}: DOM extraction fallback failed: ${e.message}`)
    }
  }

  // Strategy 3: If we got CSV text, parse it
  if (csvText) {
    const rows = parseCsv(csvText)
    console.log(`[ccsp] ${ae.name}: parsed ${rows.length} rows from CSV`)
    return { aeName: ae.name, rows, accountPeriod: '2025 Q1 - 2026 Q1' }
  }

  // If all strategies fail, return empty with warning
  await dumpDom(page, `${ae.name}-no-data`)
  console.warn(`[ccsp] ${ae.name}: could not extract data — returning empty result`)
  return { aeName: ae.name, rows: [], accountPeriod: '2025 Q1 - 2026 Q1' }
}

// -- Public scrape entry point ------------------------------------------------

export async function runCcspScrape(aes: AE[]): Promise<CcspResult[]> {
  if (ccspScrapeRunning) throw new Error('CCSP scrape already in progress')
  if (!_ctx) throw new Error('No browser context — connect Red Hat Portal first')

  ccspScrapeRunning = true
  lastCcspError = null

  const results: CcspResult[] = []

  try {
    for (const ae of aes) {
      if (!ae.tableauUrl) {
        console.warn(`[ccsp] ${ae.name}: no tableauUrl configured — skipping`)
        continue
      }
      if (!ae.driveFolderId) {
        console.warn(`[ccsp] ${ae.name}: no driveFolderId configured — skipping`)
        continue
      }

      const page = await _ctx!.newPage()
      try {
        const result = await scrapeOneAe(page, ae)
        results.push(result)
      } catch (e: any) {
        console.warn(`[ccsp] ${ae.name}: scrape failed: ${e.message}`)
        results.push({ aeName: ae.name, rows: [], accountPeriod: '2025 Q1 - 2026 Q1' })
      } finally {
        await page.close().catch(() => {})
      }
    }

    lastCcspScrape = new Date().toISOString()
    return results

  } catch (e: any) {
    lastCcspError = e.message
    throw e
  } finally {
    ccspScrapeRunning = false
  }
}

// -- Google Sheets writer -----------------------------------------------------

/**
 * Creates or updates a Google Sheet named "[AE Name] CCSP" in the AE's
 * Drive folder. If existingSheetId is provided, clears and rewrites it.
 * Returns the spreadsheet ID.
 */
export async function writeCcspSheet(
  results: CcspResult[],
  aeName: string,
  driveFolderId: string,
  existingSheetId?: string,
): Promise<string> {
  const auth   = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const sheets = google.sheets({ version: 'v4', auth })
  const drive  = google.drive({ version: 'v3', auth })

  let spreadsheetId: string

  if (existingSheetId) {
    // Clear existing sheet and rewrite
    spreadsheetId = existingSheetId
    console.log(`[ccsp] reusing existing sheet: ${spreadsheetId}`)

    // Get existing sheet tabs so we can clear them
    const meta = await sheets.spreadsheets.get({ spreadsheetId })
    const existingSheets = meta.data.sheets ?? []

    // Delete all tabs except the first, then rename/clear the first
    const requests: any[] = []
    for (let i = existingSheets.length - 1; i > 0; i--) {
      requests.push({ deleteSheet: { sheetId: existingSheets[i].properties!.sheetId } })
    }
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
    }

    // Clear the first sheet
    const firstTab = existingSheets[0]?.properties?.title ?? 'Sheet1'
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `'${firstTab}'!A:ZZ`,
    })

    // Rename first sheet to "CCSP Data"
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: existingSheets[0].properties!.sheetId, title: 'CCSP Data' },
            fields: 'title',
          },
        }],
      },
    })
  } else {
    // Create new spreadsheet in AE's Drive folder
    const created = await drive.files.create({
      requestBody: {
        name: `${aeName} CCSP`,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [driveFolderId],
      },
      supportsAllDrives: true,
      fields: 'id',
    })
    spreadsheetId = created.data.id!
    console.log(`[ccsp] created spreadsheet: ${spreadsheetId} in folder ${driveFolderId}`)
  }

  // Combine all results into a single data set
  const allRows = results.flatMap(r => r.rows)

  if (allRows.length === 0) {
    // Write a placeholder so the sheet isn't empty
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'CCSP Data!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [['No CCSP data available', '', `Scraped: ${new Date().toISOString()}`]] },
    })
    console.log(`[ccsp] ${aeName}: no data — wrote placeholder`)
    return spreadsheetId
  }

  // Collect all unique headers across all rows
  const headerSet = new Set<string>()
  for (const row of allRows) {
    for (const key of Object.keys(row)) {
      headerSet.add(key)
    }
  }
  const headers = Array.from(headerSet)

  // Build sheet data: headers + rows
  const sheetData: string[][] = [
    headers,
    ...allRows.map(row => headers.map(h => row[h] ?? '')),
  ]

  // Rename first sheet to "CCSP Data" if creating new (drive.files.create gives "Sheet1")
  if (!existingSheetId) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId })
    const firstSheet = meta.data.sheets?.[0]
    if (firstSheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            updateSheetProperties: {
              properties: { sheetId: firstSheet.properties!.sheetId, title: 'CCSP Data' },
              fields: 'title',
            },
          }],
        },
      })
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'CCSP Data'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: sheetData },
  })
  console.log(`[ccsp] ${aeName}: wrote ${allRows.length} rows (${headers.length} columns) to CCSP Data tab`)

  return spreadsheetId
}
