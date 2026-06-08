/**
 * Competitive Landscape template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Competitive Landscape section (#672): signals from competitive-intel showing
 * competitor announcements, Red Hat counter-positioning, and sales triggers.
 */
export function templateCompetitiveLandscape(signals: Signal[]): string | null {
  const competitiveSignals = signals.filter(s => routeSignal(s) === 'competitive')
  if (competitiveSignals.length === 0) return null

  const rows: string[] = []
  rows.push('## Competitive Landscape')
  rows.push('')
  rows.push('| Competitor | Announcement | Red Hat Counter | Sales Trigger |')
  rows.push('|---|---|---|---|')

  const notes: string[] = []

  for (const s of competitiveSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const competitor = String(m.competitor ?? 'Unknown')
    const announcement = s.headline.slice(0, 100)
    const counter = String(m.redHatCounter ?? m.counter ?? s.detail.slice(0, 80))
    const triggers = Array.isArray(m.salesTriggers) ? String(m.salesTriggers[0] ?? '') : String(m.salesTrigger ?? '')
    rows.push(`| ${competitor} | ${announcement} | ${counter} | ${triggers} |`)

    if (m.compensation) {
      notes.push(`_${competitor}: ${String(m.compensation)}_`)
    }
  }

  if (notes.length > 0) {
    rows.push('')
    rows.push(notes.join('\n'))
  }

  return rows.join('\n')
}
