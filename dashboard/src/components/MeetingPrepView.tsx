/**
 * MeetingPrepView — Pre-meeting intelligence brief component (#600)
 *
 * Displays an instant, scannable pre-meeting brief built from the
 * customer's intelligence graph. Shows talking points, recent changes,
 * evidence to cite, and relevant materials.
 *
 * Data source: GET /api/customer/:slug/meeting-prep-brief
 */

import { useState, useEffect } from 'react'
import {
  MessageSquare,
  Activity,
  ClipboardList,
  Paperclip,
  Users,
  BarChart3,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  X,
  NotebookPen,
  CheckCircle2,
  Clock,
  Send,
} from 'lucide-react'

interface MeetingPrepBrief {
  customerName: string
  accountTeam: Array<{ role: string; name: string }>
  signalDensity: { populated: number; total: number; pct: number }
  talkingPoints: string[]
  recentChanges: Array<{
    type: 'new' | 'historical' | 'reactivated'
    description: string
    when: string
  }>
  topEvidence: Array<{ fact: string; recency: string }>
  materials: Array<{ title: string; url: string; type: string }>
  lastDebrief?: {
    notes: string
    nextSteps?: string
    createdAt: string
  }
  generatedAt: string
}

interface MeetingDebrief {
  customerSlug: string
  notes: string
  talkingPointsUsed?: string[]
  nextSteps?: string
  createdAt: string
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const hours = ms / (1000 * 60 * 60)
  if (hours < 1) return `${Math.round(ms / 60000)}m ago`
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days <= 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function ChangeTypeBadge({ type }: { type: string }) {
  const config: Record<string, { label: string; className: string }> = {
    new: { label: 'New', className: 'bg-success/10 text-success border-success/20' },
    reactivated: { label: 'Reactivated', className: 'bg-accent/10 text-accent border-accent/20' },
    historical: { label: 'Went Inactive', className: 'bg-warning/10 text-warning border-warning/20' },
  }
  const c = config[type] ?? config.new
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${c.className}`}>
      {c.label}
    </span>
  )
}

function MaterialTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    cheatsheet: 'bg-blue-50 text-blue-700 border-blue-200',
    deck: 'bg-purple-50 text-purple-700 border-purple-200',
    lab: 'bg-green-50 text-green-700 border-green-200',
    demo: 'bg-orange-50 text-orange-700 border-orange-200',
    doc: 'bg-gray-50 text-gray-700 border-gray-200',
    service: 'bg-pink-50 text-pink-700 border-pink-200',
  }
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors[type] ?? colors.doc}`}>
      {type}
    </span>
  )
}

function DensityBar({ populated, total, pct }: { populated: number; total: number; pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: pct >= 70 ? 'var(--color-success)' : pct >= 40 ? 'var(--color-warning)' : 'var(--color-critical)',
          }}
        />
      </div>
      <span className="text-xs text-text-secondary tabular-nums whitespace-nowrap">
        {populated}/{total} ({pct}%)
      </span>
    </div>
  )
}

export function MeetingPrepView({
  customerName,
  onClose,
}: {
  customerName: string
  onClose?: () => void
}) {
  const [brief, setBrief] = useState<MeetingPrepBrief | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Debrief form state (#611)
  const [showDebrief, setShowDebrief] = useState(false)
  const [debriefNotes, setDebriefNotes] = useState('')
  const [debriefNextSteps, setDebriefNextSteps] = useState('')
  const [debriefSubmitting, setDebriefSubmitting] = useState(false)
  const [debriefSuccess, setDebriefSuccess] = useState(false)
  const [debriefError, setDebriefError] = useState<string | null>(null)
  const [previousDebriefs, setPreviousDebriefs] = useState<MeetingDebrief[]>([])

  const fetchDebriefs = async () => {
    try {
      const res = await fetch(
        `/api/customer/${encodeURIComponent(customerName)}/meeting-debriefs`,
      )
      if (res.ok) {
        const data = await res.json()
        setPreviousDebriefs(data.debriefs ?? [])
      }
    } catch {
      // Non-critical — silently fail
    }
  }

  const submitDebrief = async () => {
    if (!debriefNotes.trim()) return
    setDebriefSubmitting(true)
    setDebriefError(null)
    try {
      const res = await fetch(
        `/api/customer/${encodeURIComponent(customerName)}/meeting-debrief`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            notes: debriefNotes,
            nextSteps: debriefNextSteps || undefined,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setDebriefError(body.error ?? `Failed to save (${res.status})`)
        return
      }
      setDebriefSuccess(true)
      setDebriefNotes('')
      setDebriefNextSteps('')
      fetchDebriefs()
    } catch (e: any) {
      setDebriefError(e.message ?? 'Network error')
    } finally {
      setDebriefSubmitting(false)
    }
  }

  const fetchBrief = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/customer/${encodeURIComponent(customerName)}/meeting-prep-brief`,
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? `Failed to load brief (${res.status})`)
        return
      }
      const data = await res.json()
      setBrief(data)
    } catch (e: any) {
      setError(e.message ?? 'Network error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchBrief()
    fetchDebriefs()
  }, [customerName])

  if (loading) {
    return (
      <div className="p-8 flex flex-col items-center justify-center gap-3 min-h-[400px]">
        <RefreshCw className="w-6 h-6 animate-spin text-accent" />
        <p className="text-sm text-text-secondary">
          Building pre-meeting brief...
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8 flex flex-col items-center justify-center gap-3 min-h-[300px]">
        <AlertTriangle className="w-6 h-6 text-warning" />
        <p className="text-sm text-text-secondary">{error}</p>
        <button
          onClick={fetchBrief}
          className="text-xs text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!brief) return null

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-lg font-bold text-text-primary">
            Meeting Prep: {brief.customerName}
          </h2>
          <div className="flex items-center gap-4 mt-1.5 text-xs text-text-secondary">
            {brief.accountTeam.length > 0 && (
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" />
                {brief.accountTeam.map(m => `${m.role}: ${m.name}`).join(' | ')}
              </span>
            )}
          </div>
          <div className="mt-2 w-64">
            <div className="flex items-center gap-1.5 mb-1">
              <BarChart3 className="w-3.5 h-3.5 text-text-secondary" />
              <span className="text-xs text-text-secondary font-medium">Signal Coverage</span>
            </div>
            <DensityBar {...brief.signalDensity} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchBrief}
            className="p-1.5 rounded hover:bg-hover transition-colors"
            title="Refresh brief"
          >
            <RefreshCw className="w-4 h-4 text-text-secondary" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-hover transition-colors"
              title="Close"
            >
              <X className="w-4 h-4 text-text-secondary" />
            </button>
          )}
        </div>
      </div>

      {/* Talking Points */}
      <section className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <MessageSquare className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
            Talking Points
          </h3>
        </div>
        <div className="space-y-2">
          {brief.talkingPoints.map((point, i) => (
            <div
              key={i}
              className="bg-accent/5 border border-accent/15 rounded-lg px-4 py-3"
            >
              <p className="text-sm text-text-primary leading-relaxed">
                <span className="font-semibold text-accent mr-2">{i + 1}.</span>
                {point}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Recent Changes */}
      {brief.recentChanges.length > 0 && (
        <section className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
              Recent Changes
            </h3>
          </div>
          <div className="space-y-1.5">
            {brief.recentChanges.map((change, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-sm py-1.5 px-3 rounded bg-surface-alt/50"
              >
                <ChangeTypeBadge type={change.type} />
                <span className="text-text-primary flex-1">{change.description}</span>
                <span className="text-text-secondary text-xs whitespace-nowrap">
                  {formatRelativeTime(change.when)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Evidence to Cite */}
      {brief.topEvidence.length > 0 && (
        <section className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <ClipboardList className="w-4 h-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
              Evidence to Cite
            </h3>
          </div>
          <div className="space-y-1">
            {brief.topEvidence.map((ev, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm py-1.5 px-3 rounded bg-surface-alt/50"
              >
                <span className="text-text-primary">{ev.fact}</span>
                {ev.recency && (
                  <span className="text-text-secondary text-xs whitespace-nowrap ml-3">
                    {ev.recency}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Materials */}
      {brief.materials.length > 0 && (
        <section className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Paperclip className="w-4 h-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
              Materials
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {brief.materials.map((mat, i) => (
              <a
                key={i}
                href={mat.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border bg-surface hover:bg-hover transition-colors"
              >
                <MaterialTypeBadge type={mat.type} />
                <span className="text-text-primary">{mat.title}</span>
                <ExternalLink className="w-3 h-3 text-text-secondary" />
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Previous Meeting Notes (#611) */}
      {(brief.lastDebrief || previousDebriefs.length > 0) && (
        <section className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-text-secondary" />
            <h3 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
              Previous Meeting Notes
            </h3>
          </div>
          <div className="space-y-2">
            {(previousDebriefs.length > 0 ? previousDebriefs : brief.lastDebrief ? [brief.lastDebrief] : []).map((d, i) => (
              <div
                key={i}
                className="bg-surface-alt/50 border border-border rounded-lg px-4 py-3"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-text-secondary">
                    {formatRelativeTime(d.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
                  {d.notes}
                </p>
                {d.nextSteps && (
                  <div className="mt-2 pt-2 border-t border-border/50">
                    <span className="text-xs font-medium text-text-secondary">Next steps: </span>
                    <span className="text-sm text-text-primary">{d.nextSteps}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Debrief Form (#611) */}
      <section className="mb-5 border-t border-border pt-5">
        {!showDebrief ? (
          <button
            onClick={() => { setShowDebrief(true); setDebriefSuccess(false) }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-surface hover:bg-hover transition-colors text-sm text-text-primary"
          >
            <NotebookPen className="w-4 h-4 text-accent" />
            How did it go?
          </button>
        ) : debriefSuccess ? (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 border border-success/20">
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span className="text-sm text-success">Debrief saved. It will inform your next meeting prep.</span>
            <button
              onClick={() => { setShowDebrief(false); setDebriefSuccess(false) }}
              className="ml-auto text-xs text-text-secondary hover:underline"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <NotebookPen className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-text-primary">Post-Meeting Debrief</h3>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                What did you learn?
              </label>
              <textarea
                value={debriefNotes}
                onChange={(e) => setDebriefNotes(e.target.value)}
                placeholder="Key observations, customer reactions, discovered needs..."
                rows={3}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1">
                Next steps (optional)
              </label>
              <textarea
                value={debriefNextSteps}
                onChange={(e) => setDebriefNextSteps(e.target.value)}
                placeholder="Follow-up actions, commitments made..."
                rows={2}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-y"
              />
            </div>
            {debriefError && (
              <div className="text-xs text-critical">{debriefError}</div>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={submitDebrief}
                disabled={debriefSubmitting || !debriefNotes.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {debriefSubmitting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                Save Debrief
              </button>
              <button
                onClick={() => setShowDebrief(false)}
                className="text-xs text-text-secondary hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Footer: generation timestamp */}
      <div className="text-xs text-text-secondary/60 mt-6 text-right">
        Generated {formatRelativeTime(brief.generatedAt)}
      </div>
    </div>
  )
}
