// ── R05: Historical Metric Snapshots + Sparkline Data Pipeline ──────────────
// Captures daily KPI snapshots from cached data sources and stores up to 90 days
// of history for sparkline rendering on the dashboard.

import { readFileSync, writeFileSync as writeFileSyncRaw, renameSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(process.env.DATA_DIR ?? 'data', 'cache')
const HISTORY_PATH = join(CACHE_DIR, 'kpi-history.json')
const MAX_DAYS = 90

export interface DailySnapshot {
  date: string  // ISO date string YYYY-MM-DD
  metrics: {
    totalCases: number
    sev1Cases: number
    sev2Cases: number
    openRenewals: number  // subscriptions expiring within 90 days
    totalSubscriptions: number
    cloudAcv: number  // total ACV from CCSP
    pipelineTotal: number  // total pipeline ACV
    pipelineCount: number  // number of pipeline opportunities
    customerCount: number
    meetingsToday?: number     // BKL-G11: daily meeting count
    meetingsThisWeek?: number  // BKL-G11: weekly meeting count
  }
}

export interface KPIHistory {
  snapshots: DailySnapshot[]
  lastSnapshotDate: string | null
}

export function readHistory(): KPIHistory {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'))
  } catch {
    return { snapshots: [], lastSnapshotDate: null }
  }
}

/**
 * Capture a daily snapshot from the current cache state.
 * Reads directly from cache files rather than taking parameters —
 * this keeps the caller simple and ensures we always snapshot what's actually cached.
 */
export function captureSnapshot(customerCount: number, meetingsToday?: number, meetingsThisWeek?: number): DailySnapshot {
  const today = new Date().toISOString().slice(0, 10)

  // ── Cases (cases.json) ──────────────────────────────────────────────────
  let totalCases = 0
  let sev1Cases = 0
  let sev2Cases = 0
  try {
    const casesData = JSON.parse(readFileSync(join(CACHE_DIR, 'cases.json'), 'utf-8'))
    const cases: Array<{ severity: string }> = casesData.cases ?? []
    totalCases = cases.length
    sev1Cases = cases.filter(c => c.severity === '1').length
    sev2Cases = cases.filter(c => c.severity === '2').length
  } catch { /* cache file may not exist yet */ }

  // ── Subscriptions (per-customer *-sheets.json) ──────────────────────────
  let openRenewals = 0
  let totalSubscriptions = 0
  try {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() + 90)
    const cutoffStr = cutoff.toISOString().slice(0, 10)

    const files = readdirSync(CACHE_DIR).filter((f: string) => f.endsWith('-sheets.json'))
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8'))
        const rows: Array<{ endDate?: string; status?: string }> = data.rows ?? []
        totalSubscriptions += rows.length
        for (const row of rows) {
          if (!row.endDate) continue
          // endDate format: "DD-MMM-YYYY" e.g. "04-MAY-2026"
          const parsed = parseSubscriptionDate(row.endDate)
          if (parsed && parsed <= cutoffStr && (row.status === 'Active' || !row.status)) {
            openRenewals++
          }
        }
      } catch { /* skip malformed files */ }
    }
  } catch { /* cache dir may not exist yet */ }

  // ── CCSP (ccsp-data.json) ───────────────────────────────────────────────
  let cloudAcv = 0
  try {
    const ccspData = JSON.parse(readFileSync(join(CACHE_DIR, 'ccsp-data.json'), 'utf-8'))
    const records: Array<{ acvPlus?: number }> = ccspData.records ?? []
    cloudAcv = records.reduce((sum, r) => sum + (r.acvPlus ?? 0), 0)
  } catch { /* cache file may not exist yet */ }

  // ── Pipeline (pipeline-data.json) ───────────────────────────────────────
  let pipelineTotal = 0
  let pipelineCount = 0
  try {
    const pipeData = JSON.parse(readFileSync(join(CACHE_DIR, 'pipeline-data.json'), 'utf-8'))
    const records: Array<{ acv?: number }> = pipeData.records ?? []
    pipelineCount = records.length
    pipelineTotal = records.reduce((sum, r) => sum + (r.acv ?? 0), 0)
  } catch { /* cache file may not exist yet */ }

  return {
    date: today,
    metrics: {
      totalCases,
      sev1Cases,
      sev2Cases,
      openRenewals,
      totalSubscriptions,
      cloudAcv: Math.round(cloudAcv * 100) / 100,
      pipelineTotal: Math.round(pipelineTotal * 100) / 100,
      pipelineCount,
      customerCount,
      meetingsToday: meetingsToday ?? 0,
      meetingsThisWeek: meetingsThisWeek ?? 0,
    },
  }
}

/**
 * Parse Supportable date format "DD-MMM-YYYY" (e.g. "04-MAY-2026") to ISO date "YYYY-MM-DD".
 * Returns null if unparseable.
 */
function parseSubscriptionDate(dateStr: string): string | null {
  const months: Record<string, string> = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
  }
  const parts = dateStr.split('-')
  if (parts.length !== 3) return null
  const [day, mon, year] = parts
  const mm = months[mon?.toUpperCase()]
  if (!mm || !year || !day) return null
  return `${year}-${mm}-${day.padStart(2, '0')}`
}

export function writeSnapshot(snapshot: DailySnapshot): void {
  const history = readHistory()

  // Replace today's snapshot if it exists, otherwise append
  const idx = history.snapshots.findIndex(s => s.date === snapshot.date)
  if (idx >= 0) {
    history.snapshots[idx] = snapshot
  } else {
    history.snapshots.push(snapshot)
  }

  // Prune entries older than MAX_DAYS
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - MAX_DAYS)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  history.snapshots = history.snapshots.filter(s => s.date >= cutoffStr)
  history.lastSnapshotDate = snapshot.date

  // Sort chronologically
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date))

  // Atomic write with mode 0o600
  mkdirSync(CACHE_DIR, { recursive: true })
  const tmpPath = HISTORY_PATH + '.tmp'
  writeFileSyncRaw(tmpPath, JSON.stringify(history, null, 2), { mode: 0o600 })
  renameSync(tmpPath, HISTORY_PATH)
}

/**
 * Get last N days of history for sparkline display.
 * Returns snapshots sorted chronologically (oldest first).
 */
export function getRecentHistory(days = 30): DailySnapshot[] {
  const history = readHistory()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  return history.snapshots
    .filter(s => s.date >= cutoffStr)
    .sort((a, b) => a.date.localeCompare(b.date))
}
