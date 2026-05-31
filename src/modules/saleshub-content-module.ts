// src/modules/saleshub-content-module.ts
// GitHub Issue #448 — SalesHub Content signal module
// Emits document-level signals from the SalesHub knowledge base.
// Portfolio-scope: content is not customer-specific.
// L3 Drive Refresh (#460): syncNow downloads fresh data from Drive before reloading.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { loadSalesHubContent, getKnowledgeMtime, resetContentCache, type SalesHubDocument } from '../lib/saleshub-content.ts'
import { downloadSaleshubFromDrive } from '../lib/saleshub-drive-sync.ts'
import { loadCustomerContext, matchesSubscriptionProducts } from '../lib/customer-context-loader.ts'

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
    if (mtime > 0 && Date.now() - mtime < CACHE_TTL_MS) return // fresh
    // Stale or missing — pull from Drive
    try {
      const downloaded = await downloadSaleshubFromDrive()
      if (downloaded) {
        resetContentCache()
        console.log('[saleshub-content] refreshed from Drive via ensureFresh')
      }
    } catch (e: any) {
      console.warn(`[saleshub-content] Drive refresh failed in ensureFresh: ${e.message}`)
    }
  },

  async fetch(_customerName: string): Promise<void> {
    // Portfolio-wide data, not per-customer
  },

  async cleanup(_customerName: string): Promise<void> {
    // Portfolio-level — no per-customer cleanup
  },

  async syncNow(_customerName: string): Promise<void> {
    // Download fresh data from Drive before reloading (#460)
    try {
      const downloaded = await downloadSaleshubFromDrive()
      if (downloaded) console.log('[saleshub-content] downloaded fresh knowledge JSON from Drive')
    } catch (e: any) {
      console.warn(`[saleshub-content] Drive download failed — falling back to disk: ${e.message}`)
    }
    resetContentCache()
    const docs = loadSalesHubContent()
    if (docs.length === 0) {
      console.warn(`[saleshub-content] zero-record guard: 0 documents loaded`)
      FeatureModuleRegistry.recordOutcome('saleshub-content', { success: false, error: 'No documents loaded' })
      return
    }
    console.log(`[saleshub-content] loaded ${docs.length} documents from knowledge JSON`)
    FeatureModuleRegistry.recordOutcome('saleshub-content', {
      success: true,
      recordCount: docs.length,
    })
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const docs = loadSalesHubContent()
    if (docs.length === 0) return []

    // Load customer context for filtering (#486)
    const customerCtx = loadCustomerContext(customerSlug)

    const signals: Signal[] = []

    for (const doc of docs) {
      // Check if document's product/tdp matches customer subscriptions (#486)
      const matchTargets = [doc.product, doc.tdp].filter((t): t is string => !!t && t.length > 0)
      const isCustomerMatch = matchesSubscriptionProducts(matchTargets, customerCtx.products)

      const metadata: Record<string, unknown> = {
        documentName: doc.name,
        contentType: doc.contentType,
        tdp: doc.tdp,
        salesPlay: doc.salesPlay,
        product: doc.product,
        distributionTerms: doc.distributionTerms,
        salesStage: doc.salesStage,
        driveUrl: doc.driveUrl,
      }

      if (isCustomerMatch) {
        metadata.customerSlug = customerSlug
      }

      signals.push({
        source: 'SalesHub Content',
        type: 'intelligence',
        headline: `${doc.contentType}: ${doc.name}`,
        detail: formatDocumentDetail(doc),
        timestamp: doc.versionCreated || new Date().toISOString(),
        url: doc.driveUrl,
        rawRelevance: 0.4, // general-scope baseline; customer match raises via scoring
        metadata,
      })
    }

    return signals
  },
})
