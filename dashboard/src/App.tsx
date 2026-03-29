import { useState, useCallback, useEffect, useRef } from 'react'
import { Routes, Route } from 'react-router-dom'
import { useApi } from './hooks/useApi'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { KPICards } from './components/KPICards'
import { CalendarStrip } from './components/CalendarStrip'
import { AccountPortfolioGrid } from './components/AccountPortfolioGrid'
import { CloudSpendSection } from './components/CloudSpendSection'
import { PipelineSection } from './components/PipelineSection'
import { RefreshTimerSettings } from './components/RefreshTimerSettings'
import { WeatherSettings } from './components/WeatherSettings'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { SetupPage } from './pages/SetupPage'
import { formatRelTime } from './lib/format'
import type { KPIs, CalendarEvent, SupportCase, AccountInfo, CCSPSummary, PipelineSummary } from './types'

interface RhStatus {
  hasSession: boolean
  sessionExpired: boolean
  lastScraped: string | null
  caseCount: number
  loginInProgress: boolean
  loginTimedOut: boolean
}

const timeAgo = formatRelTime

function RhSessionBanner({ status, onReconnect, onVncOpen }: { status: RhStatus; onReconnect: () => void; onVncOpen: (win: Window | null) => void }) {
  const [reconnecting, setReconnecting] = useState(false)

  if (!status.sessionExpired && status.hasSession) return null

  const handleReconnect = async () => {
    setReconnecting(true)
    try {
      const res = await fetch('/api/auth/redhat/start', { method: 'POST' })
      const d = await res.json()
      if (d.error) {
        // Show a concise error — don't open VNC if the browser never started
        console.error('[rh-banner] start failed:', d.error)
        setReconnecting(false)
        return
      }
      onReconnect()
      // Open the noVNC viewer so the user can complete the login in their browser
      const win = window.open('http://localhost:6080/vnc.html?autoconnect=true&reconnect=true', '_blank')
      onVncOpen(win)
    } catch {
      setReconnecting(false)
    }
  }

  return (
    <div className="bg-amber-900/40 border-b border-amber-700/50 px-6 py-2.5 flex items-center gap-3 text-sm">
      <span className="text-amber-400 font-medium shrink-0">
        {status.hasSession ? '⚠ Red Hat session expired' : '⚠ Red Hat Portal not connected'}
      </span>
      {status.lastScraped && (
        <span className="text-amber-300/70">— cases last synced {timeAgo(status.lastScraped)}</span>
      )}
      <div className="flex-1" />
      {reconnecting ? (
        <span className="text-amber-300 text-xs">Login browser opened — complete sign-in in the new tab, then return here…</span>
      ) : (
        <button
          onClick={handleReconnect}
          className="bg-amber-700 hover:bg-amber-600 text-white px-3 py-1 rounded text-xs font-medium transition-colors shrink-0"
        >
          {status.hasSession ? 'Reconnect' : 'Connect'}
        </button>
      )}
    </div>
  )
}

function NoAEsBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="bg-blue-900/40 border-b border-blue-700/50 px-6 py-2.5 flex items-center gap-3 text-sm">
      <span className="text-blue-300 font-medium">No AEs configured</span>
      <span className="text-blue-300/70">&mdash; visit Setup to get started</span>
      <a href="/dashboard/setup" className="bg-blue-700 hover:bg-blue-600 text-white px-3 py-1 rounded text-xs font-medium transition-colors shrink-0">Go to Setup</a>
      <div className="flex-1" />
      <button onClick={onDismiss} className="text-blue-400 hover:text-blue-300 text-xs">Dismiss</button>
    </div>
  )
}

function Dashboard() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [active, setActive] = useState('Command Center')
  const [rhStatus, setRhStatus] = useState<RhStatus | null>(null)
  const [rhReconnecting, setRhReconnecting] = useState(false)
  const [noAesDismissed, setNoAesDismissed] = useState(false)
  const [aeCount, setAeCount] = useState<number | null>(null)
  const vncWindowRef = useRef<Window | null>(null)

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

  // Poll RH session status every 5 minutes; every 2s while reconnecting
  const fetchRhStatus = useCallback(async () => {
    try {
      const d: RhStatus = await fetch('/api/auth/redhat/status').then((r) => r.json())
      setRhStatus(d)
      if (rhReconnecting && d.hasSession && !d.loginInProgress) {
        setRhReconnecting(false)
        vncWindowRef.current?.close()
        vncWindowRef.current = null
      }
    } catch {}
  }, [rhReconnecting])

  useEffect(() => {
    fetchRhStatus()
    const interval = setInterval(fetchRhStatus, rhReconnecting ? 2_000 : 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchRhStatus, rhReconnecting])

  // Fetch AE count from health endpoint once on mount
  useEffect(() => {
    fetch('/health').then(r => r.json()).then(d => setAeCount(d.aes ?? 0)).catch(() => {})
  }, [refreshKey])

  const lastSynced =
    !anyLoading && kpisApi.data
      ? formatRelTime(new Date().toISOString())
      : null

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar active={active} onActiveChange={setActive} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar lastSynced={lastSynced} loading={anyLoading} onRefresh={handleRefresh} />
        {rhStatus && (
          <RhSessionBanner status={rhStatus} onReconnect={() => setRhReconnecting(true)} onVncOpen={(win) => { vncWindowRef.current = win }} />
        )}
        {aeCount === 0 && !noAesDismissed && (
          <NoAEsBanner onDismiss={() => setNoAesDismissed(true)} />
        )}
        {active === 'Settings' ? (
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-lg">
              <h2 className="text-lg font-semibold text-text-primary mb-4">Settings</h2>
              <div className="space-y-4">
                <WeatherSettings />
                <RefreshTimerSettings />
              </div>
            </div>
          </main>
        ) : (
          <main className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* KPI Cards */}
            <section id="section-command">
              <KPICards kpis={kpisApi.data} cases={casesApi.data?.cases ?? []} accounts={accountsApi.data?.customers ?? []} techWinsNeeded={pipelineApi.data?.techWinsNeeded ?? []} loading={kpisApi.loading} rhLastScraped={rhStatus?.lastScraped} rhHasSession={rhStatus?.hasSession} />
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
        )}
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
