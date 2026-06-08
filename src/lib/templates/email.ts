/**
 * Email Intelligence template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Email Intelligence section (#674): signals from the emails module showing
 * classified email insights, tech/competitive mentions, and action items.
 *
 * Renders: From, Classification, Headline, Tech mentions, Competitive mentions
 * Groups by classification. Limits to 10 signals. Shows action items if present.
 */
export function templateEmailIntelligence(signals: Signal[]): string | null {
  const emailSignals = signals.filter(s => routeSignal(s) === 'email').slice(0, 10)
  if (emailSignals.length === 0) return null

  // Group by classification
  const byClassification = new Map<string, Signal[]>()
  for (const s of emailSignals) {
    const classification = String(s.metadata?.classification ?? 'uncategorized')
    const group = byClassification.get(classification) ?? []
    group.push(s)
    byClassification.set(classification, group)
  }

  const lines: string[] = ['## Email Intelligence', '', '### Recent Insights']

  for (const [classification, group] of byClassification) {
    lines.push(`\n**${classification}**`)
    for (const s of group) {
      const m = s.metadata ?? {}
      const from = String(m.from ?? 'Unknown')
      const techMentions = Array.isArray(m.techMentions) ? m.techMentions.join(', ') : ''
      const competitiveMentions = Array.isArray(m.competitiveMentions) ? m.competitiveMentions.join(', ') : ''
      const parts = [`**${from}** (${classification}): ${s.headline}`]
      if (techMentions) parts.push(`Tech: ${techMentions}`)
      if (competitiveMentions) parts.push(`Competitive: ${competitiveMentions}`)
      lines.push(`- ${parts.join(' — ')}`)
    }
  }

  // Action items section — only if any signals have actionItems
  const allActionItems: string[] = []
  for (const s of emailSignals) {
    const items = s.metadata?.actionItems
    if (Array.isArray(items)) {
      for (const item of items) {
        if (typeof item === 'string' && item.length > 0) allActionItems.push(item)
      }
    }
  }
  if (allActionItems.length > 0) {
    lines.push('', '### Action Items')
    for (const item of allActionItems) {
      lines.push(`- ${item}`)
    }
  }

  return lines.join('\n')
}
