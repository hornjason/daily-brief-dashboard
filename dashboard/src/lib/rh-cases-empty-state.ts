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
 * @param rhTokenConfigured - True if REDHAT_OFFLINE_TOKEN is saved (not placeholder)
 * @returns The empty state to show, or null if cases are present
 */
export function determineRhCasesEmptyState(
  isL3Only: boolean | undefined,
  lastScraped: string | null | undefined,
  caseCount: number,
  accounts: Account[],
  rhTokenConfigured?: boolean
): RhCasesEmptyState {
  // If cases are present, use normal display
  if (caseCount > 0) return null

  // State 3: Synced successfully but zero cases (check first — lastScraped is definitive)
  if (lastScraped) {
    return 'synced-zero'
  }

  // State 2: Token configured but no sync yet → awaiting first run
  if (rhTokenConfigured) {
    return 'awaiting-sync'
  }

  // Count total account numbers across all accounts
  const totalAccountNumbers = accounts.reduce((sum, acct) => sum + (acct.accountNumbers?.length ?? 0), 0)

  // State 2: L4 configured or has account numbers but never synced
  if (isL3Only === false || totalAccountNumbers > 0) {
    return 'awaiting-sync'
  }

  // State 1: No token, no L4, no accounts → no source configured
  return 'no-source'
}
