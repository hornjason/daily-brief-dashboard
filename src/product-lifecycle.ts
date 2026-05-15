// GitHub Issue #197 — Product lifecycle fetcher using endoflife.date API
// Fetches product lifecycle data for OCP, RHEL, and AAP from endoflife.date
// and caches it locally for Signal generation.

import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache')
const CACHE_PATH = resolve(CACHE_DIR, 'product-lifecycle.json')

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true })
}

// ── Type definitions ─────────────────────────────────────────────────────────

export interface ProductLifecycle {
  slug: string           // "ocp", "rhel", "aap"
  displayName: string    // "Red Hat OpenShift Container Platform"
  currentVersion: string // "4.20"
  latestPatch: string    // "4.20.4"
  nextVersion: string | null  // next cycle if known
  nextExpected: string | null // next releaseDate if future
  gaDate: string         // releaseDate of current version
  eolDate: string        // eol of current version
  eusAvailable: boolean  // extendedSupport !== false
  supportEnd: string     // support end date
}

export interface ProductLifecycleCache {
  products: ProductLifecycle[]
  fetchedAt: string  // ISO 8601
}

interface EndOfLifeCycle {
  cycle: string
  releaseDate: string
  eol: string | boolean
  latest: string
  latestReleaseDate: string
  lts?: boolean | string
  support?: boolean | string
  extendedSupport?: boolean | string
}

// ── Product mapping ──────────────────────────────────────────────────────────

const PRODUCTS = [
  {
    slug: 'ocp',
    displayName: 'Red Hat OpenShift Container Platform',
    url: 'https://endoflife.date/api/red-hat-openshift.json',
  },
  {
    slug: 'rhel',
    displayName: 'Red Hat Enterprise Linux',
    url: 'https://endoflife.date/api/rhel.json',
  },
  {
    slug: 'aap',
    displayName: 'Red Hat Ansible Automation Platform',
    url: 'https://endoflife.date/api/red-hat-ansible-automation-platform.json',
  },
]

// ── Helper functions ─────────────────────────────────────────────────────────

/**
 * Transform a single product's endoflife.date API response into our ProductLifecycle format.
 * The "current" version is the latest cycle with active support.
 * The "next" version is any future cycle (releaseDate > now).
 */
function transformProduct(slug: string, displayName: string, cycles: EndOfLifeCycle[]): ProductLifecycle {
  if (!cycles || cycles.length === 0) {
    throw new Error(`No cycles found for ${slug}`)
  }

  const now = new Date()

  // Find current version: latest cycle where support !== false and releaseDate is in the past
  const currentCycle = cycles.find(c => {
    const released = new Date(c.releaseDate) <= now
    const supported = c.support !== false
    return released && supported
  }) || cycles[0]  // fallback to latest if no supported version found

  // Find next version: earliest cycle with future releaseDate
  const futureCycles = cycles.filter(c => new Date(c.releaseDate) > now)
  const nextCycle = futureCycles.length > 0
    ? futureCycles.reduce((earliest, c) =>
        new Date(c.releaseDate) < new Date(earliest.releaseDate) ? c : earliest
      )
    : null

  // Parse EOL date (can be string or boolean)
  const eolDate = typeof currentCycle.eol === 'string'
    ? currentCycle.eol
    : currentCycle.eol === false
    ? 'N/A'
    : currentCycle.releaseDate  // fallback if eol is true

  // Parse support end date
  const supportEnd = typeof currentCycle.support === 'string'
    ? currentCycle.support
    : typeof currentCycle.eol === 'string'
    ? currentCycle.eol
    : 'N/A'

  // Check if extended support is available
  const eusAvailable = currentCycle.extendedSupport !== false && currentCycle.extendedSupport !== undefined

  return {
    slug,
    displayName,
    currentVersion: currentCycle.cycle,
    latestPatch: currentCycle.latest || currentCycle.cycle,  // Fallback to cycle if latest not available
    nextVersion: nextCycle?.cycle ?? null,
    nextExpected: nextCycle?.releaseDate ?? null,
    gaDate: currentCycle.releaseDate,
    eolDate,
    eusAvailable,
    supportEnd,
  }
}

// ── Main fetch function ──────────────────────────────────────────────────────

/**
 * Fetch lifecycle data for all products and write to cache.
 * Each product fetch is try/caught individually — if one fails, others still succeed.
 */
export async function fetchProductLifecycle(): Promise<void> {
  const products: ProductLifecycle[] = []

  for (const product of PRODUCTS) {
    try {
      console.log(`[product-lifecycle] fetching ${product.slug} from ${product.url}`)
      const response = await fetch(product.url)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const cycles: EndOfLifeCycle[] = await response.json()
      const lifecycle = transformProduct(product.slug, product.displayName, cycles)
      products.push(lifecycle)

      console.log(`[product-lifecycle] ${product.slug}: current=${lifecycle.currentVersion}, eol=${lifecycle.eolDate}`)
    } catch (e: any) {
      console.warn(`[product-lifecycle] failed to fetch ${product.slug}:`, e?.message ?? e)
      // Continue to next product — partial failure is acceptable
    }
  }

  const cache: ProductLifecycleCache = {
    products,
    fetchedAt: new Date().toISOString(),
  }

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 })
  console.log(`[product-lifecycle] cache written: ${products.length}/${PRODUCTS.length} products`)
}

// ── Cache reader ─────────────────────────────────────────────────────────────

/**
 * Read cached product lifecycle data.
 * Returns null if cache doesn't exist or is malformed.
 */
export function readProductLifecycleCache(): ProductLifecycleCache | null {
  try {
    if (!existsSync(CACHE_PATH)) {
      return null
    }

    const raw = require('fs').readFileSync(CACHE_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch (e: any) {
    console.warn('[product-lifecycle] failed to read cache:', e?.message ?? e)
    return null
  }
}
