/**
 * Signal routing helpers — routes signals to template categories.
 * Extracted from signal-templates.ts — GitHub Issue #684
 */

import type { Signal } from '../../feature-module-registry.ts'
import { resolveToSlug } from '../product-vocabulary.ts'

/**
 * Route a signal to its primary category based on metadata keys FIRST,
 * then fall back to source name for legacy signals.
 *
 * Routing priority (most specific first):
 * 1. Cloud: hasCloudSpend OR provider metadata
 * 2. Case: severity OR caseNumber metadata
 * 3. Renewal: renewal flag OR (stage AND closeDate) metadata
 * 4. Tech: infrastructure metadata OR (confidence AND context with eval/migration keywords)
 * 5. Product: redHatProducts OR product metadata (fallback for subscription-like signals)
 */
export function routeSignal(signal: Signal): 'product' | 'cloud' | 'renewal' | 'case' | 'tech' | 'event' | 'account-plan' | 'ecosystem' | 'competitive' | 'intelligence' | 'partner' | 'saleshub' | 'email' | 'meeting-context' | 'other' {
  const m = signal.metadata ?? {}

  // #987: Meeting context correlation — before metadata-driven routing
  if (signal.source === 'meeting-context') return 'meeting-context'

  // #994: Partner detection — routes to partner section
  if (signal.source === 'partner-detected') return 'partner'

  // #672/#673/#674: Source-specific routing — before metadata checks so signals
  // with metadata.product don't incorrectly route to 'product'
  if (signal.source === 'ecosystem-catalog') return 'ecosystem'
  if (signal.source === 'competitive-intel') return 'competitive'
  if (signal.source === 'intelligence') return 'intelligence'
  if (signal.source === 'partner-catalog') return 'partner'
  if (signal.source === 'saleshub-tactics' || signal.source === 'saleshub-plays') return 'saleshub'
  if (signal.source === 'saleshub-products') return 'product'
  if (signal.source === 'emails') return 'email'

  // Metadata-driven routing (most specific first)
  if (m.hasCloudSpend || m.provider) return 'cloud'
  if (m.severity !== undefined || m.caseNumber) return 'case'
  if (m.renewal || (m.stage && m.closeDate)) return 'renewal'

  // Tech stack: infrastructure metadata OR context with evaluation/migration keywords
  if (m.infrastructure) return 'tech'
  const context = String(m.context ?? '').toLowerCase()
  if (m.confidence && (context.includes('evaluat') || context.includes('migrat') || context.includes('migrating_from'))) {
    return 'tech'
  }

  // #377: Events — signals from rh-events or with format metadata and event type
  if (signal.source === 'rh-events' || (m.format && signal.type === 'event')) return 'event'

  // #380: Account plan — strategic context, deterministic in playbook/brief
  if (signal.source === 'account-plan' || signal.type === 'account-plan') return 'account-plan'

  // Product: subscription/ccsp/product metadata (default for RH product signals)
  // #375: Also route signals with productTags (rh-rss) or productSlug (value-maps)
  if (m.redHatProducts || m.product || (Array.isArray(m.productTags) && m.productTags.length > 0) || m.productSlug) return 'product'

  // Fallback to source name for legacy signals
  if (signal.source === 'cloud-marketplace') return 'cloud'
  if (signal.source === 'cases') return 'case'
  if (signal.source === 'pipeline' && signal.type === 'subscription') return 'renewal'
  if (signal.source === 'tech-stack') return 'tech'
  if (signal.source === 'subscriptions' || signal.source === 'ccsp') return 'product'

  return 'other'
}

/**
 * Filter signals by product if productFilter is set.
 */
export function filterByProduct(signals: Signal[], productFilter?: string[]): Signal[] {
  if (!productFilter || productFilter.length === 0) return signals

  const filterSlugs = new Set(productFilter.map(p => resolveToSlug(p) ?? p.toLowerCase()))

  return signals.filter(s => {
    const m = s.metadata ?? {}
    const products = m.redHatProducts ?? (m.product ? [m.product] : [])
    if (!Array.isArray(products)) return false
    return products.some(p => {
      const slug = resolveToSlug(String(p))
      return slug ? filterSlugs.has(slug) : filterSlugs.has(String(p).toLowerCase())
    })
  })
}
