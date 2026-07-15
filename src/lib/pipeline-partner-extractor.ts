// src/lib/pipeline-partner-extractor.ts
// GitHub Issue #993 — Pipeline partner name extraction
// Extracts unique partner names from pipeline opportunity name patterns.
// Pure extraction utility — no module registration, no disk writes.

import { readFileSync, existsSync } from 'fs'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CustomerAssociation {
  customerName: string
  oppNames: string[]
  oppCount: number
}

export interface ExtractedPartner {
  /** Canonical display name (first-seen casing) */
  name: string
  /** All casing variants encountered */
  aliases: string[]
  /** Customer associations with opp details */
  customerAssociations: CustomerAssociation[]
}

/** Minimal pipeline record shape needed for extraction */
export interface PipelineRecordInput {
  oppName: string
  accountName: string
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Opp name prefixes/suffixes that are not partners */
const OPP_PREFIXES = new Set([
  'rn', 'nn', 'dr', 'mqo', 'ob', 'sqo', 'new', 'renewal',
  'net new', 'hcs drawdown', 'deal reg', 'seap', 'spp', 'haea',
  'nn asp', 'dsor renewal', 'tbd', 'partner tbd', 'dr nn', 'cloud',
  'services', 'consulting', 'growth', 'hcs', 'hcs commitment',
  'hcs upside', 'drawdown', 'seap estimate', 'co-term', 'dsor',
  'corp self assessment', 'phase 1', 'phase 2', 'phase i', 'phase ii',
  'phase iii', 'global royalty', 'local royalty',
])

/** Red Hat product keywords — segment containing any of these is product, not partner */
const PRODUCT_KEYWORDS = [
  'rhel', 'ansible', 'openshift', 'ocp', 'aap', 'rosa', 'rhoai',
  'rhaie', 'jboss', 'runtimes', 'satellite', 'fuse', '3scale',
  'acs', 'quay', 'ceph', 'acm', 'odf', 'els', 'eus', 'amq',
  'sso', 'pam', 'rhde', 'virt', 'ocp virt', 'dev hub',
  'vmware', 'vmw', 'puppet', 'vma', 'oem', 'rhls',
  'training', 'openjdk', 'ai ops', 'aiops', 'developer hub',
  'trusted app', 'directory server', 'ccsp',
  'network automation', 'automation', 'renewal',
  'embedded', 'claim', 'private offer',
  'ove', 'aro', 'rh identified',
]

/** Short product keywords that require word-boundary matching */
const SHORT_PRODUCT_KEYWORDS = new Set([
  'acs', 'acm', 'odf', 'els', 'eus', 'amq', 'sso', 'pam', 'oem', 'vma', 'ai', 'ove', 'aro',
])

/** Patterns in opp names that are Red Hat programs, not partners */
const PROGRAM_EXCLUSIONS = [
  'level up program',
  'level up cloud pak',
  'openshift level up',
]

const ID_PATTERN = /^[0-9]{5,}$/
const PAREN_ID_PATTERN = /^\([0-9/,\s]+\)$/
const QUARTER_PATTERN = /^\(?q[1-4]\)?$/i
const DATE_PATTERN = /^(?:due\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/i
const YEAR_PATTERN = /^cy\d{2,4}(?:q\d)?$/i
const CCSP_PATTERN = /^(?:global|local)\s+royalty/i

/** Annotations inside parens that are NOT partner names */
const PAREN_ANNOTATIONS = new Set([
  'primary', 'new partner', 'us', 'pull fwd', 'bridge',
])

// ── Helpers ────────────────────────────────────────────────────────────────────

function isProductSegment(seg: string): boolean {
  const lower = seg.toLowerCase()
  for (const kw of PRODUCT_KEYWORDS) {
    if (SHORT_PRODUCT_KEYWORDS.has(kw)) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return true
    } else {
      if (lower.includes(kw)) return true
    }
  }
  return false
}

function isProgramExclusion(seg: string): boolean {
  const lower = seg.toLowerCase()
  return PROGRAM_EXCLUSIONS.some(p => lower.includes(p))
}

function isPrefix(seg: string): boolean {
  return OPP_PREFIXES.has(seg.toLowerCase().trim())
}

function isIdOrMeta(seg: string): boolean {
  const trimmed = seg.trim()
  if (ID_PATTERN.test(trimmed)) return true
  if (PAREN_ID_PATTERN.test(trimmed)) return true
  if (QUARTER_PATTERN.test(trimmed)) return true
  if (DATE_PATTERN.test(trimmed)) return true
  if (YEAR_PATTERN.test(trimmed)) return true
  if (/^\d{1,4}$/.test(trimmed)) return true // bare short numbers (months, days, years)
  if (/^negative adjustment/i.test(trimmed)) return true
  if (/^qty\s+\d+/i.test(trimmed)) return true
  if (/^m\d+$/i.test(trimmed)) return true // M1, M2 etc.
  if (/^us$/i.test(trimmed)) return true
  if (/^\*+/.test(trimmed)) return true // asterisk markers
  return false
}

/**
 * Check if a segment matches the account name (customer).
 * Fuzzy: substring match both directions, with common suffix stripping.
 */
function isCustomerSegment(seg: string, accountName: string): boolean {
  if (!accountName) return false
  const segLower = seg.toLowerCase().trim()
  const acctLower = accountName.toLowerCase().trim()

  if (segLower.length < 3) return false
  if (segLower === acctLower) return true

  // Strip common corporate suffixes for comparison
  const stripSuffixes = (s: string) =>
    s.replace(/,?\s*(?:inc\.?|llc|corp\.?|corporation|company|co\.?|ltd\.?|l\.?p\.?|llp|plc|pty|asia pacific)$/i, '').trim()

  const acctClean = stripSuffixes(acctLower)
  const segClean = stripSuffixes(segLower)

  // Segment contained in account name (or stripped version)
  if (acctClean.length >= 3 && acctClean.includes(segClean) && segClean.length >= 3) return true
  if (segClean.length >= 3 && segClean.includes(acctClean) && acctClean.length >= 3) return true

  // First meaningful word match for abbreviated references
  // e.g., "Hotwire" matches "Hotwire Communications, LLC"
  const acctWords = acctClean.split(/\s+/)
  if (acctWords[0] && acctWords[0].length >= 3 && segClean === acctWords[0]) return true

  return false
}

/** Check if segment looks like a person name (First Last pattern) */
function isPersonName(seg: string): boolean {
  const parts = seg.split(/\s+and\s+/i)
  return parts.every(part => {
    const words = part.trim().split(/\s+/)
    if (words.length < 2 || words.length > 4) return false
    // Each word must be ≥3 chars and Title Case — avoids false positives like "Level Up"
    return words.every(w => /^[A-Z][a-z]{2,}$/.test(w))
  })
}

/**
 * Extract a parenthesized partner name from a segment like "Newmont (WWT)".
 * Returns the extracted name or null if not a partner pattern.
 */
function extractParenPartner(seg: string): string | null {
  const match = seg.match(/\(([^)]+)\)/)
  if (!match) return null
  const inner = match[1].trim()
  // Skip numeric IDs, quarters, annotations
  if (/^[0-9/,\s]+$/.test(inner)) return null
  if (QUARTER_PATTERN.test(inner)) return null
  if (PAREN_ANNOTATIONS.has(inner.toLowerCase())) return null
  if (/^\*/.test(inner)) return null // asterisk annotations
  if (inner.length < 2) return null
  return inner
}

/**
 * Strip parenthesized annotations from a segment for cleaner classification.
 * e.g., "CDW (Primary)" → "CDW"
 */
function stripParenAnnotation(seg: string): string {
  return seg.replace(/\s*\([^)]*\)\s*/g, '').trim()
}

/**
 * Parse opp name into segments, handling ` - ` and `//` separators.
 * Falls back to `-` (no spaces) for compact formats.
 */
function parseSegments(oppName: string): string[] {
  // Normalize // separators to -
  let normalized = oppName.replace(/\s*\/\/\s*/g, ' - ')

  if (normalized.includes(' - ')) {
    return normalized.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean)
  }

  // Compact format: split on bare dashes
  if (normalized.includes('-')) {
    return normalized.split('-').map(s => s.trim()).filter(Boolean)
  }

  // Underscore-separated
  if (normalized.includes('_')) {
    return normalized.split('_').map(s => s.trim()).filter(Boolean)
  }

  return [normalized.trim()].filter(Boolean)
}

/**
 * Split a slash-separated segment into individual partner candidates.
 * Only splits when parts look like org names (not product combos).
 * e.g., "Arrow/CDW" → ["Arrow", "CDW"]
 * e.g., "RHEL/JBOSS" → [] (product combo, not partners)
 */
function splitSlashPartners(seg: string): string[] {
  if (!seg.includes('/')) return [seg]

  const parts = seg.split('/').map(s => s.trim()).filter(Boolean)

  // If any part is a product keyword, don't treat this as a partner pair
  const hasProduct = parts.some(p => isProductSegment(p))
  if (hasProduct) return []

  // If parts look like org names (short-ish, not IDs), return them
  return parts.filter(p => p.length >= 2 && !isIdOrMeta(p))
}

// ── Main extraction ────────────────────────────────────────────────────────────

/**
 * Extract partner names from a single opp record.
 * Returns an array of partner name strings found in this opp.
 */
function extractPartnersFromRecord(record: PipelineRecordInput): string[] {
  const { oppName, accountName } = record
  if (!oppName) return []

  // Skip CCSP royalty records — different naming convention
  if (CCSP_PATTERN.test(oppName)) return []

  const segments = parseSegments(oppName)
  const partners: string[] = []

  for (const rawSeg of segments) {
    // Check for parenthesized partner (e.g., "Newmont (WWT)")
    const parenPartner = extractParenPartner(rawSeg)
    if (parenPartner && !isProductSegment(parenPartner) && !isPrefix(parenPartner)) {
      partners.push(parenPartner)
    }

    // Strip paren annotations for remaining classification
    const seg = stripParenAnnotation(rawSeg)
    if (!seg) continue

    // Skip classified segments
    if (isPrefix(seg)) continue
    if (isCustomerSegment(seg, accountName)) continue
    if (isIdOrMeta(seg)) continue
    if (isProgramExclusion(seg)) continue
    if (isPersonName(seg)) continue

    // Handle slash-separated partner pairs
    if (seg.includes('/')) {
      const slashParts = splitSlashPartners(seg)
      for (const part of slashParts) {
        if (!isPrefix(part) && !isCustomerSegment(part, accountName) && !isIdOrMeta(part)) {
          partners.push(part)
        }
      }
      continue
    }

    // Skip product segments
    if (isProductSegment(seg)) continue

    // Skip very short segments (≤2 chars) that are likely noise
    if (seg.length <= 2) continue

    partners.push(seg)
  }

  return partners
}

/**
 * Extract unique partners from pipeline records with deduplication
 * and customer association tracking.
 *
 * Fail-open: returns empty array on invalid input.
 */
export function extractPartnersFromPipeline(records: PipelineRecordInput[]): ExtractedPartner[] {
  if (!records || !Array.isArray(records)) return []

  // Map: lowercased partner name → { canonicalName, aliases, associations }
  const partnerMap = new Map<string, {
    canonicalName: string
    aliases: Set<string>
    associations: Map<string, Set<string>> // customerName → set of oppNames
  }>()

  for (const record of records) {
    const partnerNames = extractPartnersFromRecord(record)
    const customerName = record.accountName?.trim() || 'Unknown'

    for (const name of partnerNames) {
      const key = name.toLowerCase()
      let entry = partnerMap.get(key)

      if (!entry) {
        entry = {
          canonicalName: name, // first-seen casing
          aliases: new Set([name]),
          associations: new Map(),
        }
        partnerMap.set(key, entry)
      } else {
        entry.aliases.add(name)
      }

      // Track customer association
      let oppSet = entry.associations.get(customerName)
      if (!oppSet) {
        oppSet = new Set()
        entry.associations.set(customerName, oppSet)
      }
      oppSet.add(record.oppName)
    }
  }

  // Convert to output format
  const results: ExtractedPartner[] = []
  for (const entry of partnerMap.values()) {
    const customerAssociations: CustomerAssociation[] = []
    for (const [customerName, oppNames] of entry.associations) {
      customerAssociations.push({
        customerName,
        oppNames: Array.from(oppNames),
        oppCount: oppNames.size,
      })
    }

    // Sort associations by opp count descending
    customerAssociations.sort((a, b) => b.oppCount - a.oppCount)

    results.push({
      name: entry.canonicalName,
      aliases: Array.from(entry.aliases),
      customerAssociations,
    })
  }

  // Sort by total opp count descending
  results.sort((a, b) => {
    const totalA = a.customerAssociations.reduce((sum, ca) => sum + ca.oppCount, 0)
    const totalB = b.customerAssociations.reduce((sum, ca) => sum + ca.oppCount, 0)
    return totalB - totalA
  })

  return results
}

/**
 * Filter noise: exclude partners with only 1 customer AND 1 opp (#1001).
 * Applied at the file-read level, not in the core extraction function.
 */
export function filterNoisePartners(partners: ExtractedPartner[]): ExtractedPartner[] {
  return partners.filter(p =>
    p.customerAssociations.length > 1 ||
    p.customerAssociations.reduce((sum, ca) => sum + ca.oppCount, 0) > 1
  )
}

/**
 * Extract partners from a pipeline data JSON file.
 * Expects `{ records: PipelineRecordInput[] }` or `PipelineRecordInput[]`.
 * Applies customer filter and noise filter automatically.
 * Fail-open: returns empty array on missing file or parse error.
 * @param customerNames - When provided, filters records to only loaded customers (#1001)
 */
export function extractPartnersFromFile(filePath: string, customerNames?: string[]): ExtractedPartner[] {
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    let records: PipelineRecordInput[] = Array.isArray(raw) ? raw : raw.records ?? []
    if (customerNames && customerNames.length > 0) {
      const lowerNames = customerNames.map(n => n.toLowerCase())
      records = records.filter(r => {
        const acct = r.accountName.toLowerCase()
        return lowerNames.some(cn => acct.includes(cn) || cn.includes(acct))
      })
    }
    return filterNoisePartners(extractPartnersFromPipeline(records))
  } catch {
    return []
  }
}
