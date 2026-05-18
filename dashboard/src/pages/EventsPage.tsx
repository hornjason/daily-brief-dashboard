/**
 * EventsPage — Module page for Red Hat events
 * GitHub Issue #241, #250
 *
 * Portfolio-scoped standalone events view.
 * Shows all upcoming events with enriched descriptions + customer relevance.
 * Route: /dashboard/events
 */

import { useState, useEffect, useMemo } from 'react'
import { ModulePageShell } from '../components/ModulePageShell'
import { MapPin, Copy, Check, Loader2 } from 'lucide-react'

interface CustomerRelevance {
  matchingCustomers: string[]
  productMatches: Record<string, string[]>
}

interface RHEvent {
  name: string
  date: string
  format: 'in-person' | 'virtual' | 'hybrid'
  location: string | null
  region: string
  productTags: string[]
  registrationUrl: string | null
  description: string
  summary: string
  enrichedDescription?: string | null
  enrichedAt?: string | null
  customerRelevance?: CustomerRelevance
}

function formatEventDate(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(isoDate))
  } catch {
    return isoDate
  }
}

function getFormatBadge(format: string) {
  if (format === 'virtual') {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-health-green-bg text-health-green">
        Virtual
      </span>
    )
  } else if (format === 'hybrid') {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-health-amber-bg text-health-amber">
        Hybrid
      </span>
    )
  }
  return (
    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-accent/10 text-accent">
      In-Person
    </span>
  )
}

const REGION_OPTIONS = [
  { value: 'all', label: 'All Regions' },
  { value: 'northeast', label: 'Northeast' },
  { value: 'southeast', label: 'Southeast' },
  { value: 'central', label: 'Central' },
  { value: 'west', label: 'West' },
  { value: 'canada', label: 'Canada' },
  { value: 'national', label: 'National' },
] as const

/** Extract state abbreviation from location like "Cambridge, MA" */
function extractState(location: string | null): string | null {
  if (!location) return null
  const match = location.match(/,\s+([A-Z]{2})$/)
  return match ? match[1] : null
}

function EventsContent() {
  const [events, setEvents] = useState<RHEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [formatFilter, setFormatFilter] = useState<string>('all')
  const [productFilter, setProductFilter] = useState<string>('all')
  const [regionFilter, setRegionFilter] = useState<string>('all')

  const fetchEvents = async () => {
    setLoading(true)
    setError(null)
    try {
      // Try enriched endpoint first, fall back to basic
      let res = await fetch('/api/events/enriched')
      if (!res.ok) {
        res = await fetch('/api/events')
      }
      if (!res.ok) {
        throw new Error('Failed to fetch events')
      }
      const data = await res.json()
      setEvents(data.events ?? [])
    } catch (e: any) {
      setError(e.message || 'Failed to fetch events')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEvents()
  }, [])

  // Extract unique product tags for filter
  const allProductTags = useMemo(() => {
    const tags = new Set<string>()
    for (const event of events) {
      if (event.productTags) {
        for (const tag of event.productTags) {
          tags.add(tag)
        }
      }
    }
    return Array.from(tags).sort()
  }, [events])

  // Filter events
  const filteredEvents = useMemo(() => {
    return events.filter(event => {
      if (formatFilter !== 'all' && event.format !== formatFilter) return false
      if (productFilter !== 'all' && !event.productTags?.includes(productFilter)) return false
      if (regionFilter !== 'all' && event.region !== regionFilter) return false
      return true
    })
  }, [events, formatFilter, productFilter, regionFilter])

  const handleCopy = async (event: RHEvent, index: number) => {
    const snippet = `Red Hat Event: ${event.name}\n${event.location ?? 'Virtual'} | ${formatEventDate(event.date)}${event.registrationUrl ? `\nRegister: ${event.registrationUrl}` : ''}`
    try {
      await navigator.clipboard.writeText(snippet)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 2000)
    } catch {}
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-text-secondary animate-spin" />
          <span className="text-sm text-text-secondary">Loading events...</span>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchEvents}
            className="px-4 py-2 bg-surface-hover hover:bg-surface-active text-text-primary text-sm rounded transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center space-y-3">
          <MapPin className="w-12 h-12 text-text-secondary mx-auto" />
          <p className="text-base font-medium text-text-primary">No upcoming events</p>
          <p className="text-sm text-text-secondary max-w-md">
            Red Hat events will appear here when available. Events are fetched weekly from the NA Revenue Marketing Newsletter.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Format filter */}
        <div className="flex items-center gap-1.5">
          {['all', 'in-person', 'virtual', 'hybrid'].map(fmt => (
            <button
              key={fmt}
              onClick={() => setFormatFilter(fmt)}
              className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                formatFilter === fmt
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {fmt === 'all' ? 'All Formats' : fmt === 'in-person' ? 'In-Person' : fmt.charAt(0).toUpperCase() + fmt.slice(1)}
            </button>
          ))}
        </div>

        {/* Product filter */}
        {allProductTags.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-text-secondary mx-1">|</span>
            <button
              onClick={() => setProductFilter('all')}
              className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                productFilter === 'all'
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              All Products
            </button>
            {allProductTags.map(tag => (
              <button
                key={tag}
                onClick={() => setProductFilter(tag)}
                className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                  productFilter === tag
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border text-text-secondary hover:text-text-primary'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Region filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-text-secondary mx-1">|</span>
          {REGION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setRegionFilter(opt.value)}
              className={`text-sm px-3 py-1 rounded-full border transition-colors ${
                regionFilter === opt.value
                  ? 'border-accent bg-accent/10 text-accent font-medium'
                  : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Event cards */}
      {filteredEvents.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-text-secondary">No events match your filters.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredEvents.map((event, idx) => (
            <div
              key={`${event.name}-${event.date}-${idx}`}
              className="bg-surface/50 border border-border rounded-xl p-6 space-y-4 hover:border-border-strong transition-colors"
            >
              <h3 className="text-lg font-bold">
                {event.registrationUrl ? (
                  <a
                    href={event.registrationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {event.name}
                  </a>
                ) : (
                  <span className="text-text-primary">{event.name}</span>
                )}
              </h3>

              {/* Enriched description (Gemini-synthesized) */}
              {event.enrichedDescription ? (
                <p className="text-sm text-text-secondary leading-relaxed">
                  {event.enrichedDescription}
                </p>
              ) : event.enrichedAt === undefined && (event.summary || event.description) ? (
                /* Fallback to raw summary if enrichment hasn't run yet */
                <p className="text-sm text-text-secondary leading-relaxed">
                  {event.summary || event.description}
                </p>
              ) : !event.enrichedDescription && event.enrichedAt === null ? (
                /* Enrichment attempted but failed */
                (event.summary || event.description) ? (
                  <p className="text-sm text-text-secondary leading-relaxed">
                    {event.summary || event.description}
                  </p>
                ) : null
              ) : event.enrichedAt === undefined ? (
                /* Enrichment hasn't run — show placeholder */
                <p className="text-sm text-text-secondary/50 leading-relaxed italic">
                  Loading description...
                </p>
              ) : null}

              {/* Customer relevance pills */}
              {event.customerRelevance && event.customerRelevance.matchingCustomers.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs text-text-secondary font-medium">Relevant to:</span>
                  {event.customerRelevance.matchingCustomers.map(customerName => {
                    // Find which products matched this customer
                    const matchedProducts = Object.entries(event.customerRelevance!.productMatches)
                      .filter(([, customers]) => customers.includes(customerName))
                      .map(([product]) => product)
                    return (
                      <span
                        key={customerName}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent border border-accent/20"
                      >
                        {customerName}
                        {matchedProducts.length > 0 && (
                          <span className="text-accent/60">({matchedProducts.join(', ')})</span>
                        )}
                      </span>
                    )
                  })}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                {getFormatBadge(event.format)}
                <span className="text-xs text-text-secondary">{formatEventDate(event.date)}</span>
                {event.location && (
                  <span className="flex items-center gap-1 text-xs text-text-secondary">
                    <MapPin className="w-3 h-3" />
                    {event.location}
                    {extractState(event.location) && (
                      <span className="ml-0.5 px-1.5 py-0.5 rounded bg-surface-hover text-[10px] font-semibold text-text-secondary/70 uppercase">
                        {extractState(event.location)}
                      </span>
                    )}
                  </span>
                )}
                {event.productTags?.map((tag, i) => (
                  <span key={i} className="px-2 py-1 rounded text-xs font-medium bg-accent/10 text-accent border border-accent/30">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                <button
                  onClick={() => handleCopy(event, idx)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs text-text-secondary font-medium hover:border-border-strong hover:text-text-primary transition-colors"
                >
                  {copiedIndex === idx ? (
                    <><Check className="w-3 h-3" /> Copied</>
                  ) : (
                    <><Copy className="w-3 h-3" /> Share</>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function EventsPage() {
  return (
    <ModulePageShell
      title="Red Hat Events"
      icon="CalendarDays"
      scope="portfolio"
    >
      <EventsContent />
    </ModulePageShell>
  )
}
