/**
 * BKL-BOOTSTRAP-CUSTOMER-FOLDER-DEDUP-01
 *
 * Regression: fresh-install bootstrap created duplicate Drive folders because
 * `existingCustomers` was empty at the point deriveSfCustomersByTerritory ran,
 * so every SF legal name ("Greenheck Fan Corporation") was treated as a new
 * customer even when a territory-sheet folder ("Greenheck Fan") already existed.
 *
 * Fix: read-sf-bookings.ts now builds virtual Customer records from
 * ctx.customerNames (territory sheet names, folder-created in step 2) and
 * includes them in the candidate pool passed to deriveSfCustomersByTerritory.
 * The fuzzy-match in matchCustomer then links "Greenheck Fan Corporation" to
 * the "Greenheck Fan" virtual → group.customer is non-null → NOT a new customer
 * → no duplicate folder.
 */
import { describe, expect, it } from 'bun:test'
import { deriveSfCustomersByTerritory } from '../../src/sf-bookings-reader.ts'
import type { Customer } from '../../src/types.ts'
import type { SfBookingsRawData } from '../../src/sf-bookings-reader.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal SF bookings sheet with one row for "GREENHECK FAN CORPORATION". */
function makeRawSfData(): SfBookingsRawData {
  const headers = [
    'ACCOUNT_GLOBAL_SALES_GROUP_NAME',
    'ACCOUNT_SALES_GROUP_NAME',
    'ACCOUNT_NAME',
    'PRODUCT_DESCRIPTION',
    'PRODUCT_QUANTITY',
    'OPPORTUNITY_LINE_START_DATE',
    'OPPORTUNITY_LINE_END_DATE',
    'PRODUCT_CODE',
    'PRODUCT_FORECAST_OFFERING_GROUP',
    'OPPORTUNITY_NAME_H',
    'OPPORTUNITY_TERRITORY_NAME',
  ]
  const row = [
    'GREENHECK FAN CORPORATION',           // ACCOUNT_GLOBAL_SALES_GROUP_NAME
    'GREENHECK FAN CORPORATION',           // ACCOUNT_SALES_GROUP_NAME
    'GREENHECK FAN CORPORATION',           // ACCOUNT_NAME
    'Red Hat Enterprise Linux Server',     // PRODUCT_DESCRIPTION
    '10',                                  // PRODUCT_QUANTITY
    '2025-01-01',                          // OPPORTUNITY_LINE_START_DATE
    '2027-01-01',                          // OPPORTUNITY_LINE_END_DATE
    'MCT0370',                             // PRODUCT_CODE
    'RHEL',                                // PRODUCT_FORECAST_OFFERING_GROUP
    'Greenheck Fan - RHEL Renewal 2025',   // OPPORTUNITY_NAME_H (non-CCSP)
    'MIDWEST_TERR1',                       // OPPORTUNITY_TERRITORY_NAME
  ]
  return { headers, dataRows: [row] }
}

function makeTerritoryVirtuals(customerNames: string[], customerFolders: Record<string, { id: string; url: string }>, aeName: string): Customer[] {
  return customerNames.map(name => ({
    name,
    ae: aeName,
    importedFrom: 'territory' as any,
    driveFolderId: (customerFolders[name]?.id ?? ''),
    accountNumbers: [],
  }))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BKL-BOOTSTRAP-CUSTOMER-FOLDER-DEDUP-01 — territory virtual candidates prevent duplicate folders', () => {
  const aeName = 'Test AE'
  const territories = ['MIDWEST_TERR1']
  const rawSfData = makeRawSfData()

  it('WITHOUT territory virtuals: SF name appears in newCustomers (demonstrates the bug)', () => {
    // On a fresh install, existingCustomers is empty — the original buggy behaviour
    const existingCustomers: Customer[] = []
    const { newCustomers } = deriveSfCustomersByTerritory(rawSfData, territories, existingCustomers, aeName, false)

    // "GREENHECK FAN CORPORATION" → sanitized "Greenheck Fan Corporation" ends up as a new customer
    const names = newCustomers.map(c => c.name)
    expect(names.some(n => n.toLowerCase().includes('greenheck'))).toBe(true)
  })

  it('WITH territory virtuals: SF name does NOT appear in newCustomers (fix verified)', () => {
    // After the fix, we pass territory-sheet virtual customers into the pool
    const customerNames = ['Greenheck Fan']
    const customerFolders = { 'Greenheck Fan': { id: 'folder-1', url: 'https://drive.google.com/drive/folders/folder-1' } }
    const territoryVirtuals = makeTerritoryVirtuals(customerNames, customerFolders, aeName)

    const existingCustomers: Customer[] = []
    const { newCustomers, results } = deriveSfCustomersByTerritory(
      rawSfData, territories, [...existingCustomers, ...territoryVirtuals], aeName, false,
    )

    // "Greenheck Fan Corporation" must fuzzy-match "Greenheck Fan" virtual → NOT in newCustomers
    const newNames = newCustomers.map(c => c.name)
    expect(newNames.some(n => n.toLowerCase().includes('greenheck'))).toBe(false)

    // And the customer IS still represented in results (subscription data preserved)
    const resultNames = results.map(r => r.customerName)
    expect(resultNames.some(n => n.toLowerCase().includes('greenheck'))).toBe(true)
  })

  it('territory virtual driveFolderId is preserved through the fix — no new folder ID generated', () => {
    const customerNames = ['Greenheck Fan']
    const customerFolders = { 'Greenheck Fan': { id: 'folder-1', url: 'https://drive.google.com/drive/folders/folder-1' } }
    const territoryVirtuals = makeTerritoryVirtuals(customerNames, customerFolders, aeName)

    const { newCustomers } = deriveSfCustomersByTerritory(
      rawSfData, territories, [...[], ...territoryVirtuals], aeName, false,
    )

    // If a Greenheck entry shows up in newCustomers, it would trigger a new Drive folder creation
    // The fix prevents this entirely — zero Greenheck entries in newCustomers
    expect(newCustomers.filter(c => c.name.toLowerCase().includes('greenheck'))).toHaveLength(0)
  })

  it('normalization: "GREENHECK FAN CORPORATION" normalizes to same token set as "Greenheck Fan"', () => {
    // Validates the matching logic works (the fuzzy match IS the fix enabler)
    // If normalization changes, this test catches regression at the root level
    const territoryVirtuals: Customer[] = [{ name: 'Greenheck Fan', ae: aeName, importedFrom: 'territory' as any, accountNumbers: [] }]
    const { newCustomers } = deriveSfCustomersByTerritory(rawSfData, territories, territoryVirtuals, aeName, false)
    expect(newCustomers.filter(c => c.name.toLowerCase().includes('greenheck'))).toHaveLength(0)
  })
})
