import { Clock } from 'lucide-react'
import { useApi } from '../hooks/useApi'

interface DeltaChange {
  section: string
  summary: string
  details: string[]
}

interface DeltaResponse {
  hasPrevious: boolean
  message?: string
  lastBriefDate?: string
  changes?: DeltaChange[]
}

/** Classify a detail line for coloring the triangle marker */
function detailSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase()
  if (/sev\s*[12]|critical|expired|declined|lost|risk|churn/i.test(lower)) return 'negative'
  if (/increased|grew|won|closed.*won|upgrade|new meeting|scheduled/i.test(lower)) return 'positive'
  return 'neutral'
}

const SENTIMENT_COLORS = {
  positive: 'text-health-green',
  negative: 'text-health-red',
  neutral: 'text-health-amber',
}

export default function TemporalDeltaSection({ customerName }: { customerName: string }) {
  const { data, loading, error } = useApi<DeltaResponse>(
    `/api/customer/${encodeURIComponent(customerName)}/temporal-delta`
  )

  if (loading) {
    return (
      <div className="rounded-lg border border-border-primary bg-surface-primary px-4 py-3 animate-pulse">
        <div className="h-4 w-48 bg-border-primary/40 rounded" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border border-border-primary bg-surface-primary px-4 py-3">
        <p className="text-xs text-text-secondary">Unable to load change history</p>
      </div>
    )
  }

  // No previous brief
  if (!data.hasPrevious) {
    return (
      <div className="rounded-lg border border-border-primary bg-surface-primary px-4 py-3 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-text-secondary" />
        <p className="text-xs text-text-secondary">{data.message}</p>
      </div>
    )
  }

  // Has previous but no changes
  if (!data.changes?.length) {
    return (
      <div className="rounded-lg border border-border-primary bg-surface-primary px-4 py-3 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-text-secondary" />
        <p className="text-xs text-text-secondary">No changes since {data.lastBriefDate}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border-primary bg-surface-primary overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border-primary/60 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-text-secondary" />
        <h3 className="text-xs font-medium text-text-primary">
          What Changed Since {data.lastBriefDate}
        </h3>
        <span className="ml-auto text-[10px] text-text-secondary bg-border-primary/30 px-1.5 py-0.5 rounded-full">
          {data.changes.length} {data.changes.length === 1 ? 'section' : 'sections'}
        </span>
      </div>
      <ul className="divide-y divide-border-primary/40">
        {data.changes.map((ch, i) => (
          <li key={i} className="px-4 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-text-primary">{ch.section}</span>
              <span className="text-[11px] text-text-secondary">{ch.summary}</span>
            </div>
            {ch.details && ch.details.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-1">
                {ch.details.map((detail, j) => {
                  const sentiment = detailSentiment(detail)
                  return (
                    <li key={j} className="flex items-start gap-1.5 text-[11px] text-text-primary/80">
                      <span className={`${SENTIMENT_COLORS[sentiment]} shrink-0 leading-none mt-px`} aria-hidden="true">&#x25B2;</span>
                      <span>{detail}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
