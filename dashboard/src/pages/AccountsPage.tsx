/**
 * AccountsPage — Route: /dashboard/accounts
 * GitHub Issue #239
 *
 * Extracted from the monolithic Dashboard component in App.tsx.
 * Displays: AccountPortfolioGrid with search/filter/triage controls.
 * Fetches its own account, case, and calendar data via useApi.
 */
import { useMemo } from 'react'
import { useApi } from '../hooks/useApi'
import { AccountPortfolioGrid } from '../components/AccountPortfolioGrid'
import { normalizeProductName, stripProductName, discoverAllProducts } from '../utils/productName'
import type { AccountInfo, SupportCase, CalendarEvent } from '../types'

interface AccountsPageProps {
  refreshKey: number
  aeFilterSelected: string
  productFilterSelected: string[]
  filteredAccounts: AccountInfo[]
  activePodId: string
}

export function AccountsPage({
  refreshKey,
  aeFilterSelected,
  productFilterSelected,
  filteredAccounts,
  activePodId,
}: AccountsPageProps) {
  const podQuery = activePodId ? `&pod=${activePodId}` : ''
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}${podQuery}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const calendarApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&_=${refreshKey}`)

  // Derive AE list with counts for the grid
  const aeList = useMemo(() => {
    const accounts = accountsApi.data?.customers ?? []
    const map = new Map<string, number>()
    for (const a of accounts) {
      if (a.ae) map.set(a.ae, (map.get(a.ae) ?? 0) + 1)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }))
  }, [accountsApi.data])

  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      <section id="section-accounts" data-section="section-accounts">
        <AccountPortfolioGrid
          accounts={filteredAccounts}
          cases={casesApi.data?.cases ?? []}
          events={calendarApi.data?.events ?? []}
          loading={accountsApi.loading}
          selectedProducts={productFilterSelected}
          aeList={aeList}
          aeFilterSelected={aeFilterSelected}
          allAccounts={accountsApi.data?.customers ?? []}
        />
      </section>
    </main>
  )
}
