/**
 * test/unit/deal-attribution.test.ts
 * Unit tests for deal attribution logic — GitHub Issue #614
 *
 * Tests the correlation between intelligence activity (meeting preps,
 * motions, graph density) and deal progression.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { resolve } from 'path'

// ── Test helpers ────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = resolve(import.meta.dir, `../../.test-tmp-deal-attr-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeJsonFile(dir: string, ...pathParts: string[]) {
  return (data: unknown) => {
    const filePath = resolve(dir, ...pathParts)
    const parent = resolve(filePath, '..')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(filePath, JSON.stringify(data, null, 2))
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeGraph(slug: string, overrides?: Record<string, unknown>) {
  const base = {
    customerId: slug,
    customerName: 'Test Customer',
    version: '1.0',
    builtAt: new Date().toISOString(),
    nodeCount: 2,
    edgeCount: 1,
    nodes: {
      [`customer:${slug}`]: {
        id: `customer:${slug}`,
        type: 'customer',
        name: 'Test Customer',
        properties: {},
        sourceModule: 'core',
        contentHash: 'abc123',
        updatedAt: new Date().toISOString(),
      },
      'deal:big-renewal': {
        id: 'deal:big-renewal',
        type: 'deal',
        name: 'Big Renewal',
        properties: {
          stage: 'Commit',
          amount: 250000,
          closeDate: '2026-07-15',
        },
        sourceModule: 'pipeline',
        contentHash: 'def456',
        updatedAt: new Date().toISOString(),
      },
    },
    edges: [
      {
        from: `customer:${slug}`,
        to: 'deal:big-renewal',
        relation: 'HAS_DEAL',
        tier: 'factual',
        strength: 0.8,
        evidence: ['Pipeline signal'],
        scoredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        sourceType: 'pipeline',
      },
    ],
    history: [
      {
        motionId: 'motion-1',
        title: 'Expand RHEL footprint',
        phaseCount: 3,
        status: 'active',
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  }
  return { ...base, ...overrides }
}

function makeDebrief(customerSlug: string, timestamp: string, notes: string) {
  return {
    customerSlug,
    notes,
    talkingPointsUsed: ['rhel-migration'],
    nextSteps: 'Schedule follow-up',
    createdAt: timestamp,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('deal-attribution', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  it('should export computeDealAttribution function', async () => {
    const mod = await import('../../src/lib/deal-attribution.ts')
    expect(typeof mod.computeDealAttribution).toBe('function')
  })

  it('returns empty array when no graph exists for customer', async () => {
    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution('nonexistent-customer', tmpDir)
    expect(result).toEqual([])
  })

  it('returns deals from the graph with correct structure', async () => {
    const slug = 'test-corp'
    const graph = makeGraph(slug)
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result.length).toBe(1)
    expect(result[0].dealId).toBe('deal:big-renewal')
    expect(result[0].dealName).toBe('Big Renewal')
    expect(result[0].stage).toBe('Commit')
    expect(result[0].amount).toBe(250000)
    expect(result[0].customerSlug).toBe(slug)
  })

  it('counts meeting prep debriefs in priorIntelligence', async () => {
    const slug = 'debrief-test'
    const graph = makeGraph(slug)
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    // Write debrief files
    const debriefDir = resolve(tmpDir, 'debriefs', slug)
    mkdirSync(debriefDir, { recursive: true })
    writeFileSync(
      resolve(debriefDir, '2026-05-20T10-00-00-000Z.json'),
      JSON.stringify(makeDebrief(slug, '2026-05-20T10:00:00.000Z', 'Discussed RHEL migration')),
    )
    writeFileSync(
      resolve(debriefDir, '2026-05-25T10-00-00-000Z.json'),
      JSON.stringify(makeDebrief(slug, '2026-05-25T10:00:00.000Z', 'Follow-up on expansion')),
    )

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].priorIntelligence.meetingPrepsGenerated).toBe(2)
  })

  it('identifies recommended tactics from motion history', async () => {
    const slug = 'motion-test'
    const graph = makeGraph(slug, {
      history: [
        {
          motionId: 'motion-1',
          title: 'Expand RHEL footprint',
          phaseCount: 3,
          status: 'active',
          firstSeenAt: '2026-05-01T00:00:00.000Z',
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
        {
          motionId: 'motion-2',
          title: 'Cloud marketplace entry',
          phaseCount: 2,
          status: 'dismissed',
          firstSeenAt: '2026-04-15T00:00:00.000Z',
          lastSeenAt: '2026-05-15T00:00:00.000Z',
        },
      ],
    })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].priorIntelligence.tacticsRecommended).toContain('Expand RHEL footprint')
    expect(result[0].priorIntelligence.tacticsRecommended).toContain('Cloud marketplace entry')
  })

  it('computes graph density as node+edge count', async () => {
    const slug = 'density-test'
    const graph = makeGraph(slug)
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    // Graph has 2 nodes + 1 edge = density 3
    expect(result[0].priorIntelligence.graphDensityAtTime).toBe(3)
  })

  it('assigns strong attribution when debriefs exist and motion was generated', async () => {
    const slug = 'strong-attr'
    const graph = makeGraph(slug, {
      history: [
        {
          motionId: 'motion-1',
          title: 'Expand RHEL',
          phaseCount: 3,
          status: 'active',
          firstSeenAt: '2026-05-01T00:00:00.000Z',
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const debriefDir = resolve(tmpDir, 'debriefs', slug)
    mkdirSync(debriefDir, { recursive: true })
    writeFileSync(
      resolve(debriefDir, '2026-05-20T10-00-00-000Z.json'),
      JSON.stringify(makeDebrief(slug, '2026-05-20T10:00:00.000Z', 'Discussed deal')),
    )

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].attributionScore).toBe('strong')
  })

  it('assigns moderate attribution when only motion exists (no debriefs)', async () => {
    const slug = 'moderate-attr'
    const graph = makeGraph(slug, {
      history: [
        {
          motionId: 'motion-1',
          title: 'Expand RHEL',
          phaseCount: 3,
          status: 'active',
          firstSeenAt: '2026-05-01T00:00:00.000Z',
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].attributionScore).toBe('moderate')
  })

  it('assigns weak attribution when only debriefs exist (no motion)', async () => {
    const slug = 'weak-attr'
    const graph = makeGraph(slug, { history: [] })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const debriefDir = resolve(tmpDir, 'debriefs', slug)
    mkdirSync(debriefDir, { recursive: true })
    writeFileSync(
      resolve(debriefDir, '2026-05-20T10-00-00-000Z.json'),
      JSON.stringify(makeDebrief(slug, '2026-05-20T10:00:00.000Z', 'Discussed deal')),
    )

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].attributionScore).toBe('weak')
  })

  it('assigns none attribution when no intelligence activity exists', async () => {
    const slug = 'no-attr'
    const graph = makeGraph(slug, { history: [] })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].attributionScore).toBe('none')
  })

  it('captures motionGeneratedAt from earliest motion firstSeenAt', async () => {
    const slug = 'motion-time'
    const graph = makeGraph(slug, {
      history: [
        {
          motionId: 'motion-1',
          title: 'Motion A',
          phaseCount: 2,
          status: 'active',
          firstSeenAt: '2026-04-15T00:00:00.000Z',
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
        {
          motionId: 'motion-2',
          title: 'Motion B',
          phaseCount: 3,
          status: 'active',
          firstSeenAt: '2026-05-01T00:00:00.000Z',
          lastSeenAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result[0].priorIntelligence.motionGeneratedAt).toBe('2026-04-15T00:00:00.000Z')
  })

  it('handles multiple deal nodes in a single graph', async () => {
    const slug = 'multi-deal'
    const graph = makeGraph(slug, {
      nodeCount: 3,
      edgeCount: 2,
      nodes: {
        [`customer:${slug}`]: {
          id: `customer:${slug}`,
          type: 'customer',
          name: 'Multi Deal Corp',
          properties: {},
          sourceModule: 'core',
          contentHash: 'abc',
          updatedAt: new Date().toISOString(),
        },
        'deal:renewal-1': {
          id: 'deal:renewal-1',
          type: 'deal',
          name: 'RHEL Renewal',
          properties: { stage: 'Commit', amount: 100000, closeDate: '2026-07-01' },
          sourceModule: 'pipeline',
          contentHash: 'def',
          updatedAt: new Date().toISOString(),
        },
        'deal:expansion-1': {
          id: 'deal:expansion-1',
          type: 'deal',
          name: 'OCP Expansion',
          properties: { stage: 'Best Case', amount: 500000, closeDate: '2026-09-01' },
          sourceModule: 'pipeline',
          contentHash: 'ghi',
          updatedAt: new Date().toISOString(),
        },
      },
      edges: [
        {
          from: `customer:${slug}`,
          to: 'deal:renewal-1',
          relation: 'HAS_DEAL',
          tier: 'factual',
          strength: 0.8,
          evidence: ['Pipeline signal'],
          scoredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          sourceType: 'pipeline',
        },
        {
          from: `customer:${slug}`,
          to: 'deal:expansion-1',
          relation: 'HAS_DEAL',
          tier: 'factual',
          strength: 0.7,
          evidence: ['Pipeline signal'],
          scoredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          sourceType: 'pipeline',
        },
      ],
    })
    writeJsonFile(tmpDir, slug, 'intelligence-graph.json')(graph)

    const { computeDealAttribution } = await import('../../src/lib/deal-attribution.ts')
    const result = computeDealAttribution(slug, tmpDir)

    expect(result.length).toBe(2)
    const names = result.map(d => d.dealName).sort()
    expect(names).toEqual(['OCP Expansion', 'RHEL Renewal'])
  })
})
