/**
 * src/lib/todays-meetings.ts
 * Today's Meetings with Signal Density — Morning Brief Integration
 *
 * GitHub Issue #609 — Surface today's customer meetings with intelligence
 * density levels in the morning brief, so the seller knows which meetings
 * have rich intelligence available and which need prep.
 *
 * This is a CONSUMER of the intelligence graph — it reads graph data
 * to compute signal density per customer with meetings today.
 */

import { TOTAL_SIGNAL_TYPES } from './tactic-scorer.ts'
import type { CustomerGraph } from './intelligence-graph-types.ts'
import type { Customer } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal calendar event shape — compatible with both CalendarEvent and the
 *  lighter inline type used in buildMorningSummary. */
interface CalendarEventLike {
  title: string
  start: string
  customers?: string[]
}

export type DensityLevel = 'high' | 'medium' | 'limited'

export interface TodaysMeeting {
  customerName: string
  customerSlug: string
  meetingTitle: string
  meetingStart: string
  densityLevel: DensityLevel
  densityDetail: { populated: number; total: number }
  meetingPrepUrl: string
}

// ── Signal Density ──────────────────────────────────────────────────────────

/**
 * Categorize signal density into human-readable levels.
 * Thresholds match the tactic-scorer.ts sparse-data warning (< 4 = sparse).
 *
 * - high:    >= 8 of 12 signal types populated (strong intelligence)
 * - medium:  >= 4 of 12 signal types populated (reasonable coverage)
 * - limited: < 4 signal types populated (sparse data, may need manual prep)
 */
export function computeSignalDensityLevel(populated: number, total: number): DensityLevel {
  if (total === 0) return 'limited'
  if (populated >= 8) return 'high'
  if (populated >= 4) return 'medium'
  return 'limited'
}

/**
 * Count active (non-historical) distinct node types in a customer graph.
 * Excludes the 'customer' node type (root node, always present).
 */
function countActiveNodeTypes(graph: CustomerGraph): number {
  const nodeTypes = new Set(
    Object.values(graph.nodes)
      .filter(n => (n as any).history?.status !== 'historical')
      .map(n => n.type)
      .filter(t => t !== 'customer')
  )
  return nodeTypes.size
}

// ── Core Builder ────────────────────────────────────────────────────────────

/**
 * Build the "Today's Meetings" section for the morning summary.
 *
 * Filters calendar events to today-only, matches against known customers,
 * computes signal density from the intelligence graph, and returns
 * structured meeting data with density levels and prep links.
 *
 * @param calendarEvents - Calendar events (already fetched)
 * @param customers - Known customers
 * @param loadGraphFn - Function to load a customer's intelligence graph by slug
 * @returns Array of meetings with intelligence density, empty if no meetings today
 */
export function buildTodaysMeetings(
  calendarEvents: CalendarEventLike[],
  customers: Customer[],
  loadGraphFn: (slug: string) => CustomerGraph | null,
): TodaysMeeting[] {
  // Filter to today's events with customer matches
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date()
  todayEnd.setHours(23, 59, 59, 999)

  const customerSet = new Set(customers.map(c => c.name.toLowerCase()))

  // Cache density per customer slug to avoid re-reading graph files
  const densityCache = new Map<string, { populated: number; total: number }>()

  const toSlug = (name: string) =>
    name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '')

  const meetings: TodaysMeeting[] = []

  for (const event of calendarEvents) {
    const start = new Date(event.start)
    if (start < todayStart || start > todayEnd) continue

    // Must have customer matches
    const matchedCustomers = (event.customers ?? []).filter(c =>
      customerSet.has(c.toLowerCase())
    )
    if (matchedCustomers.length === 0) continue

    // For each matched customer, compute density and create entry
    for (const customerName of matchedCustomers) {
      const slug = toSlug(customerName)

      // Compute density (cached per slug)
      let density = densityCache.get(slug)
      if (!density) {
        const graph = loadGraphFn(slug)
        const populated = graph ? countActiveNodeTypes(graph) : 0
        density = { populated, total: TOTAL_SIGNAL_TYPES }
        densityCache.set(slug, density)
      }

      meetings.push({
        customerName,
        customerSlug: slug,
        meetingTitle: event.title,
        meetingStart: event.start,
        densityLevel: computeSignalDensityLevel(density.populated, density.total),
        densityDetail: density,
        meetingPrepUrl: `/dashboard/customer/${slug}/meeting-prep`,
      })
    }
  }

  return meetings
}
