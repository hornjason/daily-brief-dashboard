/**
 * src/ccsp-scraper.ts
 *
 * Scrapes Cloud Consumption (CCSP) data from the Tableau dashboard
 * (https://10ay.online.tableau.com — requires Red Hat SSO).
 *
 * Flow per AE:
 *   1. Navigate to the base Cloud Consumption Summary dashboard
 *   2. Apply filters: Super Geo=AMERICAS, Geo=NA_COMM,
 *      Region=NA_COMM_COMMERCIAL, Segment=Commercial,
 *      Year + Quarter = dynamic rolling 1-year window (previous FY + current FY)
 *   3. Apply per-AE Account Territory filter (derived: POD and
 *      Subregion are parsed from the territory string)
 *   4. Navigate to Raw Data tab
 *   5. Download CSV via Tableau's Download button
 *   6. Parse CSV and write to Google Sheet in AE's Drive folder
 *
 * Territory values are stored in aes.json as tableauTerritories[].
 * Example: ["WEST_COMM_CORP_NORTHWEST_TERR01"]
 * POD  = first 4 segments: WEST_COMM_CORP_NORTHWEST
 * Sub  = first 3 segments: WEST_COMM_CORP
 *
 * The shared browser context from Red Hat SSO login is reused so
 * Tableau's SSO passthrough works without re-authentication.
 */

// Base URL — same for all AEs; filters applied programmatically
const TABLEAU_BASE_URL = 'https://10ay.online.tableau.com/#/site/redhatanalytics/views/OverallCloudConsumptionDashboard/CloudConsumptionSummary'

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
  accountPeriod: string   // e.g. "2025-Q1 – 2026-Q4" (dynamic rolling window)
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

// -- Filter helpers -----------------------------------------------------------

/**
 * Rolling 4-quarter window for CCSP Tableau filters.
 *
 * Selects the 4 most recent calendar quarters whose start date has passed,
 * starting from the current quarter and filling backwards.
 *
 * Derives Red Hat fiscal years from those quarters:
 *   Q1 (Jan-Mar) spans FY boundary: Jan-Feb = FY(Y), March = FY(Y+1) → both
 *   Q2-Q4 (Apr-Dec) are fully in FY(Y+1)
 *
 * Example (today = March 29, 2026):
 *   quarters = ['2026-Q1', '2025-Q4', '2025-Q3', '2025-Q2']
 *   years    = ['FY2026', 'FY2027']
 */
export function getRollingFyWindow(): { years: string[]; quarters: string[]; label: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-12

  // Calendar quarter (1-4) based on month
  const currentCalQ = Math.ceil(month / 3)

  // Build 4 quarters rolling backwards from current calendar quarter
  const quarters: string[] = []
  let q = currentCalQ
  let y = year
  for (let i = 0; i < 4; i++) {
    quarters.push(`${y}-Q${q}`)
    q--
    if (q === 0) { q = 4; y-- }
  }

  // Derive RH fiscal years that cover these quarters
  // Q1 (Jan-Mar) spans FY boundary: Jan-Feb = FY(Y), March = FY(Y+1) → include both
  // Q2-Q4 (Apr-Dec) are fully in FY(Y+1)
  const fySet = new Set<string>()
  for (const qtr of quarters) {
    const [qYear, qPart] = qtr.split('-')
    const qy = parseInt(qYear)
    const qNum = parseInt(qPart[1])
    if (qNum === 1) {
      fySet.add(`FY${qy}`)
      fySet.add(`FY${qy + 1}`)
    } else {
      fySet.add(`FY${qy + 1}`)
    }
  }
  const years = [...fySet].sort()

  const label = `${quarters[quarters.length - 1]} – ${quarters[0]}`
  console.log(`[ccsp] rolling 4-quarter window: years=[${years.join(', ')}] quarters=[${quarters.join(', ')}] label="${label}"`)
  return { years, quarters, label }
}

/**
 * Derive POD and Subregion from a territory string.
 * "WEST_COMM_CORP_NORTHWEST_TERR01" → pod="WEST_COMM_CORP_NORTHWEST", sub="WEST_COMM_CORP"
 */
function parseTerritoryParts(territory: string): { pod: string; subregion: string } {
  const parts = territory.split('_')
  // Territory format: REGION_SEG_TYPE_POD_TERR##
  // POD = everything except the last segment (TERR##)
  // Subregion = first 3 segments (REGION_SEG_TYPE)
  const pod = parts.slice(0, -1).join('_')
  const subregion = parts.slice(0, 3).join('_')
  return { pod, subregion }
}

/**
 * Apply a single Tableau filter dropdown.
 * Clicks the dropdown, deselects All, selects the target values, clicks Apply.
 */
async function applyFilter(
  page: Page,
  label: string,
  values: string[],
  aeName: string,
): Promise<void> {
  // Tableau filter dropdowns are identified by their label text
  const trigger = await page.$(`[aria-label="${label}"], select[title*="${label}"]`)
  if (!trigger) {
    // Try finding by nearby text
    const byText = await page.$(`text="${label}"`)
    if (!byText) {
      // Filter not found = dashboard has changed or filters aren't loaded yet.
      // Throw so the caller aborts instead of continuing with wrong/unfiltered data.
      throw new Error(`filter "${label}" not found on Tableau dashboard — dashboard may have changed`)
    }
    // Click the parent dropdown
    const parent = await byText.$('xpath=ancestor::div[contains(@class,"filter") or contains(@class,"dropdown")][1]')
    if (!parent) {
      throw new Error(`filter "${label}" found by text but parent dropdown container not found`)
    }
    await parent.click()
  } else {
    await trigger.click()
  }
  await page.waitForTimeout(800)

  // Deselect (All) first if checked
  const allOption = await page.$('text="(All)"')
  if (allOption) {
    const checkbox = await allOption.$('xpath=preceding-sibling::input[@type="checkbox"] | ancestor::label/input')
    const checked = await checkbox?.isChecked()
    if (checked) await allOption.click()
    await page.waitForTimeout(300)
  }

  // Select each target value
  for (const val of values) {
    const opt = await page.$(`text="${val}"`)
    if (opt) {
      await opt.click()
      await page.waitForTimeout(300)
    } else {
      console.warn(`[ccsp] ${aeName}: filter option "${val}" not found in "${label}"`)
    }
  }

  // Click Apply
  const applyBtn = await page.$('button:has-text("Apply"), input[value="Apply"]')
  if (applyBtn) await applyBtn.click()
  await page.waitForTimeout(1_500)
}

// -- Per-AE scrape ------------------------------------------------------------

async function scrapeOneAe(page: Page, ae: AE): Promise<CcspResult> {
  const territories = ae.tableauTerritories ?? []
  console.log(`[ccsp] ${ae.name}: navigating to base Tableau dashboard...`)

  await page.goto(TABLEAU_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {
    console.warn(`[ccsp] ${ae.name}: networkidle timed out — continuing anyway`)
  })
  await page.waitForTimeout(5_000)

  // Detect login wall — Tableau redirects to SSO/login when session is invalid
  const currentUrl = page.url()
  const isLoginPage = !currentUrl.includes('10ay.online.tableau.com') ||
    currentUrl.includes('/auth') || currentUrl.includes('/login') ||
    await page.$('input[type="password"], #username, [data-testid="login"]').then(el => !!el).catch(() => false)
  if (isLoginPage) {
    console.warn(`[ccsp] ${ae.name}: Tableau session not active (on login page: ${currentUrl}) — skipping scrape`)
    throw new Error('Tableau session required — log in via the VNC window and retry')
  }

  console.log(`[ccsp] ${ae.name}: page loaded, applying filters...`)
  await dumpDom(page, `${ae.name}-loaded`)

  // -- Calculate rolling 1-year window (dynamic — never stale) ----------------
  const { years, quarters, label } = getRollingFyWindow()

  // -- Apply global filters ---------------------------------------------------
  await applyFilter(page, 'Super Geo', ['AMERICAS'], ae.name)
  await applyFilter(page, 'Geo', ['NA_COMM'], ae.name)
  await applyFilter(page, 'Region', ['NA_COMM_COMMERCIAL'], ae.name)
  await applyFilter(page, 'Segment', ['Commercial'], ae.name)
  await applyFilter(page, 'Year', years, ae.name)
  await applyFilter(page, 'Quarter', quarters, ae.name)

  // -- Apply per-AE filters derived from territories --------------------------
  if (territories.length > 0) {
    const { pod, subregion } = parseTerritoryParts(territories[0])
    await applyFilter(page, 'Subregion', [subregion], ae.name)
    await applyFilter(page, 'POD', [pod], ae.name)
    await applyFilter(page, 'Account Territory', territories, ae.name)
  }

  // -- Navigate to Raw Data tab -----------------------------------------------
  await page.waitForTimeout(2_000)
  const rawDataTab = await page.$('text="Raw Data"')
  if (rawDataTab) {
    console.log(`[ccsp] ${ae.name}: clicking Raw Data tab`)
    await rawDataTab.click()
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(3_000)
  } else {
    console.warn(`[ccsp] ${ae.name}: Raw Data tab not found — attempting download from current view`)
  }

  // -- Download CSV -----------------------------------------------------------
  let csvText: string | null = null

  try {
    const downloadBtn = await page.$(
      'button[aria-label*="Download"], button[title*="Download"], ' +
      'button:has-text("Download"), [data-tb-test-id="download-ToolbarButton"]'
    )

    if (downloadBtn) {
      console.log(`[ccsp] ${ae.name}: clicking Download button`)
      await downloadBtn.click()
      await page.waitForTimeout(2_000)

      const dataOption = await page.$(
        'button:has-text("Data"), button:has-text("Crosstab"), ' +
        '[data-tb-test-id*="data"], [data-tb-test-id*="crosstab"]'
      )
      if (dataOption) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          dataOption.click(),
        ])
        const readStream = await download.createReadStream()
        if (readStream) {
          csvText = await streamToText(readStream)
          console.log(`[ccsp] ${ae.name}: downloaded ${csvText.length} bytes`)
        }
      } else {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15_000 }),
          Promise.resolve(),
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
    console.warn(`[ccsp] ${ae.name}: download failed: ${e.message}`)
  }

  // If we got CSV text, parse it
  if (csvText) {
    const rows = parseCsv(csvText)
    console.log(`[ccsp] ${ae.name}: parsed ${rows.length} rows from CSV`)
    return { aeName: ae.name, rows, accountPeriod: label }
  }

  // If all strategies fail, return empty with warning
  await dumpDom(page, `${ae.name}-no-data`)
  console.warn(`[ccsp] ${ae.name}: could not extract data — returning empty result`)
  return { aeName: ae.name, rows: [], accountPeriod: label }
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
      if (!ae.tableauTerritories?.length) {
        console.warn(`[ccsp] ${ae.name}: no tableauTerritories configured — skipping`)
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
        results.push({ aeName: ae.name, rows: [], accountPeriod: getRollingFyWindow().label })
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

    // Rename "Sheet1" → "CCSP Data" immediately so all subsequent writes use the correct name
    const meta0 = await sheets.spreadsheets.get({ spreadsheetId })
    const firstSheet0 = meta0.data.sheets?.[0]
    if (firstSheet0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ updateSheetProperties: {
            properties: { sheetId: firstSheet0.properties!.sheetId, title: 'CCSP Data' },
            fields: 'title',
          }}],
        },
      })
    }
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

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'CCSP Data'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: sheetData },
  })
  console.log(`[ccsp] ${aeName}: wrote ${allRows.length} rows (${headers.length} columns) to CCSP Data tab`)

  return spreadsheetId
}
