#!/usr/bin/env bun
/**
 * scripts/phase0-search-probe.ts — Phase 0 dry run: search Seismic API by document name
 *
 * Tests the Search API with a sample of document names from different sections
 * to validate: (1) can we find docs by name, (2) do we get usable URLs back.
 *
 * Requires: Mac Mini with active SalesHub auth (browser session).
 * Usage: bun scripts/phase0-search-probe.ts
 *
 * This is a READ-ONLY probe — no downloads, no file writes beyond the report.
 */

import { chromium } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const SALESHUB_URL = 'https://saleshub.redhat.com'
const COOKIE_PATH = process.env.COOKIE_PATH || resolve(import.meta.dir, '../data-sync/rh-profile/saleshub-cookies.json')

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
  error?: string
}

async function main() {
  console.log('═══ Phase 0 Search Probe ═══════════════════════')
  console.log(`Testing ${TEST_SAMPLES.length} document names from different gap categories`)
  console.log()

  // Launch browser with saved cookies
  let cookies: any[] = []
  try {
    cookies = JSON.parse(readFileSync(COOKIE_PATH, 'utf-8'))
    console.log(`Loaded ${cookies.length} cookies from ${COOKIE_PATH}`)
  } catch (e) {
    console.error(`Failed to load cookies: ${e}`)
    console.error('Run this on Mac Mini where SalesHub auth exists')
    process.exit(1)
  }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  await context.addCookies(cookies)
  const page = await context.newPage()

  // Navigate to SalesHub to establish session
  console.log('Navigating to SalesHub...')
  await page.goto(`${SALESHUB_URL}/app/#/doccenter/${PROFILE_VERSION_ID}/main///`, {
    waitUntil: 'networkidle',
    timeout: 30_000,
  })
  console.log(`Page loaded: ${page.url()}`)

  // Capture auth token from network requests
  let authToken = ''
  const headers: Record<string, string> = {}

  const capturePromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 10_000)
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('gateway/services/search') || url.includes('api/doccenter')) {
        const reqHeaders = req.headers()
        if (reqHeaders.authorization && reqHeaders.authorization.startsWith('Bearer')) {
          authToken = reqHeaders.authorization
          Object.assign(headers, reqHeaders)
          clearTimeout(timeout)
          resolve()
        }
      }
    })
  })

  // Trigger a search to capture auth
  await page.fill('input[placeholder="Search"]', 'test').catch(() => {})
  await page.keyboard.press('Enter').catch(() => {})
  await capturePromise

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

      const response = await page.evaluate(async (args) => {
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

      // Parse results — Seismic wraps in Documents or Results array
      const data = response.data
      const docs = data?.Documents ?? data?.Results ?? data?.results ?? []

      if (docs.length === 0) {
        results.push({ ...sample, found: false, error: 'No results returned' })
        console.log(`  ❌ No results`)
        continue
      }

      // Take the best match (first result)
      const best = docs[0]
      const apiName = best.Name ?? best.name ?? best.Title ?? 'unknown'
      const contentId = best.Id ?? best.ContentId ?? best.id ?? best.contentId ?? ''
      const versionId = best.VersionId ?? best.versionId ?? ''
      const format = best.Format ?? best.format ?? best.Type ?? ''
      const downloadUrl = contentId && versionId
        ? `${SALESHUB_URL}/api/doccenter/download/${contentId}/${versionId}`
        : (best.DownloadUrl ?? best.downloadUrl ?? '')
      const viewerUrl = best.Url ?? best.url ?? best.ViewerUrl ?? ''

      results.push({
        ...sample,
        found: true,
        apiName,
        contentId,
        versionId,
        format,
        downloadUrl: downloadUrl || undefined,
        viewerUrl: viewerUrl || undefined,
      })

      const nameMatch = apiName.toLowerCase().includes(sample.name.toLowerCase().slice(0, 20)) ? '✅ name match' : '⚠️ fuzzy'
      console.log(`  ✅ Found: "${apiName.slice(0, 60)}" | ${format} | ${nameMatch}`)
      if (downloadUrl) console.log(`     Download URL: ${downloadUrl.slice(0, 100)}`)
      if (docs.length > 1) console.log(`     (${docs.length} total results)`)

    } catch (e: any) {
      results.push({ ...sample, found: false, error: e.message })
      console.log(`  ❌ Error: ${e.message}`)
    }

    // Brief pause between searches
    await new Promise(r => setTimeout(r, 500))
  }

  await browser.close()

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log()
  console.log('═══ RESULTS ═══════════════════════════════════')
  console.log()

  const found = results.filter(r => r.found)
  const notFound = results.filter(r => !r.found)

  console.log(`Found: ${found.length}/${results.length}`)
  console.log(`Not found: ${notFound.length}/${results.length}`)
  console.log()

  if (found.length > 0) {
    console.log('── FOUND ──')
    for (const r of found) {
      const hasUrl = r.downloadUrl ? '📥 has download URL' : (r.viewerUrl ? '👁️ viewer URL only' : '❌ no URL')
      console.log(`  [${r.section}] "${r.name}"`)
      console.log(`    → API: "${r.apiName}" | ${r.format} | ${hasUrl}`)
      if (r.downloadUrl) console.log(`    → ${r.downloadUrl}`)
      console.log()
    }
  }

  if (notFound.length > 0) {
    console.log('── NOT FOUND ──')
    for (const r of notFound) {
      console.log(`  [${r.section}] "${r.name}" — ${r.error}`)
    }
  }
}

main().catch(console.error)
