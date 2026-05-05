import { useState, useMemo, useEffect, useRef } from 'react'
import type { AccountInfo, SupportCase, CalendarEvent, ProductSubscription } from '../types'
import { Building2, Shield, Package, Key, Calendar, X, ChevronUp, ChevronDown, Users } from 'lucide-react'
import { formatDate, formatRelTime } from '../lib/format'
import HealthDot from './HealthDot'
import PriorityActionRow from './PriorityActionRow'
import { AEGroupedList } from './AEGroupedList'
import { stripProductName } from '../utils/productName'
import { Grid } from 'react-window'

// BKL-REG-19: Shared helper to get cases for an account, with name-match fallback
// for customers that have no account numbers (same approach as PodKPIHeader BKL-REG-08).
function getCasesForAccountFromMap(account: AccountInfo, casesByAccount: Map<string, SupportCase[]>): SupportCase[] {
  const byNum = account.accountNumbers.flatMap((num) => casesByAccount.get(String(num)) ?? [])
  if (byNum.length > 0) return byNum
  return casesByAccount.get(`name:${account.name.toLowerCase()}`) ?? []
}

// Inline fallback — replaced when EmptyState.tsx lands from another track
const EmptyState = ({ title, description }: { title: string; description?: string }) => (
  <div className="flex flex-col items-center py-8 text-center">
    <p className="text-sm text-text-secondary">{title}</p>
    {description && <p className="text-xs text-text-secondary mt-1">{description}</p>}
  </div>
)

interface AccountPortfolioGridProps {
  accounts: AccountInfo[]
  cases: SupportCase[]
  events: CalendarEvent[]
  loading: boolean
  selectedProducts?: string[]
  aeList?: { name: string; count: number }[]
  aeFilterSelected?: string
  allAccounts?: AccountInfo[]
}

type ViewMode = 'all' | 'byAE' | 'grouped' | 'triage' | 'list'

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
  healthScores: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>
): { color: string; label: string; score: number; breakdown?: Record<string, { score: number; signal: string }> } {
  const composite = healthScores[account.name]
  if (composite) {
    const color = composite.status === 'green' ? '#3FB950' : composite.status === 'yellow' ? '#D29922' : '#F85149'
    const label = composite.status === 'green' ? 'Healthy' : composite.status === 'yellow' ? 'Attention' : 'Critical'
    return { color, label, score: composite.score, breakdown: composite.breakdown }
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

// BKL-UX-REG-01: same palette as AEGroupedList's getAttentionDotColor so byAE
// mode and grouped mode render identical health-dot strips.
function getAttentionDotColor(score: number): string {
  if (score >= 70) return 'bg-red-500'
  if (score >= 40) return 'bg-amber-500'
  if (score > 0) return 'bg-green-500'
  return 'bg-zinc-600'
}

function AEGroup({
  label,
  count,
  defaultCollapsed,
  customerScores,
  children,
}: {
  label: string
  count: number
  defaultCollapsed?: boolean
  /** BKL-UX-REG-01: attention scores per customer — drives the health-dot strip in the collapsed header. */
  customerScores?: number[]
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
        <span className="text-sm font-semibold text-accent">{label}</span>
        <span className="text-xs text-text-secondary">{count} account{count !== 1 ? 's' : ''}</span>
        {customerScores && customerScores.length > 0 && (
          <div className="flex items-center gap-1 pl-1">
            {customerScores.slice(0, 12).map((score, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${getAttentionDotColor(score)}`}
              />
            ))}
            {customerScores.length > 12 && (
              <span className="text-[11px] text-text-secondary tabular-nums pl-0.5">+{customerScores.length - 12}</span>
            )}
          </div>
        )}
        <div className="flex-1 h-px bg-border/50" />
      </button>
      {!collapsed && children}
    </div>
  )
}

// ── Product-filtered AE Group (LOG-12) ──────────────────────────────────────

function ProductAEGroup({
  ae,
  matching,
  hidden,
  casesByAccount,
  events,
  onProductClick,
  healthScores,
  priorityActions,
  selectedProducts,
}: {
  ae: string
  matching: AccountInfo[]
  hidden: AccountInfo[]
  casesByAccount: Map<string, SupportCase[]>
  events: CalendarEvent[]
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>
  priorityActions: Record<string, string>
  selectedProducts: string[]
}) {
  const [showHidden, setShowHidden] = useState(false)

  return (
    <div data-ae-product-group={ae}>
      {/* AE header row */}
      <div className="flex items-center gap-2 mb-3">
        <Users className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-sm font-semibold text-accent">{ae}</span>
        <span className="text-xs text-text-secondary">
          {matching.length} matching
          {hidden.length > 0 && <span className="text-text-secondary/60"> / {hidden.length} hidden</span>}
        </span>
        <div className="flex-1 h-px bg-border/50" />
      </div>

      {/* Matching account cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {matching.map((account) => {
          const acctCases = getCasesForAccountFromMap(account, casesByAccount)
          return (
            <AccountCard
              key={account.name}
              account={account}
              accountCases={acctCases}
              events={events}
              showAE={false}
              onProductClick={onProductClick}
              healthScores={healthScores}
              priorityAction={priorityActions[account.name]}
              selectedProducts={selectedProducts}
            />
          )
        })}
      </div>

      {/* Hidden accounts expand toggle */}
      {hidden.length > 0 && !showHidden && (
        <button
          onClick={() => setShowHidden(true)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          + {hidden.length} more account{hidden.length !== 1 ? 's' : ''}
        </button>
      )}
      {showHidden && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 opacity-60">
            {hidden.map((account) => {
              const acctCases = account.accountNumbers.flatMap(
                (num) => casesByAccount.get(String(num)) ?? []
              )
              return (
                <AccountCard
                  key={account.name}
                  account={account}
                  accountCases={acctCases}
                  events={events}
                  showAE={false}
                  onProductClick={onProductClick}
                  healthScores={healthScores}
                  priorityAction={priorityActions[account.name]}
                  selectedProducts={selectedProducts}
                />
              )
            })}
          </div>
          <button
            onClick={() => setShowHidden(false)}
            className="mt-2 text-xs text-text-secondary hover:underline"
          >
            hide {hidden.length} account{hidden.length !== 1 ? 's' : ''}
          </button>
        </>
      )}
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
  selectedProducts = [],
}: {
  account: AccountInfo
  accountCases: SupportCase[]
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>
  priorityAction?: string
  selectedProducts?: string[]
}) {
  const health = getHealthStatus(account, accountCases, healthScores)
  const openCases = accountCases.length
  const nextMeeting = getNextMeeting(account, events)
  const [showMoreSubs, setShowMoreSubs] = useState(false)

  // Subscription expansion: split into matching and non-matching
  const { matchingSubs, otherSubs } = useMemo(() => {
    if (selectedProducts.length === 0 || !account.products) return { matchingSubs: [], otherSubs: [] }
    const matching: ProductSubscription[] = []
    const other: ProductSubscription[] = []
    for (const p of account.products) {
      if (selectedProducts.includes(stripProductName(p.productDescription))) {
        matching.push(p)
      } else {
        other.push(p)
      }
    }
    return { matchingSubs: matching, otherSubs: other }
  }, [account.products, selectedProducts])

  return (
    <div className="bg-surface border border-border rounded-xl p-4 hover:border-accent/30 transition-all group" data-testid="account-card">
      {/* Header — links to customer page */}
      <a
        href={`/dashboard/customer/${encodeURIComponent(account.name)}`}
        className="flex flex-col mb-3 min-w-0"
      >
        <div className="flex items-center justify-between min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <HealthDot score={health.score} breakdown={health.breakdown as any} />
            <span className="text-sm font-semibold text-text-primary group-hover:text-accent transition-colors truncate" title={account.name}>
              {account.name}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {showAE && account.ae && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 font-medium">
                {account.ae.split(' ')[0]}
              </span>
            )}
            {account.confidenceScore != null && (
              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                account.confidenceScore >= 80
                  ? 'bg-green-100 text-green-800'
                  : account.confidenceScore >= 60
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-red-100 text-red-800'
              }`}>
                {account.confidenceScore}%
              </span>
            )}
          </div>
        </div>
        {account.segment && (
          <span className="text-xs text-text-secondary mt-1 ml-[22px] truncate" title={account.segment}>
            {account.segment}
          </span>
        )}
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
            {(account.totalLicenses ?? 0).toLocaleString()}
          </div>
          <div className="text-xs text-text-secondary">Licenses</div>
        </button>
      </div>

      {/* Subscription expansion (Step 7) */}
      {selectedProducts.length > 0 && matchingSubs.length > 0 && (
        <div className="mb-3 space-y-1">
          {matchingSubs.map((sub, i) => (
            <div key={`${sub.sku}-${i}`} className="flex items-center justify-between text-xs text-muted-foreground text-text-secondary px-1">
              <span className="truncate mr-2" title={sub.productDescription}>
                {stripProductName(sub.productDescription)}
              </span>
              <span className="shrink-0 tabular-nums">
                {sub.quantity}x {sub.endDate ? formatDate(sub.endDate) : ''}
              </span>
            </div>
          ))}
          {otherSubs.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowMoreSubs(v => !v) }}
              className="text-xs text-accent cursor-pointer hover:underline px-1"
            >
              {showMoreSubs ? 'hide' : `show ${otherSubs.length} more`} {showMoreSubs ? '\u25B4' : '\u25BE'}
            </button>
          )}
          {showMoreSubs && otherSubs.map((sub, i) => (
            <div key={`other-${sub.sku}-${i}`} className="flex items-center justify-between text-xs text-text-secondary/60 px-1">
              <span className="truncate mr-2" title={sub.productDescription}>
                {stripProductName(sub.productDescription)}
              </span>
              <span className="shrink-0 tabular-nums">
                {sub.quantity}x {sub.endDate ? formatDate(sub.endDate) : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {nextMeeting ? (
        <div className="flex items-center gap-1.5 text-sm px-2 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-accent min-w-0">
          <Calendar className="w-3 h-3 shrink-0" />
          <span className="font-medium truncate" title={`${formatDate(nextMeeting.start)} · ${nextMeeting.title}`}>{formatDate(nextMeeting.start)} · {nextMeeting.title}</span>
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

interface CardGridProps {
  accounts: AccountInfo[]
  casesByAccount: Map<string, SupportCase[]>
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>
  priorityActions: Record<string, string>
  selectedProducts?: string[]
}

function CardGrid({
  accounts,
  casesByAccount,
  events,
  showAE,
  onProductClick,
  healthScores,
  priorityActions,
  selectedProducts = [],
}: CardGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {accounts.map((account) => {
        const acctCases = getCasesForAccountFromMap(account, casesByAccount)
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
            selectedProducts={selectedProducts}
          />
        )
      })}
    </div>
  )
}

// ── Virtualized Card Grid (react-window v2) ────────────────────────────────

const ROW_HEIGHT = 240
const COLUMN_GAP = 16

interface VirtualCellProps {
  accounts: AccountInfo[]
  casesByAccount: Map<string, SupportCase[]>
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
  healthScores: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>
  priorityActions: Record<string, string>
  selectedProducts: string[]
  columnCount: number
}

function VirtualCell({
  columnIndex,
  rowIndex,
  style,
  accounts,
  casesByAccount,
  events,
  showAE,
  onProductClick,
  healthScores,
  priorityActions,
  selectedProducts,
  columnCount,
}: {
  columnIndex: number
  rowIndex: number
  style: React.CSSProperties
  ariaAttributes: { 'aria-colindex': number; role: 'gridcell' }
} & VirtualCellProps) {
  const idx = rowIndex * columnCount + columnIndex
  if (idx >= accounts.length) return null
  const account = accounts[idx]
  const acctCases = getCasesForAccountFromMap(account, casesByAccount)

  return (
    <div style={{ ...style, paddingRight: COLUMN_GAP, paddingBottom: COLUMN_GAP }}>
      <AccountCard
        account={account}
        accountCases={acctCases}
        events={events}
        showAE={showAE}
        onProductClick={onProductClick}
        healthScores={healthScores}
        priorityAction={priorityActions[account.name]}
        selectedProducts={selectedProducts}
      />
    </div>
  )
}

function VirtualizedCardGrid({
  accounts,
  casesByAccount,
  events,
  showAE,
  onProductClick,
  healthScores,
  priorityActions,
  selectedProducts = [],
}: CardGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // Observe container width for responsive columns
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })
    observer.observe(el)
    setContainerWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  const columnCount = containerWidth >= 1200 ? 3 : containerWidth >= 768 ? 2 : 1
  const rowCount = Math.ceil(accounts.length / columnCount)

  // Don't render grid until we have a width measurement
  if (containerWidth === 0) {
    return <div ref={containerRef} className="w-full min-h-[240px]" />
  }

  const gridHeight = Math.min(
    rowCount * (ROW_HEIGHT + COLUMN_GAP),
    Math.max(600, window.innerHeight - 200)
  )

  return (
    <div ref={containerRef} className="w-full">
      <Grid
        columnCount={columnCount}
        columnWidth={(containerWidth / columnCount)}
        rowCount={rowCount}
        rowHeight={ROW_HEIGHT + COLUMN_GAP}
        overscanCount={2}
        style={{ overflowX: 'hidden', width: containerWidth, height: gridHeight }}
        cellComponent={VirtualCell}
        cellProps={{
          accounts,
          casesByAccount,
          events,
          showAE,
          onProductClick,
          healthScores,
          priorityActions,
          selectedProducts: selectedProducts ?? [],
          columnCount,
        }}
      />
    </div>
  )
}

export function AccountPortfolioGrid({ accounts, cases, events, loading, selectedProducts = [], aeList = [], aeFilterSelected = 'all', allAccounts = [] }: AccountPortfolioGridProps) {
  const [modalAccount, setModalAccount] = useState<AccountInfo | null>(null)
  // BKL-UX109: Default to 'grouped' (list-style AE sections) for large portfolios (≥4 AEs)
  // which gives users a scan-at-scale view; fall back to card-style 'byAE' for smaller pods.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const aeCount = aeList.length > 0
      ? aeList.length
      : new Set(accounts.map(a => a.ae).filter(Boolean)).size
    return aeCount >= 4 ? 'grouped' : 'byAE'
  })
  // BKL-UX109 fix: aeList is empty at mount (async load), so the lazy initializer
  // above always picks 'byAE'. When aeList arrives, promote to 'grouped' for large
  // portfolios unless the user has already picked a view explicitly.
  const hasUserChosen = useRef(false)
  useEffect(() => {
    if (aeList.length >= 4 && !hasUserChosen.current) {
      setViewMode('grouped')
    }
  }, [aeList])
  const [search, setSearch] = useState('')
  const [aeFilter, setAeFilter] = useState('')
  const [healthScores, setHealthScores] = useState<Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }>>({})
  const [priorityActions, setPriorityActions] = useState<Record<string, string>>({})

  useEffect(() => {
    fetch('/api/health-scores')
      .then(r => r.json())
      .then((scores: { name: string; score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }[]) => {
        const map: Record<string, { score: number; status: string; breakdown?: Record<string, { score: number; signal: string }> }> = {}
        for (const s of scores) map[s.name] = { score: s.score, status: s.status, breakdown: s.breakdown }
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
  // BKL-REG-19: Also index by customerName (lowercased) so customers with no
  // accountNumbers still get their name-matched cases counted.
  const casesByAccount = useMemo(() => {
    const map = new Map<string, SupportCase[]>()
    for (const c of cases ?? []) {
      const acct = String(c.accountNumber)
      if (acct) {
        if (!map.has(acct)) map.set(acct, [])
        map.get(acct)!.push(c)
      }
      // Also index by customerName for name-match fallback
      if (c.customerName) {
        const nameKey = `name:${c.customerName.toLowerCase()}`
        if (!map.has(nameKey)) map.set(nameKey, [])
        map.get(nameKey)!.push(c)
      }
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
    if (viewMode === 'grouped') return 'grouped'
    // Auto-suggest triage for large portfolios, but keep byAE as user choice
    return 'byAE'
  }, [viewMode])

  // Oldest cachedAt across all accounts
  const oldestCachedAt = (() => {
    const timestamps = accounts.map(a => a.cachedAt).filter(Boolean) as string[]
    if (!timestamps.length) return null
    return timestamps.reduce((oldest, t) => t < oldest ? t : oldest)
  })()

  // Helper: get cases for an account (delegates to shared BKL-REG-19 helper)
  const getCasesForAccount = (account: AccountInfo): SupportCase[] =>
    getCasesForAccountFromMap(account, casesByAccount)

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

  // LOG-12: Product-filtered AE grouping — groups by AE showing matching vs hidden accounts
  const useProductAEGrouping = selectedProducts.length > 0 && aeFilterSelected === 'all' && aeList.length > 1
  const productAEGroups = useMemo(() => {
    if (!useProductAEGrouping) return []
    // Build a map of AE -> { matching (filtered), hidden (all minus filtered) }
    const matchingNames = new Set(filteredAccounts.map(a => a.name))
    const grouped = new Map<string, { matching: AccountInfo[]; hidden: AccountInfo[] }>()
    for (const a of allAccounts) {
      const ae = a.ae || 'Unassigned'
      if (!grouped.has(ae)) grouped.set(ae, { matching: [], hidden: [] })
      const g = grouped.get(ae)!
      if (matchingNames.has(a.name)) {
        g.matching.push(a)
      } else {
        g.hidden.push(a)
      }
    }
    // Order by aeList order, filter out groups with zero matching
    const ordered = aeList
      .map(ae => {
        const g = grouped.get(ae.name)
        return g ? { ae: ae.name, matching: g.matching, hidden: g.hidden } : null
      })
      .filter((g): g is { ae: string; matching: AccountInfo[]; hidden: AccountInfo[] } => g !== null && g.matching.length > 0)
    return ordered
  }, [useProductAEGrouping, filteredAccounts, allAccounts, aeList, aeFilterSelected, selectedProducts])

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
          <span className="text-xs text-text-secondary">{filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}</span>
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
                aria-label="Filter by AE"
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
                onClick={() => { hasUserChosen.current = true; setViewMode('all') }}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'all' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                All
              </button>
              <button
                onClick={() => { hasUserChosen.current = true; setViewMode('byAE') }}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'byAE' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                By AE
              </button>
              <button
                onClick={() => { hasUserChosen.current = true; setViewMode('grouped') }}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'grouped' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                title="List view grouped by AE with health indicators"
              >
                Grouped
              </button>
              <button
                onClick={() => { hasUserChosen.current = true; setViewMode('triage') }}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${effectiveViewMode === 'triage' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                Triage
              </button>
              <button
                onClick={() => { hasUserChosen.current = true; setViewMode('list') }}
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
        ) : useProductAEGrouping ? (
          /* LOG-12: Product-filtered AE grouping */
          <div className="space-y-6">
            {productAEGroups.map(({ ae, matching, hidden }) => (
              <ProductAEGroup
                key={ae}
                ae={ae}
                matching={matching}
                hidden={hidden}
                casesByAccount={casesByAccount}
                events={events}
                onProductClick={setModalAccount}
                healthScores={healthScores}
                priorityActions={priorityActions}
                selectedProducts={selectedProducts}
              />
            ))}
          </div>
        ) : effectiveViewMode === 'triage' ? (
          /* Triage view */
          <div className="space-y-6">
            {triageGroups.critical.length > 0 && (
              <AEGroup
                label="Critical"
                count={triageGroups.critical.length}
                defaultCollapsed={false}
                customerScores={triageGroups.critical.map(a => a.attentionScore ?? 0)}
              >
                <CardGrid
                  accounts={triageGroups.critical}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                  selectedProducts={selectedProducts}
                />
              </AEGroup>
            )}
            {triageGroups.attention.length > 0 && (
              <AEGroup
                label="Attention"
                count={triageGroups.attention.length}
                defaultCollapsed={false}
                customerScores={triageGroups.attention.map(a => a.attentionScore ?? 0)}
              >
                <CardGrid
                  accounts={triageGroups.attention}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                  selectedProducts={selectedProducts}
                />
              </AEGroup>
            )}
            {triageGroups.healthy.length > 0 && (
              <AEGroup
                label="Healthy"
                count={triageGroups.healthy.length}
                defaultCollapsed={true}
                customerScores={triageGroups.healthy.map(a => a.attentionScore ?? 0)}
              >
                <CardGrid
                  accounts={triageGroups.healthy}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={true}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                  selectedProducts={selectedProducts}
                />
              </AEGroup>
            )}
          </div>
        ) : effectiveViewMode === 'byAE' ? (
          /* By AE view */
          <div className="space-y-6">
            {aeGroups.map(([ae, aeAccounts]) => (
              <AEGroup
                key={ae}
                label={ae}
                count={aeAccounts.length}
                defaultCollapsed={aeGroups.length > 4}
                customerScores={aeAccounts.map(a => a.attentionScore ?? 0)}
              >
                <CardGrid
                  accounts={aeAccounts}
                  casesByAccount={casesByAccount}
                  events={events}
                  showAE={false}
                  onProductClick={setModalAccount}
                  healthScores={healthScores}
                  priorityActions={priorityActions}
                  selectedProducts={selectedProducts}
                />
              </AEGroup>
            ))}
          </div>
        ) : effectiveViewMode === 'grouped' ? (
          /* BKL-UX109: List-style AE groups with health-dot headers, pipeline ACV, case count */
          <AEGroupedList
            accounts={filteredAccounts}
            cases={cases}
            events={events}
            loading={loading}
            onCustomerClick={(name) => {
              window.location.href = `/dashboard/customer/${encodeURIComponent(name)}`
            }}
          />
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
                        <HealthDot score={health.score} breakdown={health.breakdown as any} />
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
          /* All view — virtualized for performance with large portfolios */
          <VirtualizedCardGrid
            accounts={filteredAccounts}
            casesByAccount={casesByAccount}
            events={events}
            showAE={true}
            onProductClick={setModalAccount}
            healthScores={healthScores}
            priorityActions={priorityActions}
            selectedProducts={selectedProducts}
          />
        )}
      </div>
    </>
  )
}
