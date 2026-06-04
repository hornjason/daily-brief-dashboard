/**
 * src/lib/graph-summary.ts
 * Condenses a CustomerGraph into a text summary suitable for a Gemini prompt.
 *
 * GitHub Issue #599 — Gemini inference layer, Phase 1
 *
 * Produces a structured, fact-dense summary under 500 tokens.
 * Focuses on factual data, not interpretation — Gemini handles inference.
 *
 * Dependencies:
 *   - intelligence-graph-types.ts — CustomerGraph, IntelligenceNode
 *   - graph-utils.ts — findActiveNodesByType
 */

import type { CustomerGraph } from './intelligence-graph-types.ts'
import { findActiveNodesByType } from './graph-utils.ts'

/**
 * Condense a CustomerGraph into a text summary for Gemini prompts.
 * Stays under ~500 tokens by focusing on facts and counts.
 */
export function summarizeGraph(graph: CustomerGraph): string {
  const lines: string[] = []

  lines.push(`Customer: ${graph.customerName}`)

  // ── Subscriptions ──────────────────────────────────────────────────────────
  const subs = findActiveNodesByType(graph, 'subscription')
  if (subs.length > 0) {
    const subDescriptions = subs.map(s => {
      const name = String(s.properties.productDescription ?? s.name)
      const endDate = s.properties.endDate as string | undefined
      const status = s.properties.urgency as string | undefined
      let detail = name
      if (endDate) {
        const isExpired = new Date(endDate).getTime() < Date.now()
        detail += isExpired ? ` (expired ${endDate.slice(0, 7)})` : ` (expires ${endDate.slice(0, 7)})`
      }
      if (status && status !== 'active') {
        detail += ` [${status}]`
      }
      return detail
    })
    lines.push(`Active subscriptions: ${subDescriptions.join(', ')}`)
  }

  // ── Cases ──────────────────────────────────────────────────────────────────
  const cases = findActiveNodesByType(graph, 'case')
  if (cases.length > 0) {
    const products = new Map<string, number>()
    const severities = new Map<string, number>()
    for (const c of cases) {
      const product = String(c.properties.product ?? 'unknown')
      products.set(product, (products.get(product) ?? 0) + 1)
      const sev = String(c.properties.severity ?? 'unknown')
      severities.set(sev, (severities.get(sev) ?? 0) + 1)
    }
    const productBreakdown = Array.from(products.entries())
      .map(([p, n]) => `${n} on ${p}`).join(', ')
    const sevBreakdown = Array.from(severities.entries())
      .map(([s, n]) => `${n} sev-${s}`).join(', ')
    lines.push(`Open cases: ${cases.length} (${productBreakdown}) — severity: ${sevBreakdown}`)
  }

  // ── Pipeline (Deals) ───────────────────────────────────────────────────────
  const deals = findActiveNodesByType(graph, 'deal')
  if (deals.length > 0) {
    const totalAmount = deals.reduce((sum, d) => {
      const amt = Number(d.properties.amount ?? 0)
      return sum + amt
    }, 0)
    const amountStr = totalAmount > 0 ? ` ($${Math.round(totalAmount / 1000)}K total)` : ''
    lines.push(`Pipeline: ${deals.length} active deal${deals.length > 1 ? 's' : ''}${amountStr}`)
  }

  // ── Cloud Spend (Programs: cloud-spend type) ──────────────────────────────
  const programs = findActiveNodesByType(graph, 'program')
  const cloudPrograms = programs.filter(p => p.properties.programType === 'cloud-spend')
  if (cloudPrograms.length > 0) {
    const cloudDetails = cloudPrograms.map(p => {
      const partner = String(p.properties.cloudPartner ?? 'unknown')
      const acv = p.properties.acvPlus as number | undefined
      return acv ? `${partner} ($${Math.round(acv / 1000)}K ACV)` : partner
    })
    lines.push(`Cloud spend: ${cloudDetails.join(', ')}`)
  }

  // ── Tech Stack (non-Red Hat products) ──────────────────────────────────────
  const techStack = findActiveNodesByType(graph, 'product')
  if (techStack.length > 0) {
    const techNames = techStack.map(t => String(t.properties.techName ?? t.name))
    const displayed = techNames.slice(0, 10)
    const suffix = techNames.length > 10 ? ` (+${techNames.length - 10} more)` : ''
    lines.push(`Tech stack: ${displayed.join(', ')}${suffix}`)
  }

  // ── Engagement (emails, meetings) ──────────────────────────────────────────
  const engagements = findActiveNodesByType(graph, 'engagement')
  if (engagements.length > 0) {
    const channels = new Map<string, number>()
    for (const e of engagements) {
      const channel = String(e.properties.channel ?? 'unknown')
      channels.set(channel, (channels.get(channel) ?? 0) + 1)
    }
    const channelBreakdown = Array.from(channels.entries())
      .map(([ch, n]) => `${n} ${ch}`).join(', ')
    lines.push(`Recent engagement: ${channelBreakdown}`)
  }

  // ── Competitive Intel ─────────────────────────────────────────────────────
  const intels = findActiveNodesByType(graph, 'intel')
  const competitive = intels.filter(i => i.properties.intelType === 'competitive')
  if (competitive.length > 0) {
    const competitors = competitive.map(c => String(c.properties.competitor ?? c.name))
    lines.push(`Competitor tech: ${[...new Set(competitors)].join(', ')}`)
  }

  // ── Lifecycle / EOL ────────────────────────────────────────────────────────
  const lifecycles = findActiveNodesByType(graph, 'lifecycle')
  if (lifecycles.length > 0) {
    const urgent = lifecycles.filter(lc => {
      const eol = lc.properties.eolDate as string | undefined
      if (!eol) return false
      const months = (new Date(eol).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30)
      return months > 0 && months <= 12
    })
    if (urgent.length > 0) {
      const eolDetails = urgent.map(lc => {
        const product = String(lc.properties.product ?? lc.name)
        const eol = lc.properties.eolDate as string
        return `${product} (EOL: ${eol.slice(0, 7)})`
      })
      lines.push(`Upcoming EOL: ${eolDetails.join(', ')}`)
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  const events = findActiveNodesByType(graph, 'event')
  if (events.length > 0) {
    const eventNames = events.map(e => e.name).slice(0, 5)
    lines.push(`Events: ${eventNames.join(', ')}`)
  }

  // ── Partner Ecosystem ──────────────────────────────────────────────────────
  const partners = findActiveNodesByType(graph, 'partner')
  if (partners.length > 0) {
    lines.push(`Partner ecosystem: ${partners.length} certified partner${partners.length > 1 ? 's' : ''}`)
  }

  // ── Marketplace Programs ───────────────────────────────────────────────────
  const marketplace = programs.filter(p => p.properties.programType === 'marketplace')
  if (marketplace.length > 0) {
    const providers = marketplace.map(p => String(p.properties.provider ?? p.name))
    lines.push(`Marketplace: ${providers.join(', ')}`)
  }

  // ── Plays (solution matches) ───────────────────────────────────────────────
  const plays = findActiveNodesByType(graph, 'play')
  if (plays.length > 0) {
    const playNames = plays.map(p => p.name).slice(0, 5)
    lines.push(`Active solution plays: ${playNames.join(', ')}`)
  }

  // ── Signal Density ─────────────────────────────────────────────────────────
  const nodeTypes = new Set(
    Object.values(graph.nodes)
      .filter(n => n.history?.status !== 'historical' && n.type !== 'customer')
      .map(n => n.type),
  )
  lines.push(`Signal density: ${nodeTypes.size}/12 types (${Math.round((nodeTypes.size / 12) * 100)}% coverage)`)

  return lines.join('\n')
}
