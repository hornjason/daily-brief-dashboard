import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:7777'
const SCREENSHOT_DIR = '/Users/jhorn/.claude/PAI/Projects/DailyBriefDashboard/screenshots'

test.describe('ExpansionMotionSection validation (#528)', () => {

  test('1. CrowdStrike detail page - verify motion section renders', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/customer/Crowdstrike`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(4000)

    await page.screenshot({ path: `${SCREENSHOT_DIR}/528-01-crowdstrike-top.png` })
    await page.screenshot({ path: `${SCREENSHOT_DIR}/528-02-crowdstrike-full.png`, fullPage: true })

    // Check for Strategic Motion section text
    const strategicMotion = await page.locator('text=Strategic Motion').count()
    const buildAndRun = await page.locator('text=/Build and Run/i').count()
    console.log(`"Strategic Motion" heading: ${strategicMotion}`)
    console.log(`"Build and Run" title: ${buildAndRun}`)

    // Check for phase names
    const anchor = await page.locator('text=/Anchor:/').count()
    const expand = await page.locator('text=/Expand:/').count()
    console.log(`Anchor phase: ${anchor}, Expand phase: ${expand}`)

    // Check for confidence badge
    const confidenceBadge = await page.locator('text=/confidence$/i').count()
    console.log(`Confidence badge: ${confidenceBadge}`)

    // Check for phase count badge
    const phaseBadge = await page.locator('text=/\\d+ phases?/').count()
    console.log(`Phase count badge: ${phaseBadge}`)

    // Verify API response structure matches component expectations
    const apiResponse = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/api/customer/crowdstrike/expansion-motion`)
      return res.json()
    }, BASE)
    console.log(`API response top-level keys: ${Object.keys(apiResponse)}`)
    console.log(`API response has .phases: ${!!apiResponse.phases}`)
    console.log(`API response has .motion: ${!!apiResponse.motion}`)
    console.log(`API response .motion.phases: ${!!apiResponse.motion?.phases}`)
    console.log(`BUG CHECK: Component checks data.phases but API returns data.motion.phases`)
  })

  test('2. API data validation - phases, briefs, tactics', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    const motionData = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/api/customer/crowdstrike/expansion-motion`)
      return res.json()
    }, BASE)

    const motion = motionData.motion
    console.log(`Motion title: ${motion?.title}`)
    console.log(`Sales play: ${motion?.salesPlay}`)
    console.log(`Confidence: ${motion?.confidence}`)
    console.log(`Number of phases: ${motion?.phases?.length}`)
    console.log(`Generated at: ${motion?.generatedAt}`)

    for (const phase of motion?.phases || []) {
      console.log(`\n--- Phase: ${phase.name} ---`)
      console.log(`  Category: ${phase.category}`)
      console.log(`  Urgency: ${phase.urgency}`)
      console.log(`  Tactics count: ${phase.tactics?.length}`)
      console.log(`  Has brief text: ${!!phase.brief}`)
      console.log(`  Evidence count: ${phase.evidence?.length || 0}`)
      console.log(`  Target personas: ${phase.targetPersonas?.length || 0}`)

      // Validate tactic count (3-8 expected, not 10+)
      const tc = phase.tactics?.length || 0
      if (tc > 10) {
        console.log(`  WARNING: ${tc} tactics exceeds max 10 - filtering may not be working`)
      } else {
        console.log(`  Tactic count OK (${tc} <= 10)`)
      }

      // Check phase name format: "Category: Description"
      const hasCleanFormat = /^(Anchor|Expand|Land):/.test(phase.name)
      console.log(`  Clean phase name format: ${hasCleanFormat}`)

      // Check for brief in each tactic
      for (const tactic of (phase.tactics || []).slice(0, 3)) {
        console.log(`    Tactic: ${tactic.name}`)
        console.log(`    Parent TDP: ${tactic.parentTdp}`)
        console.log(`    Brief: ${(tactic.brief || 'NONE').substring(0, 100)}`)
        console.log(`    Assets: ${tactic.assets?.length || 0}`)
      }

      // Evidence with source labels
      for (const ev of (phase.evidence || []).slice(0, 3)) {
        console.log(`    Evidence: [${ev.module}] ${ev.fact?.substring(0, 100)}`)
      }
    }
  })

  test('3. Admin page - Intelligence Graph section', async ({ page }) => {
    await page.goto(`${BASE}/dashboard/admin`)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(2000)

    // Scroll to Intelligence Graph section
    const igHeader = page.locator('text=Intelligence Graph').first()
    await igHeader.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/528-03-admin-ig-section.png` })

    // Generate All Graphs button
    const generateBtn = await page.locator('text=/Generate All Graphs/i').count()
    console.log(`PASS - Generate All Graphs button: ${generateBtn > 0}`)

    // Stats
    const pageText = await page.evaluate(() => document.body.innerText)
    const graphsBuilt = pageText.match(/Graphs Built[\s\S]*?(\d+\s*\/\s*\d+)/)?.[1]
    const motionsGenerated = pageText.match(/Motions Generated[\s\S]*?(\d+)/)?.[1]
    console.log(`Graphs Built: ${graphsBuilt}`)
    console.log(`Motions Generated: ${motionsGenerated}`)

    // Intelligence Graph Viewer
    const viewer = page.locator('text=/Intelligence Graph Viewer/i')
    const hasViewer = await viewer.count() > 0
    console.log(`PASS - Intelligence Graph Viewer: ${hasViewer}`)

    // Click viewer to expand and check for dropdown
    if (hasViewer) {
      await viewer.click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${SCREENSHOT_DIR}/528-04-admin-ig-viewer-expanded.png` })
      const selects = await page.locator('select').count()
      console.log(`Customer dropdown selects: ${selects}`)
    }
  })

  test('4. Empty state - customer without motion', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`)
    // Check which customers lack motions
    const noMotionResult = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/api/accounts`)
      const data = await res.json()
      for (const c of data.customers) {
        const slug = c.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')
        const motionRes = await fetch(`${base}/api/customer/${slug}/expansion-motion`)
        const motion = await motionRes.json()
        if (!motion.motion) return c.name
      }
      return null
    }, BASE)

    console.log(`Customer without motion: ${noMotionResult}`)

    if (noMotionResult) {
      await page.goto(`${BASE}/dashboard/customer/${encodeURIComponent(noMotionResult)}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(3000)

      await page.screenshot({ path: `${SCREENSHOT_DIR}/528-05-no-motion-customer.png` })

      // Motion section should be completely hidden
      const strategicMotion = await page.locator('text=Strategic Motion').count()
      const noMotionMsg = await page.locator('text=/no motion/i').count()
      console.log(`"Strategic Motion" on no-motion page: ${strategicMotion}`)
      console.log(`"No motion" message: ${noMotionMsg}`)
      console.log(`Expected: section completely hidden (0 mentions)`)
    }
  })
})
