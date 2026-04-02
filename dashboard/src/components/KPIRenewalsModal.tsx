import { useState, useMemo } from 'react'
import { Package, ArrowRight, X } from 'lucide-react'

export interface RenewalRow {
  customerName: string
  productDescription: string
  quantity: number
  endDate: string
  daysLeft: number
  ae?: string
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
}

export default function KPIRenewalsModal({ title, accentClass, rows, byCustomer, onClose }: KPIRenewalsModalProps) {
  const [viewMode, setViewMode] = useState<'all' | 'byAe'>('all')

  const byAe = useMemo(() => {
    const map = new Map<string, RenewalRow[]>()
    for (const row of rows) {
      const ae = row.ae ?? row.customerName
      const list = map.get(ae) ?? []
      list.push(row)
      map.set(ae, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[1][0].daysLeft - b[1][0].daysLeft)
  }, [rows])

  const groupsToRender = viewMode === 'byAe' ? byAe : byCustomer

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-3xl max-h-[82vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Package className={`w-4 h-4 ${accentClass}`} />
            <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
            <span className="text-xs text-text-secondary">{rows.length} subscriptions · {byCustomer.length} accounts</span>
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
                  <div key={i} className={`flex items-center justify-between gap-3 text-xs px-3 py-2 rounded-lg border ${urgencyBg(row.daysLeft)}`}>
                    <span className="text-text-primary truncate flex-1">{row.productDescription}</span>
                    <span className="text-text-secondary shrink-0">x{row.quantity}</span>
                    <span className={`font-mono font-semibold shrink-0 tabular-nums ${urgencyColor(row.daysLeft)}`}>
                      {daysLabel(row.daysLeft)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
