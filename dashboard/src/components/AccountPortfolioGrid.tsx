import { useState, useMemo, useEffect } from 'react'
import type { AccountInfo, SupportCase, CalendarEvent } from '../types'
import { Building2, Shield, Package, Key, Calendar, X, ChevronUp, ChevronDown, Users } from 'lucide-react'
import { formatDate, formatRelTime } from '../lib/format'
import HealthDot from './HealthDot'
import PriorityActionRow from './PriorityActionRow'

// Inline fallback — replaced when EmptyState.tsx lands from another track
const EmptyState = ({ title, description }: { title: string; description?: string }) => (
  <div className="flex flex-col items-center py-8 text-center">
    <p className="text-sm text-text-secondary">{title}</p>
    {description && <p className="text-xs text-text-secondary/60 mt-1">{description}</p>}
  </div>
)

interface AccountPortfolioGridProps {
  accounts: AccountInfo[]
  cases: SupportCase[]
  events: CalendarEvent[]
  loading: boolean
}

type ViewMode = 'all' | 'byAE' | 'triage' | 'list'

function getHealthStatusFromCases(account: AccountInfo, accountCases: SupportCase[]): { color: string; label: string } {
  const hasSev1 = accountCases.some((c) => c.severity === '1')
  const hasAnyCases = accountCases.length > 0
  if (hasSev1) return { color: '#F85149', label: 'Critical' }
  if (hasAnyCases) return { color: '#D29922', label: 'Attention' }
  return { color: '#3FB950', label: 'Healthy' }
}

function getHealthStatus(
  account: AccountInfo,
  accountCases: SupportCase[],
  healthScores: Record<string, { score: number; status: string }>
): { color: string; label: string; score: number } {
  const composite = healthScores[account.name]
  if (composite) {
    const color = composite.status === 'green' ? '#3FB950' : composite.status === 'yellow' ? '#D29922' : '#F85149'
    const label = composite.status === 'green' ? 'Healthy' : composite.status === 'yellow' ? 'Attention' : 'Critical'
    return { color, label, score: composite.score }
  }
  // Fallback to case-only triage with synthetic scores
  const old = getHealthStatusFromCases(account, accountCases)
  return { ...old, score: old.label === 'Healthy' ? 80 : old.label === 'Attention' ? 50 : 20 }
}

function getNextMeeting(account: AccountInfo, events: CalendarEvent[]): CalendarEvent | null {
  const now = new Date()
  return (
    events.find(
      (ev) =>
        ev.customers?.some((c) => c.toLowerCase() === account.name.toLowerCase()) &&
        new Date(ev.start) >= now
    ) ?? null
  )
}

// ── Products Modal ────────────────────────────────────────────────────────────

type SortKey = 'productDescription' | 'quantity' | 'endDate'

function ProductsModal({
  account,
  onClose,
}: {
  account: AccountInfo
  onClose: () => void
}) {
  const [sortKey, setSortKey] = useState<SortKey>('productDescription')
  const [sortAsc, setSortAsc] = useState(true)

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v)
    else { setSortKey(key); setSortAsc(true) }
  }

  const sorted = [...account.products].sort((a, b) => {
    let av: string | number = a[sortKey] ?? ''
    let bv: string | number = b[sortKey] ?? ''
    if (sortKey === 'quantity') { av = Number(av); bv = Number(bv) }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortAsc ? cmp : -cmp
  })

  const totalLicenses = account.products.reduce((s, p) => s + (p.quantity ?? 0), 0)

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronUp className="w-3 h-3 opacity-20" />
    return sortAsc
      ? <ChevronUp className="w-3 h-3 text-accent" />
      : <ChevronDown className="w-3 h-3 text-accent" />
  }

  function expiryColor(endDate?: string) {
    if (!endDate) return 'text-text-secondary'
    const days = (new Date(endDate).getTime() - Date.now()) / 86_400_000
    if (days < 30) return 'text-critical'
    if (days < 90) return 'text-warning'
    return 'text-text-secondary'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{account.name}</h3>
            <p className="text-xs text-text-secondary mt-0.5">
              {account.productCount} product{account.productCount !== 1 ? 's' : ''} · {totalLicenses.toLocaleString()} total licenses
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          {sorted.length === 0 ? (
            <p className="text-sm text-text-secondary italic text-center py-8">No product data cached for this account.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface border-b border-border">
                <tr>
                  <th className="text-left px-5 py-2.5">
                    <button
                      onClick={() => toggleSort('productDescription')}
                      className="flex items-center gap-1 text-text-secondary hover:text-text-primary transition-colors font-medium uppercase tracking-wide"
                    >
                      Product <SortIcon col="productDescription" />
                    </button>
                  </th>
                  <th className="text-center px-3 py-2.5 w-24">
                    <button
                      onClick={() => toggleSort('quantity')}
                      className="flex items-center justify-center gap-1 text-text-secondary hover:text-text-primary transition-colors font-medium uppercase tracking-wide w-full"
                    >
                      Qty <SortIcon col="quantity" />
                    </button>
                  </th>
                  <th className="text-right px-5 py-2.5 w-32">
                    <button
                      onClick={() => toggleSort('endDate')}
                      className="flex items-center justify-end gap-1 text-text-secondary hover:text-text-primary transition-colors font-medium uppercase tracking-wide w-full"
                    >
                      Expires <SortIcon col="endDate" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((p, i) => (
                  <tr
                    key={`${p.sku}-${i}`}
                    className="border-b border-border/40 hover:bg-border/20 transition-colors"
                  >
                    <td className="px-5 py-2.5">
                      <div className="text-text-primary font-medium leading-snug">{p.productDescription}</div>
                      {p.sku && <div className="text-text-secondary mt-0.5">{p.sku}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className="text-text-primary font-semibold">{p.quantity?.toLocaleString() ?? '—'}</span>
                    </td>
                    <td className={`px-5 py-2.5 text-right ${expiryColor(p.endDate)}`}>
                      {p.endDate ? formatDate(p.endDate) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-bg/50">
                  <td className="px-5 py-2.5 text-text-secondary font-medium">Total</td>
                  <td className="px-3 py-2.5 text-center text-text-primary font-bold">
                    {totalLicenses.toLocaleString()}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Collapsible AE Group ─────────────────────────────────────────────────────

function AEGroup({
  label,
  count,
  defaultCollapsed,
  children,
}: {
  label: string
  count: number
  defaultCollapsed?: boolean
  children: React.ReactNode
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)

  return (
    <div data-ae-group={label}>
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center gap-2 mb-3 w-full text-left group/ae"
      >
        {collapsed ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-secondary group-hover/ae:text-accent transition-colors shrink-0" />
        ) : (
          <ChevronUp className="w-3.5 h-3.5 text-text-secondary group-hover/ae:text-accent transition-colors shrink-0" />
        )}
        <span className="text-xs font-semibold text-accent">{label}</span>
        <span className="text-xs text-text-secondary">{count} account{count !== 1 ? 's' : ''}</span>
        <div className="flex-1 h-px bg-border/50" />
      </button>
      {!collapsed && children}
    </div>
  )
}

// ── Grid ──────────────────────────────────────────────────────────────────────

function AccountCard({
  account,
  accountCases,
  events,
  showAE,
  onProductClick,
  healthScores,
  priorityAction,
}: {
  account: AccountInfo
  accountCases: SupportCase[]
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string }>
  priorityAction?: string
}) {
  const health = getHealthStatus(account, accountCases, healthScores)
  const openCases = accountCases.length
  const nextMeeting = getNextMeeting(account, events)

  return (
    <div className="bg-surface border border-border rounded-xl p-4 hover:border-accent/30 transition-all group">
      {/* Header — links to customer page */}
      <a
        href={`/dashboard/customer/${encodeURIComponent(account.name)}`}
        className="flex items-center justify-between mb-3"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <HealthDot score={health.score} />
          <span className="text-sm font-semibold text-text-primary group-hover:text-accent transition-colors truncate">
            {account.name}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {showAE && account.ae && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium">
              {account.ae.split(' ')[0]}
            </span>
          )}
          <span className="text-xs text-text-secondary">{account.segment}</span>
        </div>
      </a>

      {priorityAction && (
        <div className="mb-2 -mt-1 px-0.5">
          <PriorityActionRow text={priorityAction} />
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="text-center">
          <div className="flex items-center justify-center gap-1 text-text-secondary mb-0.5">
            <Shield className="w-3 h-3" />
          </div>
          <div className={`text-sm font-bold ${openCases > 0 ? 'text-warning' : 'text-success'}`}>
            {openCases}
          </div>
          <div className="text-xs text-text-secondary">Cases</div>
        </div>
        <button
          onClick={() => onProductClick(account)}
          className="text-center hover:bg-accent/10 rounded-lg p-1 -m-1 transition-colors group/stat"
          title="View product details"
        >
          <div className="flex items-center justify-center gap-1 text-text-secondary mb-0.5 group-hover/stat:text-accent transition-colors">
            <Package className="w-3 h-3" />
          </div>
          <div className="text-sm font-bold text-text-primary group-hover/stat:text-accent transition-colors underline decoration-dotted underline-offset-2">
            {account.productCount}
          </div>
          <div className="text-xs text-text-secondary">Products</div>
        </button>
        <button
          onClick={() => onProductClick(account)}
          className="text-center hover:bg-accent/10 rounded-lg p-1 -m-1 transition-colors group/stat"
          title="View license details"
        >
          <div className="flex items-center justify-center gap-1 text-text-secondary mb-0.5 group-hover/stat:text-accent transition-colors">
            <Key className="w-3 h-3" />
          </div>
          <div className="text-sm font-bold text-text-primary group-hover/stat:text-accent transition-colors underline decoration-dotted underline-offset-2">
            {account.totalLicenses.toLocaleString()}
          </div>
          <div className="text-xs text-text-secondary">Licenses</div>
        </button>
      </div>

      {nextMeeting ? (
        <div className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-accent">
          <Calendar className="w-3 h-3 shrink-0" />
          <span className="font-medium truncate">{formatDate(nextMeeting.start)} · {nextMeeting.title}</span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-text-secondary/75">
          <Calendar className="w-3 h-3 shrink-0" />
          <span>No upcoming meetings</span>
        </div>
      )}
    </div>
  )
}

// ── Card Grid Helper ─────────────────────────────────────────────────────────

function CardGrid({
  accounts,
  casesByAccount,
  events,
  showAE,
  onProductClick,
  healthScores,
  priorityActions,
}: {
  accounts: AccountInfo[]
  casesByAccount: Map<string, SupportCase[]>
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string }>
  priorityActions: Record<string, string>
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {accounts.map((account) => {
        const acctCases = account.accountNumbers.flatMap(
          (num) => casesByAccount.get(String(num)) ?? []
        )
        return (
          <AccountCard
            key={account.name}
            account={account}
            accountCases={acctCases}
            events={events}
            showAE={showAE}
            onProductClick={onProductClick}
            healthScores={healthScores}
            priorityAction={priorityActions[account.name]}
          />
        )
      })}
    </div>
  )
}

export function AccountPortfolioGrid({ accounts, cases, events, loading }: AccountPortfolioGridProps) {
  const [modalAccount, setModalAccount] = useState<AccountInfo | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('byAE')
  const [search, setSearch] = useState('')
  const [aeFilter, setAeFilter] = useState('')
  const [healthScores, setHealthScores] = useState<Record<string, { score: number; status: string }>>({})
  const [priorityActions, setPriorityActions] = useState<Record<string, string>>({})

  useEffect(() => {
    fetch('/api/health-scores')
      .then(r => r.json())
      .then((scores: { name: string; score: number; status: string }[]) => {
        const map: Record<string, { score: number; status: string }> = {}
        for (const s of scores) map[s.name] = { score: s.score, status: s.status }
        setHealthScores(map)
      })
      .catch(() => {})
  }, [])

  // Fetch priority actions for all accounts in parallel
  const accountKey = useMemo(() => accounts.map(a => a.name).join(','), [accounts])
  useEffect(() => {
    if (!accounts.length) return
    const map: Record<string, string> = {}
    Promise.allSettled(
      accounts.map(a =>
        fetch(`/api/customer/${encodeURIComponent(a.name)}/priority-action`)
          .then(r => r.json())
          .then(d => { if (d.action?.text) map[a.name] = d.action.text })
      )
    ).then(() => setPriorityActions(map))
  }, [accountKey])

  // Pre-compute cases map — O(n) instead of O(n*m) per card (BKL-UX39)
  const casesByAccount = useMemo(() => {
    const map = new Map<string, SupportCase[]>()
    for (const c of cases ?? []) {
      const acct = String(c.accountNumber)
      if (!acct) continue
      if (!map.has(acct)) map.set(acct, [])
      map.get(acct)!.push(c)
    }
    return map
  }, [cases])

  // Unique AEs for dropdown
  const uniqueAes = useMemo(() => {
    const aes = new Set<string>()
    for (const a of accounts) {
      if (a.ae) aes.add(a.ae)
    }
    return [...aes].sort()
  }, [accounts])

  // Filtered accounts
  const filteredAccounts = useMemo(() => {
    let result = accounts
    if (search) {
      const q = search.toLowerCase()
      result = result.filter((a) => a.name.toLowerCase().includes(q))
    }
    if (aeFilter) {
      result = result.filter((a) => a.ae === aeFilter)
    }
    return result
  }, [accounts, search, aeFilter])

  // Auto-select triage when large portfolio
  const effectiveViewMode = useMemo(() => {
    if (viewMode === 'triage') return 'triage'
    if (viewMode === 'all') return 'all'
    if (viewMode === 'list') return 'list'
    // Auto-suggest triage for large portfolios, but keep byAE as user choice
    return 'byAE'
  }, [viewMode])

  // Oldest cachedAt across all accounts
  const oldestCachedAt = (() => {
    const timestamps = accounts.map(a => a.cachedAt).filter(Boolean) as string[]
    if (!timestamps.length) return null
    return timestamps.reduce((oldest, t) => t < oldest ? t : oldest)
  })()

  // Helper: get cases for an account
  const getCasesForAccount = (account: AccountInfo): SupportCase[] =>
    account.accountNumbers.flatMap((num) => casesByAccount.get(String(num)) ?? [])

  // Group accounts by AE
  const aeGroups = useMemo(() => {
    const map = new Map<string, AccountInfo[]>()
    for (const a of filteredAccounts) {
      const key = a.ae || 'Unassigned'
      const arr = map.get(key) ?? []
      arr.push(a)
      map.set(key, arr)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filteredAccounts])

  // Triage groups — uses composite health scores when available, falls back to case-only
  const triageGroups = useMemo(() => {
    const critical: AccountInfo[] = []
    const attention: AccountInfo[] = []
    const healthy: AccountInfo[] = []

    for (const account of filteredAccounts) {
      const acctCases = getCasesForAccount(account)
      const health = getHealthStatus(account, acctCases, healthScores)
      if (health.score < 40) {
        critical.push(account)
      } else if (health.score < 70) {
        attention.push(account)
      } else {
        healthy.push(account)
      }
    }

    // Sort within each group: lowest score first, then by next meeting soonest
    const sortGroup = (group: AccountInfo[]) =>
      group.sort((a, b) => {
        const aHealth = getHealthStatus(a, getCasesForAccount(a), healthScores)
        const bHealth = getHealthStatus(b, getCasesForAccount(b), healthScores)
        if (aHealth.score !== bHealth.score) return aHealth.score - bHealth.score
        const aNext = getNextMeeting(a, events)
        const bNext = getNextMeeting(b, events)
        if (aNext && bNext) return new Date(aNext.start).getTime() - new Date(bNext.start).getTime()
        if (aNext) return -1
        if (bNext) return 1
        return 0
      })

    return {
      critical: sortGroup(critical),
      attention: sortGroup(attention),
      healthy: sortGroup(healthy),
    }
  }, [filteredAccounts, casesByAccount, events, healthScores])

  if (loading) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Account Portfolio</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-36 bg-surface border border-border rounded-xl animate-pulse-slow" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      {modalAccount && (
        <ProductsModal account={modalAccount} onClose={() => setModalAccount(null)} />
      )}

      <div>
        {/* Section header with controls */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <Building2 className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Account Portfolio</h2>
          <span className="text-xs text-text-secondary">{filteredAccounts.length} accounts</span>
          {oldestCachedAt && (
            <span className="text-xs text-text-secondary">· synced {formatRelTime(oldestCachedAt)}</span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Search input (BKL-UX41) */}
            <input
              type="text"
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-2.5 py-1 text-xs bg-surface-hover border border-border rounded-badge text-text-primary placeholder:text-text-secondary focus:outline-none focus:border-accent"
            />

            {/* AE dropdown filter (BKL-UX24) */}
            {uniqueAes.length > 1 && (
              <select
                value={aeFilter}
                onChange={(e) => setAeFilter(e.target.value)}
                className="px-2 py-1 text-xs bg-surface-hover border border-border rounded-badge text-text-primary"
              >
                <option value="">All AEs</option>
                {uniqueAes.map((ae) => (
                  <option key={ae} value={ae}>{ae}</option>
                ))}
              </select>
            )}

            {/* View mode toggle */}
            <div className="flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('all')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'all' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                All
              </button>
              <button
                onClick={() => setViewMode('byAE')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'byAE' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                By AE
              </button>
              <button
                onClick={() => setViewMode('triage')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'triage' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                Triage
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'list' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                List
              </button>
            </div>
          </div>
        </div>

        {/* Empty state */}
        {filteredAccounts.length === 0 ? (
          <EmptyState title="No accounts found" description="Try adjusting your search or filter" />
        ) : effectiveViewMode === 'triage' ? (
          /* Triage view */
          <div className="space-y-6">
            {triageGroups.critical.length > 0 && (
              <AEGroup label="Critical" count={triageGroups.critical.length} defaultCollapsed={false}>
                <CardGrid
                  accounts={triageGroups.critical}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                />
              </AEGroup>
            )}
            {triageGroups.attention.length > 0 && (
              <AEGroup label="Attention" count={triageGroups.attention.length} defaultCollapsed={false}>
                <CardGrid
                  accounts={triageGroups.attention}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                />
              </AEGroup>
            )}
            {triageGroups.healthy.length > 0 && (
              <AEGroup label="Healthy" count={triageGroups.healthy.length} defaultCollapsed={true}>
                <CardGrid
                  accounts={triageGroups.healthy}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                />
              </AEGroup>
            )}
          </div>
        ) : effectiveViewMode === 'byAE' ? (
          /* By AE view */
          <div className="space-y-6">
            {aeGroups.map(([ae, aeAccounts]) => (
              <AEGroup key={ae} label={ae} count={aeAccounts.length}>
                <CardGrid
                  accounts={aeAccounts}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={false}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                />
              </AEGroup>
            ))}
          </div>
        ) : effectiveViewMode === 'list' ? (
          /* Compact list view (BKL-UX43) */
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-text-secondary">
                  <th className="text-left py-2 px-3 font-medium">Customer</th>
                  <th className="text-left py-2 px-3 font-medium">AE</th>
                  <th className="text-center py-2 px-3 font-medium">Health</th>
                  <th className="text-right py-2 px-3 font-medium">Cases</th>
                  <th className="text-left py-2 px-3 font-medium">Next Meeting</th>
                  <th className="text-right py-2 px-3 font-medium">Products</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((account) => {
                  const acctCases = getCasesForAccount(account)
                  const health = getHealthStatus(account, acctCases, healthScores)
                  const nextMeeting = getNextMeeting(account, events)
                  return (
                    <tr
                      key={account.name}
                      className="border-b border-border/50 hover:bg-surface-hover transition-colors cursor-pointer"
                      tabIndex={0}
                      role="button"
                      onClick={() => { window.location.href = `/dashboard/customer/${encodeURIComponent(account.name)}` }}
                      onKeyDown={(e) => { if (e.key === 'Enter') window.location.href = `/dashboard/customer/${encodeURIComponent(account.name)}` }}
                    >
                      <td className="py-2 px-3 font-medium text-text-primary">{account.name}</td>
                      <td className="py-2 px-3 text-text-secondary">{account.ae}</td>
                      <td className="py-2 px-3 text-center">
                        <HealthDot score={health.score} />
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{acctCases.length}</td>
                      <td className="py-2 px-3 text-text-secondary">
                        {nextMeeting ? formatDate(nextMeeting.start) : '\u2014'}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">{account.productCount}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          /* All view */
          <CardGrid
            accounts={filteredAccounts}
            casesByAccount={casesByAccount}
            events={events}
            showAE={true}
            onProductClick={setModalAccount}
            healthScores={healthScores}
            priorityActions={priorityActions}
          />
        )}
      </div>
    </>
  )
}
