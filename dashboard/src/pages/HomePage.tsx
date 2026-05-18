/**
 * HomePage — Route: /dashboard
 * GitHub Issue #239
 *
 * Extracted from the monolithic Dashboard component in App.tsx.
 * Displays: Morning Summary, Top Actions Panel, KPI Cards, Red Hat Pulse.
 * Each data dependency is fetched independently via useApi.
 */
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { discoverAllProducts, normalizeProductName, stripProductName } from '../utils/productName'
import { KPICards } from '../components/KPICards'
import MorningSummary from '../components/MorningSummary'
import { RedHatPulseCard } from '../components/RedHatPulseCard'
import TopActionsPanel from '../components/TopActionsPanel'
import type { TopAction } from '../components/TopActionsPanel'
import { PipelineSection } from '../components/PipelineSection'
import { CloudSpendSection } from '../components/CloudSpendSection'
import { ChevronUp } from 'lucide-react'
import type { KPIs, SupportCase, AccountInfo, CCSPSummary, PipelineSummary } from '../types'

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

function caseMatchesProducts(caseProduct: string | string[], selectedLabels: string[]): boolean {
  const productStr = Array.isArray(caseProduct) ? (caseProduct[0] ?? '') : (caseProduct ?? '')
  if (!productStr) return false
  const lower = productStr.toLowerCase()
  for (const label of selectedLabels) {
    const keywords = PRODUCT_CASE_KEYWORDS[label]
    if (keywords) {
      if (keywords.some(kw => lower.includes(kw))) return true
    } else {
      if (lower.includes(label.toLowerCase())) return true
    }
  }
  return false
}

interface HomePageProps {
  refreshKey: number
  onRefresh: () => void
  aeFilterSelected: string
  productFilterSelected: string[]
  filteredAccounts: AccountInfo[]
  activePodId: string
}

export function HomePage({
  refreshKey,
  onRefresh,
  aeFilterSelected,
  productFilterSelected,
  filteredAccounts,
  activePodId,
}: HomePageProps) {
  const podQuery = activePodId ? `&pod=${activePodId}` : ''
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}${podQuery}`)
  const kpisApi = useApi<KPIs>(`/api/kpis?_=${refreshKey}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const nodeRoleApi = useApi<{ isL3Only: boolean }>('/api/node-role')
  const isL3Only = nodeRoleApi.data?.isL3Only ?? true
  const rhTokenApi = useApi<{ configured: boolean }>('/api/settings/offline-token')

  // RH session status
  const [rhStatus, setRhStatus] = useState<{ hasSession: boolean; lastScraped: string | null } | null>(null)
  useEffect(() => {
    fetch('/api/auth/redhat/status').then(r => r.json()).then(setRhStatus).catch(() => {})
  }, [refreshKey])

  const pipelineQueryStr = aeFilterSelected && aeFilterSelected !== 'all' ? `?ae=${encodeURIComponent(aeFilterSelected)}` : ''
  const pipelineApi = useApi<PipelineSummary>(`/api/pipeline${pipelineQueryStr}`)
  const ccspQueryStr = (() => {
    const params = new URLSearchParams()
    if (aeFilterSelected !== 'all') params.set('ae', aeFilterSelected)
    if (productFilterSelected.length > 0) params.set('products', productFilterSelected.map(encodeURIComponent).join(','))
    const s = params.toString()
    return s ? `?${s}` : ''
  })()
  const ccspApi = useApi<CCSPSummary>(`/api/ccsp${ccspQueryStr}`)

  const morningSummaryApi = useApi<{ signals: Array<{ customer: string; type: string; severity: 'critical' | 'high' | 'medium'; text: string }> }>('/api/morning-summary')

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

  // #225: KPI Breakdown expanded by default, persist state
  const [kpiDetailsExpanded, setKpiDetailsExpanded] = useState(() => {
    const saved = localStorage.getItem('kpi-collapsed')
    return saved ? !JSON.parse(saved) : true
  })

  // Scrape status indicators
  const scrapeStatus = useApi<{
    scrapers: {
      'rh-cases': { state: string; lastSuccess: string | null; lastError: string | null }
      'ccsp': { state: string; lastSuccess: string | null; lastError: string | null }
      'supportable': { state: string; lastSuccess: string | null; lastError: string | null }
      'sf-pipeline': { state: string; lastSuccess: string | null; lastError: string | null }
    }
  }>('/api/scraper-status')

  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Scrape staleness indicators */}
      {scrapeStatus.data && (
        <div className="flex items-center gap-3 flex-wrap text-xs text-text-secondary">
          {([
            { storeKey: 'rh-cases' as const, label: 'RH Cases', displayKey: 'rh' },
            { storeKey: 'ccsp' as const, label: 'CCSP', displayKey: 'ccsp' },
            { storeKey: 'sf-pipeline' as const, label: 'Salesforce', displayKey: 'salesforce' },
          ] as const).map(({ storeKey, label, displayKey }) => {
            const s = scrapeStatus.data!.scrapers[storeKey]
            const isRunning = s.state === 'running'
            const isStale = s.state === 'stale'
            const color = isRunning ? 'bg-accent' : s.lastError ? 'bg-critical' : isStale ? 'bg-warning' : 'bg-green-500'
            const tooltip = isRunning ? 'Currently running' : s.lastError ? `Last error: ${String(s.lastError).slice(0, 80)}` : s.lastSuccess ? `Last sync: ${new Date(s.lastSuccess).toLocaleString()}` : 'Not yet synced'
            return (
              <span key={displayKey} className="flex items-center gap-1" title={tooltip}>
                <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
                {label}
              </span>
            )
          })}
        </div>
      )}

      {/* Morning Summary (R06) */}
      <MorningSummary matchingCustomers={productFilterSelected.length > 0 ? new Set(filteredAccounts.map(a => a.name)) : undefined} />

      {/* Red Hat Pulse (GitHub Issue #203) */}
      <RedHatPulseCard />

      {/* Top Actions (BKL-F10a, BKL-F10b) */}
      <TopActionsPanel actions={topActions} />

      {/* KPI Cards */}
      <section id="section-command" data-section="section-command">
        <KPICards
          kpis={kpisApi.data}
          cases={casesApi.data?.cases ?? []}
          accounts={filteredAccounts}
          techWinsNeeded={pipelineApi.data?.techWinsNeeded ?? []}
          loading={kpisApi.loading}
          rhLastScraped={rhStatus?.lastScraped}
          rhHasSession={isL3Only ? undefined : rhStatus?.hasSession}
          sparklineHistory={sparklineHistory}
          selectedProducts={productFilterSelected}
          allCases={casesApi.data?.cases ?? []}
          allAccounts={accountsApi.data?.customers ?? []}
          caseMatchesProducts={caseMatchesProducts}
          isL3Only={isL3Only}
          rhTokenConfigured={rhTokenApi.data?.configured}
        />
      </section>

      {/* Collapsible KPI Detail Breakdown */}
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <button
          onClick={() => {
            const next = !kpiDetailsExpanded
            setKpiDetailsExpanded(next)
            localStorage.setItem('kpi-collapsed', JSON.stringify(!next))
          }}
          className="w-full px-5 py-3 flex items-center justify-between hover:bg-surface-hover transition-colors"
        >
          <span className="text-sm font-semibold text-text-primary">Detailed KPI Breakdown</span>
          <span className="text-text-secondary text-xs">
            {kpiDetailsExpanded ? '▼' : '▶'}
          </span>
        </button>
        {kpiDetailsExpanded && (
          <div className="border-t border-border p-5 space-y-6">
            {/* Pipeline */}
            <section id="section-pipeline" data-section="section-pipeline">
              <PipelineSection data={pipelineApi.data} loading={pipelineApi.loading} error={pipelineApi.error} onRefresh={onRefresh} selectedProducts={productFilterSelected} />
            </section>

            {/* Cloud Spend */}
            {filteredAccounts.length > 0 && (ccspApi.data || ccspApi.loading || ccspApi.error) && (
              <section id="section-cloudspend" data-section="section-cloudspend">
                <CloudSpendSection data={ccspApi.data} loading={ccspApi.loading} error={ccspApi.error} onRefresh={onRefresh} />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
