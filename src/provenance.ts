/**
 * src/provenance.ts
 *
 * Generic provenance tracking with version-aware auto-healing.
 *
 * Provenance = metadata about how data was produced (source, version, timestamp).
 * Auto-healing = automatically regenerating stale data when app version changes.
 *
 * This module provides a reusable API that can track provenance for ANY data type:
 * - Account numbers (existing consumer: account-provenance-healer.ts)
 * - Domain inferences
 * - AI-generated customer briefs
 * - Product intelligence radar data
 *
 * Design principles:
 *   - Manual entries (producedBy === 'manual') are NEVER auto-healed.
 *   - Stale = any non-manual entry whose appVersion !== current version.
 *   - Missing provenance = stale (triggers regeneration).
 *   - All functions are pure (no side effects) except where explicitly noted.
 */

export interface ProvenanceEntry {
  /** The data item this provenance describes (e.g., account number, domain, feature name). */
  key: string
  /** Source that produced this data (e.g., 'rh-scraper', 'domain-inferencer', 'manual'). */
  producedBy: string
  /** App version that produced this data (e.g., 'v1.8.0'). */
  appVersion: string
  /** ISO timestamp when this data was produced. */
  producedAt: string
}

/**
 * Determine if provenance is stale.
 *
 * Stale means: any non-manual entry has an appVersion that doesn't match
 * the current version, OR provenance is missing entirely.
 *
 * If ALL entries are manual, the data is never stale (manual edits
 * are preserved across upgrades).
 *
 * @param entries - Provenance array (may be undefined)
 * @param currentVersion - Current app version to check against
 * @returns true if data needs regeneration
 */
export function isStale(
  entries: ProvenanceEntry[] | undefined,
  currentVersion: string,
): boolean {
  // Missing or empty provenance = definitely stale
  if (!entries || entries.length === 0) return true

  // Filter to non-manual entries only
  const automatedEntries = entries.filter(p => p.producedBy !== 'manual')

  // If all entries are manual, not stale
  if (automatedEntries.length === 0) return false

  // If any automated entry has a different appVersion, it's stale
  return automatedEntries.some(p => p.appVersion !== currentVersion)
}

/**
 * Stamp data items with provenance metadata.
 *
 * Creates a provenance entry for each key with current timestamp.
 *
 * @param keys - Data items to stamp (e.g., account numbers, domains)
 * @param source - Source identifier (e.g., 'rh-scraper', 'domain-inferencer')
 * @param version - Current app version
 * @returns Array of provenance entries
 */
export function stamp(
  keys: string[],
  source: string,
  version: string,
): ProvenanceEntry[] {
  const now = new Date().toISOString()
  return keys.map(key => ({
    key,
    producedBy: source,
    appVersion: version,
    producedAt: now,
  }))
}

/**
 * Merge new provenance with existing, preserving manual entries.
 *
 * Manual provenance (producedBy === 'manual') is NEVER overwritten by
 * automated generation. This function filters existing provenance to keep
 * only manual entries, then appends the new automated entries.
 *
 * @param existing - Current provenance (may be undefined)
 * @param newEntries - Newly stamped provenance from regeneration
 * @returns Merged provenance array with manual entries preserved
 */
export function merge(
  existing: ProvenanceEntry[] | undefined,
  newEntries: ProvenanceEntry[],
): ProvenanceEntry[] {
  const manual = (existing ?? []).filter(p => p.producedBy === 'manual')
  return [...manual, ...newEntries]
}

/**
 * Build a heal plan: identify which items need regeneration.
 *
 * Returns only items with stale provenance. Consumers use this to build
 * a list of work to do at startup or on-demand.
 *
 * @param items - All items to check
 * @param getProvenance - Function to extract provenance from an item
 * @param currentVersion - Current app version
 * @param skipPredicate - Optional function to exclude items from plan (e.g., opt-out flag)
 * @returns Array of items that need regeneration
 */
export function buildHealPlan<T>(
  items: T[],
  getProvenance: (item: T) => ProvenanceEntry[] | undefined,
  currentVersion: string,
  skipPredicate?: (item: T) => boolean,
): T[] {
  const plan: T[] = []

  for (const item of items) {
    // Skip if predicate says so (e.g., user opted out)
    if (skipPredicate && skipPredicate(item)) continue

    // Check if stale
    const provenance = getProvenance(item)
    if (!isStale(provenance, currentVersion)) continue

    // Add to heal plan
    plan.push(item)
  }

  return plan
}
