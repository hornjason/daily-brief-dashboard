// src/lib/ecosystem-catalog.ts
// GitHub Issue #438 — Ecosystem Catalog (Phase 1: consumption layer)
// Types and cache loader for Red Hat technology partner ecosystem solutions.
// Reads cached JSON files from data/cache/ecosystem-catalog/*.json.
// Separate from partner-catalog.ts which handles specialized channel partners (CDW, WWT).

import { existsSync, readFileSync, readdirSync } from 'fs'
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
  const templateDir = resolve(process.env.CONFIG_DIR ?? 'config', '..', 'config-templates', 'ecosystem-catalog')
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
