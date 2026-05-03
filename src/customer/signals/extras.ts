// BKL-ARCH-23: Extras — non-SignalBundle render helpers for the customer
// header, previous_brief, account_intelligence, and product_intelligence
// blocks. These are NOT signal sources because they have no scraper origin
// and don't fit the SignalBundle discriminated union.

import { resolve } from 'path'
import { existsSync, readFileSync } from 'node:fs'
import type { Customer } from '../../types.ts'
import type { RenderContext } from './types.ts'
import { toSlug, MS_PER_DAY } from '../../cache-layer.ts'
import { loadProductConfig } from '../../product-release-radar.ts'
import { getCachedCustomerProductIntel } from '../../customer-product-intel.ts'
import { emitAIEvent } from '../../ai-events.ts'

const ACCT_INTEL_COMPANY_CAP  = 3_000
const ACCT_INTEL_INDUSTRY_CAP = 2_000
const ACCT_INTEL_TTL_MS = (Number(process.env.INTELLIGENCE_COMPANY_TTL_DAYS) || 14) * MS_PER_DAY

export function renderCustomerHeader(
  customer: Customer,
  lastInteraction: string,
  lastBriefDate: string | null,
  ctx: RenderContext,
): string {
  const { escapeXml } = ctx
  return `<customer>
  <name>${escapeXml(customer.name)}</name>
  <ae>${escapeXml(customer.ae ?? 'Unknown')}</ae>
  <segment>${escapeXml(customer.segment ?? 'Unknown')}</segment>
  <last_interaction>${escapeXml(lastInteraction)}</last_interaction>
  <last_brief_date>${escapeXml(lastBriefDate ?? 'none')}</last_brief_date>
</customer>\n\n`
}

export function renderPreviousBrief(
  previousBrief: string,
  lastBriefDate: string | null,
  ctx: RenderContext,
): string {
  const { escapeXml } = ctx
  return `<source type="previous_brief" date="${escapeXml(lastBriefDate ?? 'unknown')}">\n${previousBrief}\n</source>\n\n`
}

export function renderAccountIntelligence(
  customer: Customer,
  accountIntelligence: { company?: string; industry?: string; cachedAt?: string } | null | undefined,
  ctx: RenderContext,
): string {
  const { escapeXml } = ctx
  const intelligenceSlug = toSlug(customer.name)
  let intel: { company?: string; industry?: string; cachedAt?: string } | null = null
  if (accountIntelligence !== undefined) {
    intel = accountIntelligence
  } else {
    const intelligencePath = `${process.env.CACHE_DIR ?? resolve(import.meta.dir, '../../../data/cache')}/intelligence/${intelligenceSlug}.json`
    try {
      if (existsSync(intelligencePath)) {
        intel = JSON.parse(readFileSync(intelligencePath, 'utf-8'))
      }
    } catch { /* intelligence cache missing */ }
  }
  if (!intel || (!intel.company && !intel.industry)) return ''
  const age = intel.cachedAt ? Date.now() - new Date(intel.cachedAt).getTime() : Infinity
  if (age >= ACCT_INTEL_TTL_MS) {
    const ageDays = Math.round(age / MS_PER_DAY)
    emitAIEvent({ type: 'cache:stale', flow: 'brief', source: 'l4', accountId: intelligenceSlug })
    return `<source type="account_intelligence" status="stale" cached="${intel.cachedAt}">Account intelligence is stale (${ageDays}d old) — regeneration pending.</source>\n\n`
  }
  let xml = `<source type="account_intelligence" status="fresh" cached="${intel.cachedAt}">\n`
  if (intel.company) xml += `[Company Intelligence]\n${escapeXml(String(intel.company).slice(0, ACCT_INTEL_COMPANY_CAP))}\n`
  if (intel.industry) xml += `\n[Industry Analysis]\n${escapeXml(String(intel.industry).slice(0, ACCT_INTEL_INDUSTRY_CAP))}\n`
  xml += `</source>\n\n`
  return xml
}

export function renderProductIntelligence(customer: Customer, ctx: RenderContext): string {
  const { escapeXml } = ctx
  let xml = ''
  const customerSlug = customer.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  try {
    const productConfigs = loadProductConfig()
    for (const productCfg of productConfigs) {
      const intel = getCachedCustomerProductIntel(productCfg.slug, customerSlug)
      if (!intel || intel.relevanceScore === 'NONE') continue
      xml += `<source type="product_intelligence" product="${escapeXml(productCfg.slug)}" relevance="${escapeXml(intel.relevanceScore)}" generated="${escapeXml(intel.generatedAt)}">\n`
      xml += `[Priority Action]\n${escapeXml(intel.priorityAction)}\n\n`
      if (intel.roadmapRelevance.length) {
        xml += `[Roadmap Talking Points]\n`
        for (const r of intel.roadmapRelevance) {
          xml += `- ${escapeXml(r.feature)}: ${escapeXml(r.talkingPoint)}\n`
        }
        xml += '\n'
      }
      if (intel.expansionOpportunities.length) {
        xml += `[Expansion Opportunities]\n`
        for (const e of intel.expansionOpportunities) {
          xml += `- ${escapeXml(e.gap)} → ${escapeXml(e.product)}: ${escapeXml(e.rationale)}\n`
        }
        xml += '\n'
      }
      if (intel.caseAlignment.length) {
        xml += `[Case Alignment]\n`
        for (const ca of intel.caseAlignment) {
          xml += `- Case ${escapeXml(ca.caseNumber)}: ${escapeXml(ca.roadmapFix)} (${escapeXml(ca.timeline)})\n`
        }
        xml += '\n'
      }
      if (intel.competitiveAngle) {
        xml += `[Competitive Angle]\n${escapeXml(intel.competitiveAngle)}\n\n`
      }
      xml += `</source>\n\n`
    }
  } catch { /* product intel cache missing or config unreadable */ }
  return xml
}
