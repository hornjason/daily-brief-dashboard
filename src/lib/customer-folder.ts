/**
 * Shared customer-to-Drive-folder resolution module.
 *
 * Exports two functions:
 *   - findCustomerDriveFolder: resolves a Customer to its Drive folder ID
 *   - normalizeCustomerName: display-oriented name normalizer (strips state suffix,
 *     parentheticals, legal entity suffixes; applies title case)
 *
 * The module does NOT call persistCustomerFolderId — that side effect stays
 * with the caller (currently account-intelligence.ts). This keeps the module
 * pure and testable.
 *
 * ADR-0016: Drive traversal is fully delegated to driveClient, which enforces
 * supportsAllDrives unconditionally.
 */

import { driveClient as productionDriveClient } from './drive-client.ts'
import { aes as productionAes } from '../server-state.ts'
import type { AE, Customer } from '../types.ts'
import type { DriveFolderClient } from './drive-client.ts'

// ── Dependency injection interface ───────────────────────────────────────────

interface CustomerFolderDeps {
  driveClient: Pick<DriveFolderClient, 'findDescendantFolder'>
  aes: AE[]
}

// ── Core resolver implementation ─────────────────────────────────────────────

async function resolveCustomerFolder(
  customer: Customer,
  deps: CustomerFolderDeps,
): Promise<string> {
  // Fast path: customer already has a known folder ID — no Drive call needed.
  if (customer.driveFolderId) return customer.driveFolderId

  const ae = deps.aes.find(a => a.name === customer.ae)
  const aeFolderId = ae?.driveFolderId
  if (!aeFolderId) {
    throw new Error('Drive folder lookup failed — AE has no Drive folder configured')
  }

  // BFS up to 2 levels (handles "AE/Accounts/<customer>" layouts), fuzzy-matched.
  // ADR-0016: driveClient supplies supportsAllDrives unconditionally.
  const matchId = await deps.driveClient.findDescendantFolder(aeFolderId, customer.name, {
    fuzzy: true,
    maxDepth: 2,
  })

  if (matchId) return matchId

  throw new Error('Drive folder lookup failed — no matching folder found in Drive')
}

// ── Production singleton binding ─────────────────────────────────────────────

/**
 * Resolves a customer's Drive folder ID.
 *
 * Fast path: if `customer.driveFolderId` is set, returns it immediately.
 * Slow path: looks up the AE from server-state.aes, then calls
 * driveClient.findDescendantFolder with fuzzy=true, maxDepth=2.
 *
 * Does NOT call persistCustomerFolderId — that is the caller's responsibility.
 *
 * @throws if the customer's AE has no driveFolderId
 * @throws if findDescendantFolder returns null
 */
export function findCustomerDriveFolder(customer: Customer): Promise<string> {
  return resolveCustomerFolder(customer, {
    driveClient: productionDriveClient,
    aes: productionAes,
  })
}

// ── Test factory ─────────────────────────────────────────────────────────────

/**
 * Test-only factory — never use in production code.
 * Returns a resolver function bound to the provided stub deps.
 */
export function makeCustomerFolderResolverForTest(
  deps: CustomerFolderDeps,
): (customer: Customer) => Promise<string> {
  return (customer) => resolveCustomerFolder(customer, deps)
}

// ── normalizeCustomerName ────────────────────────────────────────────────────

/**
 * Display-oriented name normalizer (moved verbatim from bootstrap-orchestrator.ts).
 *
 * Strips state suffix " - CA", parentheticals "(HostGator)", legal entity
 * suffixes (INC., LLC, CORP., etc.); applies title case while preserving
 * words that contain digits (A10, H2O) or internal dots (U.S.) or are
 * already mixed case.
 *
 * Input:  "DROPBOX, INC. - CA"  → Output: "Dropbox"
 * Input:  "FRED HUTCHINSON CANCER CENTER"  → Output: "Fred Hutchinson Cancer Center"
 * Input:  "A10 NETWORKS, INC."  → Output: "A10 Networks"
 */
export function normalizeCustomerName(raw: string): string {
  let name = raw.trim()
  // Strip state suffix " - XX" or " - XX/XX"
  name = name.replace(/\s+-\s+[A-Z]{2}(\/[A-Z]{2})?$/, '')
  // Strip parentheticals like "(REI)" or "(HostGator)"
  name = name.replace(/\s*\([^)]*\)\s*$/, '')
  // Strip legal entity suffixes (with or without leading comma)
  const legalSuffixes = [
    /,?\s+L\.?L\.?P\.?$/i,
    /,?\s+P\.?T\.?Y\.?\s+LTD\.?$/i,
    /,?\s+L\.?P\.?$/i,
    /,?\s+INC\.?$/i,
    /,?\s+LLC\.?$/i,
    /,?\s+LTD\.?$/i,
    /,?\s+CORP\.?$/i,
    /,?\s+CO\.?$/i,
    /,?\s+PLC\.?$/i,
  ]
  for (const re of legalSuffixes) name = name.replace(re, '')
  name = name.trim().replace(/,+$/, '').trim()
  // Title case: preserve words with digits (A10, H2O) or internal dots (U.S.) or already mixed case
  name = name.split(/\s+/).map(word => {
    if (/\d/.test(word) || /[a-z]/.test(word) || /\.[a-zA-Z]/.test(word)) return word
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
  return name
}
