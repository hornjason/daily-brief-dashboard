/**
 * Cloud Marketplace template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Cloud Marketplace section: signals with hasCloudSpend/provider metadata,
 * showing cloud platform spend and offerings.
 *
 * Renders: Provider, ACV, Programs, Offerings
 */
export function templateCloudMarketplace(signals: Signal[]): string | null {
  // Only show clouds the customer actually touches (spend or intelligence)
  const cloudSignals = signals.filter(s =>
    routeSignal(s) === 'cloud' && s.metadata?.provider && (s.metadata?.hasCloudSpend || s.metadata?.hasCloudIntel)
  )
  if (cloudSignals.length === 0) return null

  // Sort: spend first, then intel
  const sorted = cloudSignals.slice().sort((a, b) => {
    const aRank = a.metadata?.hasCloudSpend ? 2 : 1
    const bRank = b.metadata?.hasCloudSpend ? 2 : 1
    return bRank - aRank
  })

  const lines: string[] = []

  // #704: Purchasing Recommendation — render top-ranked provider recommendation above catalog
  const recommended = sorted
    .filter(s => s.metadata?.recommendedProvider && s.metadata?.conversationOpener)
    .sort((a, b) => (Number(a.metadata?.providerRank) || 99) - (Number(b.metadata?.providerRank) || 99))
  if (recommended.length > 0) {
    const top = recommended[0]
    lines.push('## Purchasing Recommendation')
    lines.push('')
    lines.push(`**Recommended: ${String(top.metadata!.recommendedProvider)}** — ${String(top.metadata!.conversationOpener)}`)
    lines.push('')
  }

  for (const s of sorted) {
    const m = s.metadata ?? {}
    const provider = String(m.provider)
    const acv = m.acvPlus ? `$${Math.round(Number(m.acvPlus)).toLocaleString()}` : null

    // Provider header
    if (m.hasCloudSpend && acv) {
      lines.push(`**${provider}** — ${acv} Red Hat marketplace spend`)
    } else {
      lines.push(`**${provider}** — customer uses ${provider}, no Red Hat marketplace spend yet`)
    }

    // Programs (PPA, CPPO, MACC, Google Cloud Commit) — the actionable items
    const programs = Array.isArray(m.programs) ? m.programs : []
    for (const p of programs) {
      let line = `- Program: ${p.name}`
      if (p.eligibility) line += ` (${p.eligibility})`
      if (p.validThrough) line += ` — expires ${p.validThrough}`
      lines.push(line)
    }

    // Incentives — directly revenue-relevant
    const incentives = Array.isArray(m.incentives) ? m.incentives : []
    for (const inc of incentives) {
      let line = `- Incentive: ${inc.name}`
      if (inc.value) line += ` (${inc.value})`
      if (inc.validThrough) line += ` — expires ${inc.validThrough}`
      lines.push(line)
    }

    // Offerings — summary count only, not full catalog
    const offerings = Array.isArray(m.offerings) ? m.offerings : []
    if (offerings.length) {
      const available = offerings.filter((o: any) => o.availability?.toLowerCase()?.includes('available today')).length
      const privateOffer = offerings.filter((o: any) => {
        const a = (o.availability ?? '').toLowerCase()
        return a.includes('private offer') || a.includes('subscription')
      }).length
      const parts: string[] = []
      if (available) parts.push(`${available} available today`)
      if (privateOffer) parts.push(`${privateOffer} via private offer`)
      lines.push(`- ${offerings.length} Red Hat offerings on ${provider} Marketplace (${parts.join(', ')})`)
    }

    // New countries
    const countries = Array.isArray(m.newCountries) && m.newCountries.length ? m.newCountries : []
    if (countries.length) {
      lines.push(`- Newly available in: ${countries.join(', ')}`)
    }

    lines.push('')
  }

  return lines.join('\n').trim()
}
