/**
 * Strategic Opportunities template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Strategic Opportunities section (ADR-030): solution plays triggered by
 * detected technologies. Routes signals where metadata.solutionPlayId is present.
 *
 * Renders: Play name, trigger technologies, products, business value
 */
export function templateStrategicOpportunities(signals: Signal[]): string | null {
  const stratSignals = signals.filter(s => s.metadata?.solutionPlayId)
  if (stratSignals.length === 0) return null

  // Dedupe by solutionPlayId — a play may match multiple technologies
  const seenPlays = new Set<string>()
  const uniqueSignals: Signal[] = []
  for (const s of stratSignals) {
    const playId = String(s.metadata!.solutionPlayId)
    if (!seenPlays.has(playId)) {
      seenPlays.add(playId)
      uniqueSignals.push(s)
    }
  }

  const parts: string[] = []

  // Solution Plays sub-section
  const playRows: string[] = []
  playRows.push('### Solution Plays')
  playRows.push('| TDP | Play | Trigger Technologies | Products | Business Value |')
  playRows.push('|-----|------|---------------------|----------|----------------|')

  for (const s of uniqueSignals.slice(0, 6)) {
    const m = s.metadata ?? {}
    const tdp = String(m.solutionTdp ?? '')
    const playName = String(m.solutionPlayName ?? 'Unknown')
    const techs = s.headline.replace(/ \(.*\)$/, '')
    const products = Array.isArray(m.redHatProducts) ? m.redHatProducts.join(', ') : ''
    // Prefer SalesHub talk track over generic valueProps
    const businessValue = m.talkTrack
      ? String(m.talkTrack).slice(0, 120)
      : (Array.isArray(m.valueProps) ? m.valueProps[0]?.slice(0, 80) ?? '' : '')
    playRows.push(`| ${tdp} | ${playName} | ${techs} | ${products} | ${businessValue} |`)
  }
  parts.push(playRows.join('\n'))

  // #672: Partner Ecosystem Solutions — enrichment from ecosystem-catalog signals
  // Only show when solution plays exist (don't show partner solutions without play context)
  const ecosystemSignals = signals.filter(s => routeSignal(s) === 'ecosystem')
  if (ecosystemSignals.length > 0) {
    const ecoLines: string[] = ['### Partner Ecosystem Solutions']
    for (const s of ecosystemSignals.slice(0, 10)) {
      const m = s.metadata ?? {}
      const partnerName = String(m.partnerName ?? 'Unknown Partner')
      const solutionName = String(m.solutionName ?? s.headline)
      const resourceCount = Array.isArray(m.resourceTypes) ? m.resourceTypes.length : 0
      const urlPart = s.url ? ` — [View](${s.url})` : ''
      ecoLines.push(`- **${partnerName}**: ${solutionName} (${resourceCount} resources)${urlPart}`)
    }
    parts.push(ecoLines.join('\n'))
  }

  // #673: Specialized Partners — enrichment from partner-catalog signals
  const partnerSignals = signals.filter(s => routeSignal(s) === 'partner')
  if (partnerSignals.length > 0 && uniqueSignals.length > 0) {
    const partnerLines: string[] = ['### Specialized Partners']
    for (const s of partnerSignals.slice(0, 8)) {
      const m = s.metadata ?? {}
      const partnerName = String(m.partnerName ?? s.headline)
      const level = String(m.partnershipLevel ?? 'Partner')
      const specs = Array.isArray(m.specializations) ? m.specializations.join(', ') : ''
      const creds = Number(m.credentialCount ?? 0)
      partnerLines.push(`- **${partnerName}** (${level}) — Specializations: ${specs} | Certs: ${creds}`)
    }
    parts.push(partnerLines.join('\n'))
  }

  // Customer wins proof points (from any signal with customerWins)
  const allWins: string[] = []
  for (const s of uniqueSignals) {
    const wins = s.metadata?.customerWins
    if (Array.isArray(wins)) {
      for (const w of wins) {
        if (typeof w === 'string' && w.length > 5 && !allWins.includes(w)) allWins.push(w)
      }
    }
  }
  if (allWins.length > 0) {
    parts.push('### Customer Proof Points\n' + allWins.slice(0, 5).map(w => `- ${w}`).join('\n'))
  }

  // Linked assets (decks, resources)
  const allAssets: Array<{ name: string; url: string }> = []
  for (const s of uniqueSignals) {
    const assets = s.metadata?.linkedAssets
    if (Array.isArray(assets)) {
      for (const a of assets as Array<{ name: string; url: string }>) {
        if (a.url && !allAssets.some(x => x.name === a.name)) allAssets.push(a)
      }
    }
  }
  if (allAssets.length > 0) {
    parts.push('### Linked Assets\n' + allAssets.slice(0, 8).map(a => `- [${a.name}](${a.url})`).join('\n'))
  }

  // Marketplace Opportunities sub-section (from signals with privateOfferEligible or provider+acvPlus)
  const marketplaceSignals = signals.filter(s => {
    const m = s.metadata ?? {}
    return m.hasCloudSpend && m.acvPlus && Number(m.acvPlus) > 0
  })
  if (marketplaceSignals.length > 0) {
    const seen = new Set<string>()
    const mktRows: string[] = []
    mktRows.push('### Marketplace Opportunities')
    mktRows.push('| Provider | Spend | Programs | Private Offer |')
    mktRows.push('|----------|-------|----------|---------------|')
    for (const s of marketplaceSignals) {
      const m = s.metadata ?? {}
      const provider = String(m.provider ?? m.cloudPartner ?? '')
      if (!provider || seen.has(provider)) continue
      seen.add(provider)
      const spend = `$${Math.round(Number(m.acvPlus ?? 0)).toLocaleString()}`
      const programs = Array.isArray(m.eligiblePrograms) ? m.eligiblePrograms.join(', ') : 'N/A'
      const privateOffer = m.privateOfferEligible ? 'Eligible' : '—'
      mktRows.push(`| ${provider} | ${spend} | ${programs} | ${privateOffer} |`)
    }
    if (mktRows.length > 3) parts.push(mktRows.join('\n'))
  }

  // Version Correlations sub-section (from signals with type='version-correlation')
  const versionSignals = signals.filter(s => s.metadata?.amplified)
  if (versionSignals.length > 0) {
    const vcRows: string[] = []
    vcRows.push('### Urgent Correlations')
    vcRows.push('| Product | Cases | Lifecycle Event |')
    vcRows.push('|---------|-------|-----------------|')
    for (const s of versionSignals.slice(0, 4)) {
      const m = s.metadata ?? {}
      const product = String(m.product ?? 'Unknown')
      const cases = String(m.activeCases ?? s.headline.match(/(\d+) active/)?.[1] ?? '?')
      const lifecycle = String(m.lifecycleEvent ?? '—')
      vcRows.push(`| ${product} | ${cases} | ${lifecycle} |`)
    }
    parts.push(vcRows.join('\n'))
  }

  return parts.join('\n\n')
}
