import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useApi } from './hooks/useApi'
import { getVncUrl } from './utils'
import { Sidebar } from './components/Sidebar'
import type { DashboardViewMode } from './components/Sidebar'
import { discoverAllProducts, stripProductName, normalizeProductName, getProductGroupMembers } from './utils/productName'
import { TopBar } from './components/TopBar'
import { PodTabBar } from './components/PodTabBar'
import { PodKPIHeader } from './components/PodKPIHeader'
import { UpdateBanner } from './components/UpdateBanner'
import { RefreshTimerSettings } from './components/RefreshTimerSettings'
import { WeatherSettings } from './components/WeatherSettings'
import { EmailSettingsSection } from './components/EmailSettingsSection'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { SetupPage } from './pages/SetupPage'
import { AdminPage } from './pages/AdminPage'
import { ProductsPage } from './pages/ProductsPage'
import { ProductDetailPage } from './pages/ProductDetailPage'
import { BatchPage } from './pages/BatchPage'
import { RedHatNewsPage } from './pages/RedHatNewsPage'
import { CampaignsPage } from './pages/CampaignsPage'
import { NewsPage } from './pages/NewsPage'
import { ToolsPage } from './pages/ToolsPage'
import { EventsPage } from './pages/EventsPage'
import { HomePage } from './pages/HomePage'
import { AccountsPage } from './pages/AccountsPage'
import { CalendarPage } from './pages/CalendarPage'
import { BookOfBusinessPage } from './pages/BookOfBusinessPage'
import { MeetingPrepPage } from './pages/MeetingPrepPage'
import { PortfolioTriagePage } from './pages/PortfolioTriagePage'
import { GraphHealthPage } from './pages/GraphHealthPage'
import { formatRelTime } from './lib/format'
import { ChevronUp, RefreshCw as RefreshCwIcon, X } from 'lucide-react'
import type { AccountInfo, SupportCase, PodInfo, CCSPSummary, PipelineSummary } from './types'

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
        console.error('[rh-banner] start failed:', d.error)
        setReconnecting(false)
        return
      }
      onReconnect()
      const win = window.open(getVncUrl({ reconnect: true }), '_blank')
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

// ── Refresh Progress Banner (ADR-037 F6) ────────────────────────────────────

interface RefreshManifest {
  startedAt: string
  trigger: string
  totalModules: number
  completed: number
  failed: number
  skipped: number
  inProgress: string | null
  modules: Record<string, { status: string; durationMs?: number; reason?: string }>
}

function RefreshProgressBanner() {
  const [manifest, setManifest] = useState<RefreshManifest | null>(null)
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('refreshBannerDismissed') === 'true')

  useEffect(() => {
    if (dismissed) return

    let active = true

    async function poll() {
      try {
        const res = await fetch('/api/admin/refresh-all/status')
        if (!res.ok) return
        const data: RefreshManifest = await res.json()
        if (active) setManifest(data)
      } catch {
        // Silently fail — no banner if endpoint unavailable
      }
    }

    poll()
    const interval = setInterval(poll, 5_000)
    return () => { active = false; clearInterval(interval) }
  }, [dismissed])

  // Determine if refresh is active
  const isActive = manifest && (
    manifest.inProgress !== null ||
    Object.values(manifest.modules).some(m => m.status === 'pending' || m.status === 'in-progress')
  )

  if (dismissed || !manifest || !isActive) return null

  const done = manifest.completed + manifest.failed + manifest.skipped

  const handleDismiss = () => {
    sessionStorage.setItem('refreshBannerDismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="bg-blue-900/40 border-b border-blue-700/50 px-6 py-2.5 flex items-center gap-3 text-sm">
      <RefreshCwIcon className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
      <span className="text-blue-300 font-medium">
        Data refresh in progress &mdash; {manifest.completed}/{manifest.totalModules} modules updated
        {manifest.failed > 0 && <span className="text-amber-400 ml-1">({manifest.failed} failed)</span>}
      </span>
      {manifest.inProgress && (
        <span className="text-blue-300/60 text-xs">({manifest.inProgress})</span>
      )}
      <div className="flex-1" />
      <button
        onClick={handleDismiss}
        className="text-blue-400 hover:text-blue-300 transition-colors"
        aria-label="Dismiss refresh notification"
      >
        <X className="w-4 h-4" />
      </button>
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

// Routes where portfolio-level chrome (PodTabBar, PodKPIHeader, filter chips) should render
const PORTFOLIO_ROUTES = ['/', '/accounts', '/book-of-business', '/calendar']

function Dashboard() {
  const location = useLocation()
  const navigate = useNavigate()
  const [refreshKey, setRefreshKey] = useState(0)
  // Determine if current route is a portfolio page (show filters) or module page (hide filters)
  const subPath = location.pathname.replace('/dashboard', '') || '/'
  const isPortfolioPage = PORTFOLIO_ROUTES.includes(subPath)
  const [viewMode, setViewMode] = useState<DashboardViewMode>(() => {
    const stored = localStorage.getItem('dashboard-view-mode')
    return stored === 'product' ? 'product' : 'asa'
  })

  const handleViewModeChange = useCallback((mode: DashboardViewMode) => {
    setViewMode(mode)
    localStorage.setItem('dashboard-view-mode', mode)
  }, [])

  // BKL-UX52: Pod tab state — persisted in localStorage
  const [activePodId, setActivePodId] = useState<string>(() => {
    return localStorage.getItem('active-pod-id') ?? ''
  })
  const handlePodChange = useCallback((podId: string) => {
    setActivePodId(podId)
    localStorage.setItem('active-pod-id', podId)
  }, [])

  // Dynamic page title based on URL pathname (GitHub #238)
  useEffect(() => {
    const pathToTitle: Record<string, string> = {
      '/dashboard': 'ASA Command Center',
      '/dashboard/accounts': 'Accounts | ASA Command Center',
      '/dashboard/calendar': 'Calendar | ASA Command Center',
      '/dashboard/book-of-business': 'Book of Business | ASA Command Center',
      '/dashboard/admin': 'Admin | ASA Command Center',
      '/dashboard/setup': 'Setup | ASA Command Center',
      '/dashboard/batch': 'Batch | ASA Command Center',
      '/dashboard/products': 'Products | ASA Command Center',
      '/dashboard/campaigns': 'Campaigns | ASA Command Center',
      '/dashboard/news': 'Customer News | ASA Command Center',
      '/dashboard/tools': 'Tools | ASA Command Center',
      '/dashboard/events': 'Events | ASA Command Center',
      '/dashboard/rh-news': 'Red Hat News | ASA Command Center',
      '/dashboard/triage': 'Portfolio Triage | ASA Command Center',
      '/dashboard/admin/graph-health': 'Graph Health | ASA Command Center',
    }
    document.title = pathToTitle[location.pathname] || 'ASA Command Center'
  }, [location.pathname])
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

  // BKL-UX52: Fetch pod list
  const podsApi = useApi<{ pods: PodInfo[] }>('/api/pods')

  // Set default pod on first load
  useEffect(() => {
    if (podsApi.data?.pods?.length && !activePodId) {
      const defaultId = podsApi.data.pods[0].id
      setActivePodId(defaultId)
      localStorage.setItem('active-pod-id', defaultId)
    }
  }, [podsApi.data, activePodId])

  const pods = podsApi.data?.pods ?? []
  const activePod = pods.find(p => p.id === activePodId) ?? pods[0]

  // Shared data for layout-level components (TopBar sync indicator, PodKPIHeader, filter bars)
  const podQuery = activePodId ? `&pod=${activePodId}` : ''
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}${podQuery}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const ccspQueryStr = (() => {
    const params = new URLSearchParams()
    if (aeFilterSelected !== 'all') params.set('ae', aeFilterSelected)
    if (productFilterSelected.length > 0) params.set('products', productFilterSelected.map(encodeURIComponent).join(','))
    const s = params.toString()
    return s ? `?${s}` : ''
  })()
  const nodeRoleApi  = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only     = nodeRoleApi.data?.isL3Only ?? true
  const ccspApi      = useApi<CCSPSummary>(`/api/ccsp${ccspQueryStr}`)
  const pipelineQueryStr = aeFilterSelected && aeFilterSelected !== 'all' ? `?ae=${encodeURIComponent(aeFilterSelected)}` : ''
  const pipelineApi  = useApi<PipelineSummary>(`/api/pipeline${pipelineQueryStr}`)

  const [isRefreshing, setIsRefreshing] = useState(false)
  const anyLoading = accountsApi.loading || casesApi.loading || isRefreshing

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await fetch('/api/refresh', { method: 'POST' })
    } catch (err) {
      console.error('[App] refresh API call failed', err)
    } finally {
      setIsRefreshing(false)
      setRefreshKey((k) => k + 1)
    }
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
        const hs = aeHealthScores[acct.name]
        if (hs) {
          if (hs.status === 'red') { worst = 'critical'; break }
          if (hs.status === 'yellow' && worst !== 'critical') worst = 'warning'
        } else {
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
          p.productDescription && productFilterSelected.includes(normalizeProductName(stripProductName(p.productDescription)))
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
    } catch (err) { console.error('[App] fetchRhStatus failed', err) }
  }, [rhReconnecting])

  useEffect(() => {
    fetchRhStatus()
    const interval = setInterval(fetchRhStatus, rhReconnecting ? 2_000 : 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchRhStatus, rhReconnecting])

  // Fetch AE count from health endpoint once on mount
  useEffect(() => {
    fetch('/health').then(r => r.json()).then(d => setAeCount(d.aes ?? 0)).catch((err) => console.error('[App] health fetch failed', err))
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
      .catch((err) => console.error('[App] health-scores fetch failed', err))
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
    if (anyLoading) return null
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
        aes={accountsApi.data?.customers
          ? [...new Set(accountsApi.data.customers.map((c) => c.ae).filter(Boolean))].sort().map((ae) => ({
              name: ae,
              customerCount: accountsApi.data!.customers.filter((c) => c.ae === ae).length,
            }))
          : undefined
        }
        productAlertCount={productAlertCount}
        viewMode="asa"
      />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar lastSynced={lastSynced} loading={anyLoading} onRefresh={handleRefresh} />
        {/* BKL-UX52: Pod tab bar — portfolio pages only */}
        {isPortfolioPage && pods.length > 1 && (
          <PodTabBar pods={pods} activePodId={activePodId} onChange={handlePodChange} />
        )}
        {/* BKL-UX52: Pod KPI header — portfolio pages only */}
        {isPortfolioPage && activePod && (accountsApi.data?.customers?.length ?? 0) > 0 && (
          <PodKPIHeader
            podName={activePod.name}
            accounts={accountsApi.data?.customers ?? []}
            cases={casesApi.data?.cases ?? []}
          />
        )}
        <UpdateBanner />
        <RefreshProgressBanner />
        {rhStatus && !isL3Only && (
          <RhSessionBanner status={rhStatus} onReconnect={() => setRhReconnecting(true)} onVncOpen={(win) => { vncWindowRef.current = win }} />
        )}
        {aeCount === 0 && !noAesDismissed && (
          <NoAEsBanner onDismiss={() => setNoAesDismissed(true)} />
        )}

        {/* Filter Bar — portfolio pages only. AE chips (2+ AEs only) + Product chips */}
        {isPortfolioPage && (aeList.length > 1 || allProducts.length > 0) && (
          <div className="px-6 pb-2 pt-2 space-y-2">
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

        {/* Page Routes — each page fetches its own data independently */}
        <Routes>
          <Route path="/" element={
            <HomePage
              refreshKey={refreshKey}
              onRefresh={handleRefresh}
              aeFilterSelected={aeFilterSelected}
              productFilterSelected={productFilterSelected}
              filteredAccounts={filteredAccounts}
              activePodId={activePodId}
            />
          } />
          <Route path="/accounts" element={
            <AccountsPage
              refreshKey={refreshKey}
              aeFilterSelected={aeFilterSelected}
              productFilterSelected={productFilterSelected}
              filteredAccounts={filteredAccounts}
              activePodId={activePodId}
            />
          } />
          <Route path="/calendar" element={
            <CalendarPage
              refreshKey={refreshKey}
              activePodId={activePodId}
            />
          } />
          <Route path="/book-of-business" element={
            <BookOfBusinessPage
              refreshKey={refreshKey}
              onRefresh={handleRefresh}
              aeFilterSelected={aeFilterSelected}
              productFilterSelected={productFilterSelected}
              filteredAccounts={filteredAccounts}
            />
          } />
          <Route path="/products/:slug" element={<ProductDetailPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/news" element={<NewsPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/rh-news" element={<RedHatNewsPage />} />
          <Route path="/meeting-prep" element={<MeetingPrepPage />} />
          <Route path="/triage" element={<PortfolioTriagePage />} />
          <Route path="/settings" element={
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
          } />
        </Routes>
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
      <Route path="/dashboard/admin" element={<AdminPage />} />
      <Route path="/dashboard/admin/graph-health" element={<GraphHealthPage />} />
      <Route path="/dashboard/batch" element={<BatchPage />} />
      <Route path="/dashboard/*" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}

export default App
