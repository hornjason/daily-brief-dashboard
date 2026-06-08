/**
 * Sales Alignment template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { getTacticsByTdp, getSalesPlayByName } from '../saleshub-knowledge-loader.ts'
import { isValidMetric } from '../saleshub-filters.ts'

/**
 * Sales Alignment section — shows which Sales Plays and TDPs apply to
 * this customer based on detected technologies. Designed for management
 * visibility: clear mapping from customer signals → TDP → Sales Play.
 *
 * Appears near the top of every output so leadership can immediately
 * see which sales motions are in play.
 */
export function templateSalesAlignment(signals: Signal[]): string | null {
  // Collect plays, deduplicating by playId and merging trigger technologies
  const playMap = new Map<string, { playName: string; tdp: string; techs: Set<string>; confidence: string }>()

  for (const s of signals) {
    const playId = s.metadata?.solutionPlayId
    const playName = s.metadata?.solutionPlayName
    const tdp = s.metadata?.solutionTdp
    const confidence = s.metadata?.confidence
    if (!playId || !playName || !tdp) continue

    const key = String(playId)
    const existing = playMap.get(key)
    if (existing) {
      // Merge trigger technologies
      const techs = Array.isArray(s.metadata?.matchedTechnologies)
        ? (s.metadata!.matchedTechnologies as string[])
        : [s.headline.replace(/ \(.*\)$/, '')]
      for (const t of techs) existing.techs.add(t)
      // Upgrade confidence (keep highest)
      if (confidence === 'HIGH') existing.confidence = 'HIGH'
      else if (confidence === 'MEDIUM' && existing.confidence !== 'HIGH') existing.confidence = 'MEDIUM'
    } else {
      const techs = new Set(
        Array.isArray(s.metadata?.matchedTechnologies)
          ? (s.metadata!.matchedTechnologies as string[])
          : [s.headline.replace(/ \(.*\)$/, '')]
      )
      playMap.set(key, {
        playName: String(playName),
        tdp: String(tdp),
        techs,
        confidence: String(confidence ?? 'MEDIUM'),
      })
    }
  }

  if (playMap.size === 0) return null

  // Group by TDP
  const byTdp = new Map<string, Array<{ name: string; techs: string[]; confidence: string }>>()
  for (const [, play] of playMap) {
    const existing = byTdp.get(play.tdp) ?? []
    existing.push({ name: play.playName, techs: Array.from(play.techs), confidence: play.confidence })
    byTdp.set(play.tdp, existing)
  }

  // Map TDPs to their parent sales plays
  const tdpToPlays: Record<string, string[]> = {
    'AI Platform': ['The AI-Ready Enterprise', 'Build and Run Applications'],
    'App Platform': ['Build and Run Applications', 'Modernize Infrastructure'],
    'Automation': ['IT Operations Efficiency', 'Modernize Infrastructure', 'The AI-Ready Enterprise'],
    'Virtualization': ['Modernize Infrastructure', 'IT Operations Efficiency'],
    'Server/Cloud OS': ['Modernize Infrastructure'],
    'Container Mgmt': ['Build and Run Applications', 'Modernize Infrastructure'],
  }

  const allTdps = Array.from(byTdp.keys())
  const activeSalesPlays = new Set<string>()
  for (const tdp of allTdps) {
    for (const play of tdpToPlays[tdp] ?? []) activeSalesPlays.add(play)
  }

  const lines: string[] = []

  // Active Sales Plays roll-up
  if (activeSalesPlays.size > 0) {
    lines.push(`Sales Plays: ${Array.from(activeSalesPlays).join(', ')}`)
  }

  // TDP → Play → Technologies
  for (const [tdp, plays] of byTdp) {
    lines.push(`TDP: ${tdp}`)
    for (const play of plays) {
      const rawConf = play.confidence
      const confBadge = (rawConf === 'LOW' || rawConf === 'low') ? '⚪' : (rawConf === 'MEDIUM' || rawConf === 'medium') ? '🟡' : '🟢'
      lines.push(`  ${confBadge} ${play.name} (${play.techs.join(', ')})`)
    }
  }

  // Enriched content from SalesHub knowledge (#371)
  for (const [tdp] of byTdp) {
    const tactics = getTacticsByTdp(tdp)
    const metricsFromTactics = tactics.flatMap(t => (t.metrics ?? []) as Array<{ value: string; context: string }>).filter(isValidMetric).slice(0, 3)
    if (metricsFromTactics.length > 0) {
      lines.push(`  Key Metrics:`)
      for (const m of metricsFromTactics) {
        lines.push(`    - ${m.value} -- ${m.context}`)
      }
    }
  }

  // Customer Lens from matched sales plays
  const seenPlays = new Set<string>()
  for (const [, plays] of byTdp) {
    for (const play of plays) {
      if (seenPlays.has(play.name)) continue
      seenPlays.add(play.name)
      const salesPlay = getSalesPlayByName(play.name)
      if (salesPlay?.customerLens?.pain && salesPlay.customerLens.pain.length > 0) {
        lines.push(`  Customer Pain: ${salesPlay.customerLens.pain.slice(0, 2).join('; ')}`)
      }
      if (salesPlay?.realWorldExamples && salesPlay.realWorldExamples.length > 0) {
        const ex = salesPlay.realWorldExamples[0]
        lines.push(`  Proof Point: ${ex.customer} -- ${ex.outcome}`)
      }
    }
  }

  return lines.join('\n')
}
