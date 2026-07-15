/**
 * Partner Detection Module — GitHub Issue #994
 * Tier 1 signal producer: detects partners already involved with a customer
 * by scanning pipeline opp names, meeting attendee domains, and email
 * sender/recipient domains from meeting-context cache.
 *
 * Emits `partner-detected` signals with evidence metadata.
 * Parent: #992 — Partner Intelligence
 * Dependency: #993 — Pipeline Partner Extraction (shipped)
 */

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from '../lib/atomic-write.ts'
import { CACHE_DIR } from '../lib/paths.ts'
import { extractPartnersFromFile, type ExtractedPartner } from '../lib/pipeline-partner-extractor.ts'
import { detectPartnerDomains, deriveCompanyFromDomain } from '../lib/domain-detection.ts'

// ── Configuration ───────────────────────────────────────────────────────────

const PARTNER_DETECTION_CACHE_DIR = resolve(CACHE_DIR, 'partner-detection')
const MEETING_CONTEXT_CACHE_DIR = resolve(CACHE_DIR, 'meeting-context')
const PIPELINE_DATA_PATH = resolve(CACHE_DIR, 'pipeline-data.json')
const CACHE_TTL_MS = 4 * 60 * 60 * 1000  // 4 hours

// ── Types ───────────────────────────────────────────────────────────────────

interface EvidenceSource {
  type: 'pipeline' | 'attendee' | 'email'
  detail: string
}

interface DetectedPartner {
  partnerName: string
  domain?: string
  oppNames: string[]
  confidence: 'high' | 'medium' | 'low'
  evidenceSources: EvidenceSource[]
}

interface PartnerDetectionCache {
  cachedAt: string
  partners: DetectedPartner[]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCachePath(slug: string): string {
  return resolve(PARTNER_DETECTION_CACHE_DIR, `${slug}.json`)
}

function readCache(slug: string): PartnerDetectionCache | null {
  const path = getCachePath(slug)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function writeCache(slug: string, data: PartnerDetectionCache): void {
  if (!existsSync(PARTNER_DETECTION_CACHE_DIR)) {
    mkdirSync(PARTNER_DETECTION_CACHE_DIR, { recursive: true })
  }
  writeJsonAtomic(getCachePath(slug), data)
}

function isCacheFresh(slug: string): boolean {
  const cache = readCache(slug)
  if (!cache) return false
  const age = Date.now() - new Date(cache.cachedAt).getTime()
  return age < CACHE_TTL_MS
}

/**
 * Read the meeting-context cache for a customer slug.
 * Returns the parsed cache or null if missing/invalid.
 */
function readMeetingContextCache(slug: string): any | null {
  const path = resolve(MEETING_CONTEXT_CACHE_DIR, `${slug}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Compute rawRelevance based on evidence source count.
 * Single source: 0.70, two sources: 0.78, three sources: 0.85.
 */
function computeRawRelevance(sourceCount: number): number {
  if (sourceCount <= 1) return 0.70
  if (sourceCount >= 3) return 0.85
  // Linear interpolation for 2 sources
  return 0.70 + ((sourceCount - 1) / 2) * 0.15
}

/**
 * Compute confidence level based on evidence count.
 */
function computeConfidence(sourceCount: number): 'high' | 'medium' | 'low' {
  if (sourceCount >= 3) return 'high'
  if (sourceCount >= 2) return 'medium'
  return 'low'
}

// ── Detection Logic ─────────────────────────────────────────────────────────

/**
 * Source 1: Detect partners from pipeline opp names for a given customer.
 * Uses extractPartnersFromFile() from #993, then filters to this customer's opps.
 */
function detectFromPipeline(
  customerName: string,
  customerAliases: string[],
): Map<string, { partnerName: string; oppNames: string[]; domain?: string }> {
  const allPartners = extractPartnersFromFile(PIPELINE_DATA_PATH)
  const result = new Map<string, { partnerName: string; oppNames: string[]; domain?: string }>()

  const matchNames = [customerName, ...customerAliases].map(n => n.toLowerCase())

  for (const partner of allPartners) {
    // Filter to associations that match this customer
    const matching = partner.customerAssociations.filter(ca =>
      matchNames.some(mn => ca.customerName.toLowerCase().includes(mn) || mn.includes(ca.customerName.toLowerCase()))
    )

    if (matching.length === 0) continue

    const oppNames = matching.flatMap(ca => ca.oppNames)
    const key = partner.name.toLowerCase()
    result.set(key, {
      partnerName: partner.name,
      oppNames,
    })
  }

  return result
}

/**
 * Source 2: Detect partner domains from meeting attendee emails in meeting-context cache.
 * Cross-references attendee domains against known customer domains.
 */
function detectFromAttendees(
  slug: string,
  customerDomain: string,
  customerAliasDomains: string[],
): Map<string, { domain: string; companyName: string }> {
  const result = new Map<string, { domain: string; companyName: string }>()
  const meetingCache = readMeetingContextCache(slug)
  if (!meetingCache?.signals) return result

  const customerDomains = [customerDomain, ...customerAliasDomains].filter(Boolean) as string[]

  for (const signal of meetingCache.signals) {
    const attendeeEmails: string[] = signal.attendeeEmails ?? []
    for (const email of attendeeEmails) {
      if (email.endsWith('@redhat.com')) continue
      const domain = email.split('@')[1]?.toLowerCase() ?? ''
      if (!domain) continue
      // Skip customer domains
      if (customerDomains.some(cd => domain.endsWith(cd))) continue
      // Skip common freemail domains
      if (isFreemailDomain(domain)) continue

      if (!result.has(domain)) {
        result.set(domain, {
          domain,
          companyName: deriveCompanyFromDomain(email),
        })
      }
    }
  }

  return result
}

/**
 * Source 3: Detect partner domains from email thread participants in meeting-context cache.
 * The meeting-context cache stores sourceThreadIds — we extract domains from thread data
 * embedded in the cache signals.
 */
function detectFromEmailThreads(
  slug: string,
  customerDomain: string,
  customerAliasDomains: string[],
): Map<string, { domain: string; companyName: string }> {
  const result = new Map<string, { domain: string; companyName: string }>()
  const meetingCache = readMeetingContextCache(slug)
  if (!meetingCache?.signals) return result

  const customerDomains = [customerDomain, ...customerAliasDomains].filter(Boolean) as string[]

  for (const signal of meetingCache.signals) {
    // Extract domains from all available email-related data in the signal
    // Meeting-context signals may contain thread participant emails
    const allEmails: string[] = [
      ...(signal.attendeeEmails ?? []),
      ...(signal.threadParticipants ?? []),
    ]

    for (const email of allEmails) {
      if (email.endsWith('@redhat.com')) continue
      const domain = email.split('@')[1]?.toLowerCase() ?? ''
      if (!domain) continue
      if (customerDomains.some(cd => domain.endsWith(cd))) continue
      if (isFreemailDomain(domain)) continue

      if (!result.has(domain)) {
        result.set(domain, {
          domain,
          companyName: deriveCompanyFromDomain(email),
        })
      }
    }
  }

  return result
}

/**
 * Common freemail domains to exclude from partner detection.
 */
function isFreemailDomain(domain: string): boolean {
  const freemailDomains = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
    'aol.com', 'icloud.com', 'mail.com', 'protonmail.com',
    'live.com', 'msn.com', 'me.com',
  ])
  return freemailDomains.has(domain.toLowerCase())
}

/**
 * Merge all three detection sources into a unified partner list.
 * Cross-references pipeline partner names with attendee/email domains.
 */
function mergeDetections(
  pipelinePartners: Map<string, { partnerName: string; oppNames: string[]; domain?: string }>,
  attendeeDomains: Map<string, { domain: string; companyName: string }>,
  emailDomains: Map<string, { domain: string; companyName: string }>,
): DetectedPartner[] {
  // Build a map keyed by partner name (lowercased) for merging
  const merged = new Map<string, DetectedPartner>()

  // Start with pipeline partners
  for (const [key, pp] of pipelinePartners) {
    merged.set(key, {
      partnerName: pp.partnerName,
      domain: pp.domain,
      oppNames: pp.oppNames,
      confidence: 'low',
      evidenceSources: [{
        type: 'pipeline',
        detail: `Found in ${pp.oppNames.length} pipeline opp(s): ${pp.oppNames.slice(0, 3).join(', ')}`,
      }],
    })
  }

  // Cross-reference attendee domains against pipeline partners by company name
  for (const [domain, ad] of attendeeDomains) {
    const nameKey = ad.companyName.toLowerCase()
    // Try to match against existing pipeline partner
    const existing = merged.get(nameKey) ?? findByPartialMatch(merged, nameKey)

    if (existing) {
      existing.domain = existing.domain ?? domain
      existing.evidenceSources.push({
        type: 'attendee',
        detail: `Attendee domain: ${domain}`,
      })
    } else {
      // New partner from attendee domain only
      merged.set(domain, {
        partnerName: ad.companyName,
        domain,
        oppNames: [],
        confidence: 'low',
        evidenceSources: [{
          type: 'attendee',
          detail: `Attendee domain: ${domain}`,
        }],
      })
    }
  }

  // Cross-reference email domains
  for (const [domain, ed] of emailDomains) {
    // Check if already found in attendee detection
    let found = false
    for (const partner of merged.values()) {
      if (partner.domain === domain) {
        // Add email evidence source if not already present
        if (!partner.evidenceSources.some(es => es.type === 'email')) {
          partner.evidenceSources.push({
            type: 'email',
            detail: `Email participant domain: ${domain}`,
          })
        }
        found = true
        break
      }
    }

    if (!found) {
      const nameKey = ed.companyName.toLowerCase()
      const existing = merged.get(nameKey)
      if (existing) {
        existing.domain = existing.domain ?? domain
        if (!existing.evidenceSources.some(es => es.type === 'email')) {
          existing.evidenceSources.push({
            type: 'email',
            detail: `Email participant domain: ${domain}`,
          })
        }
      } else {
        merged.set(domain, {
          partnerName: ed.companyName,
          domain,
          oppNames: [],
          confidence: 'low',
          evidenceSources: [{
            type: 'email',
            detail: `Email participant domain: ${domain}`,
          }],
        })
      }
    }
  }

  // Update confidence based on evidence count
  for (const partner of merged.values()) {
    partner.confidence = computeConfidence(partner.evidenceSources.length)
  }

  return Array.from(merged.values())
}

/**
 * Find a partner in the merged map by partial name match.
 */
function findByPartialMatch(
  map: Map<string, DetectedPartner>,
  nameKey: string,
): DetectedPartner | undefined {
  for (const [key, partner] of map) {
    if (key.includes(nameKey) || nameKey.includes(key)) {
      return partner
    }
    // Also check the partner name lowercased
    if (partner.partnerName.toLowerCase().includes(nameKey) ||
        nameKey.includes(partner.partnerName.toLowerCase())) {
      return partner
    }
  }
  return undefined
}

// ── Core Detection ──────────────────────────────────────────────────────────

/**
 * Run partner detection for a customer slug.
 * Scans three sources: pipeline opps, meeting attendees, email threads.
 */
async function detectForCustomer(customerSlug: string): Promise<DetectedPartner[]> {
  const { customers } = await import('../server-state.ts')
  const { toSlug } = await import('../cache-layer.ts')
  const customer = customers.find((c: any) => toSlug(c.name) === customerSlug)
  if (!customer) return []

  const customerName = customer.name
  const customerAliases = customer.aliases ?? []
  const customerDomain = customer.domain ?? ''
  const customerAliasDomains = customer.aliasDomains ?? []

  // Source 1: Pipeline opps
  const pipelinePartners = detectFromPipeline(customerName, customerAliases)

  // Source 2: Meeting attendee domains
  const attendeeDomains = detectFromAttendees(
    customerSlug, customerDomain, customerAliasDomains,
  )

  // Source 3: Email thread participant domains
  const emailDomains = detectFromEmailThreads(
    customerSlug, customerDomain, customerAliasDomains,
  )

  // Merge all sources
  return mergeDetections(pipelinePartners, attendeeDomains, emailDomains)
}

// ── Module Registration ─────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'partner-detection',
  displayName: 'Partner Detection',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  cacheTtlMs: CACHE_TTL_MS,
  refreshEndpoint: '/api/customer/_global/modules/partner-detection/sync',

  cachePaths: (slug: string) => [getCachePath(slug)],

  async fetch(): Promise<void> {},

  async cleanup(customerName: string): Promise<void> {
    const { toSlug } = await import('../cache-layer.ts')
    const slug = toSlug(customerName)
    const path = getCachePath(slug)
    if (existsSync(path)) {
      const { unlinkSync } = await import('fs')
      unlinkSync(path)
    }
  },

  async syncNow(customerName: string): Promise<void> {
    if (!customerName || customerName === '_global') return
    const { toSlug } = await import('../cache-layer.ts')
    const slug = toSlug(customerName)

    const partners = await detectForCustomer(slug)
    const cache: PartnerDetectionCache = {
      cachedAt: new Date().toISOString(),
      partners,
    }
    writeCache(slug, cache)
    FeatureModuleRegistry.recordOutcome('partner-detection', {
      success: true,
      recordCount: partners.length,
    })
  },

  async ensureFresh(customerSlug: string): Promise<void> {
    if (isCacheFresh(customerSlug)) return
    const partners = await detectForCustomer(customerSlug)
    const cache: PartnerDetectionCache = {
      cachedAt: new Date().toISOString(),
      partners,
    }
    writeCache(customerSlug, cache)
  },

  usesGemini: false,

  async signals(customerSlug: string): Promise<Signal[]> {
    const cache = readCache(customerSlug)
    if (!cache || !cache.partners || cache.partners.length === 0) return []

    return cache.partners.map(partner => ({
      source: 'partner-detected' as const,
      type: 'meeting' as const,
      headline: `Partner detected: ${partner.partnerName}`,
      detail: partner.oppNames.length > 0
        ? `${partner.partnerName} found in ${partner.oppNames.length} pipeline opp(s)${partner.domain ? ` (domain: ${partner.domain})` : ''}`
        : `${partner.partnerName} detected via ${partner.evidenceSources.map(es => es.type).join(', ')}${partner.domain ? ` (domain: ${partner.domain})` : ''}`,
      rawRelevance: computeRawRelevance(partner.evidenceSources.length),
      timestamp: cache.cachedAt,
      metadata: {
        customerSlug,
        partnerName: partner.partnerName,
        domain: partner.domain,
        oppNames: partner.oppNames,
        confidence: partner.confidence,
        evidenceSources: partner.evidenceSources,
      },
    }))
  },
})
