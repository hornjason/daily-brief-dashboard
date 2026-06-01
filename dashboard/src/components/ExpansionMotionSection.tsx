import { useState, useEffect } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Target,
  Shield,
  TrendingUp,
  Zap,
  ExternalLink,
  FileText,
  Users,
  Sparkles,
} from 'lucide-react'

// ── Types (mirrors motion-builder.ts) ───────────────────────────────────────

interface MotionPhase {
  id: string
  name: string
  category: 'anchor' | 'expand' | 'transform'
  urgency: 'critical' | 'high' | 'medium' | 'low'
  tactics: Array<{
    name: string
    parentTdp: string
    assets: Array<{ name: string; url: string; type: string }>
    brief?: string
  }>
  targetPersonas: string[]
  evidence: Array<{
    module: string
    fact: string
    url?: string
  }>
  estimatedTcv?: number
}

interface StrategicMotion {
  id: string
  customerSlug: string
  customerName: string
  title: string
  salesPlay?: string
  phases: MotionPhase[]
  confidence: 'high' | 'medium' | 'low'
  totalEstimatedTcv?: number
  generatedAt: string
  status: 'active' | 'dismissed' | 'pinned'
}

// ── Props ───────────────────────────────────────────────────────────────────

interface ExpansionMotionSectionProps {
  customerSlug: string
  customerName: string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORY_ICON: Record<string, typeof Shield> = {
  anchor: Shield,
  expand: TrendingUp,
  transform: Zap,
}

const CATEGORY_COLOR: Record<string, string> = {
  anchor: 'text-amber-400',
  expand: 'text-accent',
  transform: 'text-purple-400',
}

const URGENCY_STYLE: Record<string, { dot: string; text: string }> = {
  critical: { dot: 'bg-red-400', text: 'text-red-400' },
  high: { dot: 'bg-amber-400', text: 'text-amber-400' },
  medium: { dot: 'bg-accent', text: 'text-accent' },
  low: { dot: 'bg-text-secondary', text: 'text-text-secondary' },
}

const CONFIDENCE_STYLE: Record<string, string> = {
  high: 'text-green-400 bg-green-400/10 border-green-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  low: 'text-text-secondary bg-text-secondary/10 border-text-secondary/20',
}

const MODULE_LABELS: Record<string, string> = {
  subscriptions: 'Subscriptions',
  cases: 'Support Cases',
  ccsp: 'Cloud Spend',
  pipeline: 'Pipeline',
  'solution-intelligence': 'SalesHub',
  'tech-stack': 'Tech Stack',
  'product-intel': 'Product Intel',
  emails: 'Emails',
  meetings: 'Meetings',
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

// ── Phase Card ──────────────────────────────────────────────────────────────

function PhaseCard({ phase }: { phase: MotionPhase }) {
  const [expanded, setExpanded] = useState(false)
  const CategoryIcon = CATEGORY_ICON[phase.category] ?? Target
  const categoryColor = CATEGORY_COLOR[phase.category] ?? 'text-text-secondary'
  const urgencyStyle = URGENCY_STYLE[phase.urgency] ?? URGENCY_STYLE.low

  const totalAssets = phase.tactics.reduce((sum, t) => sum + t.assets.length, 0)

  return (
    <div className="border border-border/60 rounded-lg overflow-hidden">
      {/* Phase header — always visible, clickable */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-border/10 transition-colors"
      >
        <CategoryIcon className={`w-4 h-4 shrink-0 ${categoryColor}`} />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-text-primary truncate block">
            {phase.name}
          </span>
        </div>
        {/* Urgency indicator */}
        <span className={`inline-flex items-center gap-1.5 text-xs ${urgencyStyle.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${urgencyStyle.dot}`} />
          {phase.urgency}
        </span>
        {/* Tactic count */}
        <span className="text-xs text-text-secondary shrink-0">
          {phase.tactics.length} tactic{phase.tactics.length !== 1 ? 's' : ''}
        </span>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-text-secondary shrink-0" />
          : <ChevronDown className="w-4 h-4 text-text-secondary shrink-0" />}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border/40">
          {/* WHY THIS MATTERS */}
          {phase.evidence.length > 0 && (
            <div className="pt-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                Why This Matters
              </h4>
              <ul className="space-y-1.5">
                {phase.evidence.map((ev, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
                    <span className="text-xs text-text-secondary bg-border/40 px-1.5 py-0.5 rounded shrink-0 mt-0.5">
                      {MODULE_LABELS[ev.module] ?? ev.module}
                    </span>
                    <span className="flex-1">{ev.fact}</span>
                    {ev.url && (
                      <a
                        href={ev.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline shrink-0"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* WHAT WE'RE RECOMMENDING */}
          {phase.tactics.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                What We're Recommending
              </h4>
              <div className="space-y-2">
                {phase.tactics.map((tactic, i) => (
                  <div key={i} className="bg-bg-secondary/30 rounded-lg p-3 border border-border/30">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text-primary">{tactic.name}</span>
                      <span className="text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded border border-accent/20">
                        {tactic.parentTdp}
                      </span>
                    </div>
                    {tactic.brief && (
                      <p className="text-xs text-text-secondary leading-relaxed">{tactic.brief}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ASSETS */}
          {totalAssets > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                Assets
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {phase.tactics.flatMap(t => t.assets).map((asset, i) => (
                  <a
                    key={i}
                    href={asset.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-border hover:border-accent/30 hover:bg-accent/5 text-text-primary transition-colors"
                  >
                    <FileText className="w-3 h-3 text-text-secondary" />
                    {asset.name}
                    <ExternalLink className="w-2.5 h-2.5 text-text-secondary" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* WHO WE'RE TARGETING */}
          {phase.targetPersonas.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                Who We're Targeting
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {phase.targetPersonas.map((persona, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-bg-secondary/50 border border-border/40 text-text-primary"
                  >
                    <Users className="w-3 h-3 text-text-secondary" />
                    {persona}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ACTION BUTTONS (placeholders for #518, #521) */}
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs opacity-50 cursor-not-allowed"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Generate Campaigns
            </button>
            <button
              disabled
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-xs opacity-50 cursor-not-allowed"
            >
              Add to Playbook
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────────────

export function ExpansionMotionSection({ customerSlug, customerName }: ExpansionMotionSectionProps) {
  const [motion, setMotion] = useState<StrategicMotion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setMotion(null)

    fetch(`/api/customer/${encodeURIComponent(customerSlug)}/expansion-motion`)
      .then(r => {
        if (!r.ok) {
          if (r.status === 404) return null
          throw new Error(`HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(data => {
        if (data && data.phases && data.phases.length > 0) {
          setMotion(data)
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [customerSlug])

  // Gating: completely hidden when no motion or 0 phases
  if (!loading && !motion) return null
  if (error) return null

  // Loading skeleton
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <div className="flex gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    )
  }

  if (!motion) return null

  const firstPhaseUrgency = motion.phases[0]?.urgency ?? 'medium'
  const urgencyStyle = URGENCY_STYLE[firstPhaseUrgency] ?? URGENCY_STYLE.medium
  const confidenceStyle = CONFIDENCE_STYLE[motion.confidence] ?? CONFIDENCE_STYLE.low
  const totalTactics = motion.phases.reduce((sum, p) => sum + p.tactics.length, 0)

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Hero header */}
      <div className="px-5 py-4 border-b border-border/60">
        <div className="flex items-center gap-2 mb-2">
          <Target className="w-4 h-4 text-accent" />
          <h2 className="text-base font-semibold text-text-primary">Strategic Motion</h2>
        </div>
        <h3 className="text-lg font-bold text-text-primary mb-2">{motion.title}</h3>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Phase count */}
          <span className="text-xs text-text-secondary bg-border/40 px-2 py-0.5 rounded">
            {motion.phases.length} phase{motion.phases.length !== 1 ? 's' : ''}
          </span>
          {/* TDP count */}
          <span className="text-xs text-text-secondary bg-border/40 px-2 py-0.5 rounded">
            {totalTactics} TDP{totalTactics !== 1 ? 's' : ''}
          </span>
          {/* Urgency indicator */}
          <span className={`inline-flex items-center gap-1.5 text-xs ${urgencyStyle.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${urgencyStyle.dot}`} />
            {firstPhaseUrgency}
          </span>
          {/* Confidence badge */}
          <span className={`text-xs px-2 py-0.5 rounded border font-medium ${confidenceStyle}`}>
            {motion.confidence} confidence
          </span>
          {/* TCV if available */}
          {motion.totalEstimatedTcv != null && motion.totalEstimatedTcv > 0 && (
            <span className="text-xs text-text-secondary">
              Est. TCV: ${motion.totalEstimatedTcv.toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Phase cards */}
      <div className="px-5 py-4 space-y-2">
        {motion.phases.map(phase => (
          <PhaseCard key={phase.id} phase={phase} />
        ))}
      </div>
    </div>
  )
}
