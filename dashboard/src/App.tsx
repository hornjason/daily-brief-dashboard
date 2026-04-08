import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { useApi } from './hooks/useApi'
import { Sidebar } from './components/Sidebar'
import type { DashboardViewMode } from './components/Sidebar'
import { discoverAllProducts, stripProductName, normalizeProductName, getProductGroupMembers } from './utils/productName'
import { TopBar } from './components/TopBar'
import { KPICards } from './components/KPICards'
import { CalendarStrip } from './components/CalendarStrip'
import { AccountPortfolioGrid } from './components/AccountPortfolioGrid'
import { CloudSpendSection } from './components/CloudSpendSection'
import MorningSummary from './components/MorningSummary'
import TopActionsPanel from './components/TopActionsPanel'
import type { TopAction } from './components/TopActionsPanel'
import { PipelineSection } from './components/PipelineSection'
import { RefreshTimerSettings } from './components/RefreshTimerSettings'
import { WeatherSettings } from './components/WeatherSettings'
import { EmailSettingsSection } from './components/EmailSettingsSection'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { SetupPage } from './pages/SetupPage'
import { AdminPage } from './pages/AdminPage'
import { ProductsPage } from './pages/ProductsPage'
import { ProductDetailPage } from './pages/ProductDetailPage'
import { formatRelTime } from './lib/format'
import { ChevronUp } from 'lucide-react'
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

/** Map normalized product labels to case-matching keywords (LOG-04) */
const PRODUCT_CASE_KEYWORDS: Record<string, string[]> = {
  'RHEL': ['enterprise linux', 'satellite'],
  'OCP': ['openshift'],
  'AAP': ['ansible'],
  'Storage': ['storage'],
  'Middleware': ['runtimes', 'integration'],
  'Trial': ['trial'],
  'Free': ['free'],
  'Beta': ['beta'],
  'Partner Subscriptions': ['partner'],
  'Developer Subscriptions': ['developer subscription'],
}

function caseMatchesProducts(caseProduct: string, selectedLabels: string[]): boolean {
  if (!caseProduct) return false
  const lower = caseProduct.toLowerCase()
  for (const label of selectedLabels) {
    const keywords = PRODUCT_CASE_KEYWORDS[label]
    if (keywords) {
      if (keywords.some(kw => lower.includes(kw))) return true
    } else {
      // For labels not in the map, match if the label appears in the case product
      if (lower.includes(label.toLowerCase())) return true
    }
  }
  return false
}

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
  const location = useLocation()
  const [refreshKey, setRefreshKey] = useState(0)
  const [active, setActive] = useState('Command Center')
  const [viewMode, setViewMode] = useState<DashboardViewMode>(() => {
    const stored = localStorage.getItem('dashboard-view-mode')
    return stored === 'product' ? 'product' : 'asa'
  })

  const handleViewModeChange = useCallback((mode: DashboardViewMode) => {
    setViewMode(mode)
    localStorage.setItem('dashboard-view-mode', mode)
  }, [])

  // Dynamic page title based on active sidebar section
  useEffect(() => {
    document.title = active === 'Command Center'
      ? 'ASA Command Center'
      : `${active} | ASA Command Center`
  }, [active])
  const [rhStatus, setRhStatus] = useState<RhStatus | null>(null)
  const [rhReconnecting, setRhReconnecting] = useState(false)
  const [noAesDismissed, setNoAesDismissed] = useState(false)
  const [aeCount, setAeCount] = useState<number | null>(null)
  const [productAlertCount, setProductAlertCount] = useState(0)
  const [aeHealthScores, setAeHealthScores] = useState<Record<string, { score: number; status: string }>>({})


  // AE filter chip state (Step 4)
  const [aeFilterSelected, setAeFilterSelected] = useState<string>(() => {
    return localStorage.getItem('ae-filter-selected') ?? 'all'
  })
  // Product filter chip state (Step 5)
  const [productFilterSelected, setProductFilterSelected] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem('product-filter-selected')
      return stored ? JSON.parse(stored) : []
    } catch { return [] }
  })
  const vncWindowRef = useRef<Window | null>(null)

  // Back to top button (BKL-UX23)
  const [showBackToTop, setShowBackToTop] = useState(false)

  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > window.innerHeight)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const kpisApi = useApi<KPIs>(`/api/kpis?_=${refreshKey}`)
  const calendarApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&_=${refreshKey}`)
  const calendarAllApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&all=true&_=${refreshKey}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}`)
  const ccspQueryStr = (() => {
    const params = new URLSearchParams()
    if (aeFilterSelected !== 'all') params.set('ae', aeFilterSelected)
    if (productFilterSelected.length > 0) params.set('products', productFilterSelected.map(encodeURIComponent).join(','))
    const s = params.toString()
    return s ? `?${s}` : ''
  })()
  const ccspApi      = useApi<CCSPSummary>(`/api/ccsp${ccspQueryStr}`)
  const pipelineApi  = useApi<PipelineSummary>(`/api/pipeline`)
  const morningSummaryApi = useApi<{ signals: Array<{ customer: string; type: string; severity: 'critical' | 'high' | 'medium'; text: string }> }>('/api/morning-summary')
  const scrapeStatus = useApi<{
    scrapers: {
      'rh-cases':    { state: string; lastSuccess: string | null; lastError: string | null }
      'ccsp':        { state: string; lastSuccess: string | null; lastError: string | null }
      'supportable': { state: string; lastSuccess: string | null; lastError: string | null }
      'sf-pipeline': { state: string; lastSuccess: string | null; lastError: string | null }
    }
    supportableReachable: boolean
  }>('/api/scraper-status')

  // ── KPI history for sparklines (BKL-R30) ─────────────────────────────────
  const kpiHistoryApi = useApi<{
    snapshots: Array<{
      date: string
      metrics: {
        totalCases: number
        sev1Cases: number
        openRenewals: number
        totalSubscriptions: number
        pipelineCount: number
        customerCount: number
        meetingsToday?: number
        meetingsThisWeek?: number
      }
    }>
  }>('/api/kpis/history')

  const sparklineHistory = useMemo<Record<string, number[]> | undefined>(() => {
    const snapshots = kpiHistoryApi.data?.snapshots
    if (!snapshots || snapshots.length < 2) return undefined
    return {
      openCases: snapshots.map(s => s.metrics.totalCases),
      sev1Cases: snapshots.map(s => s.metrics.sev1Cases),
      expiringWithin30: snapshots.map(s => s.metrics.openRenewals),
      renewals30to90: snapshots.map(s => s.metrics.totalSubscriptions),
      techWinsNeeded: snapshots.map(s => s.metrics.pipelineCount),
      meetingsToday: snapshots.map(s => s.metrics.meetingsToday ?? 0),
      meetingsThisWeek: snapshots.map(s => s.metrics.meetingsThisWeek ?? 0),
    }
  }, [kpiHistoryApi.data])

  const topActions = useMemo<TopAction[]>(() => {
    const signals = morningSummaryApi.data?.signals ?? []
    if (!signals.length) return []

    // Group by customer — signals are server-sorted by severity, first occurrence = top signal
    const seen = new Map<string, typeof signals[number]>()
    for (const sig of signals) {
      if (!seen.has(sig.customer)) seen.set(sig.customer, sig)
    }

    const sorted = [...seen.values()].sort((a, b) => {
      const aIsCase = a.type.includes('case')
      const bIsCase = b.type.includes('case')
      const aIsMeeting = a.type === 'meeting-prep'
      const bIsMeeting = b.type === 'meeting-prep'
      if (aIsCase !== bIsCase) return aIsCase ? -1 : 1
      if (aIsMeeting !== bIsMeeting) return aIsMeeting ? -1 : 1
      return a.customer.localeCompare(b.customer)
    })

    return sorted.slice(0, 3).map(sig => {
      const caseMatch = sig.text.match(/case #(\d{6,})/i)
      const chips: TopAction['chips'] = [
        ...(caseMatch
          ? [{ label: 'View Case', href: `https://access.redhat.com/support/cases/#/case/${caseMatch[1]}`, variant: 'case' as const }]
          : []),
        { label: 'Schedule', href: `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(`Follow up: ${sig.text.slice(0, 60)}`)}`, variant: 'calendar' as const },
      ]
      return {
        customerName: sig.customer,
        signal: sig.text,
        chips,
        priority: sig.severity === 'critical' ? 'urgent' : 'this-week',
      }
    })
  }, [morningSummaryApi.data])

  const anyLoading = kpisApi.loading || calendarApi.loading || calendarAllApi.loading || casesApi.loading || accountsApi.loading

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const handleAeFilterChange = useCallback((ae: string) => {
    setAeFilterSelected(ae)
    localStorage.setItem('ae-filter-selected', ae)
  }, [])

  const handleProductFilterToggle = useCallback((product: string) => {
    setProductFilterSelected(prev => {
      let next: string[]
      if (product === '__all__') {
        next = []
      } else {
        next = prev.includes(product) ? prev.filter(p => p !== product) : [...prev, product]
      }
      localStorage.setItem('product-filter-selected', JSON.stringify(next))
      return next
    })
  }, [])

  // Derive AE list with counts
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

  // Compute worst health status per AE for chip dots
  const aeWorstHealth = useMemo(() => {
    const accounts = accountsApi.data?.customers ?? []
    const cases = casesApi.data?.cases ?? []
    const result: Record<string, 'critical' | 'warning' | 'healthy'> = {}
    for (const ae of aeList) {
      const aeAccounts = accounts.filter(a => a.ae === ae.name)
      let worst = 'healthy' as string
      for (const acct of aeAccounts) {
        // Check health scores first
        const hs = aeHealthScores[acct.name]
        if (hs) {
          if (hs.status === 'red') { worst = 'critical'; break }
          if (hs.status === 'yellow' && worst !== 'critical') worst = 'warning'
        } else {
          // Fallback: check cases
          const acctCases = acct.accountNumbers.flatMap(
            num => cases.filter(c => String(c.accountNumber) === String(num))
          )
          if (acctCases.some(c => c.severity === '1')) { worst = 'critical'; break }
          if (acctCases.length > 0 && worst !== 'critical') worst = 'warning'
        }
      }
      result[ae.name] = worst as 'critical' | 'warning' | 'healthy'
    }
    return result
  }, [aeList, accountsApi.data, casesApi.data, aeHealthScores])

  // Discover products scoped to the current AE filter
  // When a specific AE is selected, only show products from that AE's customers
  const allProducts = useMemo(() => {
    let accounts = accountsApi.data?.customers ?? []
    if (aeFilterSelected !== 'all') {
      accounts = accounts.filter(a => a.ae === aeFilterSelected)
    }
    const ALLOWED_CHIPS = ['RHEL', 'OCP', 'AAP']
    return discoverAllProducts(accounts).filter(p => ALLOWED_CHIPS.includes(p))
  }, [accountsApi.data, aeFilterSelected])

  // Raw product descriptions for tooltip grouping (LOG-03)
  const rawProducts = useMemo(() => {
    let accounts = accountsApi.data?.customers ?? []
    if (aeFilterSelected !== 'all') {
      accounts = accounts.filter(a => a.ae === aeFilterSelected)
    }
    return [...new Set(accounts.flatMap(a => (a.products ?? []).map(p => p.productDescription).filter(Boolean)))]
  }, [accountsApi.data, aeFilterSelected])

  // Clear product selections that no longer exist when AE filter changes
  useEffect(() => {
    if (productFilterSelected.length === 0) return
    const validSet = new Set(allProducts)
    const still = productFilterSelected.filter(p => validSet.has(p))
    if (still.length !== productFilterSelected.length) {
      setProductFilterSelected(still)
      localStorage.setItem('product-filter-selected', JSON.stringify(still))
    }
  }, [allProducts])

  // Filter accounts based on AE and product filters
  const filteredAccounts = useMemo(() => {
    let accounts = accountsApi.data?.customers ?? []
    if (aeFilterSelected !== 'all') {
      accounts = accounts.filter(a => a.ae === aeFilterSelected)
    }
    if (productFilterSelected.length > 0) {
      accounts = accounts.filter(a =>
        a.products?.some(p =>
          productFilterSelected.includes(normalizeProductName(stripProductName(p.productDescription)))
        )
      )
    }
    return accounts
  }, [accountsApi.data, aeFilterSelected, productFilterSelected])

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

  // Fetch health scores for AE chip dots
  useEffect(() => {
    fetch('/api/health-scores')
      .then(r => r.json())
      .then((scores: { name: string; score: number; status: string }[]) => {
        const map: Record<string, { score: number; status: string }> = {}
        for (const s of scores) map[s.name] = { score: s.score, status: s.status }
        setAeHealthScores(map)
      })
      .catch(() => {})
  }, [refreshKey])

  // Poll product alert count for sidebar badge (every 5 min)
  useEffect(() => {
    function fetchAlertCount() {
      fetch('/api/products/alerts')
        .then(r => r.json())
        .then((alerts: any[]) => setProductAlertCount(Array.isArray(alerts) ? alerts.filter((a: any) => !a.acknowledged).length : 0))
        .catch(() => {})
    }
    fetchAlertCount()
    const interval = setInterval(fetchAlertCount, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // Derive lastSynced from the most recent cachedAt across data sources
  const lastSynced = (() => {
    if (anyLoading || !kpisApi.data) return null
    const timestamps = [
      accountsApi.data?.customers?.map(c => c.cachedAt).filter(Boolean) ?? [],
      ccspApi.data?.cachedAt ? [ccspApi.data.cachedAt] : [],
      pipelineApi.data?.cachedAt ? [pipelineApi.data.cachedAt] : [],
    ].flat() as string[]
    if (timestamps.length === 0) return null
    const newest = timestamps.reduce((a, b) => (a > b ? a : b))
    return formatRelTime(newest)
  })()

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar
        active={active}
        onActiveChange={setActive}
        aes={accountsApi.data?.customers
          ? [...new Set(accountsApi.data.customers.map((c) => c.ae).filter(Boolean))].sort().map((ae) => ({
              name: ae,
              customerCount: accountsApi.data!.customers.filter((c) => c.ae === ae).length,
            }))
          : undefined
        }
        productAlertCount={productAlertCount}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar lastSynced={lastSynced} loading={anyLoading} onRefresh={handleRefresh} />
        {rhStatus && (
          <RhSessionBanner status={rhStatus} onReconnect={() => setRhReconnecting(true)} onVncOpen={(win) => { vncWindowRef.current = win }} />
        )}
        {aeCount === 0 && !noAesDismissed && (
          <NoAEsBanner onDismiss={() => setNoAesDismissed(true)} />
        )}
        {location.pathname.startsWith('/dashboard/products/') ? (
          <ProductDetailPage />
        ) : location.pathname === '/dashboard/products' ? (
          <ProductsPage />
        ) : active === 'Settings' ? (
          <main className="flex-1 overflow-y-auto p-6">
            <div className="max-w-lg">
              <h2 className="text-lg font-semibold text-text-primary mb-4">Settings</h2>
              <div className="space-y-4">
                <WeatherSettings />
                <RefreshTimerSettings />
                <EmailSettingsSection />
              </div>
            </div>
          </main>
        ) : (
          <main className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Scrape staleness indicators */}
            {scrapeStatus.data && (
              <div className="flex items-center gap-3 flex-wrap text-xs text-text-secondary">
                {([
                  { storeKey: 'rh-cases' as const,    label: 'RH Cases',    displayKey: 'rh' },
                  { storeKey: 'ccsp' as const,         label: 'CCSP',        displayKey: 'ccsp' },
                  { storeKey: 'supportable' as const,  label: 'Supportable', displayKey: 'supportable' },
                  { storeKey: 'sf-pipeline' as const,  label: 'Salesforce',  displayKey: 'salesforce' },
                ] as const).map(({ storeKey, label, displayKey }) => {
                  const s = scrapeStatus.data!.scrapers[storeKey]
                  const isRunning = s.state === 'running'
                  const isStale = s.state === 'stale'
                  const isUnreachable = storeKey === 'supportable' && scrapeStatus.data!.supportableReachable === false && !s.lastSuccess
                  const color = isRunning ? 'bg-accent' : s.lastError ? 'bg-critical' : isStale || isUnreachable ? 'bg-warning' : 'bg-green-500'
                  const tooltip = isRunning ? 'Currently running' : isUnreachable ? 'Not reachable — check VPN' : s.lastError ? `Last error: ${String(s.lastError).slice(0, 80)}` : s.lastSuccess ? `Last sync: ${new Date(s.lastSuccess).toLocaleString()}` : 'Not yet synced'
                  return (
                    <span key={displayKey} className="flex items-center gap-1" title={tooltip}>
                      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
                      {label}
                    </span>
                  )
                })}
              </div>
            )}

            {/* Filter Bar — AE chips (2+ AEs only) + Product chips (always when data exists) */}
            {(aeList.length > 1 || allProducts.length > 0) && (
              <div className="sticky top-14 z-10 bg-bg/95 backdrop-blur-sm pb-2 -mt-2 pt-2 space-y-2">
                {/* AE Filter Chip Bar — only shown when 2+ AEs configured */}
                {aeList.length > 1 && (
                  <div role="radiogroup" aria-label="Filter by Account Executive" className="flex items-center gap-1.5 flex-wrap">
                    <button
                      onClick={() => handleAeFilterChange('all')}
                      className={`text-sm px-3 py-1 rounded-full border min-h-[32px] transition-colors ${
                        aeFilterSelected === 'all'
                          ? 'border-accent ring-1 ring-accent bg-accent/10 text-accent font-medium'
                          : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                      }`}
                      role="radio"
                      aria-checked={aeFilterSelected === 'all'}
                    >
                      All <span className="text-xs opacity-70 ml-0.5">{accountsApi.data?.customers?.length ?? 0}</span>
                    </button>
                    {aeList.map(ae => {
                      const healthStatus = aeWorstHealth[ae.name]
                      const dotColor = healthStatus === 'critical' ? 'bg-red-500' : healthStatus === 'warning' ? 'bg-amber-500' : 'bg-green-500'
                      return (
                        <button
                          key={ae.name}
                          onClick={() => handleAeFilterChange(ae.name)}
                          className={`text-sm px-3 py-1 rounded-full border min-h-[32px] transition-colors flex items-center gap-1.5 ${
                            aeFilterSelected === ae.name
                              ? 'border-accent ring-1 ring-accent bg-accent/10 text-accent font-medium'
                              : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                          }`}
                          role="radio"
                          aria-checked={aeFilterSelected === ae.name}
                        >
                          {ae.count > 0 && <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />}
                          {ae.name.split(' ')[0]} <span className="text-xs opacity-70 ml-0.5">{ae.count}</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Product Filter Chip Bar — shown whenever subscription data exists */}
                {allProducts.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap" aria-label="Filter by product">
                    <button
                      onClick={() => handleProductFilterToggle('__all__')}
                      className={`text-sm px-3 py-1 rounded-full border min-h-[32px] transition-colors ${
                        productFilterSelected.length === 0
                          ? 'border-accent ring-1 ring-accent bg-accent/10 text-accent font-medium'
                          : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                      }`}
                    >
                      All Products
                    </button>
                    {allProducts.map(product => (
                      <button
                        key={product}
                        onClick={() => handleProductFilterToggle(product)}
                        title={getProductGroupMembers(product, rawProducts).join(', ')}
                        className={`text-sm px-3 py-1 rounded-full border min-h-[32px] transition-colors ${
                          productFilterSelected.includes(product)
                            ? 'border-accent ring-1 ring-accent bg-accent/10 text-accent font-medium'
                            : 'border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
                        }`}
                      >
                        {product}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Morning Summary (R06) — hidden in product view */}
            {viewMode === 'asa' && <MorningSummary matchingCustomers={productFilterSelected.length > 0 ? new Set(filteredAccounts.map(a => a.name)) : undefined} />}

            {/* Top Actions (BKL-F10a, BKL-F10b) */}
            <TopActionsPanel actions={topActions} />

            {/* KPI Cards */}
            <section id="section-command" data-section="section-command">
              <KPICards kpis={kpisApi.data} cases={casesApi.data?.cases ?? []} accounts={filteredAccounts} techWinsNeeded={pipelineApi.data?.techWinsNeeded ?? []} loading={kpisApi.loading} rhLastScraped={rhStatus?.lastScraped} rhHasSession={rhStatus?.hasSession} sparklineHistory={sparklineHistory} selectedProducts={productFilterSelected} allCases={casesApi.data?.cases ?? []} allAccounts={accountsApi.data?.customers ?? []} caseMatchesProducts={caseMatchesProducts} />
            </section>

            {/* Pipeline */}
            <section id="section-pipeline" data-section="section-pipeline">
              <PipelineSection data={pipelineApi.data} loading={pipelineApi.loading} error={pipelineApi.error} onRefresh={handleRefresh} />
            </section>

            {/* Cloud Spend — hide when AE filter yields no customers */}
            {filteredAccounts.length > 0 && (
              <section id="section-cloudspend" data-section="section-cloudspend">
                <CloudSpendSection data={ccspApi.data} loading={ccspApi.loading} error={ccspApi.error} onRefresh={handleRefresh} />
              </section>
            )}

            {/* Calendar + Meeting Prep — visible in both views */}
            <section id="section-calendar" data-section="section-calendar">
              <CalendarStrip
                events={calendarApi.data?.events ?? []}
                allEvents={calendarAllApi.data?.events ?? []}
                cases={casesApi.data?.cases ?? []}
                accounts={accountsApi.data?.customers ?? []}
                loading={calendarApi.loading || calendarAllApi.loading}
              />
            </section>

            {/* Account Portfolio Grid — pass filtered accounts and selected products */}
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
        )}
      </div>

      {/* Back to top button (BKL-UX23) */}
      {showBackToTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-6 right-6 z-40 p-2.5 bg-surface border border-border rounded-full shadow-lg text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-all"
          aria-label="Back to top"
        >
          <ChevronUp className="w-4 h-4" />
        </button>
      )}
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/dashboard/customer/:name" element={<CustomerDetailPage />} />
      <Route path="/dashboard/setup" element={<SetupPage />} />
<Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<Dashboard />} />
    </Routes>
  )
}

export default App
