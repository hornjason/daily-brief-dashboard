/**
 * Cases template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Cases section: signals with severity/caseNumber, sorted by severity (1 = highest).
 *
 * Renders: Case Number, Severity, Product, Age (days)
 */
export function templateCases(signals: Signal[]): string | null {
  const caseSignals = signals.filter(s => routeSignal(s) === 'case')
  if (caseSignals.length === 0) return null

  // Sort by severity ascending (1 = critical, higher = less severe)
  const sorted = caseSignals.slice().sort((a, b) => {
    const sevA = Number(a.metadata?.severity ?? 999)
    const sevB = Number(b.metadata?.severity ?? 999)
    return sevA - sevB
  })

  const rows: string[] = []
  rows.push('| Case Number | Severity | Product | Age |')
  rows.push('|-------------|----------|---------|-----|')

  for (const s of sorted.slice(0, 8)) {
    const m = s.metadata ?? {}
    const caseNumber = String(m.caseNumber ?? 'Unknown')
    const severity = String(m.severity ?? '?')
    const product = String(m.product ?? s.headline.slice(0, 30))

    // Calculate age from timestamp
    const age = s.timestamp
      ? Math.floor((Date.now() - new Date(s.timestamp).getTime()) / (1000 * 60 * 60 * 24))
      : 0
    const ageStr = age > 0 ? `${age}d` : 'New'

    rows.push(`| ${caseNumber} | Sev ${severity} | ${product} | ${ageStr} |`)
  }

  return rows.join('\n')
}
