// BKL-OBS-01: Custom Playwright reporter that writes test-metrics.json after each run.
// Tracks per-spec pass/fail/skip, total duration, and per-flow pass rates for tracked flows.
// File is gitignored — posted as a CI artifact for review.

import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'

interface SpecMetric {
  title: string
  file: string
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted'
  duration: number
  retries: number
}

// Tracked flows — any spec whose title contains one of these strings is a "named flow"
// for per-flow pass-rate tracking. Extend this list as new critical flows are added.
const TRACKED_FLOWS: Record<string, string[]> = {
  'first-run-bootstrap': ['bootstrap', 'onboarding', 'wizard'],
  'brief-generation': ['brief generation', 'brief render', 'generate brief'],
  'ae-filter': ['ae filter', 'by owner', 'by ae', 'activeowner'],
  'corpus-delta': ['corpus delta', 'delta mode', 'shouldusedelta'],
  'new-user-flow': ['new-user', 'newuser', 'fresh container', 'factory'],
}

export default class MetricsReporter implements Reporter {
  private specs: SpecMetric[] = []
  private startTime = Date.now()

  onTestEnd(test: TestCase, result: TestResult): void {
    this.specs.push({
      title: test.titlePath().join(' › '),
      file: test.location.file.replace(process.cwd() + '/', ''),
      status: result.status,
      duration: result.duration,
      retries: result.retry,
    })
  }

  async onEnd(result: FullResult): Promise<void> {
    const duration = Date.now() - this.startTime
    const passed = this.specs.filter((s) => s.status === 'passed').length
    const failed = this.specs.filter((s) => s.status === 'failed').length
    const skipped = this.specs.filter((s) => s.status === 'skipped').length
    const timedOut = this.specs.filter((s) => s.status === 'timedOut').length
    const total = this.specs.length

    // Per-flow pass rates
    const flowMetrics: Record<string, { passed: number; total: number; rate: number }> = {}
    for (const [flowName, keywords] of Object.entries(TRACKED_FLOWS)) {
      const flowSpecs = this.specs.filter((s) =>
        keywords.some((kw) => s.title.toLowerCase().includes(kw))
      )
      const flowPassed = flowSpecs.filter((s) => s.status === 'passed').length
      flowMetrics[flowName] = {
        passed: flowPassed,
        total: flowSpecs.length,
        rate: flowSpecs.length ? Math.round((flowPassed / flowSpecs.length) * 100) : 100,
      }
    }

    // Flake candidates — specs that needed retries to pass
    const flakeCandidates = this.specs
      .filter((s) => s.retries > 0 && s.status === 'passed')
      .map((s) => ({ title: s.title, retries: s.retries }))

    const metrics = {
      timestamp: new Date().toISOString(),
      duration_ms: duration,
      status: result.status,
      summary: { passed, failed, skipped, timedOut, total },
      pass_rate: total ? Math.round((passed / total) * 100) : 0,
      flows: flowMetrics,
      flake_candidates: flakeCandidates,
      specs: this.specs,
    }

    const outDir = resolve(process.cwd(), 'test-results')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'test-metrics.json'), JSON.stringify(metrics, null, 2))
    console.log(
      `\n📊 test-metrics.json written — ${passed}/${total} passed, ${Object.keys(flowMetrics).length} flows tracked`
    )
  }
}
