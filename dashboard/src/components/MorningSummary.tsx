import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun, AlertTriangle, Clock, ChevronDown, ChevronUp, FileText, Lightbulb } from 'lucide-react'
import { RecommendationCard, signalToRecommendation, type RecommendationCardProps } from './RecommendationCard'

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

interface MeetingNewsItem {
  headline: string
  summary: string
  sourceUrl: string
  relevantCustomer: string
  relevantProduct: string
  publishedDate: string
}

interface ProductRelease {
  product: string
  version: string
  gaDate: string
}

interface RedHatIntelligence {
  meetingNews: MeetingNewsItem[]
  releases: ProductRelease[]
  events: Array<{
    name: string
    location: string
    date: string
    nearCustomers: string[]
  }>
}

interface MorningSummaryData {
  signals: Signal[]
  summary: string
  customerCount: number
  synthesis?: string
  redHatIntelligence?: RedHatIntelligence
}

interface MorningSummaryProps {
  /** Customer names whose accounts match the selected product filter */
  matchingCustomers?: Set<string>
}

export default function MorningSummary({ matchingCustomers }: MorningSummaryProps = {}) {
  const navigate = useNavigate()
  const [data, setData] = useState<MorningSummaryData | null>(null)
  const [newsHighlights, setNewsHighlights] = useState<NewsHighlight[]>([])
  // #225: Persist collapse state and active tab in localStorage
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('ms-collapsed')
    return saved ? JSON.parse(saved) : false  // default expanded
  })
  const [showBriefModal, setShowBriefModal] = useState(false)
  // #216: Internal tab state for Today | Alerts | Recommendations | Intelligence
  const [activeTab, setActiveTab] = useState<'today' | 'alerts' | 'recommendations' | 'intelligence'>(() => {
    const saved = localStorage.getItem('ms-active-tab')
    return (saved as 'today' | 'alerts' | 'recommendations' | 'intelligence') || 'today'
  })
  // Severity group expand state for Alerts tab (Critical expanded by default)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['critical']))

  useEffect(() => {
    fetch('/api/morning-summary')
      .then(r => r.json())
      .then((d: MorningSummaryData) => {
        setData(d)
        // BKL-UX-morning-min: Start expanded by default per user request
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

  // #484: Fetch top recommendations across priority customers
  const [topRecommendations, setTopRecommendations] = useState<Array<{ customer: string; rec: RecommendationCardProps }>>([])
  useEffect(() => {
    // Get the top 3 priority customers (those with critical/high signals) and fetch their recommendations
    if (!data?.signals?.length) return
    const priorityCustomers = [...new Set(
      data.signals
        .filter(s => s.severity === 'critical' || s.severity === 'high')
        .map(s => s.customer)
    )].slice(0, 5)

    if (priorityCustomers.length === 0) return

    Promise.all(
      priorityCustomers.map(customer =>
        fetch(`/api/customer/${encodeURIComponent(customer)}/signals/debug`)
          .then(r => r.ok ? r.json() : { signals: [] })
          .then(debugData => {
            const recSignals = (debugData.signals ?? [])
              .filter((s: any) => s.source === 'recommended-actions' && s.type === 'recommendation')
              .sort((a: any, b: any) => (b.metadata?.triggerSignalCount ?? 0) - (a.metadata?.triggerSignalCount ?? 0))
            const topRec = recSignals[0]
            return topRec ? { customer, rec: signalToRecommendation(topRec) } : null
          })
          .catch(() => null)
      )
    ).then(results => {
      const valid = results.filter((r): r is { customer: string; rec: RecommendationCardProps } => r !== null)
      setTopRecommendations(valid.slice(0, 3))
    })
  }, [data?.signals])

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

  // LOG-05: Filter signals to matching customers when product filter is active
  const displaySignals = data && matchingCustomers && matchingCustomers.size > 0
    ? data.signals.filter(s => matchingCustomers.has(s.customer))
    : data?.signals ?? []

  // #216: Group signals by severity for Alerts tab (must be before early return — React hooks rule)
  const signalsBySeverity = useMemo(() => {
    const groups: Record<'critical' | 'high' | 'medium', Signal[]> = {
      critical: [],
      high: [],
      medium: []
    }
    displaySignals.forEach(s => groups[s.severity].push(s))
    return groups
  }, [displaySignals])

  if (!data) return null

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

  // Toggle severity group expansion
  const toggleGroup = (severity: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(severity)) {
        next.delete(severity)
      } else {
        next.add(severity)
      }
      return next
    })
  }

  return (
    <div id="section-morning" data-section="section-morning" className="bg-surface border border-border rounded-xl overflow-hidden">
      <button
        onClick={() => {
          const next = !collapsed
          setCollapsed(next)
          localStorage.setItem('ms-collapsed', JSON.stringify(next))
        }}
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
        <>
          {/* #216: Tab bar */}
          <div className="flex gap-1 px-6 py-2 border-b border-border/40">
            {(['today', 'alerts', 'recommendations', 'intelligence'] as const).map(tab => {
              const count = tab === 'alerts'
                ? signalsBySeverity.critical.length + signalsBySeverity.high.length
                : tab === 'recommendations'
                ? topRecommendations.length
                : undefined
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab)
                    localStorage.setItem('ms-active-tab', tab)
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                    activeTab === tab
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-secondary hover:text-text-primary hover:bg-border/20'
                  }`}
                >
                  {tab === 'today' ? 'Today' : tab === 'alerts' ? 'Alerts' : tab === 'recommendations' ? 'Actions' : 'Customer News'}
                  {count !== undefined && count > 0 && (
                    <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
                      tab === 'alerts' ? 'bg-health-red/20 text-health-red' : 'bg-emerald-500/20 text-emerald-400'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Tab content area */}
          <div className="p-5">
            {/* Today Tab */}
            {activeTab === 'today' && (
              <div>
                {data.synthesis ? (
                  <div className="p-3 bg-surface-hover border border-border rounded-lg leading-relaxed">
                    <RenderMarkdown text={data.synthesis} />
                  </div>
                ) : (
                  <p className="text-sm text-text-secondary text-center py-4">
                    No priority items today
                  </p>
                )}
              </div>
            )}

            {/* Alerts Tab */}
            {activeTab === 'alerts' && (
              <div className="space-y-3">
                {displaySignals.length === 0 ? (
                  <p className="text-sm text-text-secondary text-center py-4">
                    {matchingCustomers && matchingCustomers.size > 0
                      ? 'No signals for selected products'
                      : `All clear across ${data.customerCount} account${data.customerCount !== 1 ? 's' : ''}`}
                  </p>
                ) : (
                  <>
                    {/* Critical Group */}
                    {signalsBySeverity.critical.length > 0 && (
                      <div className="bg-health-red/10 border-l-4 border-health-red rounded-lg">
                        <button
                          onClick={() => toggleGroup('critical')}
                          className="w-full flex items-center justify-between p-3"
                        >
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-health-red" />
                            <span className="text-sm font-semibold text-text-primary">CRITICAL</span>
                            <span className="text-xs text-text-secondary">({signalsBySeverity.critical.length})</span>
                          </div>
                          {expandedGroups.has('critical') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {expandedGroups.has('critical') && (
                          <div className="px-3 pb-3 space-y-2">
                            {signalsBySeverity.critical.map((s, i) => (
                              <button
                                key={i}
                                onClick={() => navigate(`/dashboard/customer/${encodeURIComponent(s.customer)}`)}
                                className="w-full flex items-start gap-3 text-left rounded-lg px-2 py-1.5 -mx-2 cursor-pointer hover:bg-border/20 transition-colors"
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm font-medium text-text-primary">{s.customer}</span>
                                  <span className="text-sm text-text-secondary"> — {s.text}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* High Group */}
                    {signalsBySeverity.high.length > 0 && (
                      <div className="bg-health-amber/10 border-l-4 border-health-amber rounded-lg">
                        <button
                          onClick={() => toggleGroup('high')}
                          className="w-full flex items-center justify-between p-3"
                        >
                          <div className="flex items-center gap-2">
                            <Clock className="w-4 h-4 text-health-amber" />
                            <span className="text-sm font-semibold text-text-primary">HIGH</span>
                            <span className="text-xs text-text-secondary">({signalsBySeverity.high.length})</span>
                          </div>
                          {expandedGroups.has('high') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {expandedGroups.has('high') && (
                          <div className="px-3 pb-3 space-y-2">
                            {signalsBySeverity.high.map((s, i) => (
                              <button
                                key={i}
                                onClick={() => navigate(`/dashboard/customer/${encodeURIComponent(s.customer)}`)}
                                className="w-full flex items-start gap-3 text-left rounded-lg px-2 py-1.5 -mx-2 cursor-pointer hover:bg-border/20 transition-colors"
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm font-medium text-text-primary">{s.customer}</span>
                                  <span className="text-sm text-text-secondary"> — {s.text}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Medium Group */}
                    {signalsBySeverity.medium.length > 0 && (
                      <div className="bg-accent/10 border-l-4 border-accent rounded-lg">
                        <button
                          onClick={() => toggleGroup('medium')}
                          className="w-full flex items-center justify-between p-3"
                        >
                          <div className="flex items-center gap-2">
                            <Sun className="w-4 h-4 text-accent" />
                            <span className="text-sm font-semibold text-text-primary">MEDIUM</span>
                            <span className="text-xs text-text-secondary">({signalsBySeverity.medium.length})</span>
                          </div>
                          {expandedGroups.has('medium') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {expandedGroups.has('medium') && (
                          <div className="px-3 pb-3 space-y-2">
                            {signalsBySeverity.medium.map((s, i) => (
                              <button
                                key={i}
                                onClick={() => navigate(`/dashboard/customer/${encodeURIComponent(s.customer)}`)}
                                className="w-full flex items-start gap-3 text-left rounded-lg px-2 py-1.5 -mx-2 cursor-pointer hover:bg-border/20 transition-colors"
                              >
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm font-medium text-text-primary">{s.customer}</span>
                                  <span className="text-sm text-text-secondary"> — {s.text}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Recommendations Tab (#484) */}
            {activeTab === 'recommendations' && (
              <div className="space-y-3">
                {topRecommendations.length === 0 ? (
                  <div className="text-center py-6 space-y-2">
                    <Lightbulb className="w-6 h-6 text-text-secondary mx-auto" />
                    <p className="text-sm text-text-secondary">
                      No recommendations yet — signals are building across your accounts
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-text-secondary">
                      Top recommended actions from your priority accounts
                    </p>
                    {topRecommendations.map(({ customer, rec }, i) => (
                      <div key={i}>
                        <div className="text-xs font-semibold text-text-primary mb-1">{customer}</div>
                        <RecommendationCard {...rec} />
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* Intelligence Tab */}
            {activeTab === 'intelligence' && (
              <div className="space-y-4">
                {data.redHatIntelligence ? (
                  <>
                    {/* Customer News grouped by customer */}
                    {data.redHatIntelligence.meetingNews.length > 0 && (
                      <div className="space-y-4">
                        {Object.entries(
                          data.redHatIntelligence.meetingNews.reduce((groups, item) => {
                            const customer = item.relevantCustomer || 'General'
                            if (!groups[customer]) groups[customer] = []
                            groups[customer].push(item)
                            return groups
                          }, {} as Record<string, typeof data.redHatIntelligence.meetingNews>)
                        ).map(([customer, items]) => (
                          <div key={customer}>
                            <h4 className="text-sm font-semibold text-text-primary mb-2">{customer} ({items.length})</h4>
                            <div className="space-y-2 pl-3 border-l-2 border-border">
                              {items.map((item, i) => (
                                <div key={i} className="text-sm">
                                  <span className="font-medium text-text-primary">{item.headline}</span>
                                  <div className="text-xs text-text-secondary leading-relaxed mt-0.5">{item.summary?.slice(0, 150)}{item.summary?.length > 150 ? '...' : ''}</div>
                                  {item.sourceUrl && !item.sourceUrl.includes('vertexaisearch.cloud.google.com') && (
                                    <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:text-accent/80 underline">
                                      Read Article →
                                    </a>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Product Releases This Month */}
                    {data.redHatIntelligence.releases.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium text-text-primary mb-2">Product Releases This Month</h4>
                        <ul className="space-y-1">
                          {data.redHatIntelligence.releases.map((item, i) => (
                            <li key={i} className="text-sm text-text-secondary">
                              <span className="font-medium text-text-primary">{item.product} {item.version}</span>
                              {' — '}
                              {new Date(item.gaDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                              {' (GA)'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Events Near Your Customers */}
                    {data.redHatIntelligence.events.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium text-text-primary mb-2">Events Near Your Customers</h4>
                        <div className="space-y-2">
                          {data.redHatIntelligence.events.map((item, i) => (
                            <div key={i} className="text-sm text-text-secondary">
                              <div className="font-medium text-text-primary">{item.name}</div>
                              <div className="text-xs">
                                {item.location} • {new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </div>
                              {item.nearCustomers.length > 0 && (
                                <div className="text-xs text-accent">Near: {item.nearCustomers.join(', ')}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-text-secondary text-center py-4">
                    No Red Hat Intelligence available
                  </p>
                )}

                {/* Legacy news highlights removed — replaced by meetingNews above */}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
