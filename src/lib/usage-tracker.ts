/**
 * src/lib/usage-tracker.ts — Material usage telemetry (#586)
 * Append-only JSONL log of material link clicks, campaign sends, meeting prep views.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const TELEMETRY_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'usage-telemetry')
const LOG_FILE = resolve(TELEMETRY_DIR, 'material-usage.jsonl')

interface UsageEvent {
  type: 'material_click' | 'campaign_send' | 'meeting_prep' | 'playbook_view'
  materialUrl?: string
  materialTitle?: string
  customerSlug: string
  context?: string  // e.g., 'motion-tactic', 'campaign-email', 'meeting-prep'
  timestamp: string
}

export function trackUsage(event: UsageEvent): void {
  try {
    if (!existsSync(TELEMETRY_DIR)) mkdirSync(TELEMETRY_DIR, { recursive: true })
    appendFileSync(LOG_FILE, JSON.stringify(event) + '\n')
  } catch (e: any) {
    console.warn(`[usage-tracker] Failed to log event:`, e?.message)
  }
}

export function getUsageSummary(): { totalEvents: number; byType: Record<string, number>; topMaterials: Array<{url: string, count: number}> } {
  try {
    if (!existsSync(LOG_FILE)) return { totalEvents: 0, byType: {}, topMaterials: [] }
    const lines = readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean)
    const events = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

    const byType: Record<string, number> = {}
    const materialCounts: Record<string, number> = {}

    for (const e of events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
      if (e.materialUrl) materialCounts[e.materialUrl] = (materialCounts[e.materialUrl] ?? 0) + 1
    }

    const topMaterials = Object.entries(materialCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([url, count]) => ({ url, count }))

    return { totalEvents: events.length, byType, topMaterials }
  } catch {
    return { totalEvents: 0, byType: {}, topMaterials: [] }
  }
}
