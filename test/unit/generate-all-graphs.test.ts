/**
 * test/unit/generate-all-graphs.test.ts
 * Tests for generateAllGraphs parallel processing (#545)
 */

import { describe, expect, test, mock } from 'bun:test'
import { generateAllGraphs } from '../../src/lib/expansion-motion-service.ts'
import type { GenerateAllOptions, ExpansionMotionDeps } from '../../src/lib/expansion-motion-service.ts'
import type { StrategicMotion } from '../../src/lib/motion-builder.ts'

describe('generateAllGraphs', () => {
  test('processes customers in parallel batches', async () => {
    const customers = [
      { name: 'Customer A' },
      { name: 'Customer B' },
      { name: 'Customer C' },
      { name: 'Customer D' },
      { name: 'Customer E' },
    ]

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

    const getMotion = mock(async (_slug: string, _name: string, _deps: ExpansionMotionDeps) => mockMotion)

    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(result.total).toBe(5)
    expect(result.graphsBuilt).toBe(5)
    expect(result.motionsGenerated).toBe(5)
    expect(result.errors).toEqual([])
    expect(getMotion).toHaveBeenCalledTimes(5)
  })

  test('counts motions generated correctly', async () => {
    const customers = [
      { name: 'With Motion' },
      { name: 'Without Motion' },
      { name: 'Also With Motion' },
    ]

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

    const getMotion = mock(async (_slug: string, name: string, _deps: ExpansionMotionDeps) => {
      return name === 'Without Motion' ? null : mockMotion
    })

    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(result.total).toBe(3)
    expect(result.graphsBuilt).toBe(3) // All attempts counted
    expect(result.motionsGenerated).toBe(2) // Only non-null
    expect(result.errors).toEqual([])
  })

  test('captures errors without stopping batch', async () => {
    const customers = [
      { name: 'Success' },
      { name: 'Failure' },
      { name: 'Also Success' },
    ]

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

    const getMotion = mock(async (_slug: string, name: string, _deps: ExpansionMotionDeps) => {
      if (name === 'Failure') throw new Error('Graph build failed')
      return mockMotion
    })

    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(result.total).toBe(3)
    expect(result.graphsBuilt).toBe(2) // Only successful builds
    expect(result.motionsGenerated).toBe(2)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toContain('Graph build failed')
  })

  test('respects customer slug when provided', async () => {
    const customers = [
      { name: 'Custom Name', slug: 'custom-slug' },
    ]

    const mockDeps: ExpansionMotionDeps = {
      collectSignals: async () => [],
      playSignals: [],
      tacticSignals: [],
    }

    const getMotion = mock(async (slug: string, _name: string, _deps: ExpansionMotionDeps) => {
      expect(slug).toBe('custom-slug')
      return null
    })

    await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(getMotion).toHaveBeenCalledWith('custom-slug', 'Custom Name', mockDeps)
  })

  test('generates slug from name when not provided', async () => {
    const customers = [
      { name: 'Test Company Inc.' },
    ]

    const mockDeps: ExpansionMotionDeps = {
      collectSignals: async () => [],
      playSignals: [],
      tacticSignals: [],
    }

    const getMotion = mock(async (slug: string, _name: string, _deps: ExpansionMotionDeps) => {
      expect(slug).toBe('test-company-inc')
      return null
    })

    await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(getMotion).toHaveBeenCalledWith('test-company-inc', 'Test Company Inc.', mockDeps)
  })

  test('returns duration in milliseconds', async () => {
    const customers = [{ name: 'Test' }]

    const mockDeps: ExpansionMotionDeps = {
      collectSignals: async () => [],
      playSignals: [],
      tacticSignals: [],
    }

    const getMotion = mock(async () => {
      // Simulate some delay
      await new Promise(resolve => setTimeout(resolve, 10))
      return null
    })

    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.durationMs).toBeLessThan(1000) // Sanity check
  })

  test('processes large batch efficiently', async () => {
    // 20 customers should process in 5 batches of 4
    const customers = Array.from({ length: 20 }, (_, i) => ({ name: `Customer ${i}` }))

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

    const getMotion = mock(async () => mockMotion)

    const result = await generateAllGraphs({
      customers,
      getExpansionMotion: getMotion,
      deps: mockDeps,
    })

    expect(result.total).toBe(20)
    expect(result.graphsBuilt).toBe(20)
    expect(result.motionsGenerated).toBe(20)
    expect(getMotion).toHaveBeenCalledTimes(20)
  })
})
