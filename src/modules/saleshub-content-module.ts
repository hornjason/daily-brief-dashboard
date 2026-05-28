// src/modules/saleshub-content-module.ts
// GitHub Issue #448 — SalesHub Content signal module
// Emits document-level signals from the SalesHub knowledge base.
// Portfolio-scope: content is not customer-specific.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadSalesHubContent, getKnowledgeMtime, resetContentCache, type SalesHubDocument } from '../lib/saleshub-content.ts'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // weekly — content updates ~monthly

/**
 * Format a document into a markdown detail block for signal consumers.
 */
function formatDocumentDetail(doc: SalesHubDocument): string {
  const parts: string[] = []

  parts.push(`**${doc.name}**`)

  if (doc.contentType) {
    parts.push(`Content Type: ${doc.contentType}`)
  }

  if (doc.product) {
    parts.push(`Product: ${doc.product}`)
  }

  if (doc.tdp) {
    parts.push(`TDP: ${doc.tdp}`)
  }

  if (doc.salesPlay) {
    parts.push(`Sales Play: ${doc.salesPlay}`)
  }

  if (doc.salesStage) {
    parts.push(`Sales Stage: ${doc.salesStage}`)
  }

  if (doc.distributionTerms) {
    parts.push(`Distribution: ${doc.distributionTerms}`)
  }

  if (doc.driveUrl) {
    parts.push(`[View Document](${doc.driveUrl})`)
  }

  return parts.join('\n')
}

FeatureModuleRegistry.register({
  name: 'saleshub-content',
  displayName: 'SalesHub Content',
  refreshEndpoint: '/api/refresh/saleshub-content',

  scope: 'portfolio',

  cacheTtlMs: CACHE_TTL_MS,

  refreshInterval: null, // on-demand only

  cachePaths: (_slug: string) => {
    // Uses same knowledge JSON as saleshub module
    return []
  },

  async ensureFresh(_customerSlug: string): Promise<void> {
    const mtime = getKnowledgeMtime()
    if (mtime === 0) return // no file — nothing to refresh
    if (Date.now() - mtime < CACHE_TTL_MS) return // fresh
    console.warn('[saleshub-content] knowledge JSON is older than 7 days — manual refresh recommended')
  },

  async fetch(_customerName: string): Promise<void> {
    // Portfolio-wide data, not per-customer
  },

  async cleanup(_customerName: string): Promise<void> {
    // Portfolio-level — no per-customer cleanup
  },

  async syncNow(_customerName: string): Promise<void> {
    resetContentCache()
    const docs = loadSalesHubContent()
    console.log(`[saleshub-content] loaded ${docs.length} documents from knowledge JSON`)
    FeatureModuleRegistry.recordOutcome('saleshub-content', {
      success: true,
      recordCount: docs.length,
    })
  },

  async signals(_customerSlug: string): Promise<Signal[]> {
    const docs = loadSalesHubContent()
    if (docs.length === 0) return []

    const signals: Signal[] = []

    for (const doc of docs) {
      signals.push({
        source: 'SalesHub Content',
        type: 'intelligence',
        headline: `${doc.contentType}: ${doc.name}`,
        detail: formatDocumentDetail(doc),
        timestamp: doc.versionCreated || new Date().toISOString(),
        url: doc.driveUrl,
        rawRelevance: 0.4, // general-scope, not customer-specific
        metadata: {
          documentName: doc.name,
          contentType: doc.contentType,
          tdp: doc.tdp,
          salesPlay: doc.salesPlay,
          product: doc.product,
          distributionTerms: doc.distributionTerms,
          salesStage: doc.salesStage,
          driveUrl: doc.driveUrl,
        },
      })
    }

    return signals
  },
})
