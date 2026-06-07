/**
 * Audience Filter — Audience-aware content filtering for meeting prep (#644)
 *
 * Pure function module. Filters evidence blocks based on audience type
 * before they reach Gemini for meeting prep generation.
 *
 * Three audience types:
 * - Customer: Strip internal incentives and competitive intel
 * - Partner: Strip internal incentives, pipeline dollars, competitive intel
 * - Internal: No filtering — pass all data through
 */

import { detectPartnerDomains } from './domain-detection.ts'
import { loadPartnersFromConfig, findPartnerByDomain, matchPartnersToProducts } from './partner-catalog.ts'
import { toSlug } from '../cache-layer.ts'
import type { Customer } from '../types.ts'
import type { EvidenceBlock } from './evidence-block-builder.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AudienceType = 'customer' | 'partner' | 'internal'

export interface CustomerMatch {
  customerName: string
  matchedProducts: string[]
  opportunityContext: string
  pipelineSize?: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Lever sources stripped from Customer and Partner audiences */
const INTERNAL_LEVER_SOURCES = new Set(['spiff', 'internal-incentive'])

/** Evidence sources stripped from Customer and Partner audiences */
const COMPETITIVE_SOURCES = new Set(['competitive-intel'])

/** Regex to detect dollar amounts in text (e.g. $1.2M, $500,000, $2M) */
const DOLLAR_AMOUNT_RE = /\$[\d,.]+[KkMmBb]?/

// ── Core Filter ───────────────────────────────────────────────────────────────

/**
 * Filter evidence blocks based on audience type.
 *
 * - Customer: strip spiff/internal-incentive levers, competitive-intel evidence
 * - Partner: strip spiff/internal-incentive levers, competitive-intel evidence,
 *            evidence containing pipeline dollar amounts
 * - Internal: pass through unmodified (returns same reference)
 */
export function filterForAudience(
  blocks: EvidenceBlock[],
  audienceType: AudienceType
): EvidenceBlock[] {
  if (audienceType === 'internal') return blocks

  return blocks.map(block => {
    const filteredLevers = block.availableLevers.filter(
      lever => !INTERNAL_LEVER_SOURCES.has(lever.source)
    )

    let filteredEvidence: typeof block.evidenceTrail

    if (audienceType === 'customer') {
      filteredEvidence = block.evidenceTrail.filter(
        item => !COMPETITIVE_SOURCES.has(item.source)
      )
    } else {
      // Partner: strip competitive intel AND pipeline dollar amounts
      filteredEvidence = block.evidenceTrail.filter(item => {
        if (COMPETITIVE_SOURCES.has(item.source)) return false
        if (DOLLAR_AMOUNT_RE.test(item.fact)) return false
        return true
      })
    }

    return {
      ...block,
      availableLevers: filteredLevers,
      evidenceTrail: filteredEvidence,
    }
  })
}

// ── Auto-detection ────────────────────────────────────────────────────────────

/**
 * Detect audience type from attendee emails and customer data.
 *
 * Logic:
 * - If only @redhat.com (or empty) → Internal
 * - If any customer domain present → Customer (takes precedence)
 * - If non-redhat, non-customer domains and no customer domains → Partner
 */
export function detectAudienceType(
  attendeeEmails: string[],
  customer: Customer
): AudienceType {
  if (attendeeEmails.length === 0) return 'internal'

  const { partnerDomains, customerDomains } = detectPartnerDomains(attendeeEmails, customer)

  // Check if any attendee matches a customer domain
  const hasCustomerAttendee = attendeeEmails.some(email => {
    const domain = email.split('@')[1] ?? ''
    return customerDomains.some(cd => domain.endsWith(cd))
  })

  if (hasCustomerAttendee) return 'customer'

  // Check for non-redhat, non-customer domains (partner)
  if (partnerDomains.length > 0) return 'partner'

  // All @redhat.com
  return 'internal'
}

// ── Partner Cross-Reference ───────────────────────────────────────────────────

/**
 * For partner meetings, cross-reference the partner's specializations against
 * ALL customers' tech stacks to find joint opportunity targets.
 *
 * Returns matches with: customer name, matched tech stack items,
 * relevant solution play, pipeline opportunity size.
 */
export function crossReferencePartnerCustomers(
  partnerSlug: string,
  customers: Customer[],
  signalLoader: (slug: string) => any[],
  partnerList?: any[]
): CustomerMatch[] {
  // Load partner config and find the partner
  const partners = partnerList ?? loadPartnersFromConfig()
  const partner = partners.find((p: any) =>
    toSlug(p.name) === partnerSlug ||
    p.domain?.startsWith(partnerSlug) ||
    p.name.toLowerCase().includes(partnerSlug.toLowerCase())
  )

  if (!partner) return []

  const matches: CustomerMatch[] = []

  for (const customer of customers) {
    const slug = toSlug(customer.name)
    const signals = signalLoader(slug)

    // Extract products from tech-stack signals
    const techStackProducts = signals
      .filter((s: any) => s.source === 'tech-stack')
      .map((s: any) => s.metadata?.product)
      .filter(Boolean) as string[]

    if (techStackProducts.length === 0) continue

    // Match partner specializations against customer tech stack
    const partnerMatches = matchPartnersToProducts(
      techStackProducts,
      [partner]
    )

    if (partnerMatches.length > 0) {
      const matchedProducts = partnerMatches[0].matchedProducts

      // Look for pipeline signals to estimate opportunity size
      const pipelineSignals = signals.filter((s: any) => s.source === 'pipeline')
      const pipelineSize = pipelineSignals.reduce(
        (sum: number, s: any) => sum + (s.metadata?.amount ?? 0),
        0
      )

      matches.push({
        customerName: customer.name,
        matchedProducts,
        opportunityContext: `${customer.name} uses ${matchedProducts.join(', ')} — aligns with ${partner.name}'s ${partnerMatches[0].matchType.join('/')} expertise`,
        pipelineSize: pipelineSize > 0 ? pipelineSize : undefined,
      })
    }
  }

  return matches
}
