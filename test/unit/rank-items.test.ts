/**
 * Unit tests for rankItems() in brief-pipeline.ts — GitHub Issue #338
 *
 * Tests deterministic ranking algorithm that combines urgency, category, confidence, and newness.
 * From GEMINI-BRIEF-ARCHITECTURE.md lines 197-211
 */

import { describe, test, expect } from 'bun:test'
import { rankItems } from '../../src/brief-pipeline.ts'
import type { ExtractedItem } from '../../src/brief-pipeline.ts'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    content: 'Test item',
    urgency: 'MEDIUM',
    category: 'OPPORTUNITY',
    confidence: 'MEDIUM',
    source_type: 'test',
    is_new_since_last_brief: false,
    ...overrides,
  }
}

// ── Basic Ranking Tests ──────────────────────────────────────────────────────

describe('rankItems - basic sorting', () => {
  test('items are sorted by score descending', () => {
    const items: ExtractedItem[] = [
      makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY' }),  // score: (20 + 15) * 0.7 = 24.5
      makeItem({ urgency: 'CRITICAL', category: 'RISK' }),       // score: (100 + 50) * 0.7 = 105
      makeItem({ urgency: 'HIGH', category: 'ACTION' }),         // score: (60 + 40) * 0.7 = 70
    ]

    const ranked = rankItems(items)

    expect(ranked[0].score).toBe(105)   // CRITICAL + RISK
    expect(ranked[1].score).toBe(70)    // HIGH + ACTION
    expect(ranked[2].score).toBe(24.5)  // MEDIUM + OPPORTUNITY
  })

  test('higher-scored items come first', () => {
    const items: ExtractedItem[] = [
      makeItem({ urgency: 'MEDIUM', category: 'STAKEHOLDER', content: 'Low priority' }),
      makeItem({ urgency: 'CRITICAL', category: 'RISK', content: 'High priority' }),
    ]

    const ranked = rankItems(items)

    expect(ranked[0].content).toBe('High priority')
    expect(ranked[1].content).toBe('Low priority')
  })
})

// ── Urgency Scoring Tests ────────────────────────────────────────────────────

describe('rankItems - urgency scoring', () => {
  test('CRITICAL urgency scores 100', () => {
    const item = makeItem({ urgency: 'CRITICAL', category: 'OPPORTUNITY', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (100 + 15) * 0.7 = 80.5
    expect(ranked[0].score).toBe(80.5)
  })

  test('HIGH urgency scores 60', () => {
    const item = makeItem({ urgency: 'HIGH', category: 'OPPORTUNITY', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (60 + 15) * 0.7 = 52.5
    expect(ranked[0].score).toBe(52.5)
  })

  test('MEDIUM urgency scores 20', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 15) * 0.7 = 24.5
    expect(ranked[0].score).toBe(24.5)
  })

  test('unknown urgency defaults to 20', () => {
    const item = makeItem({ urgency: 'UNKNOWN' as any, category: 'OPPORTUNITY', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 15) * 0.7 = 24.5
    expect(ranked[0].score).toBe(24.5)
  })
})

// ── Category Scoring Tests ───────────────────────────────────────────────────

describe('rankItems - category scoring', () => {
  test('RISK category scores 50', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'RISK', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 50) * 0.7 = 49
    expect(ranked[0].score).toBe(49)
  })

  test('ACTION category scores 40', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'ACTION', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 40) * 0.7 = 42
    expect(ranked[0].score).toBe(42)
  })

  test('COMPETITIVE category scores 30', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'COMPETITIVE', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 30) * 0.7 = 35
    expect(ranked[0].score).toBe(35)
  })

  test('CHANGE category scores 20', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'CHANGE', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 20) * 0.7 = 28
    expect(ranked[0].score).toBe(28)
  })

  test('OPPORTUNITY category scores 15', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 15) * 0.7 = 24.5
    expect(ranked[0].score).toBe(24.5)
  })

  test('STAKEHOLDER category scores 10', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'STAKEHOLDER', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 10) * 0.7 = 21
    expect(ranked[0].score).toBe(21)
  })

  test('unknown category defaults to 10', () => {
    const item = makeItem({ urgency: 'MEDIUM', category: 'UNKNOWN' as any, confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (20 + 10) * 0.7 = 21
    expect(ranked[0].score).toBe(21)
  })
})

// ── Confidence Multiplier Tests ──────────────────────────────────────────────

describe('rankItems - confidence multiplier', () => {
  test('HIGH confidence multiplies by 1.0', () => {
    const item = makeItem({ urgency: 'CRITICAL', category: 'RISK', confidence: 'HIGH' })
    const ranked = rankItems([item])

    // (100 + 50) * 1.0 = 150
    expect(ranked[0].score).toBe(150)
  })

  test('MEDIUM confidence multiplies by 0.7', () => {
    const item = makeItem({ urgency: 'CRITICAL', category: 'RISK', confidence: 'MEDIUM' })
    const ranked = rankItems([item])

    // (100 + 50) * 0.7 = 105
    expect(ranked[0].score).toBe(105)
  })

  test('unknown confidence defaults to 0.7', () => {
    const item = makeItem({ urgency: 'CRITICAL', category: 'RISK', confidence: 'LOW' as any })
    const ranked = rankItems([item])

    // (100 + 50) * 0.7 = 105
    expect(ranked[0].score).toBe(105)
  })
})

// ── New Item Bonus Tests ─────────────────────────────────────────────────────

describe('rankItems - new item bonus', () => {
  test('is_new_since_last_brief adds +25 bonus', () => {
    const oldItem = makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY', is_new_since_last_brief: false })
    const newItem = makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY', is_new_since_last_brief: true })

    const rankedOld = rankItems([oldItem])
    const rankedNew = rankItems([newItem])

    // Base: (20 + 15) * 0.7 = 24.5
    // New bonus: +25
    expect(rankedOld[0].score).toBe(24.5)
    expect(rankedNew[0].score).toBe(49.5)
  })

  test('new bonus can change ranking order', () => {
    const items: ExtractedItem[] = [
      makeItem({ urgency: 'MEDIUM', category: 'RISK', is_new_since_last_brief: false, content: 'Old high-score' }),      // (20 + 50) * 0.7 = 49
      makeItem({ urgency: 'MEDIUM', category: 'OPPORTUNITY', is_new_since_last_brief: true, content: 'New low-score' }), // (20 + 15) * 0.7 + 25 = 49.5
    ]

    const ranked = rankItems(items)

    expect(ranked[0].content).toBe('New low-score')
    expect(ranked[1].content).toBe('Old high-score')
  })
})

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe('rankItems - edge cases', () => {
  test('empty array returns empty array', () => {
    const ranked = rankItems([])
    expect(ranked).toEqual([])
  })

  test('single item returns array with one scored item', () => {
    const item = makeItem({ urgency: 'HIGH', category: 'ACTION' })
    const ranked = rankItems([item])

    expect(ranked.length).toBe(1)
    expect(ranked[0].score).toBe(70)  // (60 + 40) * 0.7
  })

  test('items with identical scores maintain stable order', () => {
    const items: ExtractedItem[] = [
      makeItem({ urgency: 'HIGH', category: 'ACTION', content: 'First' }),
      makeItem({ urgency: 'HIGH', category: 'ACTION', content: 'Second' }),
      makeItem({ urgency: 'HIGH', category: 'ACTION', content: 'Third' }),
    ]

    const ranked = rankItems(items)

    // All have same score, order should be preserved from input
    expect(ranked.every(r => r.score === 70)).toBe(true)
    expect(ranked.map(r => r.content)).toEqual(['First', 'Second', 'Third'])
  })
})

// ── Complex Scenario Tests ───────────────────────────────────────────────────

describe('rankItems - complex scenarios', () => {
  test('full scoring algorithm with all factors', () => {
    const items: ExtractedItem[] = [
      makeItem({
        urgency: 'CRITICAL',
        category: 'RISK',
        confidence: 'HIGH',
        is_new_since_last_brief: true,
        content: 'Critical new risk',
      }),
      makeItem({
        urgency: 'HIGH',
        category: 'ACTION',
        confidence: 'MEDIUM',
        is_new_since_last_brief: false,
        content: 'High action',
      }),
      makeItem({
        urgency: 'MEDIUM',
        category: 'OPPORTUNITY',
        confidence: 'HIGH',
        is_new_since_last_brief: true,
        content: 'Medium new opportunity',
      }),
    ]

    const ranked = rankItems(items)

    // Critical new risk: (100 + 50) * 1.0 + 25 = 175
    expect(ranked[0].content).toBe('Critical new risk')
    expect(ranked[0].score).toBe(175)

    // High action: (60 + 40) * 0.7 = 70
    expect(ranked[1].content).toBe('High action')
    expect(ranked[1].score).toBe(70)

    // Medium new opportunity: (20 + 15) * 1.0 + 25 = 60
    expect(ranked[2].content).toBe('Medium new opportunity')
    expect(ranked[2].score).toBe(60)
  })
})
