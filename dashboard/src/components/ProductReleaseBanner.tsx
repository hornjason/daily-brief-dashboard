import { X } from 'lucide-react'
import { useState } from 'react'
import type { ProductSummary, ProductAlert } from './ProductCard'

interface ProductReleaseBannerProps {
  alerts: ProductAlert[]
  summaries: ProductSummary[]
  onAcknowledge: (id: string) => void
}

export function ProductReleaseBanner({ alerts, summaries, onAcknowledge }: ProductReleaseBannerProps) {
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set())

  const unacked = alerts.filter(a => !a.acknowledged)
  if (unacked.length === 0) return null

  function getDisplayName(slug: string): string {
    const s = summaries.find(s => s.slug === slug)
    return s?.displayName ?? slug
  }

  async function handleAcknowledge(id: string) {
    setAcknowledging(prev => new Set([...prev, id]))
    try {
      const res = await fetch(`/api/products/alerts/${id}/acknowledge`, { method: 'POST' })
      if (res.ok) {
        onAcknowledge(id)
      }
    } catch (e: any) {
      console.error('[ProductReleaseBanner] acknowledge failed:', e?.message)
    } finally {
      setAcknowledging(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <div className="bg-amber-900/30 border-b border-amber-700/40 px-6 py-2">
      <div className="flex flex-col gap-1.5">
        {unacked.map(alert => (
          <div key={alert.id} className="flex items-center gap-3 text-sm">
            <span className="text-amber-400 font-medium shrink-0">
              {getDisplayName(alert.slug)} {alert.version}
            </span>
            <span className="text-amber-300/70">— New release detected</span>
            <div className="flex-1" />
            <button
              onClick={() => handleAcknowledge(alert.id)}
              disabled={acknowledging.has(alert.id)}
              className="flex items-center gap-1 bg-amber-700/60 hover:bg-amber-700 text-amber-100 px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 shrink-0"
            >
              <X className="w-3 h-3" />
              {acknowledging.has(alert.id) ? 'Acknowledging…' : 'Acknowledge'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
