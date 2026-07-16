// src/lib/ecosystem-catalog.ts
// GitHub Issue #438, #1000 — Ecosystem Catalog
// Types, cache loader, and HYDRA API sync for Red Hat technology partner ecosystem solutions.
// Reads cached JSON files from data/cache/ecosystem-catalog/*.json.
// Separate from partner-catalog.ts which handles specialized channel partners (CDW, WWT).

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EcosystemResource {
  title: string
  url: string
  type: 'lab' | 'trial' | 'solution-brief' | 'video' | 'case-study' | 'white-paper' | 'design-guide' | 'documentation' | 'other'
}

export interface AnsibleCollection {
  name: string       // e.g. "cisco.aci"
  namespace: string  // e.g. "cisco"
  category?: string  // e.g. "Networking"
  url?: string
}

export interface EcosystemSolution {
  name: string
  partnerName: string
  partnerSlug: string  // URL slug for cache file naming
  description: string
  platform: string     // Red Hat product: "Ansible Automation Platform", "OpenShift Container Platform", etc.
  categories: string[] // "AI", "Automation", "Networking", "Security", "Virtualization", etc.
  geoRegion: string    // "Global", "NA", "EMEA", etc.
  url: string          // linkback to catalog.redhat.com/en/solutions/detail/{UUID}
  coSell?: boolean     // true if "purchase through partner" detected
  resources: EcosystemResource[]
  collections: AnsibleCollection[]
  publishedAt?: string // ISO date string
}

export interface EcosystemPartnerCache {
  partnerName: string
  partnerSlug: string
  solutions: EcosystemSolution[]
  scrapedAt: string  // ISO timestamp
  solutionCount: number
}

// ── Cache directory ───────────────────────────────────────────────────────────

/**
 * Returns the resolved path to the ecosystem catalog cache directory.
 * Reads CACHE_DIR at call time (not module load time) so tests can override it.
 */
export function getEcosystemCacheDir(): string {
  const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
  return resolve(cacheDir, 'ecosystem-catalog')
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load a single partner cache file. Fail-open: returns null on missing file
 * or parse error.
 */
export function loadEcosystemPartner(filePath: string): EcosystemPartnerCache | null {
  if (!existsSync(filePath)) return null
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'))
    // Basic validation: must have partnerName and solutions array
    if (!data.partnerName || !Array.isArray(data.solutions)) return null
    return data as EcosystemPartnerCache
  } catch {
    return null
  }
}

/**
 * Load all partner cache files from the ecosystem catalog cache directory.
 * Returns an array of successfully parsed caches. Skips invalid files silently.
 */
export function loadAllEcosystemPartners(): EcosystemPartnerCache[] {
  const cacheDir = getEcosystemCacheDir()
  const appDir = resolve(import.meta.dir, '..', '..')
  const templateDir = resolve(appDir, 'config-templates', 'ecosystem-catalog')
  const dir = (existsSync(cacheDir) && readdirSync(cacheDir).some(f => f.endsWith('.json')))
    ? cacheDir
    : existsSync(templateDir) ? templateDir : cacheDir
  if (!existsSync(dir)) return []

  const results: EcosystemPartnerCache[] = []
  try {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const partner = loadEcosystemPartner(resolve(dir, file))
      if (partner) results.push(partner)
    }
  } catch {
    // Directory read failed — return empty
  }

  return results
}

// ── SOLR API Types ───────────────────────────────────────────────────────────

/** Shape of a single doc from the HYDRA SOLR search response */
interface SolrDoc {
  allTitle?: string
  partnerName?: string
  partner_catalog_url_id?: string
  short_description?: string
  target_platforms?: string[]
  subcategories?: string[]
  supported_regions?: string[]
  view_uri?: string
  lastModifiedDate?: string
  solution_type?: string
  id?: string
  uri?: string
}

/** Top-level SOLR search response */
interface SolrResponse {
  response?: {
    docs?: SolrDoc[]
    numFound?: number
  }
}

/** Shape of a single PRM resource entry */
interface PrmResource {
  title?: string
  name?: string
  url?: string
  link?: string
  type?: string
  resourceType?: { code?: string; label?: string }
  description?: string
}

// ── Resource Type Mapping (§29) ──────────────────────────────────────────────

const RESOURCE_TYPE_MAP: Record<string, EcosystemResource['type']> = {
  solution_brief: 'solution-brief',
  customer_case_study: 'case-study',
  reference_architecture: 'design-guide',
  demo: 'lab',
  learning_course: 'lab',
  video: 'video',
  overview: 'documentation',
}

/**
 * Map a PRM API resource type code to our EcosystemResource type.
 * Falls back to 'other' for unrecognized types.
 */
export function mapResourceType(apiType: string | undefined): EcosystemResource['type'] {
  if (!apiType) return 'other'
  return RESOURCE_TYPE_MAP[apiType] ?? 'other'
}

// ── Partner Slug ─────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a partner name.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses multiple hyphens.
 */
export function toPartnerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ── SOLR to EcosystemSolution Mapping (§29) ──────────────────────────────────

/**
 * Map a SOLR doc to an EcosystemSolution.
 * Uses the field mapping from ARCHITECTURE.md §29.
 */
export function mapSolrDoc(doc: SolrDoc, resources: EcosystemResource[] = []): EcosystemSolution | null {
  const name = doc.allTitle?.trim()
  if (!name) return null

  const partnerName = doc.partnerName?.trim() || extractPartnerFromTitle(name)
  if (!partnerName) return null

  const partnerSlug = doc.partner_catalog_url_id?.trim() || toPartnerSlug(partnerName)

  let url = doc.view_uri || doc.uri || ''
  if (url && !url.startsWith('http')) {
    url = `https://catalog.redhat.com${url.startsWith('/') ? '' : '/'}${url}`
  }

  return {
    name,
    partnerName,
    partnerSlug,
    description: doc.short_description?.trim() || '',
    platform: doc.target_platforms?.[0] || inferPlatform(doc.solution_type),
    categories: doc.subcategories || [],
    geoRegion: doc.supported_regions?.[0] || 'Global',
    url,
    resources,
    collections: [], // Deferred per §29 — API does not expose collections
    publishedAt: doc.lastModifiedDate || undefined,
  }
}

/**
 * Fallback: extract partner name from title patterns like
 * "SolutionName with PartnerName and Red Hat" or "PartnerName + Red Hat ..."
 */
function extractPartnerFromTitle(title: string): string {
  // "... with PartnerName and Red Hat"
  const withMatch = title.match(/with\s+(.+?)\s+and\s+Red\s*Hat/i)
  if (withMatch) return withMatch[1].trim()

  // "PartnerName + Red Hat ..."
  const plusMatch = title.match(/^(.+?)\s*\+\s*Red\s*Hat/i)
  if (plusMatch) return plusMatch[1].trim()

  // "... by PartnerName"
  const byMatch = title.match(/by\s+(.+?)$/i)
  if (byMatch) return byMatch[1].trim()

  return ''
}

/**
 * Infer Red Hat platform from solution_type when target_platforms is missing.
 */
function inferPlatform(solutionType: string | undefined): string {
  if (!solutionType) return 'Red Hat Enterprise Linux'
  const lower = solutionType.toLowerCase()
  if (lower.includes('ansible')) return 'Ansible Automation Platform'
  if (lower.includes('openshift')) return 'OpenShift Container Platform'
  if (lower.includes('rhel') || lower.includes('enterprise linux')) return 'Red Hat Enterprise Linux'
  return solutionType
}

// ── Sync Function ────────────────────────────────────────────────────────────

const SOLR_URL = 'https://access.redhat.com/hydra/rest/search/kcs?redhat_client=ecosystem-catalog&q=*&fq=documentKind%3AEcoSolution&rows=500'
const PRM_BASE = 'https://connect.redhat.com/hydra/prm/v1/solutions'
const CONCURRENCY = 5

/**
 * Fetch resources for a single solution from the PRM API.
 * Fail-open: returns empty array on error.
 */
export async function fetchSolutionResources(solutionId: string): Promise<EcosystemResource[]> {
  try {
    const resp = await fetch(`${PRM_BASE}/${solutionId}/resources`, {
      headers: { Accept: 'application/json' },
    })
    if (!resp.ok) return []
    const data = (await resp.json()) as PrmResource[] | { resources?: PrmResource[]; items?: PrmResource[] }
    const items = Array.isArray(data) ? data : (data.resources || data.items || [])
    return items
      .filter((r): r is PrmResource => !!(r.title || r.name) && !!(r.url || r.link))
      .map(r => ({
        title: (r.title || r.name)!,
        url: (r.url || r.link)!,
        type: mapResourceType(r.resourceType?.code || r.type),
      }))
  } catch {
    return []
  }
}

/**
 * Run async tasks with bounded concurrency.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i])
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Sync ecosystem catalog from HYDRA APIs.
 *
 * 1. Fetch all solutions from SOLR (1 HTTP call)
 * 2. For each solution, fetch resources from PRM API (concurrency 5)
 * 3. Map SOLR fields to EcosystemSolution (§29)
 * 4. Group by partner, write per-partner JSON cache files
 * 5. Return count of solutions synced
 */
export async function syncEcosystemCatalog(): Promise<{ solutionCount: number; partnerCount: number }> {
  // Step 1: Fetch all solutions from SOLR
  const resp = await fetch(SOLR_URL, {
    headers: { Accept: 'application/json' },
  })
  if (!resp.ok) {
    throw new Error(`SOLR API returned ${resp.status}: ${resp.statusText}`)
  }
  const solrData = (await resp.json()) as SolrResponse
  const docs = solrData.response?.docs || []
  if (docs.length === 0) {
    throw new Error('SOLR API returned 0 solutions — refusing to overwrite cache with empty data')
  }

  // Step 2: Fetch resources per solution (concurrency-limited)
  const solutionIds = docs.map(d => {
    // Extract solution ID from view_uri or id field
    const uri = d.view_uri || d.uri || ''
    const uriMatch = uri.match(/\/detail\/([^/?#]+)/)
    return uriMatch?.[1] || d.id || ''
  })

  const resourceSets = await mapWithConcurrency(
    solutionIds,
    CONCURRENCY,
    async (id) => id ? fetchSolutionResources(id) : [],
  )

  // Step 3: Map SOLR docs to EcosystemSolution
  const solutions: EcosystemSolution[] = []
  for (let i = 0; i < docs.length; i++) {
    const solution = mapSolrDoc(docs[i], resourceSets[i])
    if (solution) solutions.push(solution)
  }

  // Step 4: Group by partner
  const byPartner = new Map<string, EcosystemSolution[]>()
  for (const sol of solutions) {
    const slug = sol.partnerSlug
    const group = byPartner.get(slug) ?? []
    group.push(sol)
    byPartner.set(slug, group)
  }

  // Step 5: Write per-partner cache files
  const cacheDir = getEcosystemCacheDir()
  mkdirSync(cacheDir, { recursive: true })

  const now = new Date().toISOString()
  for (const [slug, partnerSolutions] of byPartner) {
    const cache: EcosystemPartnerCache = {
      partnerName: partnerSolutions[0].partnerName,
      partnerSlug: slug,
      solutions: partnerSolutions,
      scrapedAt: now,
      solutionCount: partnerSolutions.length,
    }
    writeFileSync(resolve(cacheDir, `${slug}.json`), JSON.stringify(cache, null, 2))
  }

  return { solutionCount: solutions.length, partnerCount: byPartner.size }
}
