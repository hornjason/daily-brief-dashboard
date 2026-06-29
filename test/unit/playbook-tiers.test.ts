/**
 * Playbook Tier Configuration Tests — GitHub Issue #687
 *
 * Validates:
 * - All 15 sections assigned to exactly 3 tiers
 * - No section missing, no duplicates
 * - Tier 1/2/3 membership matches spec
 * - Ordering: Tier 1 first, then Tier 2, then Tier 3
 * - Helper functions return correct values
 */

import { describe, test, expect } from 'bun:test'
import {
  PLAYBOOK_SECTION_TIERS,
  ALL_PLAYBOOK_SECTION_KEYS,
  TIER_1_KEYS,
  TIER_2_KEYS,
  TIER_3_KEYS,
  getSectionTier,
  isSectionExpanded,
  type PlaybookSectionKey,
} from '../../src/playbook-tiers.ts'

describe('playbook-tiers', () => {
  test('exactly 15 sections defined', () => {
    expect(PLAYBOOK_SECTION_TIERS).toHaveLength(15)
    expect(ALL_PLAYBOOK_SECTION_KEYS).toHaveLength(15)
  })

  test('no duplicate section keys', () => {
    const unique = new Set(ALL_PLAYBOOK_SECTION_KEYS)
    expect(unique.size).toBe(15)
  })

  test('all expected section keys are present', () => {
    const expected: PlaybookSectionKey[] = [
      'expansionOpportunities',
      'openActionItems',
      'renewalsAndRisk',
      'solutionPlays',
      'currentPriorities',
      'strategicPosition',
      'keyRelationships',
      'productAlignment',
      'swotAnalysis',
      'meddpicc',
      'engagementHistory',
      'subscriptions',
      'cases',
      'lifecycle',
      'teamMembers',
    ]
    for (const key of expected) {
      expect(ALL_PLAYBOOK_SECTION_KEYS).toContain(key)
    }
  })

  test('Tier 1 contains exactly the right 5 sections', () => {
    expect(TIER_1_KEYS).toHaveLength(5)
    expect(TIER_1_KEYS).toContain('expansionOpportunities')
    expect(TIER_1_KEYS).toContain('openActionItems')
    expect(TIER_1_KEYS).toContain('renewalsAndRisk')
    expect(TIER_1_KEYS).toContain('solutionPlays')
    expect(TIER_1_KEYS).toContain('currentPriorities')
  })

  test('Tier 2 contains exactly the right 5 sections', () => {
    expect(TIER_2_KEYS).toHaveLength(5)
    expect(TIER_2_KEYS).toContain('strategicPosition')
    expect(TIER_2_KEYS).toContain('keyRelationships')
    expect(TIER_2_KEYS).toContain('productAlignment')
    expect(TIER_2_KEYS).toContain('swotAnalysis')
    expect(TIER_2_KEYS).toContain('meddpicc')
  })

  test('Tier 3 contains exactly the right 5 sections', () => {
    expect(TIER_3_KEYS).toHaveLength(5)
    expect(TIER_3_KEYS).toContain('engagementHistory')
    expect(TIER_3_KEYS).toContain('subscriptions')
    expect(TIER_3_KEYS).toContain('cases')
    expect(TIER_3_KEYS).toContain('lifecycle')
    expect(TIER_3_KEYS).toContain('teamMembers')
  })

  test('tiers sum to 5+5+5 = 15', () => {
    expect(TIER_1_KEYS.length + TIER_2_KEYS.length + TIER_3_KEYS.length).toBe(15)
  })

  test('sections are ordered: all Tier 1 first, then Tier 2, then Tier 3', () => {
    const tiers = PLAYBOOK_SECTION_TIERS.map(e => e.tier)
    // Find transition points
    const firstTier2 = tiers.indexOf(2)
    const firstTier3 = tiers.indexOf(3)
    const lastTier1 = tiers.lastIndexOf(1)
    const lastTier2 = tiers.lastIndexOf(2)

    // All tier-1 entries come before any tier-2 entry
    expect(lastTier1).toBeLessThan(firstTier2)
    // All tier-2 entries come before any tier-3 entry
    expect(lastTier2).toBeLessThan(firstTier3)
  })

  test('only tiers 1, 2, 3 used', () => {
    const tiers = new Set(PLAYBOOK_SECTION_TIERS.map(e => e.tier))
    expect(tiers.size).toBe(3)
    expect(tiers.has(1)).toBe(true)
    expect(tiers.has(2)).toBe(true)
    expect(tiers.has(3)).toBe(true)
  })

  test('every entry has a non-empty title', () => {
    for (const entry of PLAYBOOK_SECTION_TIERS) {
      expect(entry.title.length).toBeGreaterThan(0)
    }
  })

  test('getSectionTier returns correct tier for each section', () => {
    expect(getSectionTier('expansionOpportunities')).toBe(1)
    expect(getSectionTier('openActionItems')).toBe(1)
    expect(getSectionTier('strategicPosition')).toBe(2)
    expect(getSectionTier('meddpicc')).toBe(2)
    expect(getSectionTier('cases')).toBe(3)
    expect(getSectionTier('teamMembers')).toBe(3)
    expect(getSectionTier('nonexistent')).toBeUndefined()
  })

  test('isSectionExpanded returns true only for Tier 1', () => {
    // Tier 1 — always expanded
    expect(isSectionExpanded('expansionOpportunities')).toBe(true)
    expect(isSectionExpanded('openActionItems')).toBe(true)
    expect(isSectionExpanded('currentPriorities')).toBe(true)

    // Tier 2 — collapsed by default
    expect(isSectionExpanded('strategicPosition')).toBe(false)
    expect(isSectionExpanded('swotAnalysis')).toBe(false)

    // Tier 3 — collapsed
    expect(isSectionExpanded('engagementHistory')).toBe(false)
    expect(isSectionExpanded('subscriptions')).toBe(false)

    // Unknown — collapsed
    expect(isSectionExpanded('unknown')).toBe(false)
  })
})
