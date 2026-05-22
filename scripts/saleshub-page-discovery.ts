/**
 * scripts/saleshub-page-discovery.ts — Discover all SalesHub Page RHSH content via API
 *
 * Uses the Seismic search API with an intercepted Bearer token to find all
 * "Page RHSH" content in the DocCenter. Returns categorized page lists
 * (tactics, plays, TDPs, products) with version IDs for URL construction.
 */

import type { Page } from '@playwright/test'

const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const DOCCENTER_URL = `https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/main///`

export interface DiscoveredPage {
  name: string
  versionId: string
  url: string
}

export interface DiscoveryResult {
  tactics: DiscoveredPage[]
  plays: DiscoveredPage[]
  tdps: DiscoveredPage[]
  products: DiscoveredPage[]
  all: DiscoveredPage[]
}

function buildPageUrl(versionId: string): string {
  return `https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252CUGFnZSBSSFNI%252Flf${versionId}//`
}

const KNOWN_TACTICS = [
  'Agentic AI', 'AIOps', 'Automate at Scale', 'Inference at Scale', 'Production AI',
  'Sovereign (Private) AI', 'Network Automation', 'Optimize and Modernize',
  'Deploy new critical', 'Operationalize AI', 'DevX', 'Multicluster',
  'Cloud marketplaces', 'Migrate to the Cloud', 'Container Adoption',
  'Secure the software supply chain', 'VM migration', 'Kubernetes for',
  'Standardize & Modernize', 'Secure and Manage',
]

const KNOWN_PLAYS = [
  'Build and Run Applications', 'Modernize Infrastructure', 'IT Operations Efficiency',
  'The AI-Ready Enterprise', 'Sovereignty',
]

const KNOWN_TDPS = [
  'AI Platform', 'Application Platform', 'Automation', 'Virtualization',
  'Container Management', 'Server/Cloud Operating System',
]

export async function discoverAllPages(page: Page): Promise<DiscoveryResult> {
  console.log('[page-discovery] Navigating to DocCenter to capture auth…')
  await page.goto(DOCCENTER_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(10_000)

  // Capture Bearer token from ANY Seismic API request (not just /results)
  let auth = '', hdrs: Record<string, string> = {}
  const capturePromise = new Promise<void>(resolve => {
    page.on('request', (req) => {
      if (!auth && req.headers().authorization?.startsWith('Bearer ')) {
        auth = req.headers().authorization ?? ''
        hdrs = req.headers()
        resolve()
      }
    })
    setTimeout(resolve, 15_000)
  })
  await capturePromise

  // Build the search URL from the captured request pattern
  const userId = hdrs['x-seismic-userid'] ?? ''
  const searchUrl = `https://saleshub.redhat.com/gateway/services/search/tenants/redhat/api/services/search/v1/results?userId=${userId}&languages=en-us`

  if (!auth) {
    console.warn('[page-discovery] Could not capture Seismic auth token — falling back to empty discovery')
    return { tactics: [], plays: [], tdps: [], products: [], all: [] }
  }

  console.log(`[page-discovery] Auth captured (${auth.length} chars). Headers: profileversionid=${hdrs.profileversionid ?? 'N/A'}, teamsiteid=${hdrs.teamsiteid ?? 'N/A'}`)

  console.log('[page-discovery] Auth captured, querying Page RHSH content…')

  // Fetch ALL Page RHSH pages (up to 200)
  const allPages: DiscoveredPage[] = []
  for (let pageIdx = 0; pageIdx < 2; pageIdx++) {
    const docs = await page.evaluate(async (args) => {
      const body = {
        SearchTerm: '', Page: { PageIndex: args.pageIdx, PageSize: 100 }, Sort: 'Standard',
        Filter: {
          AppType: 'DocCenter',
          SeismicProperties: [{ PropName: 'ProfileVersions', Values: [args.pvid] }],
          ExcludedAppTypes: ['ControlCenter', 'NewsCenter', 'WorkSpace'],
          ExcludeFolder: false,
          Folder: { FolderPath: 'root', ProfileVersionId: args.pvid },
          IncludeSubFolder: true,
          CustomProperties: [{ PropName: 'Content Type', Values: ['Page RHSH'] }],
        },
        DynamicFilter: { operator: 'and', conditions: [] },
        IncludeAppTypeFacet: true, DisableDidYouMean: false,
        SortOrder: 'default', EnableMultiFacetSearch: true,
        PermissionWorkflow: { WorkflowType: 'view' },
        Options: { WithAggregation: false, WithDocument: true },
      }
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
        body: JSON.stringify(body),
      })
      const data = await res.json()
      return (data?.ServiceResult?.Documents ?? []).map((d: any) => ({
        name: d.Name as string,
        versionId: d.VersionId as string,
      }))
    }, {
      pageIdx,
      url: searchUrl,
      auth,
      pvid: PROFILE_VERSION_ID,
      tsid: hdrs.teamsiteid,
      route: hdrs['x-seismic-route'],
      client: hdrs.seismicclientname,
    })

    for (const d of docs) {
      allPages.push({ name: d.name, versionId: d.versionId, url: buildPageUrl(d.versionId) })
    }

    if (docs.length < 100) break
  }

  console.log(`[page-discovery] Found ${allPages.length} total Page RHSH pages`)

  // Categorize
  const tactics = allPages.filter(p => KNOWN_TACTICS.some(k => p.name.includes(k)))
  const plays = allPages.filter(p => KNOWN_PLAYS.some(k => p.name === k))
  const tdps = allPages.filter(p => KNOWN_TDPS.some(k => p.name.includes(k)))
  const products = allPages.filter(p => p.name.startsWith('Red Hat ') || p.name.startsWith('Azure ') || p.name.startsWith('OpenShift '))

  console.log(`[page-discovery] Categorized: ${tactics.length} tactics, ${plays.length} plays, ${tdps.length} TDPs, ${products.length} products`)

  return { tactics, plays, tdps, products, all: allPages }
}
