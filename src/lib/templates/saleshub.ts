/**
 * SalesHub templates — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'
import { getTacticsByTdp, getTdpDescription } from '../saleshub-knowledge-loader.ts'
import { isValidCustomerWin, isValidAsset, isValidMetric } from '../saleshub-filters.ts'

/**
 * Sales Plays & Tactics section (#673): signals from saleshub-tactics and
 * saleshub-plays modules showing active tactics and strategic plays.
 */
export function templateSalesHubInsights(signals: Signal[]): string | null {
  const shSignals = signals.filter(s => routeSignal(s) === 'saleshub')
  if (shSignals.length === 0) return null

  const tactics = shSignals.filter(s => s.metadata?.playType === 'tactic')
  const strategicPlays = shSignals.filter(s => s.metadata?.playType === 'strategic')
  // ADR-041: Document intelligence signals with matchType
  const docMatches = shSignals.filter(s => {
    const mt = s.metadata?.matchType
    return Array.isArray(mt) && mt.length > 0
  })

  if (tactics.length === 0 && strategicPlays.length === 0 && docMatches.length === 0) return null

  const lines: string[] = ['## Sales Plays & Tactics']

  if (tactics.length > 0) {
    lines.push('')
    lines.push('### Active Tactics')
    for (const s of tactics.slice(0, 8)) {
      const m = s.metadata ?? {}
      const name = s.headline
      const parentTdp = String(m.parentTdp ?? '')
      const firstAsset = Array.isArray(m.assets) && m.assets.length > 0 ? m.assets[0] : null
      const snippet = firstAsset
        ? String(typeof firstAsset === 'object' ? (firstAsset as any).name ?? (firstAsset as any).title ?? JSON.stringify(firstAsset) : firstAsset)
        : (m.talkTrack ? String(m.talkTrack).slice(0, 100) : s.detail.slice(0, 100))
      lines.push(`- **${name}** (${parentTdp}) — ${snippet}`)
    }
  }

  if (strategicPlays.length > 0) {
    lines.push('')
    lines.push('### Strategic Plays')
    for (const s of strategicPlays.slice(0, 8)) {
      const m = s.metadata ?? {}
      const name = s.headline
      const tdps = Array.isArray(m.tdpAlignment) ? m.tdpAlignment.join(', ') : String(m.tdpAlignment ?? '')
      lines.push(`- **${name}** — TDPs: ${tdps}`)
    }
  }

  // ADR-041: Render integration/competitor/partner matched documents
  if (docMatches.length > 0) {
    lines.push('')
    lines.push('### Matched Product Documents')
    for (const s of docMatches.slice(0, 8)) {
      const m = s.metadata ?? {}
      const docName = String(m.documentName ?? s.headline)
      const matchTypes = Array.isArray(m.matchType) ? m.matchType : []
      const matchedTechs = Array.isArray(m.matchedTechnologies) ? m.matchedTechnologies.join(', ') : ''
      const category = String(m.documentCategory ?? '')
      const useCases = Array.isArray(m.useCases) ? m.useCases.slice(0, 3) : []
      const talkTracks = Array.isArray(m.talkTracks) ? m.talkTracks.slice(0, 2) : []
      const actionableSteps = Array.isArray(m.actionableSteps) ? m.actionableSteps.slice(0, 3) : []
      const links = Array.isArray(m.links) ? m.links.slice(0, 3) : []

      lines.push(`\n#### ${docName}${category ? ` -- ${category}` : ''}`)
      if (matchedTechs) lines.push(`**Matched:** ${matchedTechs} (${matchTypes.join(', ')})`)
      const rhProducts = Array.isArray(m.redHatProducts) ? m.redHatProducts.filter(Boolean) : []
      if (rhProducts.length > 0) lines.push(`**Products:** ${rhProducts.join(', ')}`)
      if (useCases.length > 0) lines.push(`**Use cases:** ${useCases.join(', ')}`)
      if (talkTracks.length > 0) {
        for (const tt of talkTracks) {
          lines.push(`- ${String(tt).slice(0, 200)}`)
        }
      }
      if (actionableSteps.length > 0) {
        for (const step of actionableSteps) {
          const stepText = typeof step === 'object' && step !== null ? String((step as any).step ?? step) : String(step)
          const stepUrl = typeof step === 'object' && step !== null ? (step as any).url : undefined
          lines.push(`- ${stepText}${stepUrl ? ` (${stepUrl})` : ''}`)
        }
      }
      if (links.length > 0) {
        for (const link of links) {
          if (typeof link === 'object' && link !== null) {
            lines.push(`- [${(link as any).name ?? 'Link'}](${(link as any).url ?? ''})`)
          }
        }
      }
    }
  }

  return lines.join('\n')
}

/**
 * SalesHub Context section — aggregates ALL SalesHub knowledge relevant
 * to this customer's signals into a single section. This is the canonical
 * way SalesHub content enters every consumer (playbook, brief, campaign,
 * meeting-prep). Any new consumer that calls templateAll() gets this
 * automatically — no per-consumer wiring needed.
 *
 * Content: TDP positioning, tactic talk tracks, customer wins, linked assets.
 * Source: saleshub-knowledge.json via saleshub-knowledge-loader.ts.
 */
export function templateSalesHubContext(signals: Signal[]): string | null {
  // Find unique TDPs from signals that have solution play metadata
  const tdpSet = new Set<string>()
  for (const s of signals) {
    const tdp = s.metadata?.solutionTdp
    if (typeof tdp === 'string' && tdp) tdpSet.add(tdp)
  }

  if (tdpSet.size === 0) return null

  const parts: string[] = []

  for (const tdpName of tdpSet) {
    const tdpDesc = getTdpDescription(tdpName)
    const tactics = getTacticsByTdp(tdpName)

    if (!tdpDesc && tactics.length === 0) continue

    const tdpLines: string[] = []
    tdpLines.push(`### ${tdpName}`)
    if (tdpDesc) tdpLines.push(`> ${tdpDesc.slice(0, 300)}`)

    for (const tactic of tactics.slice(0, 5)) {
      tdpLines.push(`\n**${tactic.name}**`)
      if (tactic.talkTrack) {
        tdpLines.push(`*Talk track:* ${tactic.talkTrack.slice(0, 250)}`)
      }
      // Extracted content from SalesHub knowledge (#371)
      if (tactic.extractedContent) {
        tdpLines.push(`*Extracted insights:* ${tactic.extractedContent.slice(0, 200)}`)
      }
      const validMetrics = ((tactic.metrics ?? []) as Array<{ value: string; context: string }>).filter(isValidMetric).slice(0, 3)
      if (validMetrics.length > 0) {
        tdpLines.push('*Key metrics:*')
        for (const m of validMetrics) {
          tdpLines.push(`- ${m.value} -- ${m.context}`)
        }
      }
      const validWins = tactic.customerWins.filter(isValidCustomerWin)
      if (validWins.length > 0) {
        tdpLines.push('*Customer proof points:*')
        for (const win of validWins.slice(0, 3)) {
          tdpLines.push(`- ${win}`)
        }
      }
      if (tactic.whatToSay.length > 0) {
        tdpLines.push('*Key messaging:*')
        for (const say of tactic.whatToSay.slice(0, 3)) {
          tdpLines.push(`- ${say}`)
        }
      }
      if (tactic.whatToShare.length > 0) {
        const assets = tactic.whatToShare.filter(isValidAsset).slice(0, 5)
        if (assets.length > 0) {
          tdpLines.push('*Assets to share:*')
          for (const asset of assets) {
            tdpLines.push(`- [${asset.name}](${asset.url})`)
          }
        }
      }
    }

    parts.push(tdpLines.join('\n'))
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}
