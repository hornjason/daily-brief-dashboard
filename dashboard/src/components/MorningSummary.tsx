import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sun, AlertTriangle, Clock, ChevronDown, ChevronUp } from 'lucide-react'

interface Signal {
  customer: string
  type: string
  severity: 'critical' | 'high' | 'medium'
  text: string
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
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    fetch('/api/morning-summary')
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
  }, [])

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
          {collapsed
            ? <ChevronDown className="w-3.5 h-3.5 text-text-secondary" />
            : <ChevronUp className="w-3.5 h-3.5 text-text-secondary" />
          }
        </div>
      </button>
      {!collapsed && (
        <div className="p-5">
          {data.synthesis && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900 leading-relaxed">
              {data.synthesis}
            </div>
          )}
          {displaySignals.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-4">
              {matchingCustomers && matchingCustomers.size > 0
                ? 'No signals for selected products'
                : `All clear across ${data.customerCount} accounts`}
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
        </div>
      )}
    </div>
  )
}
