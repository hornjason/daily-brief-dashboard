/**
 * Structured Customer Overview view — GitHub Issue #779
 *
 * #779: structuredCustomerOverview() is the SINGLE SOURCE OF TRUTH for
 *       cross-reference counting and product type classification.
 *       The API endpoint delegates here; React components consume the flat shape.
 *
 * Layer 3 compliance: React components must NOT access signal.metadata directly.
 * This file replicates the matchType/redHatProducts counting logic that
 * previously lived in CustomerDetailPage.tsx lines 1220-1238.
 */

import type { Signal } from '../../feature-module-registry.ts'

// ── Portfolio sources that contribute cross-reference data ──────────────────

const PORTFOLIO_SOURCES = ['product-lifecycle', 'product-intel', 'rh-rss', 'rh-events', 'value-maps']

// ── Structured view types (#779) ────────────────────────────────────────────

export interface CustomerOverviewView {
  crossRefBySource: Record<string, { subscription: number; interest: number }>
  ownedProducts: string[]
  expansionProducts: string[]
}

/**
 * SINGLE SOURCE OF TRUTH: structured customer overview view.
 * Replicates the cross-reference counting logic from CustomerDetailPage.tsx.
 * The API endpoint delegates to this function.
 */
export function structuredCustomerOverview(signals: Signal[]): CustomerOverviewView {
  const crossRefBySource: Record<string, { subscription: number; interest: number }> = {}
  const matchedProductTypes: Record<string, 'subscription' | 'interest'> = {}

  for (const s of signals) {
    if (!PORTFOLIO_SOURCES.includes(s.source)) continue
    if (!crossRefBySource[s.source]) crossRefBySource[s.source] = { subscription: 0, interest: 0 }

    const matchType = s.metadata?.matchType as string | undefined
    if (matchType === 'subscription') crossRefBySource[s.source].subscription++
    else if (matchType === 'interest') crossRefBySource[s.source].interest++

    const products = s.metadata?.redHatProducts as string[] | undefined
    if (products && matchType) {
      for (const p of products) {
        if (!matchedProductTypes[p] || matchType === 'subscription') {
          matchedProductTypes[p] = matchType as 'subscription' | 'interest'
        }
      }
    }
  }

  const ownedProducts = Object.entries(matchedProductTypes)
    .filter(([, t]) => t === 'subscription')
    .map(([p]) => p)
  const expansionProducts = Object.entries(matchedProductTypes)
    .filter(([, t]) => t === 'interest')
    .map(([p]) => p)

  return {
    crossRefBySource,
    ownedProducts,
    expansionProducts,
  }
}
