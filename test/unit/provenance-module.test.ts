/**
 * test/unit/provenance-module.test.ts
 *
 * Tests for the generic provenance module extracted from account-provenance-healer.ts
 *
 * This tests the pure functions for version-aware auto-healing that can be
 * applied to ANY data type (account numbers, domain inferences, AI briefs, product intel).
 */

import { describe, test, expect } from 'bun:test'
import type { ProvenanceEntry } from '../../src/provenance.ts'
import { isStale, stamp, merge, buildHealPlan } from '../../src/provenance.ts'

describe('provenance module — isStale()', () => {
  test('undefined provenance is stale', () => {
    expect(isStale(undefined, 'v1.8.0')).toBe(true)
  })

  test('empty array provenance is stale', () => {
    expect(isStale([], 'v1.8.0')).toBe(true)
  })

  test('current version is not stale', () => {
    const provenance: ProvenanceEntry[] = [
      { key: 'item1', producedBy: 'domain-inferencer', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]
    expect(isStale(provenance, 'v1.8.0')).toBe(false)
  })

  test('old version is stale', () => {
    const provenance: ProvenanceEntry[] = [
      { key: 'item1', producedBy: 'domain-inferencer', appVersion: 'v1.7.0', producedAt: '2026-05-10T10:00:00Z' },
    ]
    expect(isStale(provenance, 'v1.8.0')).toBe(true)
  })

  test('manual-only entries are never stale', () => {
    const provenance: ProvenanceEntry[] = [
      { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
      { key: 'manual2', producedBy: 'manual', appVersion: 'v1.2.0', producedAt: '2026-02-01T00:00:00Z' },
    ]
    expect(isStale(provenance, 'v1.8.0')).toBe(false)
  })

  test('mixed manual + current automated is not stale', () => {
    const provenance: ProvenanceEntry[] = [
      { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
      { key: 'auto1', producedBy: 'domain-inferencer', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]
    expect(isStale(provenance, 'v1.8.0')).toBe(false)
  })

  test('mixed manual + old automated is stale', () => {
    const provenance: ProvenanceEntry[] = [
      { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
      { key: 'auto1', producedBy: 'domain-inferencer', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
    ]
    expect(isStale(provenance, 'v1.8.0')).toBe(true)
  })
})

describe('provenance module — stamp()', () => {
  test('creates entries with correct structure', () => {
    const keys = ['item1', 'item2']
    const source = 'domain-inferencer'
    const version = 'v1.8.0'

    const result = stamp(keys, source, version)

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      key: 'item1',
      producedBy: source,
      appVersion: version,
    })
    expect(result[0].producedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(result[1]).toMatchObject({
      key: 'item2',
      producedBy: source,
      appVersion: version,
    })
  })

  test('empty keys array returns empty array', () => {
    const result = stamp([], 'domain-inferencer', 'v1.8.0')
    expect(result).toEqual([])
  })

  test('all entries have same timestamp within 1 second', () => {
    const keys = ['item1', 'item2', 'item3']
    const result = stamp(keys, 'brief-generator', 'v1.8.0')

    const timestamps = result.map(e => new Date(e.producedAt).getTime())
    const minTime = Math.min(...timestamps)
    const maxTime = Math.max(...timestamps)

    // All stamps within 1 second
    expect(maxTime - minTime).toBeLessThan(1000)
  })
})

describe('provenance module — merge()', () => {
  test('preserves manual entries', () => {
    const existing: ProvenanceEntry[] = [
      { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
      { key: 'auto1', producedBy: 'domain-inferencer', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
    ]
    const newEntries: ProvenanceEntry[] = [
      { key: 'auto1-new', producedBy: 'domain-inferencer', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
      { key: 'auto2-new', producedBy: 'domain-inferencer', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]

    const result = merge(existing, newEntries)

    // Manual entry preserved
    expect(result).toContainEqual(existing[0])
    // Automated entry replaced (not in result)
    expect(result.find(e => e.key === 'auto1')).toBeUndefined()
    // New entries added
    expect(result).toContainEqual(newEntries[0])
    expect(result).toContainEqual(newEntries[1])
    // Total: 1 manual + 2 new automated
    expect(result).toHaveLength(3)
  })

  test('undefined existing provenance is treated as empty', () => {
    const newEntries: ProvenanceEntry[] = [
      { key: 'auto1', producedBy: 'brief-generator', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]

    const result = merge(undefined, newEntries)

    expect(result).toEqual(newEntries)
  })

  test('empty existing provenance returns only new entries', () => {
    const newEntries: ProvenanceEntry[] = [
      { key: 'auto1', producedBy: 'product-radar', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]

    const result = merge([], newEntries)

    expect(result).toEqual(newEntries)
  })

  test('multiple manual entries are all preserved', () => {
    const existing: ProvenanceEntry[] = [
      { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
      { key: 'manual2', producedBy: 'manual', appVersion: 'v1.2.0', producedAt: '2026-02-01T00:00:00Z' },
      { key: 'auto1', producedBy: 'domain-inferencer', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
    ]
    const newEntries: ProvenanceEntry[] = [
      { key: 'auto-new', producedBy: 'domain-inferencer', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
    ]

    const result = merge(existing, newEntries)

    // Both manual entries preserved
    expect(result.filter(e => e.producedBy === 'manual')).toHaveLength(2)
    expect(result).toContainEqual(existing[0])
    expect(result).toContainEqual(existing[1])
    // Old automated entry removed
    expect(result.find(e => e.key === 'auto1')).toBeUndefined()
    // New entry added
    expect(result).toContainEqual(newEntries[0])
  })
})

describe('provenance module — buildHealPlan()', () => {
  interface TestItem {
    id: string
    provenance?: ProvenanceEntry[]
  }

  const getProvenance = (item: TestItem) => item.provenance

  test('filters to stale items only', () => {
    const items: TestItem[] = [
      {
        id: 'item1',
        provenance: [
          { key: 'data1', producedBy: 'processor', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
        ],
      },
      {
        id: 'item2',
        provenance: [
          { key: 'data2', producedBy: 'processor', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
        ],
      },
      {
        id: 'item3',
        provenance: undefined,
      },
    ]

    const result = buildHealPlan(items, getProvenance, 'v1.8.0')

    // item1: stale (v1.7.0)
    // item2: current (v1.8.0) — not in plan
    // item3: missing provenance — stale
    expect(result).toHaveLength(2)
    expect(result).toContainEqual(items[0])
    expect(result).toContainEqual(items[2])
    expect(result).not.toContainEqual(items[1])
  })

  test('skip predicate excludes items from plan', () => {
    const items: TestItem[] = [
      {
        id: 'item1',
        provenance: [
          { key: 'data1', producedBy: 'processor', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
        ],
      },
      {
        id: 'item2',
        provenance: undefined,
      },
    ]

    const skipPredicate = (item: TestItem) => item.id === 'item1'

    const result = buildHealPlan(items, getProvenance, 'v1.8.0', skipPredicate)

    // item1: stale but skipped by predicate
    // item2: stale and not skipped
    expect(result).toHaveLength(1)
    expect(result).toContainEqual(items[1])
    expect(result).not.toContainEqual(items[0])
  })

  test('manual-only items not in plan', () => {
    const items: TestItem[] = [
      {
        id: 'item1',
        provenance: [
          { key: 'manual1', producedBy: 'manual', appVersion: 'v1.0.0', producedAt: '2026-01-01T00:00:00Z' },
        ],
      },
      {
        id: 'item2',
        provenance: [
          { key: 'auto1', producedBy: 'processor', appVersion: 'v1.7.0', producedAt: '2026-05-01T10:00:00Z' },
        ],
      },
    ]

    const result = buildHealPlan(items, getProvenance, 'v1.8.0')

    // item1: manual-only — not stale
    // item2: stale automated
    expect(result).toHaveLength(1)
    expect(result).toContainEqual(items[1])
  })

  test('empty items array returns empty plan', () => {
    const result = buildHealPlan([], getProvenance, 'v1.8.0')
    expect(result).toEqual([])
  })

  test('all current items returns empty plan', () => {
    const items: TestItem[] = [
      {
        id: 'item1',
        provenance: [
          { key: 'data1', producedBy: 'processor', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
        ],
      },
      {
        id: 'item2',
        provenance: [
          { key: 'data2', producedBy: 'processor', appVersion: 'v1.8.0', producedAt: '2026-05-10T10:00:00Z' },
        ],
      },
    ]

    const result = buildHealPlan(items, getProvenance, 'v1.8.0')
    expect(result).toEqual([])
  })
})
