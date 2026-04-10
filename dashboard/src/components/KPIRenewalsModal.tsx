import { useState, useMemo } from 'react'
import { normalizeProductName, stripProductName } from '../utils/productName'
import { Package, ArrowRight, X, ChevronRight, ChevronDown } from 'lucide-react'

export interface RenewalRow {
  customerName: string
  productDescription: string
  quantity: number
  endDate: string
  daysLeft: number
  ae?: string
  sku?: string
}

// BKL-M45: Match the backend FREE_TRIAL_RE pattern from health-score.ts
const FREE_TRIAL_RE = /\b(free|beta|trial|eval|evaluation|developer|self-support|no-support|sandbox)\b/i

export function isFreeOrTrialRow(row: RenewalRow): boolean {
  return FREE_TRIAL_RE.test(row.productDescription) || FREE_TRIAL_RE.test(row.sku ?? '')
}

function classifyTierBadge(row: RenewalRow): 'FREE' | 'TRIAL' | 'BETA' {
  const text = `${row.productDescription} ${row.sku ?? ''}`.toLowerCase()
  if (/\bbeta\b/.test(text)) return 'BETA'
  if (/\b(trial|eval|evaluation)\b/.test(text)) return 'TRIAL'
  return 'FREE'
}

function urgencyColor(daysLeft: number): string {
  if (daysLeft < 0) return 'text-critical'
  if (daysLeft < 30) return 'text-critical'
  if (daysLeft < 60) return 'text-warning'
  return 'text-warning'
}

function urgencyBg(daysLeft: number): string {
  if (daysLeft < 0) return 'bg-critical/10 border-critical/20'
  if (daysLeft < 30) return 'bg-critical/10 border-critical/20'
  if (daysLeft < 60) return 'bg-warning/10 border-warning/20'
  return 'bg-warning/10 border-warning/20'
}

function daysLabel(daysLeft: number): string {
  if (daysLeft < 0) return `${Math.abs(daysLeft)}d expired`
  if (daysLeft === 0) return 'expires today'
  return `${daysLeft}d left`
}

interface KPIRenewalsModalProps {
  title: string
  accentClass: string
  rows: RenewalRow[]
  byCustomer: [string, RenewalRow[]][]
  onClose: () => void
  freeTrialRows?: RenewalRow[]
  /** BKL-PVIEW-11: Product filter cascade */
  selectedProducts?: string[]
}

function rowMatchesProducts(row: RenewalRow, selectedProducts: string[]): boolean {
  return selectedProducts.includes(normalizeProductName(stripProductName(row.productDescription)))
}

export default function KPIRenewalsModal({ title, accentClass, rows, byCustomer, onClose, freeTrialRows = [], selectedProducts }: KPIRenewalsModalProps) {
  const [viewMode, setViewMode] = useState<'all' | 'byAe'>('all')
  const [freeTrialExpanded, setFreeTrialExpanded] = useState(false)
  const [hiddenSubsExpanded, setHiddenSubsExpanded] = useState(false)

  const isFiltered = (selectedProducts?.length ?? 0) > 0

  // BKL-PVIEW-11: Split rows into matching and non-matching
  const matchingRows = useMemo(() =>
    isFiltered ? rows.filter(r => rowMatchesProducts(r, selectedProducts!)) : rows,
    [rows, selectedProducts, isFiltered]
  )
  const nonMatchingRows = useMemo(() =>
    isFiltered ? rows.filter(r => !rowMatchesProducts(r, selectedProducts!)) : [],
    [rows, selectedProducts, isFiltered]
  )

  const displayRows = isFiltered ? (hiddenSubsExpanded ? rows : matchingRows) : rows

  // Rebuild byCustomer from displayRows for consistent grouping
  const displayByCustomer = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of displayRows) {
      const list = map.get(row.customerName) ?? []
      list.push(row)
      map.set(row.customerName, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [displayRows])

  const byAe = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of displayRows) {
      const ae = row.ae ?? row.customerName
      const list = map.get(ae) ?? []
      list.push(row)
      map.set(ae, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [displayRows])

  const groupsToRender = viewMode === 'byAe' ? byAe : displayByCustomer

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-3xl max-h-[82vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Package className={`w-4 h-4 ${accentClass}`} />
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <span className="text-xs text-text-secondary">{isFiltered ? `${matchingRows.length} matching · ` : ''}{rows.length} subscriptions · {byCustomer.length} accounts</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('all')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'all' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setViewMode('byAe')}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  viewMode === 'byAe' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                By AE
              </button>
            </div>
            <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors" aria-label="Close modal">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-border/50">
          {groupsToRender.map(([groupName, groupRows]) => (
            <div key={groupName} className="px-5 py-3.5">
              <div className="flex items-center justify-between mb-2">
                <a
                  href={`/dashboard/customer/${encodeURIComponent(groupName)}`}
                  className="flex items-center gap-1.5 text-sm font-semibold text-text-primary hover:text-accent transition-colors"
                  onClick={onClose}
                >
                  {groupName}
                  <ArrowRight className="w-3.5 h-3.5" />
                </a>
                <span className="text-xs bg-border/40 text-text-secondary px-1.5 py-0.5 rounded-full tabular-nums">
                  {groupRows.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {groupRows.map((row, i) => (
                  <div key={i} className={`flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border min-w-0 ${urgencyBg(row.daysLeft)}`}>
                    <span className="text-text-primary truncate flex-1" title={row.productDescription}>{row.productDescription}</span>
                    <span className="text-text-secondary shrink-0">x{row.quantity}</span>
                    <span className={`font-mono font-semibold shrink-0 tabular-nums ${urgencyColor(row.daysLeft)}`}>
                      {daysLabel(row.daysLeft)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* BKL-PVIEW-11: Collapsed non-matching subscriptions toggle */}
          {isFiltered && nonMatchingRows.length > 0 && (
            <div className="px-5 py-3">
              <button
                onClick={() => setHiddenSubsExpanded(v => !v)}
                className="flex items-center gap-2 w-full text-left bg-border/10 hover:bg-border/20 rounded-lg px-3 py-2 transition-colors"
                aria-expanded={hiddenSubsExpanded}
              >
                {hiddenSubsExpanded
                  ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                }
                <span className="text-xs text-text-secondary/70">
                  {nonMatchingRows.length} other subscription{nonMatchingRows.length !== 1 ? 's' : ''} {hiddenSubsExpanded ? '' : 'hidden'}
                </span>
              </button>
            </div>
          )}

          {/* BKL-M45: Collapsible free/trial section */}
          {freeTrialRows.length > 0 && (
            <div className="px-5 py-3">
              <button
                onClick={() => setFreeTrialExpanded(v => !v)}
                className="flex items-center gap-2 w-full text-left bg-border/10 hover:bg-border/20 rounded-lg px-3 py-2 transition-colors"
                aria-expanded={freeTrialExpanded}
                aria-label={freeTrialExpanded ? `Hide ${freeTrialRows.length} free and trial subscriptions` : `Show ${freeTrialRows.length} free and trial subscriptions`}
              >
                {freeTrialExpanded
                  ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                }
                <span className="text-xs text-text-secondary/70">
                  {freeTrialRows.length} free/trial subscription{freeTrialRows.length !== 1 ? 's' : ''} {freeTrialExpanded ? '' : 'not shown'}
                </span>
              </button>
              {freeTrialExpanded && (
                <div className="mt-2 space-y-1.5" role="region" aria-label="Free and trial subscriptions">
                  {freeTrialRows.map((row, i) => {
                    const badge = classifyTierBadge(row)
                    return (
                      <div key={i} className="flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border border-border/30 bg-transparent min-w-0">
                        <span className="inline-flex items-center gap-2 truncate flex-1 min-w-0">
                          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-border/30 text-text-secondary">
                            {badge}
                          </span>
                          <span className="text-text-secondary truncate" title={row.productDescription}>{row.productDescription}</span>
                        </span>
                        <span className="text-text-secondary/60 shrink-0">x{row.quantity}</span>
                        <span className="font-mono text-text-secondary shrink-0 tabular-nums">
                          {daysLabel(row.daysLeft)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
