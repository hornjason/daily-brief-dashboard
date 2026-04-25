// BKL-AI-FP-09: Unit tests for diffDocCorpus and shouldUseDeltaMode
// Red-green TDD cycle: these tests validate the corpus delta detection pure functions.

import { describe, it, expect } from 'bun:test'
import { diffDocCorpus, shouldUseDeltaMode, type DocCorpusDiff } from '../../src/ai-fingerprint.ts'

// ── diffDocCorpus tests ───────────────────────────────────────────────────────

describe('diffDocCorpus', () => {
  it('all new: empty prev → all fileIds go to newDocs', () => {
    const curr = { 'file-1': '2026-04-01', 'file-2': '2026-04-02' }
    const result = diffDocCorpus({}, curr)
    expect(result.newDocs).toEqual(expect.arrayContaining(['file-1', 'file-2']))
    expect(result.newDocs).toHaveLength(2)
    expect(result.changedDocs).toHaveLength(0)
    expect(result.removedDocs).toHaveLength(0)
    expect(result.unchangedDocs).toHaveLength(0)
  })

  it('identical corpus → all fileIds go to unchangedDocs', () => {
    const snapshot = { 'file-1': '2026-04-01', 'file-2': '2026-04-02', 'file-3': '2026-04-03' }
    const result = diffDocCorpus(snapshot, { ...snapshot })
    expect(result.unchangedDocs).toEqual(expect.arrayContaining(['file-1', 'file-2', 'file-3']))
    expect(result.unchangedDocs).toHaveLength(3)
    expect(result.newDocs).toHaveLength(0)
    expect(result.changedDocs).toHaveLength(0)
    expect(result.removedDocs).toHaveLength(0)
  })

  it('one modifiedTime changed → that fileId goes to changedDocs', () => {
    const prev = { 'file-1': '2026-04-01', 'file-2': '2026-04-02' }
    const curr = { 'file-1': '2026-04-10', 'file-2': '2026-04-02' }
    const result = diffDocCorpus(prev, curr)
    expect(result.changedDocs).toEqual(['file-1'])
    expect(result.unchangedDocs).toEqual(['file-2'])
    expect(result.newDocs).toHaveLength(0)
    expect(result.removedDocs).toHaveLength(0)
  })

  it('one removed: fileId in prev but not curr → goes to removedDocs', () => {
    const prev = { 'file-1': '2026-04-01', 'file-2': '2026-04-02' }
    const curr = { 'file-1': '2026-04-01' }
    const result = diffDocCorpus(prev, curr)
    expect(result.removedDocs).toEqual(['file-2'])
    expect(result.unchangedDocs).toEqual(['file-1'])
    expect(result.newDocs).toHaveLength(0)
    expect(result.changedDocs).toHaveLength(0)
  })
})

// ── shouldUseDeltaMode activation gate tests ──────────────────────────────────

describe('shouldUseDeltaMode', () => {
  const makeDiff = (overrides: Partial<DocCorpusDiff>): DocCorpusDiff => ({
    newDocs: [],
    changedDocs: [],
    removedDocs: [],
    unchangedDocs: [],
    ...overrides,
  })

  it('gate: unchangedCount=2 (below threshold) → returns false (full-run)', () => {
    const diff = makeDiff({ unchangedDocs: ['a', 'b'], changedDocs: ['c'] })
    expect(shouldUseDeltaMode(diff, true)).toBe(false)
  })

  it('gate: unchangedCount=3 + 0 changed/new → returns false (no delta to apply)', () => {
    const diff = makeDiff({ unchangedDocs: ['a', 'b', 'c'] })
    expect(shouldUseDeltaMode(diff, true)).toBe(false)
  })

  it('gate: unchangedCount=3 + 1 changed + hasPreviousBrief → returns true (delta)', () => {
    const diff = makeDiff({ unchangedDocs: ['a', 'b', 'c'], changedDocs: ['d'] })
    expect(shouldUseDeltaMode(diff, true)).toBe(true)
  })

  it('gate: unchangedCount=5 + 1 changed + no previousBrief → returns false (need prev brief)', () => {
    const diff = makeDiff({ unchangedDocs: ['a', 'b', 'c', 'd', 'e'], changedDocs: ['f'] })
    expect(shouldUseDeltaMode(diff, false)).toBe(false)
  })

  it('gate: unchangedCount=3 + 1 new (not changed) + hasPreviousBrief → returns true', () => {
    const diff = makeDiff({ unchangedDocs: ['a', 'b', 'c'], newDocs: ['d'] })
    expect(shouldUseDeltaMode(diff, true)).toBe(true)
  })
})
