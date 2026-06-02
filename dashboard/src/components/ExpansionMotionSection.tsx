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
  Copy,
  Check,
  X,
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

interface EnrichedContact {
  persona: string
  name?: string
  email?: string
  title?: string
  linkedinUrl?: string
  source?: string
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
  enrichedContacts?: EnrichedContact[]
}

interface CampaignEmail {
  phaseId: string
  phaseName: string
  personaRole: string
  contactName?: string
  templateTier: 'executive' | 'manager'
  subject: string
  body: string
}

interface CampaignResult {
  motionTitle: string
  emails: CampaignEmail[]
  generatedAt: string
  driveUrl?: string
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

// ── Assets Section (collapsed by default, grouped by tactic) ────────────────

const INITIAL_ASSET_LIMIT = 5

function AssetsSection({
  tactics,
  totalAssets,
}: {
  tactics: MotionPhase['tactics']
  totalAssets: number
}) {
  const [assetsExpanded, setAssetsExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Group assets by tactic name
  const groupedAssets: Array<{ tacticName: string; assets: Array<{ name: string; url: string; type: string }> }> = []
  for (const tactic of tactics) {
    if (tactic.assets.length > 0) {
      groupedAssets.push({ tacticName: tactic.name, assets: tactic.assets })
    }
  }

  // Flatten for initial display limit
  const allAssets = groupedAssets.flatMap(g => g.assets.map(a => ({ ...a, tacticName: g.tacticName })))
  const visibleAssets = showAll ? allAssets : allAssets.slice(0, INITIAL_ASSET_LIMIT)

  if (totalAssets === 0) return null

  return (
    <div>
      <button
        onClick={() => setAssetsExpanded(v => !v)}
        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary hover:text-text-primary transition-colors"
      >
        <FileText className="w-3 h-3" />
        {totalAssets} asset{totalAssets !== 1 ? 's' : ''} available
        {assetsExpanded
          ? <ChevronUp className="w-3 h-3" />
          : <ChevronDown className="w-3 h-3" />}
      </button>

      {assetsExpanded && (
        <div className="mt-2 space-y-3">
          {/* Group by tactic when showing all */}
          {showAll ? (
            groupedAssets.map((group, gi) => (
              <div key={gi}>
                <span className="text-xs text-text-secondary mb-1 block">{group.tacticName}</span>
                <div className="flex flex-wrap gap-1.5">
                  {group.assets.map((asset, ai) => (
                    <a
                      key={ai}
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
            ))
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {visibleAssets.map((asset, i) => (
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
          )}

          {/* Show all toggle when more than INITIAL_ASSET_LIMIT */}
          {!showAll && allAssets.length > INITIAL_ASSET_LIMIT && (
            <button
              onClick={() => setShowAll(true)}
              className="text-xs text-accent hover:underline"
            >
              Show all {allAssets.length} assets
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Campaign Email Card ────────────────────────────────────────────────────

function CampaignEmailCard({ email }: { email: CampaignEmail }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${email.subject}\n\n${email.body}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement('textarea')
      textarea.value = `Subject: ${email.subject}\n\n${email.body}`
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const contactLabel = email.contactName ?? `(${email.personaRole})`
  const tierColor = email.templateTier === 'executive'
    ? 'text-purple-400 bg-purple-400/10 border-purple-400/20'
    : 'text-accent bg-accent/10 border-accent/20'

  return (
    <div className="border border-border/60 rounded-lg p-4 bg-bg-secondary/20">
      {/* Header: persona + tier badge */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">{contactLabel}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${tierColor}`}>
            {email.templateTier}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:border-accent/30 hover:bg-accent/5 text-text-secondary hover:text-text-primary transition-colors"
        >
          {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Subject line */}
      <div className="mb-3">
        <span className="text-xs text-text-secondary uppercase tracking-wide">Subject</span>
        <p className="text-sm text-text-primary font-medium mt-0.5">{email.subject}</p>
      </div>

      {/* Email body */}
      <div className="text-sm text-text-primary leading-relaxed whitespace-pre-wrap bg-surface/50 rounded-lg p-3 border border-border/30">
        {email.body}
      </div>
    </div>
  )
}

// ── Campaign Emails Display ────────────────────────────────────────────────

function CampaignEmailsDisplay({
  result,
  phaseId,
  onDismiss,
}: {
  result: CampaignResult
  phaseId: string
  onDismiss: () => void
}) {
  const phaseEmails = result.emails.filter(e => e.phaseId === phaseId)

  if (phaseEmails.length === 0) return null

  return (
    <div className="mt-3 border border-accent/20 rounded-lg overflow-hidden bg-surface/30">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-accent/5">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs font-semibold text-text-primary">
            {phaseEmails.length} campaign email{phaseEmails.length !== 1 ? 's' : ''} generated
          </span>
          {result.driveUrl && (
            <a
              href={result.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
              View in Drive
            </a>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="p-1 hover:bg-border/30 rounded transition-colors"
        >
          <X className="w-3.5 h-3.5 text-text-secondary" />
        </button>
      </div>

      {/* Email cards */}
      <div className="p-4 space-y-3">
        {phaseEmails.map((email, i) => (
          <CampaignEmailCard key={i} email={email} />
        ))}
      </div>
    </div>
  )
}

// ── Phase Card ──────────────────────────────────────────────────────────────

function PhaseCard({ phase, enrichedContacts, customerSlug, customerName }: { phase: MotionPhase; enrichedContacts?: EnrichedContact[]; customerSlug: string; customerName: string }) {
  const [expanded, setExpanded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatingPlaybook, setGeneratingPlaybook] = useState(false)
  const [campaignResult, setCampaignResult] = useState<CampaignResult | null>(null)
  const [campaignError, setCampaignError] = useState<string | null>(null)
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
                Recommended Tactics
              </h4>
              <div className="space-y-2">
                {phase.tactics.map((tactic, i) => (
                  <div key={i} className="bg-bg-secondary/30 rounded-lg p-3 border border-border/30">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-text-primary">{tactic.name}</span>
                      <span className="text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded border border-accent/20">
                        TDP: {tactic.parentTdp}
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

          {/* ASSETS — collapsed by default, grouped by tactic */}
          {totalAssets > 0 && (
            <AssetsSection tactics={phase.tactics} totalAssets={totalAssets} />
          )}

          {/* WHO WE'RE TARGETING */}
          {phase.targetPersonas.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">
                Target Personas
              </h4>
              <div className="space-y-1.5">
                {phase.targetPersonas.map((persona, i) => {
                  const match = enrichedContacts?.find(c => c.persona === persona)
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 text-xs px-2 py-1 rounded-lg bg-bg-secondary/50 border border-border/40 text-text-primary"
                    >
                      <Users className="w-3 h-3 text-text-secondary shrink-0" />
                      <span>{persona}</span>
                      {match ? (
                        <span className="text-accent ml-1">
                          &rarr; {match.name}{match.source ? ` (via ${match.source})` : ''}
                        </span>
                      ) : (
                        <span className="text-text-secondary ml-1 italic">(not identified)</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ACTION BUTTONS */}
          <div className="flex items-center gap-2 pt-1">
            <button
              disabled={generating}
              onClick={async () => {
                setGenerating(true)
                setCampaignError(null)
                try {
                  const res = await fetch(`/api/customer/${encodeURIComponent(customerSlug)}/expansion-motion/campaigns`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phases: [phase.id] }),
                  })
                  if (!res.ok) {
                    const errBody = await res.text().catch(() => '')
                    throw new Error(errBody || `Failed: ${res.status}`)
                  }
                  const result: CampaignResult = await res.json()
                  setCampaignResult(result)
                } catch (e: any) {
                  setCampaignError(e.message)
                } finally {
                  setGenerating(false)
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/30 text-accent text-xs transition-colors ${
                generating ? 'opacity-50 cursor-wait' : 'hover:bg-accent/20 cursor-pointer'
              }`}
            >
              <Sparkles className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'Generating...' : 'Generate Campaigns'}
            </button>
            <button
              onClick={async () => {
                setGeneratingPlaybook(true)
                try {
                  const res = await fetch(`/api/customer/${encodeURIComponent(customerName)}/playbook/generate`, { method: 'POST' })
                  if (!res.ok) throw new Error(`Failed: ${res.status}`)
                  // Playbook appears in the Playbook tab on the customer page
                  alert('Playbook generated — view it in the Playbook tab')
                } catch (e: any) {
                  alert(`Playbook generation failed: ${e.message}`)
                } finally {
                  setGeneratingPlaybook(false)
                }
              }}
              disabled={generatingPlaybook}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs transition-colors ${
                generatingPlaybook ? 'opacity-50 cursor-wait text-text-secondary' : 'text-text-primary hover:bg-border/20 cursor-pointer'
              }`}
            >
              {generatingPlaybook ? 'Generating...' : 'Add to Playbook'}
            </button>
          </div>

          {/* Campaign error message */}
          {campaignError && (
            <div className="mt-2 flex items-center gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              <span>Campaign generation failed: {campaignError}</span>
              <button onClick={() => setCampaignError(null)} className="ml-auto">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Campaign emails display */}
          {campaignResult && (
            <CampaignEmailsDisplay
              result={campaignResult}
              phaseId={phase.id}
              onDismiss={() => setCampaignResult(null)}
            />
          )}
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
        const m = data?.motion
        if (m && m.phases && m.phases.length > 0) {
          setMotion(m)
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
        <h3 className="text-lg font-bold text-text-primary mb-2">{motion.salesPlay ? `Sales Play: ${motion.title}` : motion.title}</h3>
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
          <PhaseCard key={phase.id} phase={phase} enrichedContacts={motion.enrichedContacts} customerSlug={customerSlug} customerName={customerName} />
        ))}
      </div>
    </div>
  )
}
