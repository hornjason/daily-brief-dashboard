import { useState, useCallback } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useApi } from './hooks/useApi'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { KPICards } from './components/KPICards'
import { CalendarStrip } from './components/CalendarStrip'
import { AccountPortfolioGrid } from './components/AccountPortfolioGrid'
import { CloudSpendSection } from './components/CloudSpendSection'
import { PipelineSection } from './components/PipelineSection'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { SetupPage } from './pages/SetupPage'
import { formatRelTime } from './lib/format'
import type { KPIs, CalendarEvent, SupportCase, AccountInfo, CCSPSummary, PipelineSummary } from './types'

function Dashboard() {
  const [refreshKey, setRefreshKey] = useState(0)

  const kpisApi = useApi<KPIs>(`/api/kpis?_=${refreshKey}`)
  const calendarApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&_=${refreshKey}`)
  const calendarAllApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&all=true&_=${refreshKey}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}`)
  const ccspApi     = useApi<CCSPSummary>(`/api/ccsp`)
  const pipelineApi = useApi<PipelineSummary>(`/api/pipeline`)

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
            <KPICards kpis={kpisApi.data} cases={casesApi.data?.cases ?? []} accounts={accountsApi.data?.customers ?? []} loading={kpisApi.loading} />
          </section>

          {/* Pipeline */}
          <section id="section-pipeline">
            <PipelineSection data={pipelineApi.data} loading={pipelineApi.loading} />
          </section>

          {/* Cloud Spend */}
          <section id="section-cloudspend">
            <CloudSpendSection data={ccspApi.data} loading={ccspApi.loading} />
          </section>

          {/* Calendar + Meeting Prep */}
          <section id="section-calendar">
            <CalendarStrip
              events={calendarApi.data?.events ?? []}
              allEvents={calendarAllApi.data?.events ?? []}
              cases={casesApi.data?.cases ?? []}
              accounts={accountsApi.data?.customers ?? []}
              loading={calendarApi.loading || calendarAllApi.loading}
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
      <Route path="/dashboard/setup" element={<SetupPage />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  )
}

export default App
