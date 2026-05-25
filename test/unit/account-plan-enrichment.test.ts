/**
 * GitHub Issue #349 — Account plan continuous enrichment from all signal sources
 * Verifies that account plan signals include cross-referenced enrichment
 * metadata from cases, pipeline, emails, and competitive intelligence.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE = resolve(import.meta.dir, '../fixtures/acct-plan-enrich-cache')
const originalCacheDir = process.env.CACHE_DIR

beforeAll(async () => {
  process.env.CACHE_DIR = TEST_CACHE
  mkdirSync(resolve(TEST_CACHE, 'intelligence'), { recursive: true })

  FeatureModuleRegistry._resetForTesting()
  await import('../../src/modules/account-plan-module.ts')
})

afterAll(() => {
  process.env.CACHE_DIR = originalCacheDir
  if (existsSync(TEST_CACHE)) rmSync(TEST_CACHE, { recursive: true })
})

function writeAccountPlan(slug: string, content: string) {
  mkdirSync(resolve(TEST_CACHE, 'intelligence'), { recursive: true })
  writeFileSync(resolve(TEST_CACHE, 'intelligence', `${slug}-account-plan.md`), content)
}

function writeCasesCache(cases: any[]) {
  writeFileSync(resolve(TEST_CACHE, 'cases.json'), JSON.stringify({ cases }))
}

function writePipelineCache(records: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, 'pipeline-data.json'),
    JSON.stringify({ records, fetchedAt: new Date().toISOString() }),
  )
}

function writeEmailsCache(slug: string, emails: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, `${slug}-emails.json`),
    JSON.stringify({ emails, cachedAt: new Date().toISOString() }),
  )
}

describe('account plan continuous enrichment', () => {
  test('signal metadata includes enrichment summary from cases', async () => {
    writeAccountPlan('acme-corp', '# Account Plan for Acme Corp\n\n## Executive Summary\nAcme Corp is a key customer.')

    writeCasesCache([
      { caseNumber: '200001', customerName: 'Acme Corp', product: 'RHEL 9', severity: '1', status: 'Open', daysOpen: 2 },
      { caseNumber: '200002', customerName: 'Acme Corp', product: 'OCP 4.16', severity: '3', status: 'Closed', daysOpen: 5 },
      { caseNumber: '200003', customerName: 'Other Corp', product: 'RHEL 8', severity: '2', status: 'Open', daysOpen: 1 },
    ])

    const mod = FeatureModuleRegistry.get('account-plan')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBe(1)
    const sig = signals[0]
    expect(sig.metadata!.enrichment).toBeDefined()
    expect(sig.metadata!.enrichment.cases).toBeDefined()
    expect(sig.metadata!.enrichment.cases.total).toBe(2)
    expect(sig.metadata!.enrichment.cases.openSev1).toBe(1)
  })

  test('signal metadata includes enrichment summary from pipeline', async () => {
    writeAccountPlan('acme-corp', '# Account Plan for Acme Corp\n\n## Growth Strategy\nFocusing on expansion.')

    writeCasesCache([])

    writePipelineCache([
      { accountName: 'Acme Corp', oppName: 'OCP Expansion', acv: 150000, closeDate: '2026-07-01', forecastCategory: 'Commit', stage: 'Negotiate' },
      { accountName: 'Acme Corp', oppName: 'RHEL Renewal', acv: 80000, closeDate: '2026-08-01', forecastCategory: 'Best Case', stage: 'Qualify' },
      { accountName: 'Other Corp', oppName: 'Other Deal', acv: 50000, closeDate: '2026-09-01', forecastCategory: 'Pipeline', stage: 'Discover' },
    ])

    const mod = FeatureModuleRegistry.get('account-plan')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBe(1)
    const sig = signals[0]
    expect(sig.metadata!.enrichment.pipeline).toBeDefined()
    expect(sig.metadata!.enrichment.pipeline.totalOpps).toBe(2)
    expect(sig.metadata!.enrichment.pipeline.totalAcv).toBe(230000)
  })

  test('signal metadata includes enrichment summary from emails', async () => {
    writeAccountPlan('acme-corp', '# Account Plan\n\n## Relationship Status\nEngaging regularly.')

    writeCasesCache([])
    writePipelineCache([])

    writeEmailsCache('acme-corp', [
      { subject: 'Re: OCP Migration', from: 'jane@acme.com', date: '2026-05-20T10:00:00Z', classification: 'ACTION_REQUIRED' },
      { subject: 'Weekly sync', from: 'bob@acme.com', date: '2026-05-21T09:00:00Z', classification: 'INFO' },
    ])

    const mod = FeatureModuleRegistry.get('account-plan')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBe(1)
    const sig = signals[0]
    expect(sig.metadata!.enrichment.emails).toBeDefined()
    expect(sig.metadata!.enrichment.emails.total).toBe(2)
    expect(sig.metadata!.enrichment.emails.actionRequired).toBe(1)
  })

  test('rawRelevance is boosted when enrichment sources have active signals', async () => {
    writeAccountPlan('acme-corp', '# Account Plan\n\nContent here.')

    writeCasesCache([
      { caseNumber: '300001', customerName: 'Acme Corp', product: 'RHEL', severity: '1', status: 'Open', daysOpen: 1 },
    ])

    writePipelineCache([
      { accountName: 'Acme Corp', oppName: 'Big Deal', acv: 500000, closeDate: '2026-06-01', forecastCategory: 'Commit', stage: 'Close' },
    ])

    writeEmailsCache('acme-corp', [
      { subject: 'Urgent', from: 'ceo@acme.com', date: '2026-05-22T08:00:00Z', classification: 'ACTION_REQUIRED' },
    ])

    const mod = FeatureModuleRegistry.get('account-plan')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBe(1)
    // Base rawRelevance is 0.7, should be boosted with all enrichment sources active
    expect(signals[0].rawRelevance).toBeGreaterThan(0.7)
  })

  test('enrichment is empty when no external signals exist', async () => {
    writeAccountPlan('lonely-corp', '# Account Plan\n\nNo signals here.')

    // Clean up any existing caches from other tests
    writeCasesCache([])
    writePipelineCache([])

    const mod = FeatureModuleRegistry.get('account-plan')
    const signals = await mod!.signals!('lonely-corp')

    expect(signals.length).toBe(1)
    const enrich = signals[0].metadata!.enrichment
    expect(enrich.cases.total).toBe(0)
    expect(enrich.pipeline.totalOpps).toBe(0)
    expect(enrich.emails.total).toBe(0)
  })
})
