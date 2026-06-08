/**
 * Company & Industry Intelligence template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Company & Industry Intelligence section (#673): signals from the intelligence
 * module showing company analysis and industry context.
 */
export function templateIntelligence(signals: Signal[]): string | null {
  const intelSignals = signals.filter(s => routeSignal(s) === 'intelligence')
  if (intelSignals.length === 0) return null

  const companySignals = intelSignals.filter(s => s.metadata?.docType === 'company')
  const industrySignals = intelSignals.filter(s => s.metadata?.docType === 'industry')

  if (companySignals.length === 0 && industrySignals.length === 0) return null

  const lines: string[] = ['## Company & Industry Intelligence']

  if (companySignals.length > 0) {
    lines.push('')
    lines.push('### Company Context')
    for (const s of companySignals.slice(0, 3)) {
      lines.push(s.detail.slice(0, 500))
    }
  }

  if (industrySignals.length > 0) {
    lines.push('')
    lines.push('### Industry Context')
    for (const s of industrySignals.slice(0, 3)) {
      lines.push(s.detail.slice(0, 500))
    }
  }

  return lines.join('\n')
}
