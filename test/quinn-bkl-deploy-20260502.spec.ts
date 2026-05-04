import { test, expect } from '@playwright/test'

// Quinn QA — post-deploy verification 2026-05-02
// BKL-ARCH-02, BKL-ARCH-23, BKL-DOM-INF-05, BKL-HERO-18
// Read-only, runs against prod 7777 via ci project.

const SHOT_DIR = '/tmp/quinn-bkl-deploy-20260502'
const BASE = 'http://localhost:7777'
const CUSTOMER = 'A10 Networks'

test.describe('Post-deploy verification — prod 7777', () => {
  test('L4 gating + brief loads on customer detail page', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message))

    const url = `${BASE}/dashboard/customer/${encodeURIComponent(CUSTOMER)}`
    console.log(`NAVIGATE: ${url}`)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(2000)

    await page.screenshot({ path: `${SHOT_DIR}/01-customer-detail-fullpage.png`, fullPage: true })

    const bodyText = (await page.locator('body').textContent()) || ''

    // ==================== L4 gating (BKL-HERO-18) ====================
    // Cloud Spend (CCSP) section absent
    const cloudSpendHits = (bodyText.match(/Cloud Spend|CCSP|Cloud \$/gi) || []).length
    console.log(`L4_cloud_spend_text_hits: ${cloudSpendHits}`)

    // Open Pipeline section absent
    const openPipelineHits = (bodyText.match(/Open Pipeline/gi) || []).length
    console.log(`L4_open_pipeline_text_hits: ${openPipelineHits}`)

    // Cases section absent
    const casesSidebarHits = (bodyText.match(/Open Cases|Support Cases|Recent Cases/gi) || []).length
    console.log(`L4_cases_section_hits: ${casesSidebarHits}`)

    // Header stat badges (look for badge-like elements with these labels)
    const cloudBadge = await page.locator('[data-testid*="cloud" i], [class*="badge"]').filter({ hasText: /Cloud \$|Cloud Spend/i }).count()
    const pipelineBadge = await page.locator('[data-testid*="pipeline" i], [class*="badge"]').filter({ hasText: /Pipeline/i }).count()
    const casesBadge = await page.locator('[data-testid*="cases" i], [class*="badge"]').filter({ hasText: /Cases/i }).count()
    console.log(`L4_header_badges: cloud=${cloudBadge} pipeline=${pipelineBadge} cases=${casesBadge}`)

    // ==================== Customer name in header ====================
    const headerHasCustomer = bodyText.includes(CUSTOMER)
    console.log(`HEADER_customer_name_present: ${headerHasCustomer ? 'PASS' : 'FAIL'}`)

    const h1Count = await page.locator('h1, h2').filter({ hasText: new RegExp(CUSTOMER, 'i') }).count()
    console.log(`HEADER_heading_with_customer: ${h1Count}`)

    // ==================== Brief section (BKL-ARCH-23) ====================
    // Look for brief-related elements
    const briefHits = (bodyText.match(/Brief|brief generated|Generating brief|No brief/gi) || []).length
    console.log(`BRIEF_text_hits: ${briefHits}`)

    const briefSection = await page.locator('[data-testid*="brief" i], [class*="brief" i]').count()
    console.log(`BRIEF_dom_elements: ${briefSection}`)

    await page.screenshot({ path: `${SHOT_DIR}/02-customer-detail-after-wait.png`, fullPage: true })

    // ==================== Console errors ====================
    console.log(`CONSOLE_ERRORS_count: ${consoleErrors.length}`)
    for (const err of consoleErrors.slice(0, 10)) {
      console.log(`CONSOLE_ERR: ${err.slice(0, 200)}`)
    }

    // Hard assertions for the deploy
    expect(headerHasCustomer, 'Customer name must appear on detail page').toBe(true)
  })
})
