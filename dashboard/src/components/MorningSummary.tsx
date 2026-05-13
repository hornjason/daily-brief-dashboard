import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun, AlertTriangle, Clock, ChevronDown, ChevronUp, FileText } from 'lucide-react'

/** Lightweight inline markdown renderer for constrained AI output.
 *  Handles: **bold**, ## headings, - bullets, and paragraphs. */
function RenderMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let listItems: React.ReactNode[] = []
  let key = 0

  const flushList = () => {
    if (listItems.length > 0) {
      elements.push(<ul key={key++} className="list-disc list-inside space-y-1 mb-3">{listItems}</ul>)
      listItems = []
    }
  }

  const renderInline = (line: string): React.ReactNode => {
    // Split on **bold** markers
    const parts = line.split(/(\*\*[^*]+\*\*)/)
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} className="text-text-primary font-semibold">{part.slice(2, -2)}</strong>
      }
      return part
    })
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) { flushList(); continue }

    if (trimmed.startsWith('## ')) {
      flushList()
      elements.push(
        <h3 key={key++} className="text-sm font-bold text-accent mt-3 mb-1.5 first:mt-0">{trimmed.slice(3)}</h3>
      )
    } else if (trimmed.startsWith('- ')) {
      listItems.push(<li key={key++} className="text-sm text-text-secondary leading-relaxed">{renderInline(trimmed.slice(2))}</li>)
    } else {
      flushList()
      elements.push(<p key={key++} className="text-sm text-text-secondary leading-relaxed mb-2">{renderInline(trimmed)}</p>)
    }
  }
  flushList()
  return <>{elements}</>
}

interface Signal {
  customer: string
  type: string
  severity: 'critical' | 'high' | 'medium'
  text: string
}

interface NewsHighlight {
  customerName: string
  headline: string
  summary: string
  significanceScore: number
  sourceUrl: string
}

interface MorningSummaryData {
  signals: Signal[]
  summary: string
  customerCount: number
  synthesis?: string
}

interface MorningSummaryProps {
  /** Customer names whose accounts match the selected product filter */
  matchingCustomers?: Set<string>
}

export default function MorningSummary({ matchingCustomers }: MorningSummaryProps = {}) {
  const navigate = useNavigate()
  const [data, setData] = useState<MorningSummaryData | null>(null)
  const [newsHighlights, setNewsHighlights] = useState<NewsHighlight[]>([])
  // BKL-UX-morning-min: Start expanded by default per REG-UX115-01.
  // Auto-collapse once data loads if signals > 3 to reduce visual noise on load.
  const [collapsed, setCollapsed] = useState(false)
  const [showBriefModal, setShowBriefModal] = useState(false)

  useEffect(() => {
    fetch('/api/morning-summary')
      .then(r => r.json())
      .then((d: MorningSummaryData) => {
        setData(d)
        // Auto-collapse when signals are many to reduce visual noise
        if (d.signals.length > 3) setCollapsed(true)
      })
      .catch(() => {})
  }, [])

  // Fetch news highlights
  useEffect(() => {
    fetch('/api/news/highlights')
      .then(r => r.ok ? r.json() : { highlights: [] })
      .then(data => setNewsHighlights(data.highlights || []))
      .catch(() => {})
  }, [])

  const briefPreview = useMemo(() => {
    if (!data?.synthesis) return ''
    // Strip markdown formatting for the preview
    const plain = data.synthesis.replace(/[#*\-]/g, '').replace(/\s+/g, ' ').trim()
    return plain.length > 60 ? plain.slice(0, 57) + '...' : plain
  }, [data?.synthesis])

  /** BKL-PVIEW-08: Extract compact bullet outline from synthesis for collapsed state.
   *  Pulls bold customer names + signal labels from bullet lines. */
  const compactBullets = useMemo(() => {
    if (!data?.synthesis) return []
    const bullets: Array<{ customer: string; label: string }> = []
    for (const line of data.synthesis.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('- ')) continue
      // Extract **CustomerName** and the following short label
      const boldMatch = trimmed.match(/\*\*([^*]+)\*\*/)
      if (!boldMatch) continue
      const customer = boldMatch[1]
      // Get the text after the bold name up to the first period or end of line
      const afterBold = trimmed.slice(trimmed.indexOf('**', trimmed.indexOf('**') + 2) + 2).trim()
      // Strip leading punctuation (dash, colon, etc.)
      const cleaned = afterBold.replace(/^[\s:—–\-]+/, '').trim()
      // Take just the first clause (up to period, semicolon, or comma-separated detail)
      const label = cleaned.split(/[.;]/)[0]?.trim() || ''
      if (label) bullets.push({ customer, label: label.length > 50 ? label.slice(0, 47) + '...' : label })
    }
    return bullets
  }, [data?.synthesis])

  if (!data) return null

  // LOG-05: Filter signals to matching customers when product filter is active
  const displaySignals = matchingCustomers && matchingCustomers.size > 0
    ? data.signals.filter(s => matchingCustomers.has(s.customer))
    : data.signals

  const severityBar: Record<string, string> = {
    critical: 'bg-health-red',
    high: 'bg-health-amber',
    medium: 'bg-accent',
  }
  const severityIcon: Record<string, typeof AlertTriangle> = {
    critical: AlertTriangle,
    high: Clock,
    medium: Sun,
  }

  return (
    <div id="section-morning" data-section="section-morning" className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="w-full px-5 py-3.5 flex items-center justify-between border-b border-border hover:bg-surface-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sun className="w-4 h-4 text-accent" aria-hidden="true" />
          <h3 className="text-base font-semibold text-text-primary">Morning Summary</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">{data.summary}</span>
          {data.synthesis && (
            <span
              className="relative group inline-flex items-center gap-1 px-2 py-0.5 bg-accent/15 text-accent text-xs rounded-full cursor-pointer hover:bg-accent/25 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                if (collapsed) {
                  setShowBriefModal(!showBriefModal)
                } else {
                  // Scroll to synthesis section
                  document.querySelector('#section-morning .leading-relaxed')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                }
              }}
              title={briefPreview}
            >
              <FileText className="w-3 h-3" />
              Today's Brief
            </span>
          )}
          {collapsed
            ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
            : <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
          }
        </div>
      </button>
      {/* BKL-PVIEW-08: Compact bullet outline when collapsed */}
      {collapsed && compactBullets.length > 0 && !showBriefModal && (
        <div className="px-5 py-2 border-t border-border">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {compactBullets.map((b, i) => (
              <span key={i} className="text-xs text-text-secondary">
                <span className="font-medium text-text-primary">{b.customer}</span>
                {' '}
                <span className="text-text-secondary/70">{b.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {/* Brief modal when collapsed */}
      {collapsed && showBriefModal && data.synthesis && (
        <div className="px-5 py-3 border-t border-border">
          <div className="p-3 bg-surface-hover border border-border rounded-lg leading-relaxed">
            <RenderMarkdown text={data.synthesis} />
          </div>
        </div>
      )}
      {!collapsed && (
        <div className="p-5">
          {data.synthesis && (
            <div className="mb-4 p-3 bg-surface-hover border border-border rounded-lg leading-relaxed">
              <RenderMarkdown text={data.synthesis} />
            </div>
          )}
          {displaySignals.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-4">
              {matchingCustomers && matchingCustomers.size > 0
                ? 'No signals for selected products'
                : `All clear across ${data.customerCount} account${data.customerCount !== 1 ? 's' : ''}`}
            </p>
          ) : (
            <div className="space-y-2">
              {displaySignals.map((s, i) => {
                const Icon = severityIcon[s.severity]
                return (
                  <button
                    key={i}
                    onClick={() => navigate(`/dashboard/customer/${encodeURIComponent(s.customer)}`)}
                    className="w-full flex items-start gap-3 text-left rounded-lg px-2 py-1.5 -mx-2 cursor-pointer hover:bg-border/20 transition-colors"
                  >
                    <div className={`w-0.5 self-stretch rounded-full ${severityBar[s.severity]}`} />
                    <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                      s.severity === 'critical' ? 'text-health-red'
                        : s.severity === 'high' ? 'text-health-amber'
                        : 'text-accent'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-text-primary">{s.customer}</span>
                      <span className="text-sm text-text-secondary"> &mdash; {s.text}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
          {/* News Highlights Section */}
          {newsHighlights.length > 0 && (
            <div className="mt-6 pt-4 border-t border-border">
              <h3 className="text-amber-400 font-bold text-sm mb-3">News</h3>
              <ul className="space-y-3">
                {newsHighlights.map((item, i) => (
                  <li key={i} className="text-sm">
                    <div className="mb-1">
                      <strong className="text-text-primary">{item.customerName}</strong>
                      <span className="text-text-secondary"> — {item.headline}</span>
                    </div>
                    <div className="text-xs text-zinc-500 leading-relaxed">{item.summary}</div>
                    {item.sourceUrl && (
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-accent hover:text-accent/80 underline mt-1 inline-block"
                      >
                        Source
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
