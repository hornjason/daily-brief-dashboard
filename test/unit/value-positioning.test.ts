/**
 * Value Positioning — Unit Tests
 * GitHub Issue #264 — Proactive Value Positioning Tool
 *
 * Tests the core value positioning logic:
 * 1. Cache read/write for positioning briefs
 * 2. Signal assembly from multiple sources
 * 3. Module registration with FeatureModuleRegistry
 * 4. API route behavior (cached vs generate)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { resolve } from 'path'

const TEST_CACHE_DIR = resolve(import.meta.dir, '../fixtures/value-positioning-test-cache')
const TEST_CONFIG_DIR = resolve(import.meta.dir, '../fixtures/value-positioning-test-config')

// ── Helpers ────────────────────────────────────────────────────────────────

function setupTestDirs() {
  mkdirSync(resolve(TEST_CACHE_DIR, 'intelligence'), { recursive: true })
  mkdirSync(resolve(TEST_CACHE_DIR, 'value-maps'), { recursive: true })
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
}

function cleanupTestDirs() {
  try { rmSync(TEST_CACHE_DIR, { recursive: true, force: true }) } catch {}
  try { rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }) } catch {}
}

function writeTestIntelligence(slug: string, data: any) {
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'intelligence', `${slug}.json`),
    JSON.stringify(data),
  )
}

function writeTestAccountPlan(slug: string, content: string) {
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'intelligence', `${slug}-account-plan.md`),
    `<!-- Generated: 2026-01-01T00:00:00Z -->\n\n${content}`,
  )
}

function writeTestCases(cases: any[]) {
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'cases.json'),
    JSON.stringify({ cases }),
  )
}

function writeTestPipeline(records: any[]) {
  writeFileSync(
    resolve(TEST_CACHE_DIR, 'pipeline-data.json'),
    JSON.stringify({ records }),
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Value Positioning', () => {
  beforeEach(() => {
    setupTestDirs()
    process.env.CACHE_DIR = TEST_CACHE_DIR
    process.env.CONFIG_DIR = TEST_CONFIG_DIR
  })

  afterEach(() => {
    cleanupTestDirs()
    delete process.env.CACHE_DIR
    delete process.env.CONFIG_DIR
  })

  describe('Cache operations', () => {
    test('readCachedPositioning returns null when no cache exists', async () => {
      const { readCachedPositioning } = await import('../../src/value-positioning.ts')
      const result = readCachedPositioning('acme-corp')
      expect(result).toBeNull()
    })

    test('writePositioningCache and readCachedPositioning roundtrip', async () => {
      const { readCachedPositioning, writePositioningCache } = await import('../../src/value-positioning.ts')

      const data = {
        customerName: 'Acme Corp',
        sections: {
          currentState: 'Acme is a large enterprise...',
          solutionAlignment: [
            { solution: 'OpenShift', alignment: 'Container platform for modernization', proofPoints: ['Case study X'] },
          ],
          artOfPossible: 'With OpenShift AI, Acme could...',
          nextSteps: ['Schedule technical workshop', 'POC scoping call'],
        },
        signalSummary: {
          intelligenceAvailable: true,
          accountPlanAvailable: true,
          casesCount: 5,
          pipelineCount: 2,
          valueMapProducts: ['ocp', 'rhel'],
        },
        generatedAt: '2026-01-01T00:00:00Z',
        driveUrl: '',
      }

      writePositioningCache('acme-corp', data)
      const read = readCachedPositioning('acme-corp')
      expect(read).not.toBeNull()
      expect(read!.customerName).toBe('Acme Corp')
      expect(read!.sections.solutionAlignment).toHaveLength(1)
      expect(read!.sections.nextSteps).toHaveLength(2)
    })

    test('writePositioningCache creates intelligence dir if missing', async () => {
      rmSync(resolve(TEST_CACHE_DIR, 'intelligence'), { recursive: true, force: true })
      const { writePositioningCache } = await import('../../src/value-positioning.ts')

      const data = {
        customerName: 'Test',
        sections: {
          currentState: 'test',
          solutionAlignment: [],
          artOfPossible: 'test',
          nextSteps: [],
        },
        signalSummary: {
          intelligenceAvailable: false,
          accountPlanAvailable: false,
          casesCount: 0,
          pipelineCount: 0,
          valueMapProducts: [],
        },
        generatedAt: new Date().toISOString(),
        driveUrl: '',
      }

      writePositioningCache('test-co', data)
      expect(existsSync(resolve(TEST_CACHE_DIR, 'intelligence', 'test-co-value-positioning.json'))).toBe(true)
    })
  })

  describe('Signal assembly', () => {
    test('assemblePositioningContext collects intelligence cache', async () => {
      writeTestIntelligence('acme-corp', {
        company: 'Acme Corp is a Fortune 500 company focused on digital transformation.',
        industry: 'Technology sector with cloud-native adoption trends.',
        products: { rhel: { status: 'active' } },
      })

      const { assemblePositioningContext } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('acme-corp', 'Acme Corp')

      expect(ctx.intelligence).not.toBeNull()
      expect(ctx.intelligence!.company).toContain('Fortune 500')
    })

    test('assemblePositioningContext collects account plan', async () => {
      writeTestAccountPlan('acme-corp', '# Account Plan\n## Whitespace Map\nOCP: High opportunity')

      const { assemblePositioningContext } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('acme-corp', 'Acme Corp')

      expect(ctx.accountPlan).not.toBeNull()
      expect(ctx.accountPlan).toContain('Whitespace Map')
    })

    test('assemblePositioningContext collects cases enrichment', async () => {
      writeTestCases([
        { customerName: 'Acme Corp', severity: '1', status: 'Open', caseNumber: '00001234' },
        { customerName: 'Acme Corp', severity: '2', status: 'Closed', caseNumber: '00001235' },
        { customerName: 'Other Co', severity: '1', status: 'Open', caseNumber: '00001236' },
      ])

      const { assemblePositioningContext } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('acme-corp', 'Acme Corp')

      expect(ctx.cases.total).toBe(2)
      expect(ctx.cases.openSev1).toBe(1)
    })

    test('assemblePositioningContext collects pipeline data', async () => {
      writeTestPipeline([
        { accountName: 'Acme Corp', oppName: 'OCP expansion', acv: 50000, forecastCategory: 'Pipeline' },
        { accountName: 'Other Co', oppName: 'RHEL deal', acv: 10000, forecastCategory: 'Pipeline' },
      ])

      const { assemblePositioningContext } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('acme-corp', 'Acme Corp')

      expect(ctx.pipeline.totalOpps).toBe(1)
      expect(ctx.pipeline.totalAcv).toBe(50000)
    })

    test('assemblePositioningContext returns empty when no data exists', async () => {
      const { assemblePositioningContext } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('nonexistent-co', 'Nonexistent Co')

      expect(ctx.intelligence).toBeNull()
      expect(ctx.accountPlan).toBeNull()
      expect(ctx.cases.total).toBe(0)
      expect(ctx.pipeline.totalOpps).toBe(0)
    })
  })

  describe('Prompt construction', () => {
    test('buildPositioningPrompt includes all context sections', async () => {
      writeTestIntelligence('acme-corp', {
        company: 'Acme Corp focuses on cloud migration.',
        industry: 'Tech sector.',
      })
      writeTestAccountPlan('acme-corp', '# Plan\n## Initiatives\n- Cloud migration initiative')
      writeTestCases([
        { customerName: 'Acme Corp', severity: '1', status: 'Open', caseNumber: '00001234' },
      ])
      writeTestPipeline([
        { accountName: 'Acme Corp', oppName: 'OCP deal', acv: 100000, forecastCategory: 'Commit' },
      ])

      const { assemblePositioningContext, buildPositioningPrompt } = await import('../../src/value-positioning.ts')
      const ctx = assemblePositioningContext('acme-corp', 'Acme Corp')
      const prompt = buildPositioningPrompt('Acme Corp', ctx)

      expect(prompt).toContain('Acme Corp')
      expect(prompt).toContain('cloud migration')
      expect(prompt).toContain('Initiatives')
      expect(prompt).toContain('Sev-1')
      expect(prompt).toContain('100,000')
    })
  })

  describe('Result validation', () => {
    test('validatePositioningResult rejects empty currentState', async () => {
      const { validatePositioningResult } = await import('../../src/value-positioning.ts')
      const result = {
        currentState: '',
        solutionAlignment: [{ solution: 'OCP', alignment: 'test', proofPoints: ['a'] }],
        artOfPossible: 'test',
        nextSteps: ['step 1'],
      }
      expect(validatePositioningResult(result)).toBe(false)
    })

    test('validatePositioningResult rejects empty solutionAlignment', async () => {
      const { validatePositioningResult } = await import('../../src/value-positioning.ts')
      const result = {
        currentState: 'Customer overview...',
        solutionAlignment: [],
        artOfPossible: 'test',
        nextSteps: ['step 1'],
      }
      expect(validatePositioningResult(result)).toBe(false)
    })

    test('validatePositioningResult rejects empty nextSteps', async () => {
      const { validatePositioningResult } = await import('../../src/value-positioning.ts')
      const result = {
        currentState: 'Customer overview...',
        solutionAlignment: [{ solution: 'OCP', alignment: 'test', proofPoints: ['a'] }],
        artOfPossible: 'test',
        nextSteps: [],
      }
      expect(validatePositioningResult(result)).toBe(false)
    })

    test('validatePositioningResult accepts valid result', async () => {
      const { validatePositioningResult } = await import('../../src/value-positioning.ts')
      const result = {
        currentState: 'Acme Corp is a Fortune 500 company...',
        solutionAlignment: [
          { solution: 'OpenShift', alignment: 'Container modernization', proofPoints: ['Industry adoption'] },
        ],
        artOfPossible: 'With full Red Hat stack...',
        nextSteps: ['Schedule workshop', 'POC'],
      }
      expect(validatePositioningResult(result)).toBe(true)
    })
  })

  describe('Module registration', () => {
    test('value-positioning module registers with FeatureModuleRegistry', async () => {
      const { FeatureModuleRegistry } = await import('../../src/feature-module-registry.ts')
      FeatureModuleRegistry._resetForTesting()

      await import('../../src/modules/value-positioning-module.ts')

      const mod = FeatureModuleRegistry.get('value-positioning')
      expect(mod).toBeDefined()
      expect(mod!.name).toBe('value-positioning')
      expect(mod!.scope).toBe('customer')
    })
  })
})
