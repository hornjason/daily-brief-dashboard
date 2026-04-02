import { useState, useMemo } from 'react'
import { fmtCurrency as fmtAcv } from '../lib/format'
import type { PipelineOpp } from '../types'
import { Trophy, ExternalLink, X } from 'lucide-react'

const TW_STAGE_COLORS: Record<string, string> = {
  Commit: '#3FB950',
  'Best Case': '#D29922',
  Pipeline: '#58A6FF',
  Omitted: '#6B7280',
}

const TW_STAGE_SORT: Record<string, number> = {
  Commit: 0,
  'Best Case': 1,
  Pipeline: 2,
  Omitted: 3,
}

function fmtDateShort(iso: string): string {
  if (!iso) return '\u2014'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function twUrgencyClass(iso: string): string {
  if (!iso) return 'text-text-secondary'
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 0) return 'text-critical'
  if (days <= 30) return 'text-warning'
  if (days <= 90) return 'text-accent'
  return 'text-text-secondary'
}

interface KPITechWinsModalProps {
  open: boolean
  onClose: () => void
  opps: PipelineOpp[]
}

export default function KPITechWinsModal({ open, onClose, opps }: KPITechWinsModalProps) {
  const [sortBy, setSortBy] = useState<'acv' | 'date' | 'stage'>('acv')
  const [viewMode, setViewMode] = useState<'all' | 'byAe'>('all')

  const sorted = useMemo(() => {
    return [...opps].sort((a, b) => {
      if (sortBy === 'date') return (a.closeDate ?? '').localeCompare(b.closeDate ?? '')
      if (sortBy === 'stage') return (TW_STAGE_SORT[a.forecastCategory] ?? 9) - (TW_STAGE_SORT[b.forecastCategory] ?? 9)
      return b.acv - a.acv
    })
  }, [opps, sortBy])

  const byAe = useMemo(() => {
    const map = new Map<string, PipelineOpp[]>()
    for (const opp of sorted) {
      const ae = opp.owner ?? 'Unknown'
      const list = map.get(ae) ?? []
      list.push(opp)
      map.set(ae, list)
    }
    return Array.from(map.entries()).sort((a, b) => {
      const acvA = a[1].reduce((s, o) => s + o.acv, 0)
      const acvB = b[1].reduce((s, o) => s + o.acv, 0)
      return acvB - acvA
    })
  }, [sorted])

  if (!open) return null

  function renderOpp(opp: PipelineOpp) {
    const stageColor = TW_STAGE_COLORS[opp.forecastCategory] ?? TW_STAGE_COLORS.Omitted
    const stageLabel = opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory
    const sfUrl = `https://redhatcrm.lightning.force.com/_ui/search/ui/UnifiedSearchResults?str=${encodeURIComponent(opp.oppNumber)}`
    return (
      <a
        key={opp.oppNumber}
        href={sfUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="px-5 py-3.5 flex items-center gap-3 hover:bg-accent/10 cursor-pointer group"
      >
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
        <span className="text-xs font-semibold w-12 shrink-0" style={{ color: stageColor }}>{stageLabel}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-text-secondary truncate">{opp.accountName}</p>
          <p className="text-xs font-medium text-text-primary truncate leading-snug group-hover:text-accent transition-colors">{opp.oppName}</p>
        </div>
        <div className="text-right shrink-0 ml-2">
          <p className="text-xs font-mono font-semibold text-text-primary">{fmtAcv(opp.acv)}</p>
          <p className={`text-xs ${twUrgencyClass(opp.closeDate)}`}>{fmtDateShort(opp.closeDate)}</p>
        </div>
        <ExternalLink className="w-3.5 h-3.5 text-text-secondary/65 group-hover:text-accent transition-colors shrink-0" />
      </a>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-xl max-h-[80vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center gap-2 shrink-0">
          <Trophy className="w-4 h-4 text-warning shrink-0" />
          <h2 className="text-sm font-semibold text-text-primary">Tech Wins Needed</h2>
          <span className="text-xs text-text-secondary">
            {opps.length} opps · {fmtAcv(opps.reduce((s, o) => s + o.acv, 0))} at stake
          </span>
          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              <button
                onClick={() => setViewMode('all')}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${viewMode === 'all' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                All
              </button>
              <button
                onClick={() => setViewMode('byAe')}
                className={`text-xs px-1.5 py-0.5 rounded transition-colors ${viewMode === 'byAe' ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                By AE
              </button>
            </div>
            <div className="flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              {(['acv', 'date', 'stage'] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSortBy(opt)}
                  className={`text-xs px-1.5 py-0.5 rounded transition-colors ${sortBy === opt ? 'bg-border text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {opt === 'acv' ? '$' : opt === 'date' ? 'Date' : 'Stage'}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors ml-1" aria-label="Close modal">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-border/50">
          {viewMode === 'all' ? (
            sorted.map(renderOpp)
          ) : (
            byAe.map(([aeName, aeOpps]) => (
              <div key={aeName}>
                <div className="px-5 pt-3 pb-1 flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{aeName}</span>
                  <span className="text-xs bg-border/40 text-text-secondary px-1.5 py-0.5 rounded-full tabular-nums">
                    {aeOpps.length}
                  </span>
                  <span className="text-xs text-text-secondary ml-auto">
                    {fmtAcv(aeOpps.reduce((s, o) => s + o.acv, 0))}
                  </span>
                </div>
                <div className="divide-y divide-border/30">
                  {aeOpps.map(renderOpp)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
