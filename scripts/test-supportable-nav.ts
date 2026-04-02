/**
 * scripts/test-supportable-nav.ts — End-to-end Supportable scrape test
 * Runs the actual scraper logic locally to verify before deploying to container.
 * VPN required. Usage: bun scripts/test-supportable-nav.ts
 */

import { chromium } from '@playwright/test'
import type { BrowserContext } from '@playwright/test'

// Inline the scraper logic for local testing (bypasses server/context setup)
const SUPPORTABLE_URL = 'https://supportable.corp.redhat.com:4443/pls/rhapplications/f?p=304:1'
const TEST_ACCOUNT = '11823554'

const browser = await chromium.launch({ headless: false, args: ['--ignore-certificate-errors'] })
const ctx = await browser.newContext() as BrowserContext
const page = await ctx.newPage()

// ── Navigate + SSO ────────────────────────────────────────────────────────────
console.log('Navigating…')
await page.goto(SUPPORTABLE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
await page.waitForTimeout(2_000)

if (!page.url().includes('supportable.corp.redhat.com')) {
  console.log('SSO — complete login in browser (up to 3 min)…')
  await page.waitForURL(/supportable\.corp\.redhat\.com/, { timeout: 180_000 }).catch(() => {})
  await page.waitForTimeout(2_000)
}
console.log('On Supportable:', page.url())

// ── Fill + Go ─────────────────────────────────────────────────────────────────
console.log(`Filling account ${TEST_ACCOUNT} → Go…`)
await page.fill('input#P0_ACCOUNT_NUMBER', TEST_ACCOUNT)
await page.click('button.button-alt1')
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
await page.waitForTimeout(2_000)
console.log('Loaded:', page.url())

// ── Click Export tab ──────────────────────────────────────────────────────────
const exportLinks = await page.$$('a:has-text("Export")')
console.log(`Found ${exportLinks.length} Export links — clicking last one`)
await exportLinks[exportLinks.length - 1].click()
await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
await page.waitForTimeout(2_000)
console.log('Export tab:', page.url())

// ── Select Sales Export Format ────────────────────────────────────────────────
const reportSelId = await page.evaluate(() => {
  const sel = document.querySelector('select[id*="_saved_reports"]') as HTMLSelectElement | null
  return sel?.id ?? null
})
console.log('Report selector ID:', reportSelId)
if (reportSelId) {
  const opts = await page.evaluate((id: string) => {
    const sel = document.querySelector(`select#${id}`) as HTMLSelectElement | null
    return Array.from(sel?.options ?? []).map(o => ({ value: o.value, text: o.text.trim() }))
  }, reportSelId)
  console.log('Report options:', opts)
  const salesOpt = opts.find(o => o.text.toLowerCase().includes('sales export') || o.text.toLowerCase().includes('sales'))
  if (salesOpt) {
    console.log(`Selecting: "${salesOpt.text}"`)
    await page.selectOption(`select#${reportSelId}`, salesOpt.value)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(2_000)
  }
}

// ── Actions → Filter → Status = Active ───────────────────────────────────────
console.log('\nOpening Actions menu…')
const actionsBtn = await page.$('button.a-IRR-button--actions')
if (actionsBtn) {
  await actionsBtn.click()
  const filterLink = await page.waitForSelector(
    '.a-Menu a:has-text("Filter"), .t-Menu a:has-text("Filter"), [role="menuitem"]:has-text("Filter"), li a:has-text("Filter")',
    { timeout: 5_000 }
  ).catch(() => null)

  if (filterLink) {
    console.log('Found Filter menu item — clicking…')
    await filterLink.click()
    await page.waitForTimeout(1_500)

    // Dump all visible selects in the filter dialog to find their IDs
    const selects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select'))
        .filter((el: any) => el.offsetParent !== null)
        .map((el: any) => ({
          id: el.id,
          name: el.name,
          value: el.value,
          options: Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
        }))
    )
    console.log('Visible selects in filter dialog:')
    for (const s of selects) {
      console.log(`  select#${s.id} (name="${s.name}") current="${s.value}"`)
      for (const o of s.options) console.log(`    option value="${o.value}" text="${o.text}"`)
    }

    // Set Column = Status
    const colSel = selects.find(s => s.options.some((o: any) => o.text === 'Status' || o.value === 'STATUS'))
    if (colSel) {
      const statusOpt = colSel.options.find((o: any) => o.text === 'Status' || o.text.toLowerCase() === 'status')
      if (statusOpt) {
        console.log(`Setting Column to Status (value="${statusOpt.value}")`)
        await page.selectOption(`select#${colSel.id}`, statusOpt.value)
        await page.waitForTimeout(800)
      }
    } else {
      console.log('Column select not found')
    }

    // Operator: find = select (should already be "=", but set explicitly)
    const updatedSelects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select'))
        .filter((el: any) => el.offsetParent !== null)
        .map((el: any) => ({
          id: el.id,
          options: Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
        }))
    )
    const opSel = updatedSelects.find(s => s.options.some((o: any) => o.text === '=' || o.value === 'eq'))
    if (opSel) {
      const eqOpt = opSel.options.find((o: any) => o.text === '=' || o.value === 'eq')
      if (eqOpt) {
        console.log(`Setting Operator to = (value="${eqOpt.value}")`)
        await page.selectOption(`select#${opSel.id}`, eqOpt.value)
        await page.waitForTimeout(800)
      }
    }

    // Expression: find select with Active option
    const exprSelects = await page.evaluate(() =>
      Array.from(document.querySelectorAll('select'))
        .filter((el: any) => el.offsetParent !== null)
        .map((el: any) => ({
          id: el.id,
          options: Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text.trim() })),
        }))
    )
    const exprSel = exprSelects.find(s => s.options.some((o: any) => o.text.toLowerCase() === 'active'))
    if (exprSel) {
      const activeOpt = exprSel.options.find((o: any) => o.text.toLowerCase() === 'active')
      if (activeOpt) {
        console.log(`Setting Expression to Active (value="${activeOpt.value}")`)
        await page.selectOption(`select#${exprSel.id}`, activeOpt.value)
        await page.waitForTimeout(500)
      }
    } else {
      console.log('Expression select with Active option not found — trying text input')
      // Fallback: type "Active" into expression text field
      const exprInput = await page.$('input[id*="expression"], input[name*="expression"], input[placeholder*="Expression"]')
      if (exprInput) {
        await exprInput.fill('Active')
        console.log('Filled expression input with Active')
      }
    }

    // Click Apply
    const applyBtn = await page.$('button:has-text("Apply"), input[value="Apply"]')
    if (applyBtn) {
      console.log('Clicking Apply…')
      await applyBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      await page.waitForTimeout(2_000)
      console.log('Filter applied. URL:', page.url())
    } else {
      console.log('Apply button not found')
    }
  } else {
    console.log('Filter menu item not found')
  }
} else {
  console.log('Actions button not found')
}

// ── Actions → Rows Per Page → All ─────────────────────────────────────────────
console.log('\nOpening Actions menu for Rows Per Page…')
const actionsBtn2 = await page.$('button.a-IRR-button--actions')
if (actionsBtn2) {
  await actionsBtn2.click()
  // Look for Rows Per Page menu item
  const rowsPerPageLink = await page.waitForSelector(
    'li a:has-text("Rows Per Page"), [role="menuitem"]:has-text("Rows Per Page"), li:has-text("Rows Per Page") > a',
    { timeout: 5_000 }
  ).catch(() => null)
  if (rowsPerPageLink) {
    console.log('Found Rows Per Page menu item — hovering…')
    await rowsPerPageLink.hover()
    await page.waitForTimeout(800)
    // Click "All" in the submenu
    const allLink = await page.waitForSelector(
      'li a:has-text("All"), [role="menuitem"]:has-text("All")',
      { timeout: 3_000 }
    ).catch(() => null)
    if (allLink) {
      console.log('Clicking All…')
      await allLink.click()
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      await page.waitForTimeout(2_000)
      console.log('Rows per page set to All')
    } else {
      console.log('All submenu item not found')
    }
  } else {
    console.log('Rows Per Page menu item not found — falling back to row select')
  }
} else {
  console.log('Actions button 2 not found')
}

// ── Fallback: Set rows per page via select element ────────────────────────────
const rowSelId = await page.evaluate(() => {
  const sel = document.querySelector('select[id*="_row_select"]') as HTMLSelectElement | null
  return sel?.id ?? null
})
console.log('\nRow select ID (fallback):', rowSelId)
if (rowSelId) {
  const allVal = await page.evaluate((id: string) => {
    const sel = document.querySelector(`select#${id}`) as HTMLSelectElement | null
    const opt = Array.from(sel?.options ?? []).find(o => o.text.trim().toLowerCase() === 'all')
    return opt?.value ?? null
  }, rowSelId)
  if (allVal) {
    console.log(`Setting rows per page to All via select (value=${allVal})`)
    await page.selectOption(`select#${rowSelId}`, allVal)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    await page.waitForTimeout(2_000)
  }
}

// ── Scrape table ──────────────────────────────────────────────────────────────
console.log('\nScraping table…')
const result = await page.evaluate(() => {
  const REQUIRED = ['Name', 'Status', 'Internal Sku']
  const tables = Array.from(document.querySelectorAll('table'))
  let dataTable: HTMLTableElement | null = null
  for (const t of tables) {
    const firstRowThs = Array.from(t.querySelectorAll('tr:first-child > th'))
      .map(th => th.textContent?.trim() ?? '')
    if (REQUIRED.every(h => firstRowThs.includes(h))) { dataTable = t; break }
  }
  if (!dataTable) return { error: `no data table found (${tables.length} tables)`, tables: tables.map(t => t.className) }

  const headerCols = Array.from(dataTable.querySelectorAll('tr:first-child > th'))
    .map(th => th.textContent?.trim() ?? '')

  const rows = Array.from(dataTable.querySelectorAll('tr')).slice(1).map(tr => {
    const cells = Array.from(tr.querySelectorAll('td')).map(c => c.textContent?.trim() ?? '')
    if (!cells.some(c => c)) return null
    const obj: Record<string, string> = {}
    headerCols.forEach((h, i) => { obj[h] = cells[i] ?? '' })
    return obj
  }).filter(Boolean) as Record<string, string>[]

  return { headers: headerCols, rows }
})

if ('error' in result) {
  console.log('ERROR:', result.error)
  if ('tables' in result) console.log('Tables found:', result.tables)
} else {
  const active = result.rows.filter((r: any) => r['Status']?.toLowerCase() === 'active')
  console.log(`\n✅ SUCCESS`)
  console.log(`Headers (${result.headers.length}): ${result.headers.join(' | ')}`)
  console.log(`Total rows: ${result.rows.length}`)
  console.log(`Active rows: ${active.length}`)
  if (active.length > 0) {
    console.log(`\nSample active row:`)
    for (const [k, v] of Object.entries(active[0] as any)) {
      console.log(`  ${k}: ${v}`)
    }
  }
}

console.log('\nDone. Closing browser.')
await browser.close()
