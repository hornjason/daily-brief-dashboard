/**
 * Bootstrap run history — appends a record to bootstrap-history.json on each
 * AE bootstrap completion. Keeps last 50 runs per AE (rolling window).
 */
import { readFileSync } from 'fs'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { resolve } from 'path'
import { CONFIG_DIR } from './lib/paths.ts'

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
    writeJsonAtomic(HISTORY_PATH, history)
  } catch (e: any) {
    console.warn('[bootstrap-history] write failed:', e.message)
  }
}

export function getBootstrapHistory(): Record<string, BootstrapRun[]> {
  return readHistory()
}
