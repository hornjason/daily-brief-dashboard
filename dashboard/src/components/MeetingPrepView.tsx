/**
 * MeetingPrepView — Pre-meeting intelligence brief component (#600)
 *
 * Displays an instant, scannable pre-meeting brief built from the
 * customer's intelligence graph. Shows talking points, recent changes,
 * evidence to cite, and relevant materials.
 *
 * Draft Email (#610): "Draft Email" button generates a pre-meeting
 * outreach email from talking points + evidence via Gemini.
 *
 * Data source: GET /api/customer/:slug/meeting-prep-brief
 * Email draft: POST /api/customer/:slug/meeting-prep-email
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
  Mail,
  Check,
  Copy,
  Loader2,
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
  generatedAt: string
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

/** Draft Email panel — generates and displays a pre-meeting email */
function DraftEmailPanel({
  customerName,
  talkingPoints,
  evidence,
}: {
  customerName: string
  talkingPoints: string[]
  evidence: Array<{ fact: string; recency: string }>
}) {
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generateEmail = async () => {
    setLoading(true)
    setError(null)
    setEmail(null)
    try {
      const res = await fetch(
        `/api/customer/${encodeURIComponent(customerName)}/meeting-prep-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            talkingPoints,
            evidence: evidence.map(e => e.fact),
            customerName,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? `Failed to generate email (${res.status})`)
        return
      }
      const data = await res.json()
      setEmail(data.email)
    } catch (e: any) {
      setError(e.message ?? 'Network error')
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = async () => {
    if (!email) return
    try {
      await navigator.clipboard.writeText(email)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = email
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Not yet generated — show the button
  if (!email && !loading && !error) {
    return (
      <button
        onClick={generateEmail}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-accent/30 bg-accent/5 text-accent hover:bg-accent/10 transition-colors"
      >
        <Mail className="w-4 h-4" />
        Draft Email
      </button>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-border bg-surface-alt/50">
        <Loader2 className="w-4 h-4 animate-spin text-accent" />
        <span className="text-sm text-text-secondary">Drafting email...</span>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-critical/20 bg-critical/5">
        <AlertTriangle className="w-4 h-4 text-critical" />
        <span className="text-sm text-critical flex-1">{error}</span>
        <button
          onClick={generateEmail}
          className="text-xs text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  // Email generated — show preview with copy button
  return (
    <div className="rounded-lg border border-accent/20 bg-accent/5 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-accent/15 bg-accent/10">
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-accent" />
          <span className="text-sm font-medium text-accent">Draft Email</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyToClipboard}
            className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded border border-accent/30 bg-white/80 text-accent hover:bg-white transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                Copy
              </>
            )}
          </button>
          <button
            onClick={generateEmail}
            className="p-1 rounded hover:bg-accent/10 transition-colors"
            title="Regenerate"
          >
            <RefreshCw className="w-3.5 h-3.5 text-accent" />
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <pre className="text-sm text-text-primary whitespace-pre-wrap font-sans leading-relaxed">
          {email}
        </pre>
      </div>
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
        {/* Draft Email button — after talking points (#610) */}
        {brief.talkingPoints.length > 0 && (
          <div className="mt-4">
            <DraftEmailPanel
              customerName={brief.customerName}
              talkingPoints={brief.talkingPoints}
              evidence={brief.topEvidence}
            />
          </div>
        )}
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

      {/* Footer: generation timestamp */}
      <div className="text-xs text-text-secondary/60 mt-6 text-right">
        Generated {formatRelativeTime(brief.generatedAt)}
      </div>
    </div>
  )
}
