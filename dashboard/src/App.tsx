import { useState, useCallback } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useApi } from './hooks/useApi'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { KPICards } from './components/KPICards'
import { CalendarStrip } from './components/CalendarStrip'
import { MeetingPrepCards } from './components/MeetingPrepCards'
import { SupportCasesTable } from './components/SupportCasesTable'
import { AccountPortfolioGrid } from './components/AccountPortfolioGrid'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { formatRelTime } from './lib/format'
import type { KPIs, CalendarEvent, SupportCase, AccountInfo } from './types'

function Dashboard() {
  const [refreshKey, setRefreshKey] = useState(0)

  const kpisApi = useApi<KPIs>(`/api/kpis?_=${refreshKey}`)
  const calendarApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&_=${refreshKey}`)
  const calendarAllApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&all=true&_=${refreshKey}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}`)

  const anyLoading = kpisApi.loading || calendarApi.loading || calendarAllApi.loading || casesApi.loading || accountsApi.loading

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const lastSynced =
    !anyLoading && kpisApi.data
      ? formatRelTime(new Date().toISOString())
      : null

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar lastSynced={lastSynced} loading={anyLoading} onRefresh={handleRefresh} />
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* KPI Cards */}
          <section id="section-command">
            <KPICards kpis={kpisApi.data} loading={kpisApi.loading} />
          </section>

          {/* Calendar Strip */}
          <section id="section-calendar">
            <CalendarStrip
              events={calendarApi.data?.events ?? []}
              allEvents={calendarAllApi.data?.events ?? []}
              loading={calendarApi.loading || calendarAllApi.loading}
            />
          </section>

          {/* Meeting Prep Cards */}
          <section id="section-briefs">
            <MeetingPrepCards
              events={calendarApi.data?.events ?? []}
              cases={casesApi.data?.cases ?? []}
              loading={calendarApi.loading || casesApi.loading}
            />
          </section>

          {/* Support Cases Table */}
          <section id="section-cases">
            <SupportCasesTable
              cases={casesApi.data?.cases ?? []}
              loading={casesApi.loading}
            />
          </section>

          {/* Account Portfolio Grid */}
          <section id="section-accounts">
            <AccountPortfolioGrid
              accounts={accountsApi.data?.customers ?? []}
              cases={casesApi.data?.cases ?? []}
              events={calendarApi.data?.events ?? []}
              loading={accountsApi.loading}
            />
          </section>
        </main>
      </div>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/dashboard/customer/:name" element={<CustomerDetailPage />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  )
}

export default App
