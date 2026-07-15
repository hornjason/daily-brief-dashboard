import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Zap } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ───────────────────────────────────────────────────────────────────

interface TerritoryPartner {
  name: string
  aliases: string[]
  domain: string | null
  enrichmentStatus: 'enriched' | 'pending' | 'not-found' | 'slug-unknown'
  partnershipLevel: string | null
  specializations: string[]
  catalogUrl: string | null
  customerAssociations: Array<{ customerSlug: string; customerName: string }>
  extractedAt: string | null
}

// ── Status badge ────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  enriched: 'bg-green-700 text-green-200',
  pending: 'bg-yellow-700 text-yellow-200',
  'not-found': 'bg-red-700 text-red-200',
  'slug-unknown': 'bg-orange-700 text-orange-200',
}

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? 'bg-gray-700 text-gray-300'
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${colors}`}>
      {status}
    </span>
  )
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export function TerritoryPartnersPanel() {
  const [partners, setPartners] = useState<TerritoryPartner[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [enriching, setEnriching] = useState(false)

  const loadPartners = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/territory-partners')
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`${res.status}: ${body || res.statusText}`)
      }
      const data: TerritoryPartner[] = await res.json()
      setPartners(data)
      setError(null)
    } catch (err: any) {
      setError(err.message ?? 'Failed to load partners')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPartners()
  }, [loadPartners])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/admin/territory-partners/refresh', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? `Refresh failed: ${res.status}`)
      }
      await loadPartners()
    } catch (err: any) {
      setError(err.message ?? 'Network error during refresh')
    } finally {
      setRefreshing(false)
    }
  }

  const handleEnrich = async () => {
    setEnriching(true)
    try {
      const res = await fetch('/api/admin/territory-partners/enrich', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? `Enrich failed: ${res.status}`)
      }
      await loadPartners()
    } catch (err: any) {
      setError(err.message ?? 'Network error during enrich')
    } finally {
      setEnriching(false)
    }
  }

  if (loading) {
    return <div className="text-xs text-gray-500">Loading territory partners...</div>
  }

  return (
    <div className="space-y-3">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh from Pipeline'}
        </button>
        <button
          onClick={handleEnrich}
          disabled={enriching}
          className="px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-1.5"
        >
          <Zap className={`w-3.5 h-3.5 ${enriching ? 'animate-pulse' : ''}`} />
          {enriching ? 'Enriching...' : 'Enrich All'}
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/50 border border-red-700/60 rounded-md px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Partner table */}
      {partners.length === 0 ? (
        <div className="text-xs text-gray-500">
          No territory partners found. Click "Refresh from Pipeline" to import partners from the territory config.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-700 text-left text-gray-400">
                <th className="pb-2 pr-4 font-medium">Name</th>
                <th className="pb-2 pr-4 font-medium">Tier</th>
                <th className="pb-2 pr-4 font-medium">Specializations</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 font-medium">Customers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {partners.map(p => (
                <tr key={p.name} className="hover:bg-gray-800/50">
                  <td className="py-2 pr-4 text-gray-200">
                    {p.catalogUrl ? (
                      <a
                        href={p.catalogUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-red-400 transition-colors"
                      >
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    )}
                    {p.extractedAt && (
                      <div className="text-gray-500 mt-0.5">Enriched {formatRelTime(p.extractedAt)}</div>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-gray-300">{p.partnershipLevel ?? '—'}</td>
                  <td className="py-2 pr-4 text-gray-300">
                    {p.specializations.length > 0
                      ? p.specializations.join(', ')
                      : '—'}
                  </td>
                  <td className="py-2 pr-4">
                    <StatusBadge status={p.enrichmentStatus} />
                  </td>
                  <td className="py-2 text-gray-300">
                    {p.customerAssociations.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
