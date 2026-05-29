/**
 * scripts/saleshub-content-discovery.ts — DocCenter content discovery via faceted API (#448)
 *
 * Queries the Seismic DocCenter search API with faceted filters to find
 * high-value documents (business presentations, cheatsheets, competitive reviews)
 * per TDP/Play/Tactic, downloads them, extracts text content, and stores
 * both metadata + extracted content in the knowledge base.
 *
 * Replaces Pass 1.9 (home page tile scraping — broken, found 0 links).
 *
 * Pure logic functions are exported for unit testing.
 * Browser-dependent functions (discoverFacets, queryDocuments, downloadAndExtract)
 * require a Playwright Page with an authenticated SalesHub session.
 */

import type { Page } from '@playwright/test'
import type { TdpNode, SalesPlayNode } from './saleshub-knowledge-extraction.ts'

const PROFILE_VERSION_ID = '1d1918e9-b5b0-4428-b8fc-87e02ad44156'
const DOCCENTER_URL = `https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/main///`

const MAX_DOCUMENT_SIZE = 200 * 1024 * 1024 // 200MB
const MAX_EXTRACTED_CHARS = 50_000
const SKIP_FORMATS = new Set(['MP4', 'MOV', 'WEBM', 'YouTube', 'URL', 'JSON', 'PNG', 'JPG', 'GIF', 'SVG'])

// ── Types ────────────────────────────────────────────────────────────────────

export interface DocCenterDocument {
  name: string
  contentType: string       // "Business presentation", "Cheatsheet", "Competitive review"
  size: number              // bytes
  version: string
  versionCreated: string
  versionId: string
  downloadUrl: string
  distributionTerms: string // "General Distribution" or "Confidential - Channel NDA Required"
  product: string           // "Red Hat Ansible Automation Platform" etc
  salesStage: string        // "1. Discover", "2. Validate", etc
  tdp?: string              // TDP tag if present
  salesPlay?: string        // Sales Play tag if present
  salesTactic?: string      // Sales Tactic tag if present
  extractedContent?: string // populated after download + extraction
}

export interface FacetDiscoveryResult {
  tdps: string[]            // discovered from API facets
  salesPlays: string[]
  salesTactics: string[]
  contentTypes: string[]
}

export interface MergeResult {
  tdps: (TdpNode & { documents?: DocCenterDocument[] })[]
  salesPlays: (SalesPlayNode & { documents?: DocCenterDocument[] })[]
  unmatched: DocCenterDocument[]
}

// ── Pure Logic Functions (testable without browser) ──────────────────────────

/**
 * Extract a custom property value from a Seismic document's CustomProperties array.
 */
function getCustomProp(customProperties: any[] | undefined, propName: string): string {
  if (!customProperties || !Array.isArray(customProperties)) return ''
  const prop = customProperties.find((p: any) => p.name === propName)
  return prop?.values?.[0]?.value ?? ''
}

/**
 * Parse documents from the Seismic search API response.
 * Maps the raw API shape into our DocCenterDocument type.
 */
export function parseDocumentsFromApiResponse(response: any): DocCenterDocument[] {
  const documents = response?.ServiceResult?.Documents
  if (!documents || !Array.isArray(documents)) return []

  return documents.map((d: any) => {
    const cp = d.CustomProperties
    const tdpVal = getCustomProp(cp, 'TDP')
    const playVal = getCustomProp(cp, 'Sales Play')
    const tacticVal = getCustomProp(cp, 'Sales Tactic')

    const doc: DocCenterDocument & { contentId?: string; format?: string } = {
      name: d.Name ?? '',
      contentType: getCustomProp(cp, 'Content Type'),
      size: d.Size ?? 0,
      version: `${d.MajorVersion ?? ''}${d.MinorVersion ? '.' + d.MinorVersion : ''}`,
      versionCreated: d.VersionCreatedDate ?? d.VersionCreated ?? '',
      versionId: d.VersionId ?? '',
      downloadUrl: '',
      distributionTerms: getCustomProp(cp, 'Distribution Terms') || (d.DistributionTerms ?? ''),
      product: getCustomProp(cp, 'Product'),
      salesStage: getCustomProp(cp, 'Sales Stage'),
    }
    // Store extra fields for download
    ;(doc as any).contentId = d.ContentId ?? ''
    ;(doc as any).format = d.Format ?? d.NativeFormat ?? ''
    ;(doc as any).sourceBlobId = d.SourceBlobId ?? ''
    ;(doc as any).sourceContainerName = d.SourceContainerName ?? ''
    // Extract Locations[0].FullPath for DocCenter URL construction
    const locations = d.Locations ?? []
    if (locations.length > 0 && locations[0].FullPath) {
      ;(doc as any).locationPath = locations[0].FullPath
    }

    // Only set optional fields if they have values
    if (tdpVal) doc.tdp = tdpVal
    if (playVal) doc.salesPlay = playVal
    if (tacticVal) doc.salesTactic = tacticVal

    return doc
  })
}

/**
 * Parse facet values from an aggregation-enabled API response.
 * Returns all available TDP, Sales Play, Sales Tactic, and Content Type values.
 */
export function parseFacetsFromApiResponse(response: any): FacetDiscoveryResult {
  const result: FacetDiscoveryResult = {
    tdps: [],
    salesPlays: [],
    salesTactics: [],
    contentTypes: [],
  }

  const facetsList = response?.ServiceResult?.Facets ?? response?.ServiceResult?.Aggregations
  if (!facetsList || !Array.isArray(facetsList)) return result

  for (const agg of facetsList) {
    const rawValues = agg.Values ?? agg.values ?? agg.items ?? agg.Items ?? []
    const values = rawValues.map((v: any) => v.Value ?? v.value ?? v.Name ?? v.name).filter(Boolean)
    const name = agg.Key ?? agg.key ?? agg.name ?? agg.Name ?? agg.displayName ?? ''
    switch (name) {
      case 'TDP':
        result.tdps = values
        break
      case 'Sales Play':
        result.salesPlays = values
        break
      case 'Sales Tactic':
        result.salesTactics = values
        break
      case 'Content Type':
        result.contentTypes = values
        break
    }
  }

  return result
}

/**
 * Priority document filter — only keep high-value documents.
 * Returns true if the document matches a priority pattern.
 */
export function isPriorityDocument(doc: DocCenterDocument): boolean {
  const lower = doc.name.toLowerCase()
  // Priority 1: Main TDP/Play customer decks
  if (lower.includes('customer facing deck') || lower.includes('customer presentation') || lower.includes('customer deck')) return true
  // Priority 2: Cheatsheets
  if (lower.includes('cheatsheet') || lower.includes('cheat sheet')) return true
  // Priority 3: Pitch decks for Sales Plays
  if (lower.includes('pitch deck') || lower.includes('intro pitch')) return true
  // Priority 4: Business Value one-pagers
  if (lower.includes('business value') && (lower.includes('one pager') || lower.includes('executive'))) return true
  // Priority 5: Competitive battlecards
  if (lower.includes('battlecard') || lower.includes('battle card')) return true
  // Priority 6: Elevator pitches
  if (lower.includes('elevator pitch')) return true
  return false
}

/**
 * Determine if a document should be skipped based on size or format.
 */
export function shouldSkipDocument(doc: DocCenterDocument): boolean {
  if (doc.size > MAX_DOCUMENT_SIZE) return true
  // Check format from contentType or name extension
  const format = doc.contentType?.toUpperCase() ?? ''
  if (SKIP_FORMATS.has(format)) return true
  if (format === 'VIDEO' || format.includes('VIDEO')) return true
  return false
}

/**
 * Extract text from a PPTX slide XML string.
 * PPTX files are ZIP archives containing XML; slide text is in <a:t> elements.
 */
export function extractTextFromPptxSlideXml(xml: string): string {
  if (!xml || xml.trim().length === 0) return ''

  // Extract all text from <a:t>...</a:t> elements
  const textParts: string[] = []
  const regex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    const text = match[1].trim()
    if (text) textParts.push(text)
  }

  return textParts.join(' ').trim()
}

/**
 * Extract text from a PPTX file buffer by unzipping and parsing slide XML.
 * Uses Bun's native APIs for ZIP handling.
 */
export async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  // PPTX is a ZIP containing ppt/slides/slideN.xml and ppt/notesSlides/notesSlideN.xml
  const { Glob } = await import('bun')

  // Write buffer to temp file, unzip, parse XMLs
  const tmpDir = `/tmp/pptx-extract-${Date.now()}`
  const { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = await import('fs')
  const { resolve: pathResolve } = await import('path')

  try {
    mkdirSync(tmpDir, { recursive: true })
    const tmpFile = pathResolve(tmpDir, 'doc.pptx')
    writeFileSync(tmpFile, buffer)

    // Use bun's built-in unzip via shell
    const proc = Bun.spawnSync(['unzip', '-o', '-q', tmpFile, '-d', tmpDir])
    if (proc.exitCode !== 0) {
      console.warn(`[content-discovery] unzip failed: ${proc.stderr?.toString()?.slice(0, 100)}`)
      return ''
    }

    const allText: string[] = []

    // Extract from slides
    const slidesDir = pathResolve(tmpDir, 'ppt', 'slides')
    try {
      const slideFiles = readdirSync(slidesDir)
        .filter(f => /^slide\d+\.xml$/i.test(f))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)?.[0] ?? '0')
          const numB = parseInt(b.match(/\d+/)?.[0] ?? '0')
          return numA - numB
        })

      for (const file of slideFiles) {
        const xml = readFileSync(pathResolve(slidesDir, file), 'utf-8')
        const text = extractTextFromPptxSlideXml(xml)
        if (text) allText.push(text)
      }
    } catch {
      // No slides directory
    }

    // Extract from notes
    const notesDir = pathResolve(tmpDir, 'ppt', 'notesSlides')
    try {
      const noteFiles = readdirSync(notesDir)
        .filter(f => /^notesSlide\d+\.xml$/i.test(f))
        .sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)?.[0] ?? '0')
          const numB = parseInt(b.match(/\d+/)?.[0] ?? '0')
          return numA - numB
        })

      for (const file of noteFiles) {
        const xml = readFileSync(pathResolve(notesDir, file), 'utf-8')
        const text = extractTextFromPptxSlideXml(xml)
        if (text) allText.push(text)
      }
    } catch {
      // No notes directory
    }

    const combined = allText.join('\n\n')
    return combined.slice(0, MAX_EXTRACTED_CHARS)
  } finally {
    try {
      const { rmSync } = await import('fs')
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}

/**
 * Merge discovered documents into knowledge base TDP and SalesPlay nodes.
 * Documents are matched by their TDP/SalesPlay/SalesTactic tags.
 */
export function mergeDocumentsIntoKnowledge(
  docs: DocCenterDocument[],
  tdps: TdpNode[],
  salesPlays: SalesPlayNode[],
): MergeResult {
  // Create copies with documents array
  const tdpResults = tdps.map(t => ({ ...t, documents: [] as DocCenterDocument[] }))
  const playResults = salesPlays.map(p => ({ ...p, documents: [] as DocCenterDocument[] }))
  const unmatched: DocCenterDocument[] = []

  for (const doc of docs) {
    let matched = false

    // Match by TDP tag
    if (doc.tdp) {
      const tdpLower = doc.tdp.toLowerCase()
      const matchedTdp = tdpResults.find(t =>
        t.name.toLowerCase() === tdpLower ||
        t.name.toLowerCase().includes(tdpLower) ||
        tdpLower.includes(t.name.toLowerCase()),
      )
      if (matchedTdp) {
        matchedTdp.documents.push(doc)
        matched = true
      }
    }

    // Match by Sales Play tag
    if (doc.salesPlay) {
      const playLower = doc.salesPlay.toLowerCase()
      const matchedPlay = playResults.find(p =>
        p.name.toLowerCase() === playLower ||
        p.name.toLowerCase().includes(playLower) ||
        playLower.includes(p.name.toLowerCase()),
      )
      if (matchedPlay) {
        matchedPlay.documents.push(doc)
        matched = true
      }
    }

    if (!matched) {
      unmatched.push(doc)
    }
  }

  return { tdps: tdpResults, salesPlays: playResults, unmatched }
}

// ── Browser-Dependent Functions ─────────────────────────────────────────────

/**
 * Capture the Seismic Bearer token and headers by navigating to DocCenter.
 * Returns null if auth capture fails.
 */
export async function captureSeismicAuth(page: Page): Promise<{
  auth: string
  searchUrl: string
  contentSearchUrls: string[]
  headers: Record<string, string>
} | null> {
  console.log('[content-discovery] Navigating to DocCenter to capture auth...')
  await page.goto(DOCCENTER_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(10_000)

  let auth = ''
  let hdrs: Record<string, string> = {}

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

  if (!auth) {
    console.warn('[content-discovery] Could not capture Seismic auth token')
    return null
  }

  const userId = hdrs['x-seismic-userid'] ?? ''
  const searchUrl = `https://saleshub.redhat.com/gateway/services/search/tenants/redhat/api/services/search/v1/results?userId=${userId}&languages=en-us`

  // Also build the newer Content Search API URL (returns downloadUrl per doc)
  const contentSearchUrls = [
    `https://saleshub.redhat.com/gateway/services/search/tenants/redhat/api/search/v1/content/query`,
    `https://saleshub.redhat.com/gateway/services/search/tenants/redhat/api/v1/content/query`,
  ]

  const headerKeys = Object.keys(hdrs).filter(k => k.includes('seismic') || k.includes('teamsite') || k.includes('tenant') || k.includes('profile'))
  console.log(`[content-discovery] Auth captured (${auth.length} chars), relevant headers: ${headerKeys.map(k => `${k}=${hdrs[k]?.slice(0, 30)}`).join(', ')}`)
  console.log(`[content-discovery] All header keys: ${Object.keys(hdrs).join(', ')}`)
  return { auth, searchUrl, contentSearchUrls, headers: hdrs }
}

/**
 * Build the POST body for a Seismic search API call.
 */
function buildSearchBody(opts: {
  contentTypes?: string[]
  tdp?: string
  salesPlay?: string
  salesTactic?: string
  withAggregation?: boolean
  pageIndex?: number
  pageSize?: number
}): any {
  const customProperties: any[] = []

  if (opts.contentTypes && opts.contentTypes.length > 0) {
    customProperties.push({ PropName: 'Content Type', Values: opts.contentTypes })
  }
  if (opts.tdp) {
    customProperties.push({ PropName: 'TDP', Values: [opts.tdp] })
  }
  if (opts.salesPlay) {
    customProperties.push({ PropName: 'Sales Play', Values: [opts.salesPlay] })
  }
  if (opts.salesTactic) {
    customProperties.push({ PropName: 'Sales Tactic', Values: [opts.salesTactic] })
  }

  return {
    SearchTerm: '',
    Page: { PageIndex: opts.pageIndex ?? 0, PageSize: opts.pageSize ?? 100 },
    Sort: 'Standard',
    Filter: {
      AppType: 'DocCenter',
      SeismicProperties: [{ PropName: 'ProfileVersions', Values: [PROFILE_VERSION_ID] }],
      ExcludedAppTypes: ['ControlCenter', 'NewsCenter', 'WorkSpace'],
      ExcludeFolder: false,
      Folder: { FolderPath: 'root', ProfileVersionId: PROFILE_VERSION_ID },
      IncludeSubFolder: true,
      CustomProperties: customProperties,
    },
    DynamicFilter: { operator: 'and', conditions: [] },
    IncludeAppTypeFacet: true,
    DisableDidYouMean: false,
    SortOrder: 'default',
    EnableMultiFacetSearch: true,
    PermissionWorkflow: { WorkflowType: 'view' },
    Options: {
      WithAggregation: opts.withAggregation ?? false,
      WithDocument: true,
    },
  }
}

/**
 * Discover all available facet values from the Seismic search API.
 * No hardcoded lists - discovers TDPs, Sales Plays, Tactics, and Content Types
 * from the API's aggregation response.
 */
export async function discoverFacets(
  page: Page,
  authCtx: { auth: string; searchUrl: string; headers: Record<string, string> },
): Promise<FacetDiscoveryResult> {
  console.log('[content-discovery] Discovering facets from API aggregation...')

  const body = buildSearchBody({ withAggregation: true, pageSize: 1 })

  const response = await page.evaluate(async (args) => {
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
    return res.json()
  }, {
    url: authCtx.searchUrl,
    auth: authCtx.auth,
    pvid: PROFILE_VERSION_ID,
    tsid: authCtx.headers.teamsiteid,
    route: authCtx.headers['x-seismic-route'],
    client: authCtx.headers.seismicclientname,
    body,
  })

  // Log teamsite/tenant info from search response for download URL construction
  const sr = response?.ServiceResult
  if (sr?.Documents?.[0]) {
    const doc0 = sr.Documents[0]
    const teamFields = Object.keys(doc0).filter(k => k.toLowerCase().includes('teamsite') || k.toLowerCase().includes('tenant') || k.toLowerCase().includes('library'))
    console.log(`[content-discovery] Sample doc keys with teamsite/tenant/library: ${teamFields.map(k => `${k}=${JSON.stringify(doc0[k])?.slice(0, 50)}`).join(', ')}`)
    console.log(`[content-discovery] Sample doc top-level keys: ${Object.keys(doc0).join(', ')}`)
    // Log download-relevant fields
    const dlFields = ['ContentSources', 'Locations', 'DownloadUrl', 'Url', 'Link', 'AssetUrl', 'NativeDownloadUrl', 'ViewUrl', 'ThumbnailRelativePathWithSignature', 'OriginUrl', 'UrlObjectOpenMode', 'SourceBlobId', 'SourceContainerName']
    for (const f of dlFields) {
      if (doc0[f] !== undefined) console.log(`[content-discovery] Doc.${f}: ${JSON.stringify(doc0[f])?.slice(0, 300)}`)
    }
    console.log(`[content-discovery] Doc sample: Name=${doc0.Name}, ContentId=${doc0.ContentId}, VersionId=${doc0.VersionId}, Format=${doc0.Format}, Size=${doc0.Size}`)
  }

  const facets = parseFacetsFromApiResponse(response)
  console.log(`[content-discovery] Facets: ${facets.tdps.length} TDPs, ${facets.salesPlays.length} plays, ${facets.salesTactics.length} tactics, ${facets.contentTypes.length} content types`)
  return facets
}

/**
 * Query for documents matching a category + content type filter.
 */
export async function queryDocuments(
  page: Page,
  authCtx: { auth: string; searchUrl: string; headers: Record<string, string> },
  filters: { tdp?: string; salesPlay?: string; salesTactic?: string },
  contentTypes: string[],
): Promise<DocCenterDocument[]> {
  const body = buildSearchBody({
    contentTypes,
    tdp: filters.tdp,
    salesPlay: filters.salesPlay,
    salesTactic: filters.salesTactic,
    pageSize: 100,
  })

  const response = await page.evaluate(async (args) => {
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
    return res.json()
  }, {
    url: authCtx.searchUrl,
    auth: authCtx.auth,
    pvid: PROFILE_VERSION_ID,
    tsid: authCtx.headers.teamsiteid,
    route: authCtx.headers['x-seismic-route'],
    client: authCtx.headers.seismicclientname,
    body,
  })

  return parseDocumentsFromApiResponse(response)
}

/**
 * Probe the newer Seismic Content Search API which returns downloadUrl per document.
 * If this works, we can download files directly without browser automation.
 */
export async function probeContentSearchApi(
  page: Page,
  authCtx: { auth: string; contentSearchUrls: string[]; headers: Record<string, string> },
): Promise<string | null> {
  const body = {
    term: '',
    filter: {
      operator: 'and',
      conditions: [
        { attribute: 'repository', operator: 'equal', value: 'library' },
      ],
    },
    options: {
      returnFields: ['name', 'id', 'versionId', 'format', 'downloadUrl', 'applicationUrls', 'properties'],
      pageSize: 2,
    },
  }

  for (const url of authCtx.contentSearchUrls) {
    try {
      const result = await page.evaluate(async (args) => {
        try {
          const res = await fetch(args.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: args.auth,
              profileversionid: args.pvid,
              teamsiteid: args.tsid ?? '1',
            },
            body: JSON.stringify(args.body),
          })
          const ct = res.headers.get('content-type') ?? ''
          if (!res.ok) return { ok: false, status: res.status, ct }
          const json = await res.json()
          return { ok: true, status: res.status, ct, data: json }
        } catch (e: any) { return { ok: false, status: -1, ct: '', error: e.message } }
      }, {
        url,
        auth: authCtx.auth,
        pvid: PROFILE_VERSION_ID,
        tsid: authCtx.headers.teamsiteid,
        body,
      })

      console.log(`[content-discovery] Content Search probe ${url.replace('https://saleshub.redhat.com', '')} → ${result.status} (${result.ct})`)

      if (result.ok && result.data) {
        const results = result.data.results ?? result.data.searchResults ?? []
        if (results.length > 0) {
          const sample = results[0]
          console.log(`[content-discovery] Content Search API works! Sample: name=${sample.name}, downloadUrl=${sample.downloadUrl ?? 'MISSING'}, format=${sample.format}`)
          if (sample.applicationUrls) {
            console.log(`[content-discovery] applicationUrls: ${JSON.stringify(sample.applicationUrls).slice(0, 200)}`)
          }
          if (sample.downloadUrl) {
            console.log(`[content-discovery] ✓ downloadUrl available — API download path confirmed!`)
            return url
          }
        }
      }
    } catch {}
  }

  return null
}

/**
 * Download a document and extract text content.
 * Supports PPTX (ZIP+XML) and PDF extraction.
 * Returns the extracted text content.
 */
export async function downloadAndExtract(
  page: Page,
  doc: DocCenterDocument,
  outputDir: string,
  authToken?: string,
): Promise<string> {
  const { mkdirSync, existsSync, readFileSync } = await import('fs')
  const { resolve } = await import('path')
  mkdirSync(outputDir, { recursive: true })

  // Download via browser DocCenter page — navigate, click Download, save file
  const format = (doc as any).format ?? ''
  const ext = format.toLowerCase() || 'bin'
  const contentTypeB64 = Buffer.from(doc.contentType).toString('base64').replace(/=/g, '%3D')
  const docUrl = `https://saleshub.redhat.com/apps/doccenter/${PROFILE_VERSION_ID}/doc/%252Fdd04d516a5-19b3-48c9-e01a-d2bf52939de4%252FdfMmNhNDhiYjktYzE1Ny00ZjgyLWJlYjUtNTdhY2NjZmY5Y2Rh%252CPT0%253D%252C${contentTypeB64}%252Flf${doc.versionId}//`
  const filename = `${doc.name.replace(/[/\\?%*:|"<>]/g, '_')}.${ext}`
  const localPath = resolve(outputDir, filename)

  await page.goto(docUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(5_000)

  // Click Download button — try multiple selectors
  let downloadBtn = page.locator('button:has-text("Download"), a:has-text("Download")').first()
  if (!await downloadBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    // Try icon-based download button
    downloadBtn = page.locator('[aria-label="Download"], [title="Download"]').first()
  }
  if (!await downloadBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    throw new Error(`No Download button found for ${doc.name}`)
  }

  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 }) // 2 min for large files
  await downloadBtn.click()
  const download = await downloadPromise

  const suggestedName = download.suggestedFilename() || filename
  const savePath = resolve(outputDir, suggestedName.replace(/[/\\?%*:|"<>]/g, '_'))
  await download.saveAs(savePath)

  // Use the actual saved path for extraction
  const actualPath = savePath

  // Extract text based on file type
  const fileExt = ext  // ext already set from format above
  let extractedText = ''

  if (fileExt === 'pptx') {
    const buffer = Buffer.from(readFileSync(actualPath))
    extractedText = await extractTextFromPptx(buffer)
  } else if (fileExt === 'pdf') {
    try {
      const { PDFParse, VerbosityLevel } = await import('pdf-parse')
      const buffer = readFileSync(actualPath)
      const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS })
      const result = await parser.getText()
      extractedText = (result.text ?? result.pages?.map((p: any) => p.text).join('\n\n') ?? '').slice(0, MAX_EXTRACTED_CHARS)
      await parser.destroy()
    } catch (e: any) {
      console.warn(`[content-discovery] pdf-parse failed for ${doc.name}: ${e.message?.slice(0, 100)}`)
    }
  } else if (fileExt === 'docx') {
    // DOCX is also a ZIP — similar to PPTX but text is in word/document.xml
    try {
      const { mkdirSync: mk, readFileSync: rf, rmSync } = await import('fs')
      const tmpDir = `/tmp/docx-extract-${Date.now()}`
      mk(tmpDir, { recursive: true })
      const proc = Bun.spawnSync(['unzip', '-o', '-q', actualPath, '-d', tmpDir])
      if (proc.exitCode === 0) {
        const docXml = rf(resolve(tmpDir, 'word', 'document.xml'), 'utf-8')
        // Extract text from <w:t> elements
        const textParts: string[] = []
        const regex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
        let match: RegExpExecArray | null
        while ((match = regex.exec(docXml)) !== null) {
          if (match[1].trim()) textParts.push(match[1].trim())
        }
        extractedText = textParts.join(' ').slice(0, MAX_EXTRACTED_CHARS)
      }
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      console.warn(`[content-discovery] DOCX extraction failed for ${doc.name}`)
    }
  }

  return extractedText
}
