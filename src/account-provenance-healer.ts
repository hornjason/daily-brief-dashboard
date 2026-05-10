/**
 * src/account-provenance-healer.ts
 *
 * #82 — Phase 1: accountNumbers provenance tracking with auto-healing.
 *
 * Pure functions for provenance logic + a startup healer that detects stale
 * account numbers and queues re-discovery via the existing scraper-manager
 * infrastructure.
 *
 * Design decisions:
 *   - Manual accounts (discoveredBy === 'manual') are NEVER auto-healed.
 *   - Accounts without provenance are stamped as 'pre-rc8' on first read.
 *   - Stale = any non-manual entry whose appVersion !== current APP_VERSION.
 *   - Re-discovery reuses enqueueScraperTask (scraper-manager infrastructure).
 */

import type { Customer } from './types.ts'
// Re-export AccountProvenance from types.ts so test imports work from this module
export type { AccountProvenance } from './types.ts'

// ── Pure functions (unit-testable, no side effects) ─────────────────────────

/**
 * Determine if a customer's account provenance is stale.
 *
 * Stale means: any non-manual entry has an appVersion that doesn't match
 * the current version, OR provenance is missing entirely.
 *
 * If ALL entries are manual, the customer is never stale (manual edits
 * are preserved across upgrades).
 */
export function isStaleProvenance(
  provenance: Customer['accountProvenance'],
  currentVersion: string,
): boolean {
  // Missing or empty provenance = definitely stale (pre-rc8 migration case)
  if (!provenance || provenance.length === 0) return true

  // Filter to non-manual entries only
  const automatedEntries = provenance.filter(p => p.discoveredBy !== 'manual')

  // If all entries are manual, not stale
  if (automatedEntries.length === 0) return false

  // If any automated entry has a different appVersion, it's stale
  return automatedEntries.some(p => p.appVersion !== currentVersion)
}

/**
 * Stamp existing account numbers with 'pre-rc8' provenance when no
 * provenance metadata exists. This is the migration path for accounts
 * discovered before provenance tracking was added.
 *
 * If provenance already exists (even partial), return it unchanged.
 */
export function migratePreRc8Provenance(
  accountNumbers: string[],
  existingProvenance: Customer['accountProvenance'],
): NonNullable<Customer['accountProvenance']> {
  // Already has provenance — no migration needed
  if (existingProvenance && existingProvenance.length > 0) {
    return existingProvenance
  }

  // No accounts to migrate
  if (accountNumbers.length === 0) return []

  // Stamp each account as pre-rc8
  const now = new Date().toISOString()
  return accountNumbers.map(num => ({
    accountNumber: num,
    discoveredBy: 'pre-rc8' as const,
    appVersion: 'pre-rc8',
    discoveredAt: now,
  }))
}

// ── Healer plan (pure — builds the plan without executing it) ──────────────

export interface HealerPlanEntry {
  customerName: string
  reason: 'stale-version' | 'missing-provenance'
  /** Manual account numbers that must be preserved (not cleared during re-discovery). */
  preserveManualAccounts: string[]
}

/**
 * Build a healer plan: for each customer, determine if their account
 * provenance is stale and needs re-discovery.
 *
 * Returns a list of customers that need healing, with preservation flags
 * for manual accounts.
 */
export function buildHealerPlan(
  customers: Customer[],
  currentVersion: string,
): HealerPlanEntry[] {
  const plan: HealerPlanEntry[] = []

  for (const customer of customers) {
    // Skip customers with no account numbers — nothing to heal
    if (!customer.accountNumbers || customer.accountNumbers.length === 0) continue

    // Skip customers that opted out of account discovery
    if (customer.skipAccountDiscovery) continue

    const provenance = customer.accountProvenance

    // Check if stale
    if (!isStaleProvenance(provenance, currentVersion)) continue

    // Determine reason
    const reason: HealerPlanEntry['reason'] =
      (!provenance || provenance.length === 0) ? 'missing-provenance' : 'stale-version'

    // Identify manual accounts to preserve
    const manualAccounts = (provenance ?? [])
      .filter(p => p.discoveredBy === 'manual')
      .map(p => p.accountNumber)

    plan.push({
      customerName: customer.name,
      reason,
      preserveManualAccounts: manualAccounts,
    })
  }

  return plan
}

// ── Startup healer (side-effectful — reads state, queues tasks) ────────────

/**
 * Run once at server startup, before any scrapes execute.
 *
 * 1. For each customer with accountNumbers but no provenance → stamp as 'pre-rc8'
 * 2. For each customer with stale provenance → queue re-discovery
 * 3. Manual accounts are always preserved
 *
 * Re-discovery reuses the existing scraper-manager infrastructure via
 * enqueueScraperTask, which coalesces duplicate requests.
 */
export async function healStaleAccountNumbers(): Promise<void> {
  // Lazy imports to avoid circular dependencies at module load time
  const { customers, patchCustomer } = await import('./server-state.ts')
  const { APP_VERSION } = await import('./admin-routes.ts')

  console.log(`[healer] startup account provenance check (appVersion=${APP_VERSION}, ${customers.length} customers)`)

  // Phase 1: Migrate pre-rc8 accounts (stamp provenance on first read)
  let migratedCount = 0
  for (const customer of customers) {
    if (!customer.accountNumbers || customer.accountNumbers.length === 0) continue
    if (customer.accountProvenance && customer.accountProvenance.length > 0) continue

    const provenance = migratePreRc8Provenance(customer.accountNumbers, customer.accountProvenance)
    patchCustomer(customer.name, { accountProvenance: provenance })
    migratedCount++
  }
  if (migratedCount > 0) {
    console.log(`[healer] migrated ${migratedCount} customers to pre-rc8 provenance`)
  }

  // Phase 2: Build heal plan and queue re-discovery
  // Re-read customers after migration patches
  const { customers: freshCustomers } = await import('./server-state.ts')
  const plan = buildHealerPlan(freshCustomers, APP_VERSION)

  if (plan.length === 0) {
    console.log('[healer] all account provenance is current — no healing needed')
    return
  }

  console.log(`[healer] ${plan.length} customers need re-discovery:`)
  for (const entry of plan) {
    const manualNote = entry.preserveManualAccounts.length > 0
      ? ` (preserving ${entry.preserveManualAccounts.length} manual accounts)`
      : ''
    console.log(`[healer]   ${entry.customerName}: ${entry.reason}${manualNote}`)
  }

  // Queue a single RH cases scrape — the scraper-manager's runRhScrapeWithState
  // already iterates all customers and re-discovers account numbers.
  // We don't need to queue per-customer tasks; one scrape run handles everything.
  try {
    const { enqueueScraperTask } = await import('./background-scheduler.ts')
    const { runRhScrapeWithState } = await import('./scraper-manager.ts')

    enqueueScraperTask({
      name: 'rh-cases (healer)',
      run: runRhScrapeWithState,
      source: 'startup',
      enqueuedAt: Date.now(),
    })
    console.log(`[healer] queued rh-cases re-discovery for ${plan.length} stale customers`)
  } catch (e: any) {
    console.warn(`[healer] failed to queue re-discovery: ${e?.message ?? e}`)
  }
}

// ── Provenance stamper (called by discovery paths) ──────────────────────────

/**
 * Build provenance entries for newly discovered account numbers.
 * Called by rh-cases-api.ts (bearer path) and rh-scraper.ts (browser path)
 * after successful account discovery.
 */
export function stampProvenance(
  accountNumbers: string[],
  discoveredBy: 'rh-scraper' | 'rh-cases-api',
  appVersion: string,
): NonNullable<Customer['accountProvenance']> {
  const now = new Date().toISOString()
  return accountNumbers.map(num => ({
    accountNumber: num,
    discoveredBy,
    appVersion,
    discoveredAt: now,
  }))
}

/**
 * Merge new provenance entries with existing provenance, preserving manual entries.
 *
 * Manual account provenance (discoveredBy === 'manual') is NEVER overwritten by
 * automated discovery. This function filters existing provenance to keep only manual
 * entries, then appends the new automated entries.
 *
 * @param existingProvenance - Current customer provenance (may be undefined)
 * @param newEntries - Newly stamped provenance from discovery
 * @returns Merged provenance array with manual entries preserved
 */
export function mergeProvenance(
  existingProvenance: Customer['accountProvenance'],
  newEntries: NonNullable<Customer['accountProvenance']>,
): NonNullable<Customer['accountProvenance']> {
  const manual = (existingProvenance ?? []).filter(p => p.discoveredBy === 'manual')
  return [...manual, ...newEntries]
}
