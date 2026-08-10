// src/data-ingestion-registry.ts
// Data Ingestion Registry — Layer 9 component catalog
//
// Centralizes the component inventory for the 4-tier data ingestion architecture:
//   L3 Drive → L4 Background Scrapers → Cache Layer → Application State
//
// This registry enables pattern consistency enforcement (#173) and provides
// a single source of truth for architecture compliance tests.

export interface DataIngestionComponent {
  /** Component name (human-readable) */
  name: string
  /** Ingestion tier: cache-layer | drive-sync | scraper | bootstrap */
  tier: 'cache-layer' | 'drive-sync' | 'scraper' | 'bootstrap'
  /** File path relative to src/ */
  filePath: string
  /** Optional: primary data source this component ingests from */
  source?: string
}

const _components: DataIngestionComponent[] = []

export const DataIngestionRegistry = {
  /** Register a data ingestion component */
  register(component: DataIngestionComponent): void {
    _components.push(component)
  },

  /** Get all registered components */
  list(): DataIngestionComponent[] {
    return [..._components]
  },

  /** Get components by tier */
  byTier(tier: DataIngestionComponent['tier']): DataIngestionComponent[] {
    return _components.filter(c => c.tier === tier)
  },

  /** Get component count */
  count(): number {
    return _components.length
  },
}

// ── Cache Layer (L3 → Application) ───────────────────────────────────────────
DataIngestionRegistry.register({
  name: 'Cache Layer',
  tier: 'cache-layer',
  filePath: 'cache-layer.ts',
  source: 'multi',
})

DataIngestionRegistry.register({
  name: 'Cache Strategy',
  tier: 'cache-layer',
  filePath: 'lib/cache-strategy.ts',
})

DataIngestionRegistry.register({
  name: 'Cache Hierarchy',
  tier: 'cache-layer',
  filePath: 'lib/cache-hierarchy.ts',
})

DataIngestionRegistry.register({
  name: 'CCSP Cache',
  tier: 'cache-layer',
  filePath: 'ccsp-cache.ts',
  source: 'salesforce',
})

DataIngestionRegistry.register({
  name: 'Attendee Profile Cache',
  tier: 'cache-layer',
  filePath: 'lib/attendee-profile-cache.ts',
  source: 'events',
})

// ── Drive Sync (L3 Drive Integration) ────────────────────────────────────────
DataIngestionRegistry.register({
  name: 'Drive Config Sync',
  tier: 'drive-sync',
  filePath: 'drive-config-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Drive Sources',
  tier: 'drive-sync',
  filePath: 'drive-sources.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Drive Watcher',
  tier: 'drive-sync',
  filePath: 'drive-watcher.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Template Sync',
  tier: 'drive-sync',
  filePath: 'template-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Territory Sync',
  tier: 'drive-sync',
  filePath: 'territory-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Sync State',
  tier: 'drive-sync',
  filePath: 'sync-state.ts',
})

DataIngestionRegistry.register({
  name: 'Product Drive Ingest',
  tier: 'drive-sync',
  filePath: 'product-drive-ingest.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'SalesHub Drive Sync',
  tier: 'drive-sync',
  filePath: 'lib/saleshub-drive-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'SalesHub Product Drive Sync',
  tier: 'drive-sync',
  filePath: 'lib/saleshub-product-drive-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Partner Catalog Drive Sync',
  tier: 'drive-sync',
  filePath: 'lib/partner-catalog-drive-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Ecosystem Catalog Drive Sync',
  tier: 'drive-sync',
  filePath: 'lib/ecosystem-catalog-drive-sync.ts',
  source: 'google-drive',
})

DataIngestionRegistry.register({
  name: 'Drive Client',
  tier: 'drive-sync',
  filePath: 'lib/drive-client.ts',
  source: 'google-drive',
})

// ── Scrapers (L4 Background Data Collection) ─────────────────────────────────
DataIngestionRegistry.register({
  name: 'Scraper Manager',
  tier: 'scraper',
  filePath: 'scraper-manager.ts',
})

DataIngestionRegistry.register({
  name: 'Scraper Registry',
  tier: 'scraper',
  filePath: 'scraper-registry.ts',
})

DataIngestionRegistry.register({
  name: 'Scraper Queue',
  tier: 'scraper',
  filePath: 'scraper-queue.ts',
})

DataIngestionRegistry.register({
  name: 'Scraper Status Store',
  tier: 'scraper',
  filePath: 'scraper-status-store.ts',
})

DataIngestionRegistry.register({
  name: 'Scraper Utilities',
  tier: 'scraper',
  filePath: 'scraper-utils.ts',
})

DataIngestionRegistry.register({
  name: 'Scraper Errors',
  tier: 'scraper',
  filePath: 'scraper-errors.ts',
})

DataIngestionRegistry.register({
  name: 'Red Hat Scraper',
  tier: 'scraper',
  filePath: 'rh-scraper.ts',
  source: 'redhat-portal',
})

DataIngestionRegistry.register({
  name: 'Red Hat Scraper Extract',
  tier: 'scraper',
  filePath: 'rh-scraper-extract.ts',
  source: 'redhat-portal',
})

DataIngestionRegistry.register({
  name: 'Salesforce Scraper',
  tier: 'scraper',
  filePath: 'sf-scraper.ts',
  source: 'salesforce',
})

DataIngestionRegistry.register({
  name: 'CCSP Scraper',
  tier: 'scraper',
  filePath: 'ccsp-scraper.ts',
  source: 'salesforce',
})

DataIngestionRegistry.register({
  name: 'Supportable Scraper',
  tier: 'scraper',
  filePath: 'supportable-scraper.ts',
  source: 'redhat-portal',
})

DataIngestionRegistry.register({
  name: 'Partner Catalog Scraper',
  tier: 'scraper',
  filePath: 'lib/partner-catalog-scraper.ts',
  source: 'redhat-connect',
})

// ── Bootstrap (Initial Setup & Config Loading) ───────────────────────────────
DataIngestionRegistry.register({
  name: 'SF Cache (Bootstrap)',
  tier: 'bootstrap',
  filePath: 'bootstrap/sf-cache.ts',
  source: 'salesforce',
})

DataIngestionRegistry.register({
  name: 'Create Drive Folder (Bootstrap)',
  tier: 'bootstrap',
  filePath: 'bootstrap/steps/create-drive-folder.ts',
  source: 'google-drive',
})

// ── Ingest Events (Cross-tier eventing) ──────────────────────────────────────
DataIngestionRegistry.register({
  name: 'Ingest Events',
  tier: 'cache-layer',
  filePath: 'ingest-events.ts',
})
