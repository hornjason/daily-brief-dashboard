/**
 * src/ccsp-row-filter.ts — Issue #15 Step 1
 *
 * Pure function extracted from three near-identical filter blocks in
 * `src/ccsp-scraper.ts`:
 *   - Memory cache filter (lines 488–509)
 *   - Drive cache filter (lines 556–581)
 *   - Post-live-fetch filter (lines 839–869)
 *
 * Filters a full POD CSV result down to one AE's territory list and a
 * rolling-quarter window. No IO, no globals, no Date.now, no process.env,
 * no console output. Safe to unit-test with golden-file fixtures.
 *
 * Column matching mirrors the original logic exactly:
 *   - Territory column: header normalized to lowercase, whitespace-collapsed,
 *     equal to 'account territory name' or 'account territory'.
 *   - Quarter column:  header normalized, contains 'fiscal year quarter'.
 *
 * Behavior contract (matches caller expectations in ccsp-scraper.ts):
 *   - validTerritories.length === 0 → no territory filter applied; all rows pass.
 *   - Territory column not found    → input rows returned unchanged (silent).
 *   - Quarter column not found      → territory-filtered rows returned (no quarter filter).
 *   - Empty input                   → empty output.
 */

export function filterRowsForAe(
  rows: Record<string, string>[],
  validTerritories: string[],
  quarters: string[],
): Record<string, string>[] {
  if (rows.length === 0) return rows

  const headerKeys = Object.keys(rows[0] ?? {})

  // Territory filter — only when an explicit territory list is supplied.
  let out = rows
  if (validTerritories.length > 0) {
    const terrColName = headerKeys.find(k => {
      const norm = k.toLowerCase().replace(/\s+/g, ' ').trim()
      return norm === 'account territory name' || norm === 'account territory'
    })
    if (!terrColName) {
      // No territory column — return input unchanged (silent; live path logs).
      return rows
    }
    const terrSet = new Set(validTerritories)
    out = out.filter(r => terrSet.has((r[terrColName] ?? '').trim()))
  }

  if (out.length === 0) return out

  // Quarter filter — best effort; missing column is non-fatal.
  const qtrColName = Object.keys(out[0]).find(k =>
    k.toLowerCase().replace(/\s+/g, ' ').trim().includes('fiscal year quarter'),
  )
  if (qtrColName) {
    const qtrSet = new Set(quarters)
    out = out.filter(r => qtrSet.has((r[qtrColName] ?? '').trim()))
  }

  return out
}
