/**
 * Pipeline Manifest — per-document state machine for scraper pipeline (#874)
 *
 * Replaces the three fragmented metadata files (_completeness.json,
 * _failed-downloads.json, _extraction-manifest.json) with a single unified
 * manifest that tracks every document through Gates 0-3.
 *
 * Gate 0: DOM visibility — item appeared on the page
 * Gate 1: Scrape + dedup + language filter
 * Gate 2: Download acquisition
 * Gate 3: Gemini enrichment
 */

import { writeFileSync, readFileSync, existsSync, renameSync } from 'fs'
import { resolve } from 'path'

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineManifestEntry {
  name: string
  section: string
  source: ('dom' | 'cds' | 'api')[]
  language: string  // 'en' or ISO code
  gate0_visible: boolean
  gate1_scraped: boolean
  gate1_deduped: boolean
  gate2_downloaded: boolean
  gate2_acquisitionMethod: 'api-download' | 'viewer-download' | 'menu-download' | 'viewer-extraction' | 'not-acquired' | null
  gate2_downloadPath: string | null
  gate2_skippedReason: 'non-english' | 'duplicate' | 'video' | 'external-link' | 'too-large' | null
  gate3_enriched: boolean
  gate3_productsFound: number
  gate3_classificationsFound: number
  gate3_enrichmentOutcome: 'enriched' | 'skipped' | 'failed' | null
  gate3_enrichmentReason: string | null  // reason for skip/fail
}

export interface PipelineManifest {
  productSlug: string
  productName: string
  scrapedAt: string
  gates: {
    gate0_domItemCount: number
    gate0_apiItemCount: number
    gate1_scrapedCount: number
    gate1_dedupedCount: number
    gate1_filteredCount: number
    gate1_passRate: number  // scrapedCount / domItemCount
    gate1_blocked: boolean  // true if passRate < 0.80
    gate2_downloadedCount: number
    gate2_enrichedCount: number
    gate2_enrichmentCoverage: number  // enrichedCount / downloadedCount
    gate2_enrichmentAlert: boolean  // true if coverage < 0.60
  }
  documents: PipelineManifestEntry[]
}

// ── Manifest diff / regression detection (#874 PR 3) ────────────────────────

export interface ManifestDiff {
  newDocuments: string[]         // in current but not in previous
  removedDocuments: string[]     // in previous but not in current
  enrichmentRegression: string[] // was enriched in prev, not enriched in current
  enrichmentGain: string[]      // not enriched in prev, enriched in current
  coverageChange: number        // current coverage - previous coverage
}

/**
 * Compare current vs previous manifest and detect regressions.
 *
 * - New/removed documents by name
 * - Enrichment regression: docs that LOST enrichment between runs
 * - Coverage change: difference in enrichment coverage percentage
 *
 * Logs a warning when enrichmentRegression.length > 0 or coverageChange < -0.10.
 */
export function diffManifests(
  current: PipelineManifest,
  previous: PipelineManifest,
): ManifestDiff {
  const currentNames = new Set(current.documents.map(d => d.name))
  const previousNames = new Set(previous.documents.map(d => d.name))

  const newDocuments = current.documents
    .filter(d => !previousNames.has(d.name))
    .map(d => d.name)

  const removedDocuments = previous.documents
    .filter(d => !currentNames.has(d.name))
    .map(d => d.name)

  // Build enrichment maps
  const prevEnriched = new Set(
    previous.documents.filter(d => d.gate3_enriched).map(d => d.name),
  )
  const currEnriched = new Set(
    current.documents.filter(d => d.gate3_enriched).map(d => d.name),
  )

  // Enrichment regression: was enriched before, not now (only for docs that still exist)
  const enrichmentRegression = previous.documents
    .filter(d => d.gate3_enriched && currentNames.has(d.name) && !currEnriched.has(d.name))
    .map(d => d.name)

  // Enrichment gain: not enriched before, enriched now (only for docs that existed before)
  const enrichmentGain = current.documents
    .filter(d => d.gate3_enriched && previousNames.has(d.name) && !prevEnriched.has(d.name))
    .map(d => d.name)

  // Coverage change
  const prevCoverage = previous.gates.gate2_enrichmentCoverage ?? 0
  const currCoverage = current.gates.gate2_enrichmentCoverage ?? 0
  const coverageChange = currCoverage - prevCoverage

  // Log regression warnings
  if (enrichmentRegression.length > 0 || coverageChange < -0.10) {
    console.warn(
      `[pipeline-manifest] REGRESSION: ${enrichmentRegression.length} docs lost enrichment, coverage changed by ${coverageChange > 0 ? '+' : ''}${coverageChange.toFixed(2)}`,
    )
  }

  return {
    newDocuments,
    removedDocuments,
    enrichmentRegression,
    enrichmentGain,
    coverageChange,
  }
}

// ── Credential denylist ──────────────────────────────────────────────────────

const CREDENTIAL_PATTERNS = /\b(bearer|token|auth|cookie|session|authorization|api[_-]?key)\b/i

// ── Factory ──────────────────────────────────────────────────────────────────

export function createManifest(productSlug: string, productName: string): PipelineManifest {
  return {
    productSlug,
    productName,
    scrapedAt: new Date().toISOString(),
    gates: {
      gate0_domItemCount: 0,
      gate0_apiItemCount: 0,
      gate1_scrapedCount: 0,
      gate1_dedupedCount: 0,
      gate1_filteredCount: 0,
      gate1_passRate: 0,
      gate1_blocked: false,
      gate2_downloadedCount: 0,
      gate2_enrichedCount: 0,
      gate2_enrichmentCoverage: 0,
      gate2_enrichmentAlert: false,
    },
    documents: [],
  }
}

// ── Gate 0: DOM visibility ───────────────────────────────────────────────────

export function addGate0Entry(
  manifest: PipelineManifest,
  name: string,
  section: string,
  source: string[],
): void {
  manifest.documents.push({
    name,
    section,
    source: source as ('dom' | 'cds' | 'api')[],
    language: 'en',
    gate0_visible: true,
    gate1_scraped: true,
    gate1_deduped: true,
    gate2_downloaded: false,
    gate2_acquisitionMethod: null,
    gate2_downloadPath: null,
    gate2_skippedReason: null,
    gate3_enriched: false,
    gate3_productsFound: 0,
    gate3_classificationsFound: 0,
    gate3_enrichmentOutcome: null,
    gate3_enrichmentReason: null,
  })
  manifest.gates.gate0_domItemCount = manifest.documents.filter(d => d.source.includes('dom')).length
  manifest.gates.gate0_apiItemCount = manifest.documents.filter(d => d.source.includes('api') && !d.source.includes('dom')).length
}

// ── Gate 1: Scrape + dedup + filter ──────────────────────────────────────────

export function updateGate1(
  manifest: PipelineManifest,
  name: string,
  updates: Partial<PipelineManifestEntry>,
): void {
  const entry = manifest.documents.find(d => d.name === name)
  if (!entry) return
  Object.assign(entry, updates)
}

// ── Gate 2: Download ─────────────────────────────────────────────────────────

export function updateGate2(
  manifest: PipelineManifest,
  name: string,
  updates: Partial<PipelineManifestEntry>,
): void {
  const entry = manifest.documents.find(d => d.name === name)
  if (!entry) return
  Object.assign(entry, updates)
}

// ── Gate 3: Enrichment ───────────────────────────────────────────────────────

export function updateGate3(
  manifest: PipelineManifest,
  name: string,
  updates: Partial<PipelineManifestEntry>,
): void {
  let entry = manifest.documents.find(d => d.name === name)
  if (!entry) {
    entry = {
      name,
      section: 'enrichment',
      source: ['dom'] as ('dom' | 'cds' | 'api')[],
      language: 'en',
      gate0_visible: false,
      gate1_scraped: false,
      gate1_deduped: false,
      gate2_downloaded: false,
      gate2_acquisitionMethod: 'extracted',
      gate2_downloadPath: null,
      gate2_skippedReason: null,
      gate3_enriched: false,
      gate3_productsFound: 0,
      gate3_classificationsFound: 0,
      gate3_enrichmentOutcome: null,
      gate3_enrichmentReason: null,
    }
    manifest.documents.push(entry)
  }
  Object.assign(entry, updates)
}

// ── Summary computation ──────────────────────────────────────────────────────

export function computeGateSummary(manifest: PipelineManifest): void {
  const docs = manifest.documents
  const g = manifest.gates

  g.gate0_domItemCount = docs.filter(d => d.source.includes('dom') && d.gate0_visible).length
    || docs.filter(d => d.source.includes('dom')).length
    || docs.length  // fallback for legacy manifests without source tags
  g.gate0_apiItemCount = docs.filter(d => d.source.includes('api') && !d.source.includes('dom')).length
  g.gate1_scrapedCount = docs.filter(d => d.gate1_scraped).length
  g.gate1_dedupedCount = docs.filter(d => !d.gate1_deduped).length  // count of REMOVED dupes
  g.gate1_filteredCount = docs.filter(d => d.gate2_skippedReason === 'non-english').length
  g.gate1_passRate = g.gate0_domItemCount > 0
    ? g.gate1_scrapedCount / g.gate0_domItemCount
    : 0
  g.gate1_blocked = g.gate0_domItemCount > 0 && g.gate1_passRate < 0.80

  g.gate2_downloadedCount = docs.filter(d => d.gate2_downloaded).length
  g.gate2_enrichedCount = docs.filter(d => d.gate3_enriched).length
  const enrichableDocs = docs.filter(d => d.gate3_enrichmentOutcome !== null).length
  g.gate2_enrichmentCoverage = enrichableDocs > 0
    ? g.gate2_enrichedCount / enrichableDocs
    : 0
  g.gate2_enrichmentAlert = enrichableDocs > 0 && g.gate2_enrichmentCoverage < 0.60
}

// ── I/O ──────────────────────────────────────────────────────────────────────

const MANIFEST_FILENAME = '_pipeline-manifest.json'
const PREV_FILENAME = '_pipeline-manifest.prev.json'

export function writeManifest(manifest: PipelineManifest, outputDir: string): void {
  const sanitized = sanitizeManifestValues(manifest)
  const filePath = resolve(outputDir, MANIFEST_FILENAME)
  const prevPath = resolve(outputDir, PREV_FILENAME)

  // Diff against previous manifest BEFORE rotating (#874 PR 3)
  if (existsSync(filePath)) {
    try {
      const previousRaw = readFileSync(filePath, 'utf-8')
      const previous: PipelineManifest = JSON.parse(previousRaw)
      const diff = diffManifests(sanitized, previous)

      const parts: string[] = []
      if (diff.newDocuments.length > 0) parts.push(`+${diff.newDocuments.length} new`)
      if (diff.removedDocuments.length > 0) parts.push(`-${diff.removedDocuments.length} removed`)
      if (diff.enrichmentGain.length > 0) parts.push(`+${diff.enrichmentGain.length} enriched`)
      if (diff.enrichmentRegression.length > 0) parts.push(`${diff.enrichmentRegression.length} lost enrichment`)
      if (Math.abs(diff.coverageChange) > 0.01) {
        parts.push(`coverage ${diff.coverageChange > 0 ? '+' : ''}${(diff.coverageChange * 100).toFixed(1)}%`)
      }
      if (parts.length > 0) {
        console.log(`[pipeline-manifest] Diff: ${parts.join(', ')}`)
      }
    } catch {
      // Previous manifest unreadable — skip diff
    }
  }

  // Rotate previous manifest
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, prevPath)
    } catch {
      // Best-effort rotation — don't block write
    }
  }

  writeFileSync(filePath, JSON.stringify(sanitized, null, 2))
}

export function readManifest(outputDir: string): PipelineManifest | null {
  const filePath = resolve(outputDir, MANIFEST_FILENAME)
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

// ── Credential sanitization ──────────────────────────────────────────────────

export function sanitizeManifestValues(manifest: PipelineManifest): PipelineManifest {
  const json = JSON.stringify(manifest)
  // Walk all string values and redact anything matching credential patterns
  const sanitized = JSON.parse(json, (_key, value) => {
    if (typeof value === 'string' && CREDENTIAL_PATTERNS.test(value)) {
      return '[REDACTED]'
    }
    return value
  })
  return sanitized
}
