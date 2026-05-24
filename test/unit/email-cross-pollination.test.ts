/**
 * GitHub Issue #348 — Email intelligence cross-pollination
 * Verifies that email signals include cross-referenced metadata
 * for tech-stack and competitive mentions found in email content.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { FeatureModuleRegistry } from '../../src/feature-module-registry.ts'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE = resolve(import.meta.dir, '../fixtures/email-xpoll-cache')
const originalCacheDir = process.env.CACHE_DIR

beforeAll(async () => {
  process.env.CACHE_DIR = TEST_CACHE
  mkdirSync(TEST_CACHE, { recursive: true })

  // Reset registry for isolation
  FeatureModuleRegistry._resetForTesting()
  await import('../../src/modules/emails-module.ts')
})

afterAll(() => {
  process.env.CACHE_DIR = originalCacheDir
  if (existsSync(TEST_CACHE)) rmSync(TEST_CACHE, { recursive: true })
})

function writeEmailCache(slug: string, emails: any[]) {
  writeFileSync(
    resolve(TEST_CACHE, `${slug}-emails.json`),
    JSON.stringify({ emails, cachedAt: new Date().toISOString() }),
  )
}

describe('email cross-pollination signals', () => {
  test('email mentioning a technology includes techMentions in metadata', async () => {
    writeEmailCache('acme-corp', [
      {
        subject: 'RE: Evaluating Ansible for CI/CD',
        from: 'jane@acme.com',
        date: '2026-05-20T10:00:00Z',
        classification: 'RESPONSE_NEEDED',
        snippet: 'We are currently evaluating Ansible Automation Platform for our CI/CD pipeline modernization.',
        threadId: 't1',
      },
    ])

    const mod = FeatureModuleRegistry.get('emails')
    expect(mod).toBeDefined()
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBeGreaterThan(0)
    const sig = signals[0]
    expect(sig.metadata).toBeDefined()
    expect(sig.metadata!.techMentions).toBeDefined()
    expect(sig.metadata!.techMentions).toContain('aap')
  })

  test('email mentioning a competitor includes competitiveMentions in metadata', async () => {
    writeEmailCache('acme-corp', [
      {
        subject: 'VMware migration timeline',
        from: 'bob@acme.com',
        date: '2026-05-21T09:00:00Z',
        classification: 'ACTION_REQUIRED',
        snippet: 'We need to finalize the VMware to OpenShift migration plan by Q3. Also looking at Kubernetes alternatives from AWS EKS.',
        threadId: 't2',
      },
    ])

    const mod = FeatureModuleRegistry.get('emails')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBeGreaterThan(0)
    const sig = signals[0]
    expect(sig.metadata).toBeDefined()
    expect(sig.metadata!.competitiveMentions).toBeDefined()
    expect(sig.metadata!.competitiveMentions!.length).toBeGreaterThan(0)
  })

  test('email with no tech or competitive mentions has empty arrays', async () => {
    writeEmailCache('acme-corp', [
      {
        subject: 'Meeting next Tuesday',
        from: 'carol@acme.com',
        date: '2026-05-22T08:00:00Z',
        classification: 'INFO',
        snippet: 'Just confirming our meeting next Tuesday at 2pm.',
        threadId: 't3',
      },
    ])

    const mod = FeatureModuleRegistry.get('emails')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBeGreaterThan(0)
    const sig = signals[0]
    expect(sig.metadata!.techMentions).toEqual([])
    expect(sig.metadata!.competitiveMentions).toEqual([])
  })

  test('rawRelevance is boosted when tech or competitive mentions exist', async () => {
    writeEmailCache('acme-corp', [
      {
        subject: 'Evaluating OpenShift and comparing with Tanzu',
        from: 'dave@acme.com',
        date: '2026-05-22T10:00:00Z',
        classification: 'INFO',
        snippet: 'Looking at OpenShift vs VMware Tanzu for our container platform.',
        threadId: 't4',
      },
    ])

    const mod = FeatureModuleRegistry.get('emails')
    const signals = await mod!.signals!('acme-corp')

    expect(signals.length).toBeGreaterThan(0)
    const sig = signals[0]
    // INFO emails normally get 0.4 rawRelevance, but with tech+competitive mentions should be higher
    expect(sig.rawRelevance).toBeGreaterThan(0.4)
  })
})
