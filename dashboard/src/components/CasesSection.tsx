import { useState, useEffect } from 'react'
import { Shield, CheckCircle, ExternalLink, X } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export type CaseItem = {
  caseNumber: string
  summary: string
  status: string
  severity: string
  daysOpen: number
  product?: string
  casesSource?: 'name_match' | 'account_number'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

const SEV_LABELS: Record<string, { label: string; color: string; bg: string; border: string }> = {
  '1': { label: 'Sev 1 — Critical', color: 'text-critical',       bg: 'bg-critical/15', border: 'border-critical/30' },
  '2': { label: 'Sev 2 — High',     color: 'text-warning',        bg: 'bg-warning/15',  border: 'border-warning/30' },
  '3': { label: 'Sev 3 — Normal',   color: 'text-warning',        bg: 'bg-warning/10',  border: 'border-warning/20' },
  '4': { label: 'Sev 4 — Low',      color: 'text-text-secondary', bg: 'bg-border/30',   border: 'border-border' },
}

function fmtCommentDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Case Detail Modal ─────────────────────────────────────────────────────────

function CaseDetailModal({ c, onClose }: { c: CaseItem; onClose: () => void }) {
  const portalUrl = `https://access.redhat.com/support/cases/#/case/${encodeURIComponent(c.caseNumber)}`
  const sev = SEV_LABELS[c.severity] ?? SEV_LABELS['4']
  const statusColor = (s: string) =>
    s.toLowerCase().includes('waiting on red hat') ? 'text-critical' :
    s.toLowerCase().includes('waiting on customer') ? 'text-success' : 'text-text-secondary'

  const [comment, setComment] = useState<{ author: string; body: string; createdAt: string } | null | 'loading'>('loading')

  useEffect(() => {
    fetch(`/api/cases/${encodeURIComponent(c.caseNumber)}/latest-comment`)
      .then((r) => r.json())
      .then((d) => setComment(d.comment ?? null))
      .catch(() => setComment(null))
  }, [c.caseNumber])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface border border-border rounded-2xl w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-accent shrink-0" />
            <span className="font-mono text-sm text-text-secondary">{c.caseNumber}</span>
            <span className={`text-xs font-bold px-2 py-0.5 rounded border ${sev.bg} ${sev.border} ${sev.color}`}>
              {sev.label}
            </span>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary transition-colors" role="button" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text-primary leading-relaxed">{c.summary}</p>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-bg/50 rounded-lg px-3 py-2.5">
              <p className="text-text-secondary mb-1">Status</p>
              <p className={`font-medium ${statusColor(c.status)}`}>{c.status}</p>
            </div>
            <div className="bg-bg/50 rounded-lg px-3 py-2.5">
              <p className="text-text-secondary mb-1">Days Open</p>
              <p className="font-medium text-text-primary">{c.daysOpen === 0 ? '—' : `${c.daysOpen}d`}</p>
            </div>
            {c.product && (
              <div className="col-span-2 bg-bg/50 rounded-lg px-3 py-2.5">
                <p className="text-text-secondary mb-1">Product</p>
                <p className="font-medium text-text-primary">{c.product}</p>
              </div>
            )}
          </div>

          {comment === 'loading' && (
            <div className="pt-1 border-t border-border/50">
              <div className="h-3 w-24 bg-border/40 rounded animate-pulse mt-2 mb-2" />
              <div className="h-8 bg-border/30 rounded animate-pulse" />
            </div>
          )}
          {comment && comment !== 'loading' && (
            <div className="pt-1 border-t border-border/50">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-text-secondary">Latest update</span>
                {comment.createdAt && (
                  <span className="text-xs text-text-secondary/75">· {fmtCommentDate(comment.createdAt)}</span>
                )}
                {comment.author && (
                  <span className="text-xs text-text-secondary/75">· {comment.author}</span>
                )}
              </div>
              <p className="text-xs text-text-primary/80 leading-relaxed line-clamp-4 bg-bg/40 rounded-lg px-3 py-2.5">
                {comment.body}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-border">
          <a
            href={portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full bg-accent/10 hover:bg-accent/20 border border-accent/30 text-accent text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Red Hat Portal
          </a>
        </div>
      </div>
    </div>
  )
}

// ── CasesSection ──────────────────────────────────────────────────────────────

export function CasesSection({ cases, loading }: { cases: CaseItem[]; loading: boolean }) {
  const [selected, setSelected] = useState<CaseItem | null>(null)

  function severityBg(sev: string) {
    if (sev === '1') return 'border-l-2 border-critical bg-critical/5'
    if (sev === '2') return 'border-l-2 border-warning bg-warning/5'
    return 'border-l-2 border-transparent'
  }
  function statusColor(status: string) {
    if (status.toLowerCase().includes('waiting on red hat')) return 'text-critical'
    if (status.toLowerCase().includes('waiting on customer')) return 'text-success'
    return 'text-text-secondary'
  }

  return (
    <>
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Support Cases</h2>
          {!loading && <span className="text-xs text-text-secondary">{cases.length} open</span>}
        </div>

        {loading && (
          <div className="space-y-3">
            {[1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        )}

        {!loading && cases.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-success py-1">
            <CheckCircle className="w-4 h-4" />
            No open support cases
          </div>
        )}

        {!loading && cases.length > 0 && (
          <div className="space-y-1">
            {cases.map((c) => (
              <button
                key={c.caseNumber}
                onClick={() => setSelected(c)}
                className={`w-full text-left px-3 py-2.5 rounded-lg cursor-pointer hover:brightness-125 transition-all group ${severityBg(c.severity)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-mono text-text-secondary">{c.caseNumber}</span>
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${c.severity === '1' ? 'bg-critical/20 text-critical' : c.severity === '2' ? 'bg-warning/20 text-warning' : 'bg-border/40 text-text-secondary'}`}>
                        Sev{c.severity}
                      </span>
                      {c.casesSource === 'name_match' && (
                        <span
                          className="text-xs font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          title="Matched by company name — may include related accounts"
                        >
                          name match
                        </span>
                      )}
                      {c.product && <span className="text-sm text-text-secondary min-w-0" title={c.product}>{c.product}</span>}
                    </div>
                    <p className="text-sm text-text-primary leading-snug line-clamp-3" title={c.summary}>{c.summary}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-medium ${statusColor(c.status)}`}>{c.status}</div>
                    <div className="text-xs text-text-secondary mt-0.5">{c.daysOpen}d open</div>
                    <ExternalLink className="w-3 h-3 text-text-secondary/80 group-hover:text-accent mt-1 ml-auto transition-colors" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && <CaseDetailModal c={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
