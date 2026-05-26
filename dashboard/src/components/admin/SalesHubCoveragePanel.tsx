import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, CheckCircle2, AlertCircle, XCircle, ChevronDown, ChevronRight } from 'lucide-react'
import { formatRelTime } from '../../lib/format'

// ── Types ──────────────────────────────────────────────────────────────────────

interface TdpCoverage {
  name: string
  sections: {
    customerWins: boolean
    whatToSay: boolean
    whatToShare: boolean
    whatToShow: boolean
    services: boolean
    cheatsheet: boolean
    customerDeck: boolean
  }
  sectionCount: number
  tacticCount: number
  extractedContentCount: number
}

interface PlayCoverage {
  name: string
  sections: {
    customerLens: boolean
    realWorldExamples: boolean
    emailTemplate: boolean
    discoveryQuestions: boolean
    introPitchDeck: boolean
    personas: boolean
  }
  sectionCount: number
}

interface KnowledgeCoverage {
  tdps: TdpCoverage[]
  plays: PlayCoverage[]
  totalLinkedDocs: number
  docsWithExtractedContent: number
  overallCoveragePercent: number
  scrapedAt: string | null
}

// ── Section label maps ─────────────────────────────────────────────────────────

const TDP_SECTION_LABELS: Record<string, string> = {
  customerWins: 'Customer Wins',
  whatToSay: 'What to Say',
  whatToShare: 'What to Share',
  whatToShow: 'What to Show',
  services: 'Services',
  cheatsheet: 'Cheatsheet',
  customerDeck: 'Customer Deck',
}

const PLAY_SECTION_LABELS: Record<string, string> = {
  customerLens: 'Customer Lens',
  realWorldExamples: 'Real World Examples',
  emailTemplate: 'Email Template',
  discoveryQuestions: 'Discovery Questions',
  introPitchDeck: 'Intro Pitch Deck',
  personas: 'Personas',
}

// ── Status icon helper ─────────────────────────────────────────────────────────

function StatusIcon({ filled, total }: { filled: number; total: number }) {
  if (filled === total) return <CheckCircle2 className="w-4 h-4 text-green-400" />
  if (filled === 0) return <XCircle className="w-4 h-4 text-red-400" />
  return <AlertCircle className="w-4 h-4 text-yellow-400" />
}

// ── Coverage bar ───────────────────────────────────────────────────────────────

function CoverageBar({ filled, total }: { filled: number; total: number }) {
  const pct = total > 0 ? Math.round((filled / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-400 w-8 text-right">{filled}/{total}</span>
      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            pct === 100 ? 'bg-green-500' : pct > 50 ? 'bg-yellow-500' : 'bg-red-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── TDP Row (expandable) ───────────────────────────────────────────────────────

function TdpRow({ tdp }: { tdp: TdpCoverage }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-750 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />}
        <StatusIcon filled={tdp.sectionCount} total={7} />
        <span className="text-sm text-gray-200 flex-1 truncate">{tdp.name}</span>
        <div className="w-32">
          <CoverageBar filled={tdp.sectionCount} total={7} />
        </div>
      </button>
      {expanded && (
        <div className="px-4 py-2 bg-gray-850 border-t border-gray-700">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {Object.entries(tdp.sections).map(([key, filled]) => (
              <div key={key} className="flex items-center gap-1.5 text-xs">
                {filled
                  ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                  : <XCircle className="w-3 h-3 text-gray-600 shrink-0" />
                }
                <span className={filled ? 'text-gray-300' : 'text-gray-500'}>
                  {TDP_SECTION_LABELS[key] ?? key}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-gray-500">
            {tdp.tacticCount} tactic{tdp.tacticCount !== 1 ? 's' : ''} &middot; {tdp.extractedContentCount} with extracted content
          </div>
        </div>
      )}
    </div>
  )
}

// ── Play Row (expandable) ──────────────────────────────────────────────────────

function PlayRow({ play }: { play: PlayCoverage }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800 hover:bg-gray-750 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />}
        <StatusIcon filled={play.sectionCount} total={6} />
        <span className="text-sm text-gray-200 flex-1 truncate">{play.name}</span>
        <div className="w-32">
          <CoverageBar filled={play.sectionCount} total={6} />
        </div>
      </button>
      {expanded && (
        <div className="px-4 py-2 bg-gray-850 border-t border-gray-700">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {Object.entries(play.sections).map(([key, filled]) => (
              <div key={key} className="flex items-center gap-1.5 text-xs">
                {filled
                  ? <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                  : <XCircle className="w-3 h-3 text-gray-600 shrink-0" />
                }
                <span className={filled ? 'text-gray-300' : 'text-gray-500'}>
                  {PLAY_SECTION_LABELS[key] ?? key}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Collapsible section ────────────────────────────────────────────────────────

function CoverageSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-gray-100 transition-colors mb-2"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {label} ({count})
      </button>
      {open && <div className="space-y-1.5 ml-1">{children}</div>}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

export function SalesHubCoveragePanel() {
  const [coverage, setCoverage] = useState<KnowledgeCoverage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadCoverage = useCallback(async () => {
    try {
      const res = await fetch('/api/saleshub/coverage')
      if (res.ok) {
        setCoverage(await res.json())
      }
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadCoverage() }, [loadCoverage])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await fetch('/api/saleshub/refresh', { method: 'POST' })
      // Wait a moment then reload coverage
      setTimeout(() => {
        loadCoverage()
        setRefreshing(false)
      }, 2000)
    } catch {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700 animate-pulse">
        <div className="h-4 bg-gray-700 rounded w-48 mb-4" />
        <div className="h-3 bg-gray-700 rounded w-32" />
      </div>
    )
  }

  if (!coverage || (coverage.tdps.length === 0 && coverage.plays.length === 0)) {
    return (
      <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
        <div className="text-sm text-gray-400">No SalesHub knowledge base found. Run a SalesHub scrape to populate coverage data.</div>
      </div>
    )
  }

  const pctColor = coverage.overallCoveragePercent >= 80
    ? 'text-green-400'
    : coverage.overallCoveragePercent >= 50
      ? 'text-yellow-400'
      : 'text-red-400'

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <span className={`text-xl font-bold ${pctColor}`}>{coverage.overallCoveragePercent}%</span>
            <span className="text-sm text-gray-400 ml-1.5">Complete</span>
          </div>
          {coverage.scrapedAt && (
            <span className="text-xs text-gray-500">
              Last scraped: {formatRelTime(coverage.scrapedAt)}
            </span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="px-2.5 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh SalesHub
        </button>
      </div>

      {/* Knowledge summary */}
      <div className="px-4 py-2 border-b border-gray-700/50 text-xs text-gray-400 space-y-0.5">
        <div className="flex items-center gap-3">
          <span className="text-gray-200 font-medium">{coverage.tdps.length} TDPs</span>
          <span className="text-gray-600">&middot;</span>
          <span className="text-gray-200 font-medium">{coverage.plays.length} Sales Plays</span>
          {coverage.tdps.length > 0 && (
            <>
              <span className="text-gray-600">&middot;</span>
              <span className="text-gray-200 font-medium">
                {coverage.tdps.reduce((sum, t) => sum + t.tacticCount, 0)} Tactics
              </span>
            </>
          )}
        </div>
        {coverage.totalLinkedDocs > 0 && (
          <div className="text-gray-500">
            {coverage.docsWithExtractedContent} of {coverage.totalLinkedDocs} linked documents have extracted content
          </div>
        )}
      </div>

      {/* Coverage details */}
      <div className="p-4 space-y-4">
        {coverage.tdps.length > 0 && (
          <CoverageSection label="Technology Decision Points" count={coverage.tdps.length}>
            {coverage.tdps.map(tdp => <TdpRow key={tdp.name} tdp={tdp} />)}
          </CoverageSection>
        )}

        {coverage.plays.length > 0 && (
          <CoverageSection label="Sales Plays" count={coverage.plays.length}>
            {coverage.plays.map(play => <PlayRow key={play.name} play={play} />)}
          </CoverageSection>
        )}
      </div>
    </div>
  )
}
