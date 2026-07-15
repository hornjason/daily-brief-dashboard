// src/lib/territory-partner-generator.ts
// GitHub Issue #995 — Territory partners generation
// Reads pipeline data via extractPartnersFromFile(), maps to TerritoryPartner schema,
// merges with existing file (preserving enrichment fields), writes territory-partners.json.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { extractPartnersFromFile } from './pipeline-partner-extractor.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { CACHE_DIR } from './paths.ts'
import { getEcosystemCacheDir, type EcosystemPartnerCache } from './ecosystem-catalog.ts'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface TerritoryPartnerAssociation {
  customerName: string
  oppNames: string[]
  oppCount: number
}

export interface TerritoryPartner {
  name: string
  aliases: string[]
  domain: string | null
  enrichmentStatus: 'pending' | 'enriched' | 'not-found' | 'slug-unknown'
  partnershipLevel: string | null
  specializations: string[]
  catalogUrl: string | null
  customerAssociations: TerritoryPartnerAssociation[]
  extractedAt: string
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PIPELINE_DATA_PATH = resolve(CACHE_DIR, 'pipeline-data.json')
const TERRITORY_PARTNERS_PATH = resolve(CACHE_DIR, 'territory-partners.json')

/** Fields preserved from existing entries during incremental merge */
const ENRICHMENT_FIELDS = [
  'domain',
  'enrichmentStatus',
  'partnershipLevel',
  'specializations',
  'catalogUrl',
] as const

// ── Helpers ────────────────────────────────────────────────────────────────────

function readExistingPartners(path: string): TerritoryPartner[] {
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * Build a lookup map keyed by lowercased partner name for incremental merge.
 */
function buildExistingMap(partners: TerritoryPartner[]): Map<string, TerritoryPartner> {
  const map = new Map<string, TerritoryPartner>()
  for (const p of partners) {
    map.set(p.name.toLowerCase(), p)
  }
  return map
}

// ── Main ───────────────────────────────────────────────────────────────────────

/**
 * Generate territory partners from pipeline data.
 * Reads pipeline-data.json, extracts partners, merges with existing
 * territory-partners.json (preserving enrichment fields), and writes result.
 *
 * @param pipelinePath - Override path for pipeline data (default: CACHE_DIR/pipeline-data.json)
 * @param outputPath - Override path for output (default: CACHE_DIR/territory-partners.json)
 * @param customerNames - When provided, filters pipeline records to only loaded customers (#1001)
 * @returns Array of generated TerritoryPartner entries
 */
export function generateTerritoryPartners(
  pipelinePath: string = PIPELINE_DATA_PATH,
  outputPath: string = TERRITORY_PARTNERS_PATH,
  customerNames?: string[],
): TerritoryPartner[] {
  const extracted = extractPartnersFromFile(pipelinePath, customerNames)
  const existing = readExistingPartners(outputPath)
  const existingMap = buildExistingMap(existing)
  const now = new Date().toISOString()

  const partners: TerritoryPartner[] = extracted.map((ep) => {
    const prev = existingMap.get(ep.name.toLowerCase())

    // Merge: new extraction data + preserved enrichment from existing
    const partner: TerritoryPartner = {
      name: ep.name,
      aliases: ep.aliases,
      domain: prev?.domain ?? null,
      enrichmentStatus: prev?.enrichmentStatus ?? 'pending',
      partnershipLevel: prev?.partnershipLevel ?? null,
      specializations: prev?.specializations ?? [],
      catalogUrl: prev?.catalogUrl ?? null,
      customerAssociations: ep.customerAssociations.map((ca) => ({
        customerName: ca.customerName,
        oppNames: ca.oppNames,
        oppCount: ca.oppCount,
      })),
      extractedAt: now,
    }

    return partner
  })

  writeJsonAtomic(outputPath, partners)
  return partners
}

/**
 * Read territory partners from disk without regenerating.
 * @param path - Override path (default: CACHE_DIR/territory-partners.json)
 */
export function readTerritoryPartners(
  path: string = TERRITORY_PARTNERS_PATH,
): TerritoryPartner[] {
  return readExistingPartners(path)
}

// ── Ecosystem-First Seeding (#1002) ──────────────────────────────────────────

/**
 * Seed territory partners from ecosystem catalog cache + legacy partners.json.
 * Reads per-partner JSON files from ecosystem-catalog/ cache dir, extracts
 * unique partner names, merges with existing territory-partners.json and
 * legacy partners.json (preserving enrichment fields), writes result.
 *
 * @param outputPath - Override output path
 * @returns Array of seeded TerritoryPartner entries
 */
export function seedPartnersFromEcosystem(
  outputPath: string = TERRITORY_PARTNERS_PATH,
): TerritoryPartner[] {
  const existing = readExistingPartners(outputPath)
  const existingMap = buildExistingMap(existing)
  const now = new Date().toISOString()
  const seen = new Set<string>()
  const result: TerritoryPartner[] = []

  // Source 1: Ecosystem catalog cache files
  const ecoDir = getEcosystemCacheDir()
  if (existsSync(ecoDir)) {
    const files = readdirSync(ecoDir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      try {
        const cache: EcosystemPartnerCache = JSON.parse(readFileSync(resolve(ecoDir, file), 'utf-8'))
        if (!cache.partnerName) continue
        const key = cache.partnerName.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)

        const prev = existingMap.get(key)
        result.push({
          name: cache.partnerName,
          aliases: [cache.partnerName],
          domain: prev?.domain ?? null,
          enrichmentStatus: prev?.enrichmentStatus ?? 'pending',
          partnershipLevel: prev?.partnershipLevel ?? null,
          specializations: prev?.specializations ?? [],
          catalogUrl: prev?.catalogUrl ?? null,
          customerAssociations: prev?.customerAssociations ?? [],
          extractedAt: now,
        })
      } catch { /* skip malformed files */ }
    }
  }

  // Source 2: Legacy partners.json (known-good curated entries)
  const configDir = process.env.CONFIG_DIR ?? 'data/config'
  const legacyPath = resolve(configDir, 'partners.json')
  if (existsSync(legacyPath)) {
    try {
      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'))
      for (const lp of Array.isArray(legacy) ? legacy : []) {
        const key = (lp.name ?? '').toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)

        const prev = existingMap.get(key)
        result.push({
          name: lp.name,
          aliases: lp.aliases ?? [lp.name],
          domain: lp.domain ?? prev?.domain ?? null,
          enrichmentStatus: lp.partnershipLevel ? 'enriched' : (prev?.enrichmentStatus ?? 'pending'),
          partnershipLevel: lp.partnershipLevel ?? prev?.partnershipLevel ?? null,
          specializations: lp.specializations ?? prev?.specializations ?? [],
          catalogUrl: lp.catalogUrl ?? prev?.catalogUrl ?? null,
          customerAssociations: prev?.customerAssociations ?? [],
          extractedAt: now,
        })
      }
    } catch { /* skip malformed file */ }
  }

  writeJsonAtomic(outputPath, result)
  console.log(`[territory-partners] Seeded ${result.length} partners from ecosystem catalog (${seen.size - (existsSync(legacyPath) ? 1 : 0)} eco + legacy)`)
  return result
}
