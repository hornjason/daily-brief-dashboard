/**
 * BKL-#65: RH Cases KPI empty state determination
 * Pure function that determines which empty state to show for the RH Cases KPI card.
 */

export type RhCasesEmptyState = 'no-source' | 'awaiting-sync' | 'synced-zero' | null

interface Account {
  accountNumbers: (string | number)[]
}

/**
 * Determine which empty state to show for the RH Cases KPI card.
 * @param isL3Only - True if this is a hero install (no L4/primary node)
 * @param lastScraped - ISO timestamp of last successful sync, or null
 * @param caseCount - Number of cases returned from the sync
 * @param accounts - Customer accounts with account numbers
 * @returns The empty state to show, or null if cases are present
 */
export function determineRhCasesEmptyState(
  isL3Only: boolean | undefined,
  lastScraped: string | null | undefined,
  caseCount: number,
  accounts: Account[]
): RhCasesEmptyState {
  // If cases are present, use normal display
  if (caseCount > 0) return null

  // State 3: Synced successfully but zero cases (check first — lastScraped is definitive)
  if (lastScraped) {
    return 'synced-zero'
  }

  // Count total account numbers across all accounts
  const totalAccountNumbers = accounts.reduce((sum, acct) => sum + (acct.accountNumbers?.length ?? 0), 0)

  // State 1: No L4 node AND no account numbers → no source configured
  if ((isL3Only === true || isL3Only === undefined) && totalAccountNumbers === 0) {
    return 'no-source'
  }

  // State 2: L4 configured (isL3Only = false) but never synced
  if (isL3Only === false && !lastScraped) {
    return 'awaiting-sync'
  }

  // Fallback: no source (same as state 1 for undefined isL3Only)
  return 'no-source'
}
