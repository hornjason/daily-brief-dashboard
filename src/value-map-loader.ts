/**
 * Value Map Loader — reads the exported Red Hat Business Value Map deck
 * and returns per-product sections keyed by product slug.
 *
 * The text file lives at data/cache/value-maps/business-value-maps.txt
 * (110K chars of structured value propositions: business objectives,
 * business impact, solution enablers).
 *
 * Usage:
 *   import { getValueMap } from './value-map-loader.ts'
 *   const section = getValueMap('ocp')  // returns raw text or null
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR } from './lib/paths.ts'

// ── Slug → product display-name mapping ────────────────────────────────────
// These names match the "Value Map" headers in the exported deck.
const SLUG_TO_PRODUCT: Record<string, string[]> = {
  'ocp':  ['Red Hat OpenShift Container Platform', 'OpenShift Container Platform'],
  'rhel': ['Red Hat Enterprise Linux', 'Enterprise Linux'],
  'aap':  ['Red Hat Ansible Automation Platform', 'Ansible Automation Platform'],
  'acs':  ['Red Hat Advanced Cluster Security', 'Advanced Cluster Security'],
  'acm':  ['Red Hat Advanced Cluster Management', 'Advanced Cluster Management'],
  'quay': ['Red Hat Quay', 'Quay'],
  'rhoai':['Red Hat OpenShift AI', 'OpenShift AI'],
  'ods':  ['Red Hat OpenShift Data Science', 'OpenShift Data Science'],
  'rhdh': ['Red Hat Developer Hub', 'Developer Hub'],
  '3scale':['Red Hat 3scale API Management', '3scale'],
  'sso':  ['Red Hat Single Sign-On', 'Red Hat build of Keycloak'],
  'fuse': ['Red Hat Fuse', 'Red Hat Integration'],
  'amq':  ['Red Hat AMQ', 'AMQ Streams', 'AMQ Broker'],
  'satellite': ['Red Hat Satellite'],
  'insights':  ['Red Hat Insights'],
  'runtimes':  ['Red Hat Runtimes', 'Red Hat build of Quarkus'],
}

// ── In-memory cache ────────────────────────────────────────────────────────
let _cache: Map<string, string> | null = null

/**
 * Resolve the value-maps text file path.
 * Checks DATA_DIR env first (container), then falls back to relative path.
 */
function getValueMapPath(): string {
  return resolve(CACHE_DIR, 'value-maps/business-value-maps.txt')
}

/**
 * Parse the raw text file into sections keyed by slug.
 *
 * Strategy: scan for lines that look like product "Value Map" headers,
 * then capture everything between them as that product's section.
 * A header line typically contains the product name followed by "Value Map"
 * or just the product name as a standalone heading.
 */
function parseValueMaps(raw: string): Map<string, string> {
  const result = new Map<string, string>()

  // Build a reverse lookup: lowercase product name → slug
  const nameToSlug = new Map<string, string>()
  for (const [slug, names] of Object.entries(SLUG_TO_PRODUCT)) {
    for (const name of names) {
      nameToSlug.set(name.toLowerCase(), slug)
    }
  }

  // Split into lines for header detection
  const lines = raw.split('\n')

  // Find header positions: lines containing a known product name + "value map"
  // or just the product name as a section header (all-caps or title case, standalone)
  interface HeaderMatch { lineIndex: number; slug: string }
  const headers: HeaderMatch[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase()
    if (!line) continue

    for (const [name, slug] of nameToSlug.entries()) {
      if (line.includes(name) && (line.includes('value map') || line.includes('business value'))) {
        headers.push({ lineIndex: i, slug })
        break
      }
    }
  }

  // If structured headers found, extract sections between them
  if (headers.length > 0) {
    for (let h = 0; h < headers.length; h++) {
      const start = headers[h].lineIndex
      const end = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length
      const section = lines.slice(start, end).join('\n').trim()
      if (section) {
        // Only set if not already captured (first match wins for a slug)
        if (!result.has(headers[h].slug)) {
          result.set(headers[h].slug, section)
        }
      }
    }
  }

  // Fallback: if no structured headers were found, try a simpler approach —
  // look for lines that exactly match or start with a known product name
  if (result.size === 0) {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      const lower = trimmed.toLowerCase()
      for (const [name, slug] of nameToSlug.entries()) {
        if (lower === name || lower.startsWith(name + ' ') || lower.startsWith(name + ':')) {
          // Find the next product name line
          let endIdx = lines.length
          for (let j = i + 1; j < lines.length; j++) {
            const jLower = lines[j].trim().toLowerCase()
            for (const [n2] of nameToSlug.entries()) {
              if (jLower === n2 || jLower.startsWith(n2 + ' ') || jLower.startsWith(n2 + ':')) {
                endIdx = j
                break
              }
            }
            if (endIdx !== lines.length) break
          }
          const section = lines.slice(i, endIdx).join('\n').trim()
          if (section && !result.has(slug)) {
            result.set(slug, section)
          }
          break
        }
      }
    }
  }

  return result
}

/**
 * Get the business value map section for a product slug.
 * Returns the raw text section or null if not found / file missing.
 *
 * Results are cached in memory after first read.
 */
export function getValueMap(slug: string): string | null {
  if (!_cache) {
    const path = getValueMapPath()
    if (!existsSync(path)) {
      console.warn(`[value-map-loader] File not found: ${path}`)
      _cache = new Map() // cache the miss so we don't re-check every call
      return null
    }
    try {
      const raw = readFileSync(path, 'utf-8')
      _cache = parseValueMaps(raw)
      console.log(`[value-map-loader] Parsed ${_cache.size} product sections from ${path}`)
    } catch (e: any) {
      console.error(`[value-map-loader] Failed to read/parse: ${e?.message}`)
      _cache = new Map()
      return null
    }
  }
  return _cache.get(slug) ?? null
}

/**
 * Force reload from disk (e.g., after file update).
 */
export function clearValueMapCache(): void {
  _cache = null
}

/**
 * List all slugs that have value map content.
 */
export function getAvailableValueMapSlugs(): string[] {
  // Trigger load if not cached
  getValueMap('__probe__')
  return _cache ? [..._cache.keys()] : []
}
