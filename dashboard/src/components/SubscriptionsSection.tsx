import { useMemo } from 'react'
import { Package } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SheetProduct {
  sku: string
  productDescription: string
  quantity: number
  status: string
  startDate?: string
  endDate?: string
  daysLeft?: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

function expiryColor(daysLeft: number): string {
  if (daysLeft < 30) return 'text-critical'
  if (daysLeft < 90) return 'text-warning'
  return 'text-success'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── SubscriptionsSection ──────────────────────────────────────────────────────

export function SubscriptionsSection({ products, loading }: { products: SheetProduct[]; loading: boolean }) {
  const today = Date.now()
  const sorted = useMemo(() =>
    [...products]
      .map((p) => ({
        ...p,
        daysLeft: p.endDate ? Math.ceil((new Date(p.endDate).getTime() - today) / 86_400_000) : 9999,
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft),
    [products]
  )

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Package className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Products</h2>
        {!loading && <span className="text-xs text-text-secondary">{products.length}</span>}
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}
        </div>
      )}

      {!loading && products.length === 0 && (
        <p className="text-sm text-text-secondary italic py-1">No product data cached — run sheet sync</p>
      )}

      {!loading && sorted.length > 0 && (
        <div className="space-y-1">
          {sorted.map((p, i) => (
            <div key={i} className="flex items-center gap-3 py-2 border-b border-border/40 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text-primary truncate">{p.productDescription}</p>
                <p className="text-xs text-text-secondary mt-0.5">
                  Qty: {p.quantity.toLocaleString()}{p.sku ? ` · ${p.sku}` : ''}
                </p>
              </div>
              <div className="text-right shrink-0">
                {p.endDate ? (
                  <>
                    <p className={`text-xs font-semibold ${expiryColor(p.daysLeft!)}`}>
                      {p.daysLeft! < 0 ? 'Expired' : `${p.daysLeft}d`}
                    </p>
                    <p className="text-xs text-text-secondary">{formatDate(p.endDate)}</p>
                  </>
                ) : (
                  <p className="text-xs text-text-secondary">—</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
