/**
 * test/unit/enhanced-gemini-recommender.test.ts
 * Unit tests for enhancedRecommendTactics() and merge logic — GitHub Issue #613
 *
 * Tests:
 * - enhancedRecommendTactics() returns properly typed results (mock Gemini)
 * - Merge logic: deterministic + novel deduplication
 * - isNovel flag is set correctly
 * - Cap at 8 total recommendations
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { EnhancedGeminiRecommendation } from '../../src/lib/gemini-tactic-recommender.ts'

// ── Mock callGemini ─────────────────────────────────────────────────────────

// We mock at the module level so enhancedRecommendTactics uses the mock
const mockCallGemini = mock(() => Promise.resolve({
  text: JSON.stringify([
    {
      tacticName: 'Ansible Lightspeed Adoption',
      parentTdp: 'Automation',
      reasoning: 'Customer has mainframe modernization initiative + RHEL subscription + automation cases = platform migration play',
      confidence: 'high',
      signalsUsed: ['RHEL subscription', 'Automation cases'],
      isNovel: true,
      discoveryReason: 'Mainframe modernization combined with RHEL and automation cases suggests platform migration',
    },
    {
      tacticName: 'OpenShift AI Workloads',
      parentTdp: 'AI Platform',
      reasoning: 'Tech stack includes ML frameworks and customer has OCP subscription',
      confidence: 'medium',
      signalsUsed: ['TensorFlow in tech stack', 'OCP subscription'],
      isNovel: true,
      discoveryReason: 'ML tools in tech stack + container platform = AI workload opportunity',
    },
  ]),
  cached: false,
  inputTokens: 100,
  outputTokens: 200,
  model: 'gemini-2.5-flash',
}))

// Mock the gemini-call module
mock.module('../../src/gemini-call.ts', () => ({
  callGemini: mockCallGemini,
}))

// Import after mocking
const { enhancedRecommendTactics, mergeRecommendations } = await import('../../src/lib/gemini-tactic-recommender.ts')

// ── Tests ───────────────────────────────────────────────────────────────────

describe('enhancedRecommendTactics', () => {
  beforeEach(() => {
    mockCallGemini.mockClear()
  })

  test('returns EnhancedGeminiRecommendation[] with isNovel flag', async () => {
    const availableTactics = [
      { name: 'Ansible Lightspeed Adoption', parentTdp: 'Automation' },
      { name: 'OpenShift AI Workloads', parentTdp: 'AI Platform' },
      { name: 'RHEL Standardization', parentTdp: 'Server and Cloud Computing' },
    ]
    const deterministicTop = ['RHEL Standardization']

    const results = await enhancedRecommendTactics(
      'Customer summary text',
      'Full graph context with nodes and edges',
      availableTactics,
      deterministicTop,
      'Test Customer',
    )

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)

    for (const r of results) {
      expect(r).toHaveProperty('tacticName')
      expect(r).toHaveProperty('parentTdp')
      expect(r).toHaveProperty('reasoning')
      expect(r).toHaveProperty('confidence')
      expect(r).toHaveProperty('signalsUsed')
      expect(r).toHaveProperty('isNovel')
      expect(typeof r.isNovel).toBe('boolean')
    }
  })

  test('marks tactics NOT in deterministicTop as novel', async () => {
    const availableTactics = [
      { name: 'Ansible Lightspeed Adoption', parentTdp: 'Automation' },
      { name: 'OpenShift AI Workloads', parentTdp: 'AI Platform' },
    ]
    const deterministicTop = ['Some Other Tactic']

    const results = await enhancedRecommendTactics(
      'summary',
      'full context',
      availableTactics,
      deterministicTop,
      'Test Customer',
    )

    // Both should be novel since neither is in deterministicTop
    for (const r of results) {
      expect(r.isNovel).toBe(true)
    }
  })

  test('marks tactics IN deterministicTop as NOT novel', async () => {
    const availableTactics = [
      { name: 'Ansible Lightspeed Adoption', parentTdp: 'Automation' },
      { name: 'OpenShift AI Workloads', parentTdp: 'AI Platform' },
    ]
    // Both returned tactics are in deterministicTop
    const deterministicTop = ['Ansible Lightspeed Adoption', 'OpenShift AI Workloads']

    const results = await enhancedRecommendTactics(
      'summary',
      'full context',
      availableTactics,
      deterministicTop,
      'Test Customer',
    )

    for (const r of results) {
      expect(r.isNovel).toBe(false)
    }
  })

  test('filters out tactics not in available list', async () => {
    // Available list has only one of the two returned tactics
    const availableTactics = [
      { name: 'Ansible Lightspeed Adoption', parentTdp: 'Automation' },
    ]

    const results = await enhancedRecommendTactics(
      'summary',
      'full context',
      availableTactics,
      [],
      'Test Customer',
    )

    // Only the matching tactic should be returned
    expect(results.length).toBe(1)
    expect(results[0].tacticName).toBe('Ansible Lightspeed Adoption')
  })

  test('includes discoveryReason for novel tactics', async () => {
    const availableTactics = [
      { name: 'Ansible Lightspeed Adoption', parentTdp: 'Automation' },
      { name: 'OpenShift AI Workloads', parentTdp: 'AI Platform' },
    ]

    const results = await enhancedRecommendTactics(
      'summary',
      'full context',
      availableTactics,
      [],
      'Test Customer',
    )

    const novel = results.filter(r => r.isNovel)
    for (const r of novel) {
      expect(r.discoveryReason).toBeDefined()
      expect(typeof r.discoveryReason).toBe('string')
      expect(r.discoveryReason!.length).toBeGreaterThan(0)
    }
  })
})

describe('mergeRecommendations', () => {
  const deterministicTactics = [
    { name: 'RHEL Standardization', parentTdp: 'Server and Cloud Computing', compositeScore: 1.5 },
    { name: 'Ansible Migration', parentTdp: 'Automation', compositeScore: 1.2 },
    { name: 'OpenShift Expansion', parentTdp: 'Container Mgmt', compositeScore: 1.0 },
    { name: 'Satellite Compliance', parentTdp: 'Management', compositeScore: 0.8 },
    { name: 'ACS Security', parentTdp: 'Security', compositeScore: 0.6 },
  ]

  test('deduplicates by tactic name (case-insensitive)', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      {
        tacticName: 'RHEL Standardization', // duplicate of deterministic
        parentTdp: 'Server and Cloud Computing',
        reasoning: 'some reasoning',
        confidence: 'high',
        signalsUsed: [],
        isNovel: false,
      },
      {
        tacticName: 'AI Platform Adoption',
        parentTdp: 'AI Platform',
        reasoning: 'novel reasoning',
        confidence: 'medium',
        signalsUsed: [],
        isNovel: true,
        discoveryReason: 'ML signals',
      },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)

    // Should not have duplicate RHEL Standardization
    const names = merged.map(m => m.name)
    const uniqueNames = [...new Set(names)]
    expect(names.length).toBe(uniqueNames.length)
  })

  test('keeps deterministic ranking for overlapping tactics', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      {
        tacticName: 'RHEL Standardization',
        parentTdp: 'Server and Cloud Computing',
        reasoning: 'reasoning',
        confidence: 'high',
        signalsUsed: [],
        isNovel: false,
      },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)

    // First 5 should be deterministic order
    expect(merged[0].name).toBe('RHEL Standardization')
    expect(merged[1].name).toBe('Ansible Migration')
  })

  test('appends novel Gemini recommendations after deterministic ones', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      {
        tacticName: 'AI Platform Adoption',
        parentTdp: 'AI Platform',
        reasoning: 'novel',
        confidence: 'high',
        signalsUsed: [],
        isNovel: true,
        discoveryReason: 'ML signals in tech stack',
      },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)

    // Deterministic first, then novel
    expect(merged.length).toBe(6)
    expect(merged[5].name).toBe('AI Platform Adoption')
    expect(merged[5].isNovel).toBe(true)
  })

  test('caps total at 8 recommendations (5 deterministic + up to 3 novel)', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      { tacticName: 'Novel 1', parentTdp: 'AI', reasoning: '', confidence: 'high', signalsUsed: [], isNovel: true, discoveryReason: 'r1' },
      { tacticName: 'Novel 2', parentTdp: 'AI', reasoning: '', confidence: 'medium', signalsUsed: [], isNovel: true, discoveryReason: 'r2' },
      { tacticName: 'Novel 3', parentTdp: 'AI', reasoning: '', confidence: 'low', signalsUsed: [], isNovel: true, discoveryReason: 'r3' },
      { tacticName: 'Novel 4', parentTdp: 'AI', reasoning: '', confidence: 'low', signalsUsed: [], isNovel: true, discoveryReason: 'r4' },
      { tacticName: 'Novel 5', parentTdp: 'AI', reasoning: '', confidence: 'low', signalsUsed: [], isNovel: true, discoveryReason: 'r5' },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)

    // 5 deterministic + max 3 novel = 8
    expect(merged.length).toBe(8)
  })

  test('sets isNovel correctly on merged results', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      { tacticName: 'Novel Tactic', parentTdp: 'AI', reasoning: '', confidence: 'high', signalsUsed: [], isNovel: true, discoveryReason: 'found it' },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)

    // Deterministic ones should not be novel
    for (let i = 0; i < 5; i++) {
      expect(merged[i].isNovel).toBe(false)
    }
    // Novel one should be novel
    expect(merged[5].isNovel).toBe(true)
    expect(merged[5].discoveryReason).toBe('found it')
  })

  test('handles empty gemini results', () => {
    const merged = mergeRecommendations(deterministicTactics, [])
    expect(merged.length).toBe(5)
  })

  test('handles case-insensitive dedup', () => {
    const geminiNovel: EnhancedGeminiRecommendation[] = [
      {
        tacticName: 'rhel standardization', // lowercase version
        parentTdp: 'Server and Cloud Computing',
        reasoning: 'reasoning',
        confidence: 'high',
        signalsUsed: [],
        isNovel: false,
      },
    ]

    const merged = mergeRecommendations(deterministicTactics, geminiNovel)
    // Should deduplicate — not add a second entry
    expect(merged.length).toBe(5)
  })
})
