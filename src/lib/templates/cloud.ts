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

  // #702 Fix 8: Staleness warning when newsletter data is >14 days old
  const firstSignal = sorted[0]
  if (firstSignal?.timestamp) {
    const dataDate = new Date(firstSignal.timestamp)
    const now = new Date()
    const daysDiff = Math.floor((now.getTime() - dataDate.getTime()) / (1000 * 60 * 60 * 24))
    if (daysDiff > 14) {
      const dateStr = dataDate.toISOString().slice(0, 10)
      lines.push(`> Warning: Newsletter data is from ${dateStr} — may be outdated. Refresh for latest.`)
      lines.push('')
    }
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

    // #699 GAP-14: List offering names, not just count
    // #702 Fix 5: Mark pending offerings
    const offerings = Array.isArray(m.offerings) ? m.offerings : []
    if (offerings.length) {
      const namedOfferings = offerings.map((o: any) => {
        let name = o.name ?? 'Unknown'
        // #702 Fix 5: Append (Pending) for review/preview/coming soon offerings
        const avail = (o.availability ?? '').toLowerCase()
        if (avail.includes('review') || avail.includes('preview') || avail.includes('coming soon')) {
          name += ' (Pending)'
        }
        return name
      })
      const top3 = namedOfferings.slice(0, 3)
      const remaining = namedOfferings.length - 3
      const displayNames = remaining > 0
        ? `${top3.join(', ')} + ${remaining} more`
        : top3.join(', ')
      lines.push(`- Red Hat offerings on ${provider}: ${displayNames}`)
    }

    // New countries
    const countries = Array.isArray(m.newCountries) && m.newCountries.length ? m.newCountries : []
    if (countries.length) {
      lines.push(`- Newly available in: ${countries.join(', ')}`)
    }

    lines.push('')
  }

  // #466: Drive linkback — show link to source materials folder
  const driveFolderUrl = sorted.find(s => s.metadata?.driveFolderUrl)?.metadata?.driveFolderUrl
  if (driveFolderUrl) {
    lines.push(`[View source materials](${driveFolderUrl})`)
    lines.push('')
  }

  return lines.join('\n').trim()
}
