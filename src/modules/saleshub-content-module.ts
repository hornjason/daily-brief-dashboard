// src/modules/saleshub-content-module.ts
// GitHub Issues #448, #507 — SalesHub Content signal module
// Emits document-level signals from the SalesHub Drive folder.
// #507: Lists files directly from Drive instead of reading knowledge JSON.
// Portfolio-scope: content is not customer-specific.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import {
  loadDriveContent,
  getDriveContentMtime,
  getDriveContentCachePath,
  resetDriveContentCache,
  mapFolderToProduct,
  type DriveContentFile,
} from '../lib/saleshub-content.ts'
import { listSaleshubDriveFiles } from '../lib/saleshub-drive-sync.ts'
import { loadCustomerContext, matchesSubscriptionProducts } from '../lib/customer-context-loader.ts'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // weekly — content updates ~monthly

/**
 * Derive a user-friendly content type label from MIME type.
 */
function mimeToContentType(mimeType: string): string {
  if (mimeType === 'application/vnd.google-apps.document') return 'Document'
  if (mimeType === 'application/vnd.google-apps.presentation') return 'Presentation'
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'Spreadsheet'
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType.includes('presentationml') || mimeType.includes('powerpoint')) return 'PowerPoint'
  if (mimeType.includes('spreadsheetml') || mimeType.includes('excel')) return 'Excel'
  if (mimeType.includes('wordprocessingml') || mimeType.includes('msword')) return 'Word Document'
  return 'File'
}

/**
 * Format a Drive file into a markdown detail block for signal consumers.
 */
function formatDriveFileDetail(file: DriveContentFile): string {
  const parts: string[] = []

  parts.push(`**${file.name}**`)

  const contentType = mimeToContentType(file.mimeType)
  parts.push(`Content Type: ${contentType}`)

  const product = mapFolderToProduct(file.parentFolder)
  parts.push(`Product: ${product}`)

  parts.push(`Folder: ${file.parentFolder}`)

  if (file.driveUrl) {
    parts.push(`[View Document](${file.driveUrl})`)
  }

  if (file.extractedText) {
    // Include first 500 chars of extracted text as preview
    const preview = file.extractedText.length > 500
      ? file.extractedText.slice(0, 500) + '...'
      : file.extractedText
    parts.push(`\n${preview}`)
  }

  return parts.join('\n')
}

FeatureModuleRegistry.register({
  name: 'saleshub-content',
  displayName: 'SalesHub Content',
  refreshEndpoint: '/api/refresh/saleshub-content',
  signalRole: 'enrichment',
  signalAudience: 'all',
  scope: 'portfolio',

  cacheTtlMs: CACHE_TTL_MS,

  refreshInterval: null, // on-demand only

  cachePaths: (_slug: string) => {
    return [getDriveContentCachePath()]
  },

  async ensureFresh(_customerSlug: string): Promise<void> {
    const mtime = getDriveContentMtime()
    if (mtime > 0 && Date.now() - mtime < CACHE_TTL_MS) return // fresh
    // Stale or missing — list files from Drive
    try {
      const result = await listSaleshubDriveFiles()
      if (result) {
        resetDriveContentCache()
        console.log(`[saleshub-content] refreshed Drive content via ensureFresh (${result.totalFiles} files)`)
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
    // List files directly from Drive folder (#507)
    try {
      const result = await listSaleshubDriveFiles()
      if (result) {
        resetDriveContentCache()
        console.log(`[saleshub-content] listed ${result.totalFiles} files from Drive (${result.withText} with text)`)
        FeatureModuleRegistry.recordOutcome('saleshub-content', {
          success: true,
          recordCount: result.totalFiles,
        })
        return
      }
    } catch (e: any) {
      console.warn(`[saleshub-content] Drive listing failed: ${e.message}`)
    }

    // Fallback: read from existing cache
    resetDriveContentCache()
    const files = loadDriveContent()
    if (files.length === 0) {
      console.warn('[saleshub-content] zero-record guard: 0 files in Drive content cache')
      FeatureModuleRegistry.recordOutcome('saleshub-content', { success: false, error: 'No files in Drive cache' })
      return
    }
    console.log(`[saleshub-content] loaded ${files.length} files from Drive content cache`)
    FeatureModuleRegistry.recordOutcome('saleshub-content', {
      success: true,
      recordCount: files.length,
    })
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const files = loadDriveContent()
    if (files.length === 0) return []

    // Load customer context for filtering (#486)
    const customerCtx = loadCustomerContext(customerSlug)

    const signals: Signal[] = []

    for (const file of files) {
      const product = mapFolderToProduct(file.parentFolder)
      const contentType = mimeToContentType(file.mimeType)

      // Check if file's product (from folder name) matches customer subscriptions (#486)
      const matchTargets = [product, file.parentFolder, file.name].filter(t => t.length > 0)
      const isCustomerMatch = matchesSubscriptionProducts(matchTargets, customerCtx.products)
      if (!isCustomerMatch) continue

      const metadata: Record<string, unknown> = {
        documentName: file.name,
        contentType,
        product,
        parentFolder: file.parentFolder,
        driveUrl: file.driveUrl,
        driveId: file.driveId,
        mimeType: file.mimeType,
      }

      if (isCustomerMatch) {
        metadata.customerSlug = customerSlug
      }

      signals.push({
        source: 'SalesHub Content',
        type: 'intelligence',
        headline: `${contentType}: ${file.name}`,
        detail: formatDriveFileDetail(file),
        timestamp: file.modifiedTime || new Date().toISOString(),
        url: file.driveUrl,
        rawRelevance: 0.4, // general-scope baseline; customer match raises via scoring
        metadata,
      })
    }

    return signals
  },
})
