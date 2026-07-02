#!/usr/bin/env bun
/**
 * scripts/phase0-search-probe.ts — Phase 0 dry run: search Seismic API by document name
 *
 * Tests the Search API with a sample of document names from different sections
 * to validate: (1) can we find docs by name, (2) do we get usable URLs back.
 *
 * Requires: Mac Mini with active SalesHub auth (session-state.json).
 * Usage: bun scripts/phase0-search-probe.ts
 *
 * This is a READ-ONLY probe — no downloads, no file writes beyond the report.
 */

import { chromium } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const SALESHUB_URL = 'https://saleshub.redhat.com'
const PROFILE_DIR = process.env.RH_PROFILE_DIR ?? '/data/rh-profile'
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium-browser'

const BASE_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
]

// ── Test samples: one or two items from each gap category ──────────────────
// Priority 1: Page-visible items we can't currently get
const TEST_SAMPLES = [
  // Carousel thumbnails (no URL at all)
  { name: 'Pitch Deck - Red Hat Ansible Automation', section: 'business-decks', reason: 'carousel' },
  { name: 'Ansible by the Numbers', section: 'business-decks', reason: 'carousel' },
  // Viewer items (has URL but no Download button)
  { name: 'AAP 2.6 one-slide overview', section: 'product-news', reason: 'viewer-no-download' },
  { name: 'Ansible Lightspeed customer deck', section: 'product-news', reason: 'viewer-no-download' },
  { name: 'The Wave report', section: 'product-news', reason: 'viewer-no-download' },
  // Not in DOM
  { name: 'AAP 2.6 release overview + reference guide', section: 'overview', reason: 'not-in-dom' },
  // Technical resources (architecture diagrams, no link)
  { name: 'Red Hat Architecture - Event Driven Automation', section: 'technical-resources', reason: 'no-link' },
  { name: 'Red Hat Architecture - Self-Healing Infrastructure', section: 'technical-resources', reason: 'no-link' },
  // Domain docs captured but not enriched
  { name: 'AIOps Business Value', section: 'aiops', reason: 'captured-not-enriched' },
  // Competitive
  { name: 'ABU Competitive Battlecard - Puppet', section: 'competitive', reason: 'no-link' },
]

interface SearchResult {
  name: string
  section: string
  reason: string
  found: boolean
  apiName?: string
  contentId?: string
  versionId?: string
  format?: string
  downloadUrl?: string
  viewerUrl?: string
  resultCount?: number
  error?: string
}

async function main() {
  console.log('═══ Phase 0 Search Probe ═══════════════════════')
  console.log(`Testing ${TEST_SAMPLES.length} document names from different gap categories`)
  console.log()

  // Load session state (same as scraper)
  const sessionStatePath = resolve(PROFILE_DIR, 'session-state.json')
  if (!existsSync(sessionStatePath)) {
    // Fallback for local dev
    const localPath = resolve(import.meta.dir, '../data-sync/rh-profile/session-state.json')
    if (!existsSync(localPath)) {
      console.error(`No session-state.json at ${sessionStatePath} or ${localPath}`)
      console.error('Run this on Mac Mini where SalesHub auth exists')
      process.exit(1)
    }
  }

  const statePath = existsSync(sessionStatePath)
    ? sessionStatePath
    : resolve(import.meta.dir, '../data-sync/rh-profile/session-state.json')
  const sessionState = JSON.parse(readFileSync(statePath, 'utf-8'))
  console.log(`Loaded ${sessionState.cookies?.length ?? 0} cookies from ${statePath}`)

  // Launch browser same way as scraper
  const execPath = existsSync(CHROMIUM_PATH) ? CHROMIUM_PATH : undefined
  const browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: [...BASE_CHROMIUM_ARGS, '--disable-blink-features=AutomationControlled', '--headless=new'],
  })

  const context = await browser.newContext({
    storageState: sessionState,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  const page = await context.newPage()

  // Navigate to SalesHub to establish session + capture auth
  console.log('Navigating to SalesHub...')
  let authToken = ''
  const headers: Record<string, string> = {}

  page.on('request', (req) => {
    const url = req.url()
    if ((url.includes('gateway/services/search') || url.includes('api/doccenter')) && !authToken) {
      const reqHeaders = req.headers()
      if (reqHeaders.authorization?.startsWith('Bearer')) {
        authToken = reqHeaders.authorization
        Object.assign(headers, reqHeaders)
      }
    }
  })

  await page.goto(`${SALESHUB_URL}/app/#/doccenter/${PROFILE_VERSION_ID}/main///`, {
    waitUntil: 'networkidle',
    timeout: 45_000,
  })
  console.log(`Page loaded: ${page.url()}`)

  // If auth not captured from page load, trigger a search
  if (!authToken) {
    console.log('Auth not captured from page load, triggering search...')
    await page.fill('input[placeholder="Search"]', 'ansible').catch(() => {})
    await page.keyboard.press('Enter').catch(() => {})
    await new Promise(r => setTimeout(r, 5_000))
  }

  if (!authToken) {
    console.error('Could not capture auth token. Session may be expired.')
    await browser.close()
    process.exit(1)
  }
  console.log(`Auth captured (${authToken.length} chars)`)
  console.log()

  // ── Search for each sample document ──────────────────────────────────────

  const results: SearchResult[] = []
  const searchUrl = `${SALESHUB_URL}/gateway/services/search/tenants/redhat/api/services/search/v1/results?userId=${headers['x-seismic-userid'] ?? ''}&languages=en-us`

  for (const sample of TEST_SAMPLES) {
    console.log(`Searching: "${sample.name}" [${sample.section}]...`)

    try {
      const body = {
        SearchTerm: sample.name,
        Page: { PageIndex: 0, PageSize: 5 },
        Sort: 'Standard',
        Filter: {
          AppType: 'DocCenter',
          SeismicProperties: [{ PropName: 'ProfileVersions', Values: [PROFILE_VERSION_ID] }],
          ExcludedAppTypes: ['ControlCenter', 'NewsCenter', 'WorkSpace'],
          ExcludeFolder: false,
          Folder: { FolderPath: 'root', ProfileVersionId: PROFILE_VERSION_ID },
          IncludeSubFolder: true,
          CustomProperties: [],
        },
        DynamicFilter: { operator: 'and', conditions: [] },
        IncludeAppTypeFacet: true,
        DisableDidYouMean: false,
        SortOrder: 'default',
        EnableMultiFacetSearch: true,
        PermissionWorkflow: { WorkflowType: 'view' },
        Options: { WithAggregation: false, WithDocument: true },
      }

      const response: any = await page.evaluate(async (args: any) => {
        try {
          const res = await fetch(args.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: args.auth,
              profileversionid: args.pvid,
              teamsiteid: args.tsid ?? '1',
              'x-seismic-route': args.route ?? '',
              seismicclientname: args.client ?? '',
            },
            body: JSON.stringify(args.body),
          })
          if (!res.ok) return { ok: false, status: res.status }
          return { ok: true, data: await res.json() }
        } catch (e: any) {
          return { ok: false, error: e.message }
        }
      }, {
        url: searchUrl,
        auth: authToken,
        pvid: PROFILE_VERSION_ID,
        tsid: headers.teamsiteid,
        route: headers['x-seismic-route'],
        client: headers.seismicclientname,
        body,
      })

      if (!response.ok) {
        results.push({ ...sample, found: false, error: `API error: ${response.status ?? response.error}` })
        console.log(`  ❌ API error: ${response.status ?? response.error}`)
        continue
      }

      // Parse results — Seismic wraps in various shapes
      const data = response.data
      const docs = data?.Documents ?? data?.Results ?? data?.results ?? data?.documents ?? []

      if (docs.length === 0) {
        // Log the raw response shape for debugging
        const keys = Object.keys(data ?? {}).join(', ')
        results.push({ ...sample, found: false, error: `No results (response keys: ${keys})` })
        console.log(`  ❌ No results (response keys: ${keys})`)
        // Dump first 500 chars if small
        const raw = JSON.stringify(data).slice(0, 500)
        console.log(`  Raw: ${raw}`)
        continue
      }

      // Take the best match (first result)
      const best = docs[0]
      const apiName = best.Name ?? best.name ?? best.Title ?? best.title ?? 'unknown'
      const contentId = best.Id ?? best.ContentId ?? best.id ?? best.contentId ?? ''
      const versionId = best.VersionId ?? best.versionId ?? ''
      const format = best.Format ?? best.format ?? best.Type ?? best.type ?? ''
      const downloadUrl = contentId && versionId
        ? `${SALESHUB_URL}/api/doccenter/download/${contentId}/${versionId}`
        : (best.DownloadUrl ?? best.downloadUrl ?? '')
      const viewerUrl = best.Url ?? best.url ?? best.ViewerUrl ?? best.viewerUrl ?? ''

      results.push({
        ...sample,
        found: true,
        apiName,
        contentId,
        versionId,
        format,
        downloadUrl: downloadUrl || undefined,
        viewerUrl: viewerUrl || undefined,
        resultCount: docs.length,
      })

      const nameMatch = apiName.toLowerCase().includes(sample.name.toLowerCase().slice(0, 15)) ? '✅ match' : '⚠️ fuzzy'
      console.log(`  ✅ Found: "${apiName.slice(0, 70)}" | ${format} | ${nameMatch} | ${docs.length} results`)
      if (contentId) console.log(`     contentId: ${contentId}`)
      if (downloadUrl) console.log(`     download: ${downloadUrl.slice(0, 120)}`)

    } catch (e: any) {
      results.push({ ...sample, found: false, error: e.message })
      console.log(`  ❌ Error: ${e.message}`)
    }

    // Brief pause between searches
    await new Promise(r => setTimeout(r, 800))
  }

  await browser.close()

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log()
  console.log('═══ PHASE 0 PROBE RESULTS ═════════════════════')
  console.log()

  const found = results.filter(r => r.found)
  const notFound = results.filter(r => !r.found)
  const withDownload = found.filter(r => r.downloadUrl)

  console.log(`Found via API:     ${found.length}/${results.length}`)
  console.log(`With download URL: ${withDownload.length}/${results.length}`)
  console.log(`Not found:         ${notFound.length}/${results.length}`)
  console.log()

  console.log('── FOUND ──')
  for (const r of found) {
    const hasUrl = r.downloadUrl ? '📥 download URL' : (r.viewerUrl ? '👁️ viewer only' : '❌ no URL')
    console.log(`  ✅ [${r.section}] "${r.name}"`)
    console.log(`     → "${r.apiName}" | ${r.format} | ${hasUrl} | ${r.resultCount} results`)
  }
  console.log()

  if (notFound.length > 0) {
    console.log('── NOT FOUND ──')
    for (const r of notFound) {
      console.log(`  ❌ [${r.section}] "${r.name}" — ${r.error}`)
    }
    console.log()
  }

  console.log('── VERDICT ──')
  if (found.length >= 7) {
    console.log('✅ Search API is viable for Phase 0 — proceed with full implementation')
  } else if (found.length >= 4) {
    console.log('⚠️ Partial success — Search API works but may need query tuning')
  } else {
    console.log('❌ Search API not returning useful results — investigate response format')
  }
}

main().catch(console.error)
