/**
 * src/fixtures/supportable-table.ts
 *
 * Minimal HTML fixture builder for the Supportable APEX Interactive Report table.
 *
 * Generates HTML matching the APEX subscription table structure used by
 * parseHtmlTable() in supportable-extract.ts. Headers are chosen to match
 * SUBSCRIPTION_COLUMN_PATTERNS so the parser identifies the table correctly.
 *
 * APEX subscription table column map:
 *   SKU | Ordered Item | Product Description | Quantity | Status |
 *   Start Date | End Date | Contract | Customer Number | Account Number
 */

export interface SupportableFixture {
  sku?: string
  orderedItem?: string
  productDescription?: string
  quantity?: string
  status?: string
  startDate?: string
  endDate?: string
  contract?: string
  customerNumber?: string
  accountNumber?: string
}

/**
 * Build an APEX-shaped HTML table containing the given subscription rows.
 * Pass an empty array to test the empty-table path.
 */
export function makeSupportableTable(rows: SupportableFixture[]): string {
  const headers = [
    'SKU',
    'Ordered Item',
    'Product Description',
    'Quantity',
    'Status',
    'Start Date',
    'End Date',
    'Contract',
    'Customer Number',
    'Account Number',
  ]

  const headerRow = headers.map(h => `<th>${h}</th>`).join('')

  const dataRows = rows.map(r => {
    const cells = [
      r.sku             ?? 'MCT1234',
      r.orderedItem     ?? 'Red Hat Enterprise Linux',
      r.productDescription ?? 'RHEL Server',
      r.quantity        ?? '10',
      r.status          ?? 'Active',
      r.startDate       ?? '2025-01-01',
      r.endDate         ?? '2026-01-01',
      r.contract        ?? '12345678',
      r.customerNumber  ?? 'CUST001',
      r.accountNumber   ?? 'ACC001',
    ]
    const tds = cells.map(v => `<td>${v}</td>`).join('')
    return `<tr>${tds}</tr>`
  })

  return [
    '<table>',
    `  <thead><tr>${headerRow}</tr></thead>`,
    '  <tbody>',
    ...dataRows.map(r => `    ${r}`),
    '  </tbody>',
    '</table>',
  ].join('\n')
}
