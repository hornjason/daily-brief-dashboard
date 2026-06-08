/**
 * Product Alignment template — GitHub Issue #684
 * Extracted from signal-templates.ts
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

/**
 * Product Alignment section: subscription/ccsp/tech-stack signals showing
 * what Red Hat products the customer uses or is evaluating.
 *
 * Renders: Product name, confidence, use case context
 */
export function templateProductAlignment(signals: Signal[]): string | null {
  const productSignals = signals.filter(s => routeSignal(s) === 'product')
  if (productSignals.length === 0) return null

  const rows: string[] = []
  rows.push('| Product | Confidence | Use Case Context |')
  rows.push('|---------|------------|------------------|')

  for (const s of productSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const products = m.redHatProducts
    const firstProduct = Array.isArray(products) && products.length > 0 ? products[0] : null
    // #375/#379: Also read productTags (rh-rss) and productSlug (value-maps)
    const firstTag = Array.isArray(m.productTags) && m.productTags.length > 0 ? m.productTags[0] : null
    const product = String(m.product ?? firstProduct ?? m.productSlug ?? firstTag ?? 'Unknown')
    const confidence = String(m.confidence ?? '').toUpperCase() || 'MEDIUM'
    const context = String(m.context ?? s.detail.slice(0, 60)) || s.headline.slice(0, 60)
    rows.push(`| ${product} | ${confidence} | ${context} |`)
  }

  return rows.join('\n')
}
