/**
 * test/unit/generate-all-graphs-performance.test.ts
 * Performance benchmark for parallel graph generation (#545)
 */

import { describe, expect, test, mock } from 'bun:test'
import { generateAllGraphs } from '../../src/lib/expansion-motion-service.ts'
import type { ExpansionMotionDeps } from '../../src/lib/expansion-motion-service.ts'
import type { StrategicMotion } from '../../src/lib/motion-builder.ts'

describe('generateAllGraphs performance', () => {
  test('processes 12 customers faster than sequential would', async () => {
    // Simulate 12 customers with 100ms build time each
    // Sequential: 1200ms minimum
    // Parallel (4 concurrent): 300ms minimum (3 batches × 100ms)
    const customers = Array.from({ length: 12 }, (_, i) => ({ name: `Customer ${i}` }))

    const mockDeps: ExpansionMotionDeps = {
      collectSignals: async () => [],
      playSignals: [],
      tacticSignals: [],
    }

    const mockMotion: StrategicMotion = {
      title: 'Test Motion',
      phases: [],
      nextSteps: [],
      metrics: { expectedTimelineMonths: 6, confidence: 0.8 },
    }

    const getMotion = mock(async () => {
      // Simulate 100ms per graph build
      await new Promise(resolve => setTimeout(resolve, 100))
      return mockMotion
    })

    const start = Date.now()
    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })
    const elapsed = Date.now() - start

    expect(result.total).toBe(12)
    expect(result.graphsBuilt).toBe(12)

    // With CONCURRENCY=4, we expect 3 batches of 100ms each = ~300ms
    // Allow overhead but verify it's much faster than sequential (1200ms)
    expect(elapsed).toBeLessThan(800) // Well under sequential time
    expect(elapsed).toBeGreaterThan(200) // Realistic with overhead

    console.log(`Generated ${result.total} graphs in ${elapsed}ms (expected ~300ms for parallel, ~1200ms for sequential)`)
  })

  test('maintains concurrency limit', async () => {
    // Track how many operations run concurrently
    let currentConcurrent = 0
    let maxConcurrent = 0

    const customers = Array.from({ length: 16 }, (_, i) => ({ name: `Customer ${i}` }))

    const mockDeps: ExpansionMotionDeps = {
      collectSignals: async () => [],
      playSignals: [],
      tacticSignals: [],
    }

    const mockMotion: StrategicMotion = {
      title: 'Test Motion',
      phases: [],
      nextSteps: [],
      metrics: { expectedTimelineMonths: 6, confidence: 0.8 },
    }

    const getMotion = mock(async () => {
      currentConcurrent++
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent
      }

      await new Promise(resolve => setTimeout(resolve, 50))

      currentConcurrent--
      return mockMotion
    })

    await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    // Should never exceed CONCURRENCY=4
    expect(maxConcurrent).toBeLessThanOrEqual(4)
    expect(maxConcurrent).toBeGreaterThanOrEqual(1)
  })
})
