import { useState } from 'react'
import type { AccountInfo, SupportCase, CalendarEvent, ProductSubscription } from '../types'
import { Building2, Shield, Package, Key, Calendar, X, ChevronUp, ChevronDown } from 'lucide-react'
import { formatDate, formatRelTime } from '../lib/format'

interface AccountPortfolioGridProps {
  accounts: AccountInfo[]
  cases: SupportCase[]
  events: CalendarEvent[]
  loading: boolean
}

function getHealthStatus(account: AccountInfo, cases: SupportCase[]): { color: string; label: string } {
  const accountCases = cases.filter((c) =>
    account.accountNumbers.some((num) => String(num) === String(c.accountNumber))
  )
  const hasSev1 = accountCases.some((c) => c.severity === '1')
  const hasAnyCases = accountCases.length > 0
  if (hasSev1) return { color: '#F85149', label: 'Critical' }
  if (hasAnyCases) return { color: '#D29922', label: 'Attention' }
  return { color: '#3FB950', label: 'Healthy' }
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

function getOpenCasesCount(account: AccountInfo, cases: SupportCase[]): number {
  return cases.filter((c) =>
    account.accountNumbers.some((num) => String(num) === String(c.accountNumber))
  ).length
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

// ── Grid ──────────────────────────────────────────────────────────────────────

function AccountCard({
  account,
  cases,
  events,
  showAE,
  onProductClick,
}: {
  account: AccountInfo
  cases: SupportCase[]
  events: CalendarEvent[]
  showAE: boolean
  onProductClick: (a: AccountInfo) => void
}) {
  const health = getHealthStatus(account, cases)
  const openCases = getOpenCasesCount(account, cases)
  const nextMeeting = getNextMeeting(account, events)

  return (
    <div className="bg-surface border border-border rounded-xl p-4 hover:border-accent/30 transition-all group">
      {/* Header — links to customer page */}
      <a
        href={`/dashboard/customer/${encodeURIComponent(account.name)}`}
        className="flex items-center justify-between mb-3"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: health.color }}
            title={health.label}
          />
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

export function AccountPortfolioGrid({ accounts, cases, events, loading }: AccountPortfolioGridProps) {
  const [modalAccount, setModalAccount] = useState<AccountInfo | null>(null)
  const [groupByAE, setGroupByAE] = useState(false)

  // Oldest cachedAt across all accounts — reflects how stale the subscription data is
  const oldestCachedAt = (() => {
    const timestamps = accounts.map(a => a.cachedAt).filter(Boolean) as string[]
    if (!timestamps.length) return null
    return timestamps.reduce((oldest, t) => t < oldest ? t : oldest)
  })()

  // Group accounts by AE
  const aeGroups = (() => {
    if (!groupByAE) return null
    const map = new Map<string, AccountInfo[]>()
    for (const a of accounts) {
      const key = a.ae || 'Unassigned'
      const arr = map.get(key) ?? []
      arr.push(a)
      map.set(key, arr)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })()

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
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Account Portfolio</h2>
          <span className="text-xs text-text-secondary">{accounts.length} accounts</span>
          {oldestCachedAt && (
            <span className="text-xs text-text-secondary">· synced {formatRelTime(oldestCachedAt)}</span>
          )}
          <div className="ml-auto flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
            <button
              onClick={() => setGroupByAE(false)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${!groupByAE ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
            >
              All
            </button>
            <button
              onClick={() => setGroupByAE(true)}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${groupByAE ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
            >
              By AE
            </button>
          </div>
        </div>

        {aeGroups ? (
          <div className="space-y-6">
            {aeGroups.map(([ae, aeAccounts]) => (
              <div key={ae}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-semibold text-accent">{ae}</span>
                  <span className="text-xs text-text-secondary">{aeAccounts.length} accounts</span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {aeAccounts.map((account) => (
                    <AccountCard
                      key={account.name}
                      account={account}
                      cases={cases}
                      events={events}
                      showAE={false}
                      onProductClick={setModalAccount}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((account) => (
            <AccountCard
              key={account.name}
              account={account}
              cases={cases}
              events={events}
              showAE={true}
              onProductClick={setModalAccount}
            />
          ))}
        </div>
        )}
      </div>
    </>
  )
}

