/**
 * Renewals template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Renewals section: pipeline signals with renewal metadata, sorted by closeDate.
 *
 * Renders: Product, Amount, Close Date, Stage
 */
export function templateRenewals(signals: Signal[]): string | null {
  const renewalSignals = signals.filter(s => routeSignal(s) === 'renewal')
  if (renewalSignals.length === 0) return null

  // Sort by closeDate ascending (soonest first)
  const sorted = renewalSignals.slice().sort((a, b) => {
    const dateA = a.metadata?.closeDate ? new Date(String(a.metadata.closeDate)).getTime() : Infinity
    const dateB = b.metadata?.closeDate ? new Date(String(b.metadata.closeDate)).getTime() : Infinity
    return dateA - dateB
  })

  const rows: string[] = []
  rows.push('| Product | Amount | Close Date | Stage |')
  rows.push('|---------|--------|------------|-------|')

  for (const s of sorted.slice(0, 8)) {
    const m = s.metadata ?? {}
    const product = String(m.product ?? s.headline.slice(0, 30))
    const amount = m.amount ? `$${Math.round(Number(m.amount)).toLocaleString()}` : 'N/A'
    const closeDate = m.closeDate ? new Date(String(m.closeDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'
    const stage = String(m.stage ?? 'Unknown')
    rows.push(`| ${product} | ${amount} | ${closeDate} | ${stage} |`)
  }

  return rows.join('\n')
}
