import { useState, useEffect } from 'react'
import { TrendingUp, Calendar, Users, X, RefreshCw, AlertCircle } from 'lucide-react'
import type { PipelineSummary, PipelineOpp, PipelineByQuarterStage } from '../types'
import { formatRelTime, fmtCurrency as fmt } from '../lib/format'
import RelTime from './RelTime'
import Modal from './Modal'

function fmtDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function closeDateUrgency(iso: string): 'overdue' | 'urgent' | 'soon' | 'ok' {
  if (!iso) return 'ok'
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000
  if (days < 0) return 'overdue'
  if (days <= 30) return 'urgent'
  if (days <= 90) return 'soon'
  return 'ok'
}

const URGENCY_COLORS: Record<string, string> = {
  overdue: 'text-critical',
  urgent:  'text-warning',
  soon:    'text-accent',
  ok:      'text-text-secondary',
}

const STAGE_COLORS: Record<string, string> = {
  Commit:       '#3FB950',
  'Best Case':  '#D29922',
  Pipeline:     '#58A6FF',
  Closed:       '#A371F7',
  Omitted:      '#6B7280',
}

function firstNames(full: string): string {
  return full.split(' ')[0]
}

export function OppDetail({ opp, onClose }: { opp: PipelineOpp; onClose: () => void }) {
  const stageColor = STAGE_COLORS[opp.forecastCategory] ?? STAGE_COLORS.Omitted
  const urgency = closeDateUrgency(opp.closeDate)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-sm p-5 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-secondary mb-0.5">{opp.accountName}</p>
            {opp.oppId ? (
              <a
                href={`https://redhatcrm.lightning.force.com/lightning/r/Opportunity/${opp.oppId}/view`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-semibold text-blue-400 hover:text-blue-300 leading-snug hover:underline"
              >
                {opp.oppName}
              </a>
            ) : (
              <p className="text-sm font-semibold text-text-primary leading-snug">{opp.oppName}</p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 text-text-secondary hover:text-text-primary transition-colors mt-0.5" role="button" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ACV */}
        <div className="text-3xl font-bold text-text-primary tabular-nums">{fmt(opp.acv)}</div>

        {/* Key fields grid */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Stage</p>
            <p className="text-sm font-semibold" style={{ color: stageColor }}>{opp.forecastCategory}</p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Close Date</p>
            <p className={`text-sm font-semibold ${URGENCY_COLORS[urgency]}`}>
              {opp.closeDate ? new Date(opp.closeDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
            </p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Probability</p>
            <p className="text-sm font-semibold text-text-primary">{opp.probability}%</p>
          </div>
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Type</p>
            <p className="text-sm font-semibold text-text-primary">{opp.renewal ? '↻ Renewal' : '✦ New Business'}</p>
          </div>
          {opp.offeringGroup && (
            <div className="bg-border/30 rounded-lg p-2.5">
              <p className="text-xs text-text-secondary mb-0.5">Offering</p>
              <p className="text-sm font-semibold text-text-primary">{opp.offeringGroup}</p>
            </div>
          )}
          <div className="bg-border/30 rounded-lg p-2.5">
            <p className="text-xs text-text-secondary mb-0.5">Owner</p>
            <p className="text-sm font-semibold text-text-primary">{opp.owner.split(' ')[0]}</p>
          </div>
        </div>

        {opp.products.length > 0 && (
          <div>
            <p className="text-xs font-medium text-text-secondary mb-1.5">Products</p>
            <ul className="space-y-1">
              {opp.products.map((p, i) => (
                <li key={i} className="flex gap-2 text-xs text-text-secondary">
                  <span className="text-accent mt-0.5 shrink-0">·</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-text-secondary/65">Opp #{opp.oppNumber}</p>
      </div>
    </div>
  )
}

interface Props {
  data: PipelineSummary | null
  loading: boolean
  error?: string | null
  onRefresh?: () => void
}

export function PipelineSection({ data, loading, error, onRefresh }: Props) {
  const [activeOwner, setActiveOwner] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'acv' | 'date' | 'stage'>('acv')
  const [selectedOpp, setSelectedOpp] = useState<PipelineOpp | null>(null)
  const totalAcv       = data?.totalAcv       ?? 0
  const openCount      = data?.openCount      ?? 0
  const renewalAcv     = data?.renewalAcv     ?? 0
  const newAcv         = data?.newAcv         ?? 0
  const byStage        = data?.byStage        ?? []
  const byOwner        = data?.byOwner        ?? []
  const topOpps        = data?.topOpps        ?? []
  const closedOpps     = data?.closedOpps     ?? []

  const maxStageAcv = byStage.reduce((m, s) => Math.max(m, s.acv), 0)
  const maxOwnerAcv = byOwner.reduce((m, o) => Math.max(m, o.acv), 0)

  const ownerOpps = activeOwner ? topOpps.filter(o => o.owner === activeOwner) : topOpps
  const ownerClosed = activeOwner ? closedOpps.filter(o => o.owner === activeOwner) : closedOpps

  // Quarterly stage breakdown — open + closed, reactive to selected owner
  const byQuarterStage = (() => {
    const qMap = new Map<string, { commit: number; bestCase: number; pipeline: number; closed: number }>()
    for (const o of [...ownerOpps, ...ownerClosed]) {
      if (!o.closeDate) continue
      const d = new Date(o.closeDate)
      const q = `Q${Math.ceil((d.getMonth() + 1) / 3)} ${d.getFullYear()}`
      const slot = qMap.get(q) ?? { commit: 0, bestCase: 0, pipeline: 0, closed: 0 }
      if (o.forecastCategory === 'Commit')         slot.commit   += o.acv
      else if (o.forecastCategory === 'Best Case') slot.bestCase += o.acv
      else if (o.forecastCategory === 'Pipeline')  slot.pipeline += o.acv
      else if (o.forecastCategory === 'Closed')    slot.closed   += o.acv
      qMap.set(q, slot)
    }
    return [...qMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([quarter, v]) => ({ quarter, ...v }))
  })()

  const STAGE_SORT_ORDER: Record<string, number> = { Commit: 0, 'Best Case': 1, Pipeline: 2, Omitted: 3 }

  const sortedOwnerOpps = [...ownerOpps].sort((a, b) => {
    if (sortBy === 'date')  return (a.closeDate ?? '').localeCompare(b.closeDate ?? '')
    if (sortBy === 'stage') return (STAGE_SORT_ORDER[a.forecastCategory] ?? 9) - (STAGE_SORT_ORDER[b.forecastCategory] ?? 9)
    return b.acv - a.acv  // 'acv' default
  })

  const filteredOpps: PipelineOpp[] = sortedOwnerOpps

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Open Pipeline</h2>
        <span className="text-xs text-text-secondary">Opportunities 2026</span>
        {loading && <span className="text-xs text-text-secondary animate-pulse">Loading…</span>}
        {!loading && (
          <span className="text-xs text-text-secondary ml-auto">
            {data?.cachedAt ? <RelTime iso={data.cachedAt} className="text-xs text-text-secondary" /> : 'Live'}
          </span>
        )}
        {onRefresh && (
          <button onClick={onRefresh} className="ml-auto text-text-secondary hover:text-text-primary transition-colors shrink-0" title="Refresh" aria-label="Refresh pipeline data">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {error && !loading && (
        <div className="flex items-center gap-2 text-xs text-critical px-5 py-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Failed to load pipeline data. {onRefresh && <button onClick={onRefresh} className="underline hover:no-underline">Retry</button>}</span>
        </div>
      )}

      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left: totals + stage breakdown */}
        <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-4">
          {/* Total ACV */}
          <div>
            <div className="text-xs text-text-secondary mb-1">Total Open ACV</div>
            {loading ? (
              <div className="h-8 w-28 bg-border rounded animate-pulse-slow" />
            ) : (
              <div className="text-3xl font-bold text-text-primary tabular-nums">{fmt(totalAcv)}</div>
            )}
            <div className="text-xs text-text-secondary">{openCount} opportunities</div>
          </div>

          {/* New vs Renewal */}
          {!loading && (
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-border/30 rounded-lg p-2.5">
                <div className="text-xs text-text-secondary mb-0.5">New Business</div>
                <div className="text-sm font-semibold text-text-primary">{fmt(newAcv)}</div>
              </div>
              <div className="bg-border/30 rounded-lg p-2.5">
                <div className="text-xs text-text-secondary mb-0.5">Renewal</div>
                <div className="text-sm font-semibold text-text-primary">{fmt(renewalAcv)}</div>
              </div>
            </div>
          )}

          {/* By forecast stage */}
          <div>
            <div className="text-xs font-medium text-text-secondary mb-2">By Forecast Stage</div>
            {loading
              ? [1, 2, 3].map(i => <div key={i} className="h-5 bg-border rounded animate-pulse-slow mb-2" />)
              : byStage.map(({ stage, acv, count }) => {
                const pct = maxStageAcv > 0 ? (acv / maxStageAcv) * 100 : 0
                const color = STAGE_COLORS[stage] ?? STAGE_COLORS.Omitted
                return (
                  <div key={stage} className="mb-2">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-text-primary font-medium">{stage}</span>
                      <span className="text-text-secondary">{fmt(acv)} · {count}</span>
                    </div>
                    <div className="h-1.5 bg-border rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
                    </div>
                  </div>
                )
              })
            }
          </div>
        </div>

        {/* Middle: By owner */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-3.5 h-3.5 text-accent" />
            <span className="text-sm font-medium text-text-secondary">By Owner</span>
            {activeOwner && (
              <button onClick={() => setActiveOwner(null)} className="ml-auto text-xs text-text-secondary hover:text-text-primary transition-colors" aria-label="Clear owner filter">
                clear
              </button>
            )}
          </div>
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4].map(i => <div key={i} className="h-8 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : (
            <div className="space-y-2">
              {byOwner.map(({ owner, acv, count }) => {
                const pct = maxOwnerAcv > 0 ? (acv / maxOwnerAcv) * 100 : 0
                const isActive = activeOwner === owner
                return (
                  <button
                    key={owner}
                    onClick={() => setActiveOwner(isActive ? null : owner)}
                    className={`w-full text-left rounded px-2 py-1.5 transition-colors ${isActive ? 'bg-border/40' : 'hover:bg-border/20'}`}
                  >
                    <div className="flex justify-between text-sm mb-1">
                      <span className={`font-medium ${isActive ? 'text-text-primary' : 'text-text-secondary'}`}>
                        {firstNames(owner)}
                      </span>
                      <span className="text-xs text-text-secondary">{fmt(acv)} · {count}</span>
                    </div>
                    <div className="h-1.5 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: isActive ? '#58A6FF' : '#4B5563' }}
                      />
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          {/* Quarter × Stage grid */}
          {!loading && byQuarterStage.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <div className="grid grid-cols-5 gap-x-1 mb-1.5">
                <span className="text-xs text-text-secondary"></span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Commit'] }}>Commit</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Best Case'] }}>Best</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Pipeline'] }}>Pipeline</span>
                <span className="text-xs font-medium text-center" style={{ color: STAGE_COLORS['Closed'] }}>Closed</span>
              </div>
              {byQuarterStage.map(({ quarter, commit, bestCase, pipeline, closed }) => (
                <div key={quarter} className="grid grid-cols-5 gap-x-1 py-0.5 hover:bg-border/20 rounded px-1 -mx-1">
                  <span className="text-xs text-text-secondary font-medium">{quarter}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{commit > 0 ? fmt(commit) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{bestCase > 0 ? fmt(bestCase) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{pipeline > 0 ? fmt(pipeline) : <span className="text-text-secondary/65">—</span>}</span>
                  <span className="text-xs text-text-primary text-center font-mono">{closed > 0 ? fmt(closed) : <span className="text-text-secondary/65">—</span>}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Top opps */}
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Calendar className="w-3.5 h-3.5 text-accent" />
            <span className="text-sm font-medium text-text-secondary">
              {activeOwner ? `${firstNames(activeOwner)}'s Opps` : 'Top Opportunities'}
            </span>
            <div className="ml-auto flex items-center gap-0.5 bg-border/30 rounded-md p-0.5">
              {(['acv', 'date', 'stage'] as const).map(opt => (
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
          {loading ? (
            <div className="space-y-2">
              {[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-border rounded animate-pulse-slow" />)}
            </div>
          ) : filteredOpps.length === 0 ? (
            <div className="text-xs text-text-secondary">No opportunities</div>
          ) : (
            <div className="overflow-y-auto max-h-64">
              {filteredOpps.map((opp) => {
                const urgency = closeDateUrgency(opp.closeDate)
                const stageColor = STAGE_COLORS[opp.forecastCategory] ?? STAGE_COLORS.Omitted
                return (
                  <button key={opp.oppNumber} onClick={() => setSelectedOpp(opp)} className="w-full text-left flex items-center gap-2 py-1 px-1 -mx-1 hover:bg-border/20 rounded group cursor-pointer min-w-0" tabIndex={0}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: stageColor }} />
                    <span className="text-xs font-medium shrink-0 w-10" style={{ color: stageColor }}>
                      {opp.forecastCategory === 'Best Case' ? 'Best' : opp.forecastCategory}
                    </span>
                    <span className="text-sm text-text-primary truncate flex-1 min-w-0" title={opp.accountName}>{opp.accountName}</span>
                    <span className={`text-xs shrink-0 ${URGENCY_COLORS[urgency]}`}>{fmtDate(opp.closeDate)}</span>
                    <span className="text-xs font-mono text-text-primary shrink-0">{fmt(opp.acv)}</span>
                    {opp.renewal && <span className="text-xs text-text-secondary/75 shrink-0">↻</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>

      </div>

      {selectedOpp && <OppDetail opp={selectedOpp} onClose={() => setSelectedOpp(null)} />}
    </div>
  )
}
