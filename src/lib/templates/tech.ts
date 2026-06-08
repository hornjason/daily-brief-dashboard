/**
 * Tech Stack template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Tech Stack section: signals with confidence metadata showing technology
 * evaluation/migration context.
 *
 * Renders: Technology, Status, Why, Red Hat Products
 */
export function templateTechStack(signals: Signal[]): string | null {
  const techSignals = signals.filter(s => routeSignal(s) === 'tech')
  if (techSignals.length === 0) return null

  // Group by context priority: migration opportunities first, then evaluating, then using, then developing
  const contextOrder: Record<string, number> = {
    migrating_from: 1,
    evaluating: 2,
    using: 3,
    developing: 4,
  }

  const sorted = [...techSignals].sort((a, b) => {
    const aContext = String(a.metadata?.context ?? 'using')
    const bContext = String(b.metadata?.context ?? 'using')
    const aPriority = contextOrder[aContext] ?? 999
    const bPriority = contextOrder[bContext] ?? 999
    return aPriority - bPriority
  })

  const rows: string[] = []
  rows.push('| Technology | Status | Why | Red Hat Products |')
  rows.push('|------------|--------|-----|------------------|')

  for (const s of sorted) {
    const m = s.metadata ?? {}
    const tech = s.headline

    // Status column with visual markers
    const context = String(m.context ?? 'using')
    let status = ''
    switch (context) {
      case 'migrating_from':
        status = '⚠️ MIGRATING FROM'
        break
      case 'evaluating':
        status = '🔍 EVALUATING'
        break
      case 'developing':
        status = '🔧 Developing'
        break
      case 'using':
      default:
        status = 'Using'
        break
    }

    // Why column from metadata.why or description fallback
    const why = String(m.why ?? s.detail.slice(0, 60))

    // Red Hat Products column from metadata.redHatProducts
    const products = Array.isArray(m.redHatProducts)
      ? m.redHatProducts.map(p => String(p).toUpperCase()).join(', ')
      : ''

    rows.push(`| ${tech} | ${status} | ${why} | ${products} |`)
  }

  // Count actionable signals (migrating_from + evaluating)
  const migratingCount = sorted.filter(s => String(s.metadata?.context) === 'migrating_from').length
  const evaluatingCount = sorted.filter(s => String(s.metadata?.context) === 'evaluating').length

  if (migratingCount > 0 || evaluatingCount > 0) {
    rows.push('')
    rows.push(`_${migratingCount} migration opportunities, ${evaluatingCount} evaluating — see Tech Stack tab for sources and details._`)
  }

  return rows.join('\n')
}
