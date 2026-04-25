// Feed Dashboard Reporter — pipes CTRF output into PAI test-health JSONL via AppendTestHistory.ts.
// Runs in onExit (not onEnd) to avoid race condition with ctrf reporter file writes.
// Skipped in CI — PAI tools are not available in the CI environment.

import type { Reporter } from '@playwright/test/reporter'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { execSync } from 'child_process'

const HOME = process.env.HOME || ''
const APPEND_TOOL = join(HOME, '.claude', 'PAI', 'Tools', 'AppendTestHistory.ts')

export default class FeedDashboardReporter implements Reporter {
  async onExit(): Promise<void> {
    if (process.env.CI) {
      return
    }

    const ctrfPath = resolve(process.cwd(), 'ctrf', 'ctrf-report.json')

    if (!existsSync(ctrfPath)) {
      console.log('\n📡 feed-dashboard: ctrf-report.json not found — skipping test-health append')
      return
    }

    try {
      execSync(`bun ${APPEND_TOOL} --ctrf ${ctrfPath}`, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      console.log('\n📡 feed-dashboard: test run appended to ~/.claude/MEMORY/test-health/runs.jsonl')
    } catch (err) {
      console.log(`\n📡 feed-dashboard: failed to append test history — ${String(err)}`)
    }
  }
}
