import { test, expect, Page } from '@playwright/test'
import * as path from 'path'

// Quinn L3 Hero Mode Audit
// Council audit — find UI elements inappropriate, misleading, or unnecessary
// for L3 hero installs (NODE_ROLE unset; no RH Portal, no Tableau, no CCSP, no Supportable).
// Does NOT trigger any saves or scrapes — read-only DOM scan.

const BASE = process.env.TEST_URL ?? process.env.BASE_URL ?? 'http://localhost:7776'
const SS_DIR = '/tmp'

type Finding = {
  id: string
  page: string
  url: string
  element: string
  text: string
  why: string
  severity: 'P1' | 'P2' | 'P3'
  gate: string
  screenshot?: string
}

const findings: Finding[] = []

function record(f: Finding) {
  findings.push(f)
  console.log(`[FINDING ${f.id}] ${f.severity} ${f.page} :: ${f.element}`)
  console.log(`    text: ${f.text.slice(0, 200)}`)
  console.log(`    why: ${f.why}`)
  console.log(`    gate: ${f.gate}`)
  if (f.screenshot) console.log(`    screenshot: ${f.screenshot}`)
}

async function shot(page: Page, name: string) {
  const p = path.join(SS_DIR, `qa-l3-audit-${name}.png`)
  await page.screenshot({ path: p, fullPage: true })
  return p
}

// Match a regex against full body text and report all matching surrounding contexts.
async function bodyText(page: Page): Promise<string> {
  return (await page.textContent('body')) || ''
}

// @destructive tag routes this spec through the `test` project (port 7776).
// This audit is read-only — no saves, no scrapes — but the test project is the
// correct gate for any spec that targets 7776 and assumes L3 mode.
test.describe('Quinn L3 Hero Mode Audit — full app sweep @destructive', () => {
  // Serial so findings array accumulates across the audit and A5 can summarize.
  test.describe.configure({ mode: 'serial' })
  // Don't abort sibling tests if one fails — we want all pages audited.
  test.describe.configure({ retries: 0 })

  test('A0 — Confirm L3 mode on test container', async ({ request }) => {
    const r = await request.get(`${BASE}/api/node-role`)
    const body = await r.json()
    console.log('node-role:', JSON.stringify(body))
    expect(body.isL3Only, 'Test container must be L3-only for this audit').toBe(true)
  })

  test('A1 — Main dashboard /dashboard audit', async ({ page }) => {
    const consoleErrs: string[] = []
    page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()) })

    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const ss = await shot(page, 'a1-dashboard')

    const text = await bodyText(page)

    // Connection prompts that don't apply to L3
    const rhPortalPrompts = [
      'Connect to RH Portal', 'Connect RH Portal', 'RH Portal not connected',
      'RH session expired', 'Sign in to Red Hat Portal', 'rh-session',
    ]
    for (const phrase of rhPortalPrompts) {
      if (text.toLowerCase().includes(phrase.toLowerCase())) {
        record({
          id: 'BKL-HERO-05',
          page: 'Dashboard',
          url: `${BASE}/dashboard`,
          element: 'Connection prompt / banner',
          text: phrase,
          why: 'L3 hero mode does NOT run RH Portal scraper. Prompting user to connect is misleading — connecting does nothing useful and the connect flow is L4-only.',
          severity: 'P1',
          gate: '!isL3Only',
          screenshot: ss,
        })
        break
      }
    }

    const tableauPrompts = ['Connect Tableau', 'Tableau not connected', 'Tableau session', 'Tableau login']
    for (const phrase of tableauPrompts) {
      if (text.toLowerCase().includes(phrase.toLowerCase())) {
        record({
          id: 'BKL-HERO-06',
          page: 'Dashboard',
          url: `${BASE}/dashboard`,
          element: 'Tableau connection prompt',
          text: phrase,
          why: 'L3 hero mode does not run Tableau scraper.',
          severity: 'P1',
          gate: '!isL3Only',
          screenshot: ss,
        })
        break
      }
    }

    // CCSP / Supportable status callouts
    const ccspIssues = [
      'CCSP not synced', 'CCSP scrape failed', 'CCSP last run', 'Run CCSP',
      'Supportable not connected', 'Supportable scrape',
    ]
    for (const phrase of ccspIssues) {
      if (text.toLowerCase().includes(phrase.toLowerCase())) {
        record({
          id: 'BKL-HERO-07',
          page: 'Dashboard',
          url: `${BASE}/dashboard`,
          element: 'CCSP/Supportable status indicator',
          text: phrase,
          why: 'L3 hero mode does not run CCSP or Supportable scrapers. Status indicators will be permanently red/stale.',
          severity: 'P2',
          gate: '!isL3Only',
          screenshot: ss,
        })
        break
      }
    }

    // SessionHealthPanel — likely shows RH Portal/Tableau session expiry
    const sessionHealth = page.getByText(/session health|session status|connection health/i)
    if (await sessionHealth.count() > 0) {
      const sh = await sessionHealth.first().textContent()
      record({
        id: 'BKL-HERO-08',
        page: 'Dashboard',
        url: `${BASE}/dashboard`,
        element: 'SessionHealthPanel component',
        text: sh?.slice(0, 200) || 'session health panel detected',
        why: 'Session health shows RH Portal + Tableau session age. On L3 these never connect, so panel shows permanent red.',
        severity: 'P2',
        gate: '!isL3Only',
        screenshot: ss,
      })
    }

    // KPI / data panels that depend on L4 scrapers
    const kpiDataChecks = [
      { key: 'cases scraped', label: 'RH Cases KPI' },
      { key: 'pipeline', label: 'Tableau pipeline panel' },
      { key: 'cloud spend', label: 'Cloud Spend (CCSP)' },
      { key: 'subscriptions', label: 'Subscriptions panel' },
    ]
    for (const k of kpiDataChecks) {
      const loc = page.getByText(new RegExp(k.key, 'i'))
      const count = await loc.count()
      if (count > 0) {
        // Check if it shows "—" or "0" as a placeholder
        const sample = await loc.first().textContent()
        console.log(`KPI/Panel '${k.label}' present, sample text: ${sample?.slice(0, 100)}`)
      }
    }

    // CCSP / Cloud Spend panel
    const cloudSpend = page.getByText(/cloud spend/i)
    if (await cloudSpend.count() > 0) {
      record({
        id: 'BKL-HERO-09',
        page: 'Dashboard',
        url: `${BASE}/dashboard`,
        element: 'CloudSpendSection (CCSP-sourced)',
        text: 'Cloud Spend panel rendered',
        why: 'CloudSpend data comes from CCSP scraper which L3 does not run. Panel will be empty or show zeros indefinitely.',
        severity: 'P2',
        gate: 'hasCCSP (or !isL3Only)',
        screenshot: ss,
      })
    }

    console.log('Dashboard console errors:', JSON.stringify(consoleErrs.filter(e => !e.includes('favicon'))))
  })

  test('A2 — Setup wizard /dashboard/setup audit', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/setup`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    const ss = await shot(page, 'a2-setup')

    const text = await bodyText(page)

    // Setup wizard L3 gating — most should already be hidden per BKL-HERO-01
    // Verify Data Sources accordion is hidden, Refresh Timer hidden, Automation hidden
    const dataSources = page.getByText(/Data Sources/i).first()
    const dataSourcesVisible = (await dataSources.count()) > 0 && (await dataSources.isVisible().catch(() => false))
    if (dataSourcesVisible) {
      record({
        id: 'BKL-HERO-10',
        page: 'Setup',
        url: `${BASE}/dashboard/setup`,
        element: 'Data Sources accordion',
        text: 'Data Sources visible on L3',
        why: 'BKL-HERO-01 specifies Data Sources accordion hidden on L3. Verify gate is intact.',
        severity: 'P1',
        gate: '!isL3Only',
        screenshot: ss,
      })
    }

    const refresh = page.getByText(/Refresh Timer|Automation & Limits/i)
    if ((await refresh.count()) > 0) {
      const t = await refresh.first().textContent()
      record({
        id: 'BKL-HERO-11',
        page: 'Setup',
        url: `${BASE}/dashboard/setup`,
        element: 'Refresh Timer / Automation section',
        text: t?.slice(0, 100) || '',
        why: 'BKL-HERO-01 expected these hidden on L3 — automation runs only on primary node.',
        severity: 'P2',
        gate: '!isL3Only',
        screenshot: ss,
      })
    }

    // Step 3 should be HeroStep3Connections on L3 — verify, not full connections accordion
    const step3Heading = page.getByText(/Connections|Red Hat Portal connection|Tableau connection/i)
    const step3Count = await step3Heading.count()
    console.log(`Step 3 heading variants found: ${step3Count}`)
  })

  test('A3 — Admin page /dashboard/admin audit', async ({ page }) => {
    const consoleErrs: string[] = []
    page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text()) })

    await page.goto(`${BASE}/dashboard/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2500)
    const ss = await shot(page, 'a3-admin')

    const text = await bodyText(page)

    // Manual scrape triggers
    const scrapeButtons = [
      { sel: 'button:has-text("Run RH"), button:has-text("Scrape RH"), button:has-text("Run Cases")', label: 'Run RH cases scrape' },
      { sel: 'button:has-text("Run Tableau"), button:has-text("Scrape Tableau")', label: 'Run Tableau scrape' },
      { sel: 'button:has-text("Run CCSP"), button:has-text("Scrape CCSP")', label: 'Run CCSP scrape' },
      { sel: 'button:has-text("Run Supportable"), button:has-text("Scrape Supportable")', label: 'Run Supportable scrape' },
    ]
    for (const sb of scrapeButtons) {
      const loc = page.locator(sb.sel)
      const c = await loc.count()
      if (c > 0) {
        const t = await loc.first().textContent()
        record({
          id: `BKL-HERO-12-${sb.label.replace(/\s+/g, '-').toLowerCase()}`,
          page: 'Admin',
          url: `${BASE}/dashboard/admin`,
          element: `Scrape trigger button: ${sb.label}`,
          text: t || sb.label,
          why: 'Manual scrape trigger for an L4-only scraper. Clicking on L3 either fails or no-ops — irrelevant control.',
          severity: 'P1',
          gate: '!isL3Only',
          screenshot: ss,
        })
      }
    }

    // Scrape history / status sections
    const scrapeStatus = page.getByText(/scrape (status|history|log)|last (scraped|sync)|sync history/i)
    if (await scrapeStatus.count() > 0) {
      const t = await scrapeStatus.first().textContent()
      record({
        id: 'BKL-HERO-13',
        page: 'Admin',
        url: `${BASE}/dashboard/admin`,
        element: 'Scrape history / status section',
        text: t?.slice(0, 200) || '',
        why: 'Will always show stale or never-run for L4 scrapers on L3 hero. Adds noise.',
        severity: 'P2',
        gate: 'show only sources actually used; hide L4-only on L3',
        screenshot: ss,
      })
    }

    // RH session / Tableau session admin controls
    const sessionControls = page.getByText(/RH (session|portal session|cookie)|Tableau (session|cookie|login)/i)
    if (await sessionControls.count() > 0) {
      const t = await sessionControls.first().textContent()
      record({
        id: 'BKL-HERO-14',
        page: 'Admin',
        url: `${BASE}/dashboard/admin`,
        element: 'RH/Tableau session admin controls',
        text: t?.slice(0, 200) || '',
        why: 'L3 hero never holds these sessions; admin controls are dead.',
        severity: 'P2',
        gate: '!isL3Only',
        screenshot: ss,
      })
    }

    // Health indicators
    const healthDots = page.locator('[data-testid*="health"]')
    if (await healthDots.count() > 0) {
      console.log(`Found ${await healthDots.count()} health indicator(s) on Admin`)
    }

    console.log('Admin console errors:', JSON.stringify(consoleErrs.filter(e => !e.includes('favicon'))))
  })

  test('A4 — Customer detail page audit (sample)', async ({ page, request }) => {
    // Find a customer to navigate to
    const aesRes = await request.get(`${BASE}/api/aes`)
    let custId: string | null = null
    if (aesRes.ok()) {
      const aes = await aesRes.json()
      const aeArr = Array.isArray(aes) ? aes : aes.aes || []
      for (const ae of aeArr) {
        const cs = ae.customers || ae.accounts || []
        if (cs.length > 0) {
          custId = cs[0].accountNumber || cs[0].id || cs[0].name
          break
        }
      }
    }
    if (!custId) {
      // Try /api/customers
      const cs = await request.get(`${BASE}/api/customers`).catch(() => null)
      if (cs?.ok()) {
        const arr = await cs.json()
        const list = Array.isArray(arr) ? arr : arr.customers || []
        if (list.length > 0) custId = list[0].accountNumber || list[0].id
      }
    }
    if (!custId) {
      console.log('No customer found to audit detail page — skipping A4 detail navigation')
      return
    }

    const url = `${BASE}/dashboard/customer/${custId}`
    console.log(`Navigating to customer detail: ${url}`)
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null)
    if (!resp || resp.status() >= 400) {
      // Try alternate path
      await page.goto(`${BASE}/dashboard/account/${custId}`, { waitUntil: 'domcontentloaded' }).catch(() => null)
    }
    await page.waitForTimeout(2500)
    const ss = await shot(page, 'a4-customer-detail')

    const text = await bodyText(page)

    // CCSP-sourced sections
    if (/cloud spend|CCSP/i.test(text)) {
      record({
        id: 'BKL-HERO-15',
        page: 'Customer Detail',
        url,
        element: 'Cloud Spend / CCSP section',
        text: 'Cloud Spend section present',
        why: 'CCSP not scraped on L3; section will be empty.',
        severity: 'P2',
        gate: 'hasCCSP (or !isL3Only)',
        screenshot: ss,
      })
    }

    if (/subscriptions|entitlements/i.test(text)) {
      record({
        id: 'BKL-HERO-16',
        page: 'Customer Detail',
        url,
        element: 'Subscriptions section (Supportable-derived)',
        text: 'Subscriptions section present',
        why: 'Subscriptions originally from Supportable; on L3 derived from SF bookings if available, otherwise empty.',
        severity: 'P3',
        gate: 'data-driven: hide if empty rather than show empty state',
        screenshot: ss,
      })
    }

    if (/RH cases|red hat cases|support cases/i.test(text)) {
      // Check if this shows live-scraped vs Drive-cached
      record({
        id: 'BKL-HERO-17',
        page: 'Customer Detail',
        url,
        element: 'RH Cases section',
        text: 'RH Cases section present',
        why: 'RH cases on L3 come from Drive cache only. Verify "Last scraped" / "Run Now" controls are hidden.',
        severity: 'P2',
        gate: '!isL3Only for live-scrape controls',
        screenshot: ss,
      })
    }

    if (/pipeline|tableau/i.test(text)) {
      record({
        id: 'BKL-HERO-18',
        page: 'Customer Detail',
        url,
        element: 'Pipeline (Tableau) section',
        text: 'Pipeline section present',
        why: 'Tableau pipeline data only available on L4. L3 should hide or show "from SF only" variant.',
        severity: 'P2',
        gate: '!isL3Only',
        screenshot: ss,
      })
    }
  })

  test('A5 — Persist findings summary', async () => {
    console.log('\n========================================')
    console.log('QUINN L3 HERO AUDIT — FINDINGS SUMMARY')
    console.log('========================================')
    console.log(`Total findings: ${findings.length}`)
    const byPage: Record<string, Finding[]> = {}
    const bySev: Record<string, number> = { P1: 0, P2: 0, P3: 0 }
    for (const f of findings) {
      byPage[f.page] = byPage[f.page] || []
      byPage[f.page].push(f)
      bySev[f.severity] = (bySev[f.severity] || 0) + 1
    }
    console.log(`By severity: P1=${bySev.P1} P2=${bySev.P2} P3=${bySev.P3}`)
    console.log('\nFull JSON:')
    console.log(JSON.stringify(findings, null, 2))
  })
})
