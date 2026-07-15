// src/lib/territory-partner-generator.ts
// GitHub Issue #995 — Territory partners generation
// Reads pipeline data via extractPartnersFromFile(), maps to TerritoryPartner schema,
// merges with existing file (preserving enrichment fields), writes territory-partners.json.

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { extractPartnersFromFile } from './pipeline-partner-extractor.ts'
import { writeJsonAtomic } from './atomic-write.ts'
import { CACHE_DIR } from './paths.ts'

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
