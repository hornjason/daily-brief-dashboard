/**
 * Bootstrap run history — appends a record to bootstrap-history.json on each
 * AE bootstrap completion. Keeps last 50 runs per AE (rolling window).
 */
import { readFileSync, writeFileSync as writeFileSyncRaw, renameSync } from 'fs'
import { resolve } from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const HISTORY_PATH = resolve(CONFIG_DIR, 'bootstrap-history.json')

export interface BootstrapRun {
  aeName: string
  completedAt: string        // ISO timestamp
  success: boolean
  customerCount: number
  accountsFound: number      // customers with accountNumbers.length > 0
  durationMs: number
  source: 'pod' | 'single'  // was this a POD run or single-AE run
  error?: string
}

const MAX_RUNS_PER_AE = 50

function readHistory(): Record<string, BootstrapRun[]> {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function recordBootstrapRun(run: BootstrapRun): void {
  const history = readHistory()
  const key = run.aeName
  if (!history[key]) history[key] = []
  history[key].push(run)
  // Rolling window: keep last MAX_RUNS_PER_AE per AE
  if (history[key].length > MAX_RUNS_PER_AE) {
    history[key] = history[key].slice(-MAX_RUNS_PER_AE)
  }
  try {
    const tmp = HISTORY_PATH + '.tmp'
    writeFileSyncRaw(tmp, JSON.stringify(history, null, 2), { mode: 0o600 })
    renameSync(tmp, HISTORY_PATH)
  } catch (e: any) {
    console.warn('[bootstrap-history] write failed:', e.message)
  }
}

export function getBootstrapHistory(): Record<string, BootstrapRun[]> {
  return readHistory()
}
