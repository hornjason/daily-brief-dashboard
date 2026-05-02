/**
 * l3-bootstrap — Deep module for AE Drive folder + sheet scaffolding from L3 data.
 *
 * Public contract (ADR-016, Phase 1):
 *   bootstrapAe(config, deps): Promise<AeBootstrapResult>
 *
 * No Playwright, no browser, no Tableau, no SF OAuth.
 * All Drive operations + L3 reads are injected via deps for testability.
 *
 * BKL-ARCH-L4-SPLIT: Phase 1 of the two-container split.
 * The hero install calls this instead of the browser-based CCSP/SF scrape paths.
 */

// ── Public types ──────────────────────────────────────────────────────────────

/** Input configuration for a single AE bootstrap. */
export interface AeBootstrapConfig {
  region: string
  podId: string
  territoryCode: string
  aeName: string
  customerNames: string[]
  parentFolderId: string
  sfReportId: string
}

/** Result returned after a successful bootstrap. */
export interface AeBootstrapResult {
  /** Drive folder ID for the AE (created under parentFolderId). */
  driveFolderId: string
  /** SF Bookings sheet ID (created inside driveFolderId). */
  sfBookingsSheetId: string
  /** CCSP sheet ID (created inside driveFolderId). */
  ccspSheetId: string
  /** Pipeline sheet ID (created inside driveFolderId). */
  pipelineSheetId: string
  /** Customers with no matching rows in any L3 data source. */
  unmatchedCustomers: string[]
}

// ── Dependency types (injected for testability) ───────────────────────────────

/**
 * Minimal Drive client interface.
 * Production implementation uses googleapis; tests inject a mock.
 */
export interface L3BootstrapDriveClient {
  createFolder(name: string, parentId: string): Promise<string>
  createSheet(name: string, parentFolderId: string): Promise<string>
  writeRows(sheetId: string, rows: string[][]): Promise<void>
}

/** L3 reader config — passed to each read method. */
interface L3ReadConfig {
  podId: string
  aeName: string
  customerNames: string[]
}

/**
 * L3 data reader interface.
 * Production implementation reads Drive CSVs; tests inject a mock.
 */
export interface L3DataReader {
  readSfBookings(config: L3ReadConfig): Promise<string[][]>
  readCcsp(config: L3ReadConfig): Promise<string[][]>
  readPipeline(config: L3ReadConfig): Promise<string[][]>
}

/** Combined deps — injected into bootstrapAe(). */
export interface AeBootstrapDeps {
  driveClient: L3BootstrapDriveClient
  l3Reader: L3DataReader
}

// ── Sheet name constants ──────────────────────────────────────────────────────

const SF_BOOKINGS_SHEET_NAME = 'SF Bookings'
const CCSP_SHEET_NAME = 'CCSP'
const PIPELINE_SHEET_NAME = 'Pipeline'

// ── Core bootstrap logic ──────────────────────────────────────────────────────

/**
 * Bootstrap a single AE: create Drive folder + 3 sheets, populate from L3 data.
 *
 * Steps (no browser, no Playwright):
 *   1. Create AE folder under parentFolderId
 *   2. Read L3 data for SF Bookings, CCSP, Pipeline
 *   3. Create 3 sheets inside the AE folder
 *   4. Write L3 rows into each sheet
 *   5. Return sheet IDs + folder ID + unmatched customer names
 */
export async function bootstrapAe(
  config: AeBootstrapConfig,
  deps: AeBootstrapDeps,
): Promise<AeBootstrapResult> {
  const { driveClient, l3Reader } = deps
  const { aeName, podId, customerNames, parentFolderId } = config

  // BKL-SEC-14: Validate aeName before Drive folder creation
  if (!aeName || aeName.trim().length === 0) {
    throw new Error('bootstrapAe: aeName must not be empty')
  }
  if (aeName.length > 200) {
    throw new Error(`bootstrapAe: aeName too long (${aeName.length} chars, max 200)`)
  }
  if (/[\x00-\x1f\x7f]/.test(aeName)) {
    throw new Error('bootstrapAe: aeName contains control characters')
  }
  // Step 1: Create AE Drive folder
  const driveFolderId = await driveClient.createFolder(aeName, parentFolderId)

  // Step 2: Read L3 data in parallel
  const l3Config: L3ReadConfig = { podId, aeName, customerNames }
  const [sfRows, ccspRows, pipelineRows] = await Promise.all([
    l3Reader.readSfBookings(l3Config),
    l3Reader.readCcsp(l3Config),
    l3Reader.readPipeline(l3Config),
  ])

  // Step 3: Create 3 sheets inside the AE folder
  const [sfBookingsSheetId, ccspSheetId, pipelineSheetId] = await Promise.all([
    driveClient.createSheet(SF_BOOKINGS_SHEET_NAME, driveFolderId),
    driveClient.createSheet(CCSP_SHEET_NAME, driveFolderId),
    driveClient.createSheet(PIPELINE_SHEET_NAME, driveFolderId),
  ])

  // Step 4: Write L3 rows to sheets
  await Promise.all([
    driveClient.writeRows(sfBookingsSheetId, sfRows),
    driveClient.writeRows(ccspSheetId, ccspRows),
    driveClient.writeRows(pipelineSheetId, pipelineRows),
  ])

  // Step 5: Compute unmatched customers — names that have no data row in any sheet
  const unmatchedCustomers = _computeUnmatched(customerNames, sfRows, ccspRows, pipelineRows)

  return {
    driveFolderId,
    sfBookingsSheetId,
    ccspSheetId,
    pipelineSheetId,
    unmatchedCustomers,
  }
}

// ── Helper: compute unmatched customers ──────────────────────────────────────

/**
 * A customer is "matched" if their name appears as the first column value
 * in at least one data row (skipping the header row) in any of the 3 data sources.
 * Names are compared case-insensitively to handle minor formatting differences.
 */
function _computeUnmatched(
  customerNames: string[],
  sfRows: string[][],
  ccspRows: string[][],
  pipelineRows: string[][],
): string[] {
  if (customerNames.length === 0) return []

  // Collect all customer names that appear in any data source (skip header row 0)
  const matched = new Set<string>()
  for (const source of [sfRows, ccspRows, pipelineRows]) {
    // Skip header row (index 0) — data starts at index 1
    for (let i = 1; i < source.length; i++) {
      const name = source[i]?.[0]?.trim()
      if (name) matched.add(name.toLowerCase())
    }
  }

  return customerNames.filter(name => !matched.has(name.toLowerCase()))
}
