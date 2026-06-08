/**
 * Competitive Vocabulary Resolver — GitHub Issue #680
 *
 * Shared module that resolves competitor/third-party technology names
 * to Red Hat displacement products and solution plays. Replaces the 86
 * hardcoded DISPLACEMENT_KEYWORDS in motion-builder.ts.
 *
 * Data sources (fallback chain):
 * 1. competitive-intel cache (data/cache/competitive-intel/decks.json)
 *    — Gemini-extracted competitive data from slide decks
 * 2. solution-plays.json (config/ or config-templates/)
 *    — seed data with triggerTechnologies per play
 *
 * Lazy singleton — builds displacement map on first call, caches in memory.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { CONFIG_DIR, CACHE_DIR } from './paths.ts'

// ── Optional product-vocabulary integration ──────────────────────────────────
// product-vocabulary.ts (#676) may not be merged yet. Use dynamic import with
// fallback to keep this module self-contained.

let _resolveToSlug: ((input: string) => string | null) | null = null
let _resolveToDisplayName: ((slug: string) => string | null) | null = null
let _productVocabLoaded = false

async function loadProductVocabulary(): Promise<void> {
  if (_productVocabLoaded) return
  _productVocabLoaded = true
  try {
    const vocabPath = resolve(import.meta.dir, 'product-vocabulary.ts')
    if (existsSync(vocabPath)) {
      const mod = await import(vocabPath)
      _resolveToSlug = mod.resolveToSlug
      _resolveToDisplayName = mod.resolveToDisplayName
    }
  } catch {
    // product-vocabulary not available yet — use fallback slug→displayName map
  }
}

// Synchronous init attempt — best-effort at module load time
try {
  const vocabPath = resolve(import.meta.dir, 'product-vocabulary.ts')
  if (existsSync(vocabPath)) {
    // Dynamic require to avoid static analysis errors when file doesn't exist
    const mod = require(vocabPath)
    _resolveToSlug = mod.resolveToSlug
    _resolveToDisplayName = mod.resolveToDisplayName
    _productVocabLoaded = true
  }
} catch {
  // Not available — will use built-in fallback
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface DisplacementEntry {
  /** Display name of the Red Hat product that displaces */
  redHat: string
  /** Red Hat product slug */
  slug: string
  /** Technology Decision Point category */
  tdp: string
  /** Matching solution play IDs */
  plays: string[]
}

interface SolutionPlay {
  id: string
  name: string
  tdp: string
  triggerTechnologies: string[]
  redHatProducts: string[]
  [key: string]: unknown
}

interface SolutionPlaysConfig {
  version: number
  tdps: string[]
  plays: SolutionPlay[]
}

/** Competitive-intel cache types (from competitive-intel-module.ts) */
interface CompetitiveExtraction {
  competitor: string
  product: string
  announcement: string
  redHatCounter: string
  salesTriggers: string[]
  compensation: string | null
  keyDates: string[]
}

interface DeckCache {
  deckId: string
  deckName: string
  deckDate: string
  contentHash: string
  extractions: CompetitiveExtraction[]
  cachedAt: string
}

interface CompetitiveIntelCache {
  decks: DeckCache[]
  emailSearchTerms: string[]
  lastRefreshed: string
}

// ── Known vendor prefixes ────────────────────────────────────────────────────
// Company names extracted as vendor prefixes for fuzzy matching in
// customer-solution-context.ts. These are canonical vendor/company names,
// not product names.

const VENDOR_NAMES = new Set([
  'vmware', 'broadcom', 'cisco', 'juniper', 'arista', 'hashicorp',
  'puppet', 'chef', 'progress', 'citrix', 'ibm', 'microsoft',
  'amazon', 'aws', 'google', 'oracle', 'suse', 'rancher',
  'pivotal', 'docker', 'datadog', 'splunk', 'dynatrace',
  'new relic', 'palo alto', 'fortinet', 'checkpoint', 'crowdstrike',
  'carbon black', 'aqua security', 'sysdig', 'snyk', 'twistlock',
  'prisma cloud', 'f5', 'nutanix', 'red hat',
])

// ── Lazy Singleton ───────────────────────────────────────────────────────────

let _displacementMap: Map<string, DisplacementEntry> | null = null
let _playTriggers: Map<string, string[]> | null = null

// ── Data Loading ─────────────────────────────────────────────────────────────

function loadSolutionPlays(): SolutionPlaysConfig | null {
  const paths = [
    resolve(CONFIG_DIR, 'solution-plays.json'),
    resolve('config-templates', 'solution-plays.json'),
  ]

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, 'utf-8'))
      }
    } catch { /* try next */ }
  }

  return null
}

function loadCompetitiveIntelCache(): CompetitiveIntelCache | null {
  try {
    const cachePath = resolve(CACHE_DIR, 'competitive-intel', 'decks.json')
    if (!existsSync(cachePath)) return null
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch {
    return null
  }
}

/** Built-in slug → display name mapping (fallback when product-vocabulary unavailable) */
const SLUG_DISPLAY_NAMES: Record<string, string> = {
  ocp: 'Red Hat OpenShift Container Platform',
  rhel: 'Red Hat Enterprise Linux',
  aap: 'Red Hat Ansible Automation Platform',
  acs: 'Red Hat Advanced Cluster Security',
  acm: 'Red Hat Advanced Cluster Management',
  rhoai: 'Red Hat OpenShift AI',
  rhdh: 'Red Hat Developer Hub',
  quay: 'Red Hat Quay',
  satellite: 'Red Hat Satellite',
  insights: 'Red Hat Insights',
}

/**
 * Resolve a product slug to its display name, with fallback.
 * Uses product-vocabulary first, then built-in map, then uppercase slug.
 */
function slugToDisplayName(slug: string): string {
  if (_resolveToDisplayName) {
    const display = _resolveToDisplayName(slug)
    if (display) return display
  }
  return SLUG_DISPLAY_NAMES[slug] ?? slug.toUpperCase()
}

// ── Map Building ─────────────────────────────────────────────────────────────

function buildMaps(): { displacement: Map<string, DisplacementEntry>; playTriggers: Map<string, string[]> } {
  const displacement = new Map<string, DisplacementEntry>()
  const playTriggers = new Map<string, string[]>()

  // ── Source 1: solution-plays.json (always loaded as base) ──────────────
  const config = loadSolutionPlays()
  if (config?.plays) {
    for (const play of config.plays) {
      // Store play → trigger technologies mapping
      playTriggers.set(play.id, play.triggerTechnologies ?? [])

      // Resolve the primary Red Hat product for this play
      const primarySlug = play.redHatProducts?.[0] ?? ''
      const displayName = slugToDisplayName(primarySlug)

      for (const tech of play.triggerTechnologies ?? []) {
        const key = tech.toLowerCase()

        if (displacement.has(key)) {
          // Aggregate plays for technologies that appear in multiple plays
          const existing = displacement.get(key)!
          if (!existing.plays.includes(play.id)) {
            existing.plays.push(play.id)
          }
        } else {
          displacement.set(key, {
            redHat: displayName,
            slug: primarySlug,
            tdp: play.tdp,
            plays: [play.id],
          })
        }
      }
    }
  }

  // ── Source 2: competitive-intel cache (overlay on top of seed data) ────
  const cache = loadCompetitiveIntelCache()
  if (cache?.decks) {
    for (const deck of cache.decks) {
      for (const extraction of deck.extractions ?? []) {
        const key = extraction.competitor.toLowerCase()

        // Try to resolve the competitor's product to a Red Hat slug
        const slug = _resolveToSlug
          ? (_resolveToSlug(extraction.product) ?? _resolveToSlug(extraction.competitor))
          : null

        if (slug) {
          const displayName = slugToDisplayName(slug)

          if (displacement.has(key)) {
            // Competitive intel enriches existing entries but doesn't replace
            // seed data — it may add additional context
          } else {
            // Find which TDP this slug maps to from solution-plays
            let tdp = ''
            const matchingPlays: string[] = []
            if (config?.plays) {
              for (const play of config.plays) {
                if (play.redHatProducts?.includes(slug)) {
                  if (!tdp) tdp = play.tdp
                  matchingPlays.push(play.id)
                }
              }
            }

            displacement.set(key, {
              redHat: displayName,
              slug,
              tdp: tdp || 'General',
              plays: matchingPlays,
            })
          }
        }
      }
    }
  }

  return { displacement, playTriggers }
}

function ensureMaps(): void {
  if (!_displacementMap || !_playTriggers) {
    const { displacement, playTriggers } = buildMaps()
    _displacementMap = displacement
    _playTriggers = playTriggers
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a competitor/technology name to its Red Hat displacement entry.
 * Case-insensitive lookup.
 *
 * @param competitor - The competitor or technology name to look up
 * @returns DisplacementEntry or null if unknown
 */
export function resolveDisplacement(competitor: string): DisplacementEntry | null {
  if (!competitor) return null
  ensureMaps()

  // Try exact lowercase match
  const key = competitor.toLowerCase()
  return _displacementMap!.get(key) ?? null
}

/**
 * Get trigger technologies for a specific solution play.
 *
 * @param playId - The solution play ID (e.g., 'vmware-migration')
 * @returns Array of trigger technology names, or empty array if play not found
 */
export function getTriggerTechnologies(playId: string): string[] {
  ensureMaps()
  return _playTriggers!.get(playId) ?? []
}

/**
 * Get all known competitor/technology names (lowercase).
 *
 * @returns Array of lowercase competitor names
 */
export function getAllCompetitors(): string[] {
  ensureMaps()
  return Array.from(_displacementMap!.keys())
}

/**
 * Get the full displacement map.
 *
 * @returns Map of lowercase competitor name to DisplacementEntry
 */
export function getDisplacementMap(): Map<string, DisplacementEntry> {
  ensureMaps()
  return new Map(_displacementMap!)
}

/**
 * Get unique vendor/company prefixes from the displacement map.
 * Used by customer-solution-context.ts to strip vendor names during fuzzy matching.
 *
 * @returns Array of lowercase vendor prefix strings
 */
export function getVendorPrefixes(): string[] {
  ensureMaps()

  // Combine hardcoded vendor names with vendor-like entries from the map
  const prefixes = new Set(VENDOR_NAMES)

  // Also extract single-word company-like prefixes from multi-word map keys
  for (const key of _displacementMap!.keys()) {
    const parts = key.split(/\s+/)
    if (parts.length >= 2) {
      // Multi-word entries: the first word is often the vendor name
      const vendor = parts[0]
      if (vendor.length > 2 && VENDOR_NAMES.has(vendor)) {
        prefixes.add(vendor)
      }
    }
  }

  return Array.from(prefixes)
}

/**
 * Reset the cached displacement map. For testing only.
 */
export function resetCache(): void {
  _displacementMap = null
  _playTriggers = null
}
