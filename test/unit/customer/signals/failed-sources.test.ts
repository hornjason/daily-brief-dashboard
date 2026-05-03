// BKL-ARCH-23: failed-sources renderer — self-closing tag with count="0".

import { describe, it, expect } from 'bun:test'
import { renderFailedSources } from '../../../../src/customer/signals/failed-sources.ts'
import { makeCtx } from './_helpers.ts'
import type { ScraperStatusMap } from '../../../../src/scraper-status-store.ts'

function statusMap(overrides: Partial<ScraperStatusMap> = {}): ScraperStatusMap {
  const base = { state: 'fresh', lastRun: null, lastSuccess: '2026-05-01T00:00:00.000Z', lastError: null, recordCount: 0, durationMs: 0, updatedAt: '', consecutiveFailures: 0 } as const
  return {
    'rh-cases':    { ...base },
    'supportable': { ...base },
    'ccsp':        { ...base },
    'sf-pipeline': { ...base },
    ...overrides,
  } as ScraperStatusMap
}

describe('renderFailedSources', () => {
  it('emits self-closing tag with count="0" when scraper failed and bundle has no data', () => {
    const status = statusMap({
      'rh-cases': { state: 'failed', lastRun: null, lastSuccess: '2026-04-30T00:00:00.000Z', lastError: 'boom', recordCount: 0, durationMs: 0, updatedAt: '', consecutiveFailures: 1 },
    })
    const xml = renderFailedSources([null, null, null, null, null, null, null], status, makeCtx())
    expect(xml).toContain('<source type="support_cases" status="scraper_failed" last_success="2026-04-30T00:00:00.000Z" count="0" />')
  })

  it('does NOT emit failed tag when scraper failed but bundle has data', () => {
    const status = statusMap({
      'rh-cases': { state: 'failed', lastRun: null, lastSuccess: null, lastError: 'boom', recordCount: 0, durationMs: 0, updatedAt: '', consecutiveFailures: 1 },
    })
    const casesBundle = { kind: 'cases' as const, status: { syncedDate: '', staleness: 'ok' as const, lastSuccess: null, lastError: null }, items: [{ caseNumber: 'C1', summary: '', status: '', severity: '2', accountNumber: '1', daysOpen: 1 }] }
    const xml = renderFailedSources([null, casesBundle, null, null, null, null, null], status, makeCtx())
    expect(xml).not.toContain('<source type="support_cases"')
  })

  it('emits last_success="never" when scraper has no prior success', () => {
    const status = statusMap({
      'sf-pipeline': { state: 'failed', lastRun: null, lastSuccess: null, lastError: 'boom', recordCount: 0, durationMs: 0, updatedAt: '', consecutiveFailures: 1 },
    })
    const xml = renderFailedSources([null, null, null, null, null, null, null], status, makeCtx())
    expect(xml).toContain('<source type="pipeline" status="scraper_failed" last_success="never" count="0" />')
  })
})
