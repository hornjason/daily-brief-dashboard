/**
 * src/fixtures/portal-cases.ts
 *
 * Minimal HTML fixture builder for the Red Hat portal support-case table.
 *
 * Generates `<table><tbody>...</tbody></table>` with the exact 14-column
 * structure the portal renders. Use with extractCasesFromDocument() in tests.
 *
 * Portal column map (0-indexed):
 *   [0] checkbox     [1] case# (link)  [2] summary    [3] opened-by
 *   [4] modified     [5] severity      [6] status     [7] (unused)
 *   [8] product      [9-13]            (unused)
 */

export interface PortalCaseFixture {
  caseNumber?: string    // default '01234567'
  summary?: string       // default 'Test summary'
  openedBy?: string      // default 'test.user@example.com'
  modified?: string      // default '2026-03-27'
  severity?: string      // default '3 (Normal)'
  status?: string        // default 'Waiting on Red Hat'
  product?: string       // default 'Red Hat Enterprise Linux'
}

/**
 * Build a portal-shaped HTML table containing the given rows.
 * Pass an empty array to test the empty-table path.
 */
export function makePortalTable(rows: PortalCaseFixture[]): string {
  const trs = rows.map((r) => {
    const caseNum = r.caseNumber ?? '01234567'
    return [
      '<tr>',
      '  <td><input type="checkbox"></td>',                                        // [0] checkbox
      `  <td><a href="/support/cases/#/case/${caseNum}">${caseNum}</a></td>`,      // [1] case#
      `  <td>${r.summary ?? 'Test summary'}</td>`,                                 // [2] summary
      `  <td>${r.openedBy ?? 'test.user@example.com'}</td>`,                       // [3] opened-by
      `  <td>${r.modified ?? '2026-03-27'}</td>`,                                  // [4] modified
      `  <td>${r.severity ?? '3 (Normal)'}</td>`,                                  // [5] severity
      `  <td>${r.status ?? 'Waiting on Red Hat'}</td>`,                            // [6] status
      '  <td></td>',                                                               // [7] unused
      `  <td>${r.product ?? 'Red Hat Enterprise Linux'}</td>`,                     // [8] product
      '  <td></td><td></td><td></td><td></td><td></td>',                          // [9-13] unused
      '</tr>',
    ].join('\n')
  })
  return `<table><tbody>\n${trs.join('\n')}\n</tbody></table>`
}
