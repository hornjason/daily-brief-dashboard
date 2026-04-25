// TEST-P3-02 Phase 7 mutation-killing tests — targets exact mutant survivors on
// computeBriefFingerprint / detectFingerprintDelta / diffDocCorpus / shouldUseDeltaMode.
// Runtime: bun:test (project uses Bun's native test runner; no vitest).

import { describe, it, expect } from 'bun:test'
import {
  computeBriefFingerprint,
  detectFingerprintDelta,
  diffDocCorpus,
  shouldUseDeltaMode,
  type BriefInputBundle,
  type DocCorpusDiff,
} from '../../src/ai-fingerprint.ts'

const BASE_BUNDLE: BriefInputBundle = {
  emailTuples: [{ subject: 'A', sender: 'a@x.com', date: '2026-04-01' }],
  meetingTuples: [{ title: 'Sync', attendees: ['a', 'b'], date: '2026-04-02' }],
  ccspTier: 'gold',
  pipelineStage: 'Negotiate',
  openCaseCounts: { P1: 2, P2: 1 },
  preferencesHash: 'abc123',
}

describe('computeBriefFingerprint', () => {
  it('returns a 32-char hex string', () => {
    const fp = computeBriefFingerprint(BASE_BUNDLE)
    expect(fp).toHaveLength(32)
    expect(fp).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic — same input same output', () => {
    expect(computeBriefFingerprint(BASE_BUNDLE)).toBe(computeBriefFingerprint(BASE_BUNDLE))
  })

  it('changes when email subject changes', () => {
    const b2 = { ...BASE_BUNDLE, emailTuples: [{ subject: 'B', sender: 'a@x.com', date: '2026-04-01' }] }
    expect(computeBriefFingerprint(BASE_BUNDLE)).not.toBe(computeBriefFingerprint(b2))
  })

  it('changes when ccspTier changes', () => {
    const b2 = { ...BASE_BUNDLE, ccspTier: 'silver' }
    expect(computeBriefFingerprint(BASE_BUNDLE)).not.toBe(computeBriefFingerprint(b2))
  })

  it('handles null ccspTier and pipelineStage without throwing', () => {
    const b2 = { ...BASE_BUNDLE, ccspTier: null, pipelineStage: null }
    expect(() => computeBriefFingerprint(b2)).not.toThrow()
  })

  it('null ccspTier produces different fingerprint than empty string', () => {
    const withNull = { ...BASE_BUNDLE, ccspTier: null }
    const withEmpty = { ...BASE_BUNDLE, ccspTier: '' }
    // null coalesces to the string 'null'; '' stays '' — they must differ.
    expect(computeBriefFingerprint(withNull)).not.toBe(computeBriefFingerprint(withEmpty))
  })

  it('email order does not affect fingerprint (sort by date)', () => {
    const b1 = { ...BASE_BUNDLE, emailTuples: [
      { subject: 'A', sender: 'a@x.com', date: '2026-04-01' },
      { subject: 'B', sender: 'b@x.com', date: '2026-04-02' },
    ]}
    const b2 = { ...BASE_BUNDLE, emailTuples: [
      { subject: 'B', sender: 'b@x.com', date: '2026-04-02' },
      { subject: 'A', sender: 'a@x.com', date: '2026-04-01' },
    ]}
    expect(computeBriefFingerprint(b1)).toBe(computeBriefFingerprint(b2))
  })

  it('meeting attendee order does not affect fingerprint (attendees sorted)', () => {
    const b1 = { ...BASE_BUNDLE, meetingTuples: [{ title: 'Sync', attendees: ['a', 'b'], date: '2026-04-02' }] }
    const b2 = { ...BASE_BUNDLE, meetingTuples: [{ title: 'Sync', attendees: ['b', 'a'], date: '2026-04-02' }] }
    expect(computeBriefFingerprint(b1)).toBe(computeBriefFingerprint(b2))
  })

  it('changes when openCaseCounts changes', () => {
    const b2 = { ...BASE_BUNDLE, openCaseCounts: { P1: 3, P2: 1 } }
    expect(computeBriefFingerprint(BASE_BUNDLE)).not.toBe(computeBriefFingerprint(b2))
  })
})

describe('detectFingerprintDelta', () => {
  it('cold-cache: null previousFingerprint → changed=true, delta=cold-cache', () => {
    const result = detectFingerprintDelta(null, BASE_BUNDLE)
    expect(result.changed).toBe(true)
    expect(result.delta).toContain('cold-cache')
  })

  it('cold-cache: undefined previousFingerprint → changed=true, delta=cold-cache', () => {
    const result = detectFingerprintDelta(undefined, BASE_BUNDLE)
    expect(result.changed).toBe(true)
    expect(result.delta).toContain('cold-cache')
  })

  it('cache-hit: same fingerprint → changed=false, no delta array', () => {
    const fp = computeBriefFingerprint(BASE_BUNDLE)
    const result = detectFingerprintDelta(fp, BASE_BUNDLE)
    expect(result.changed).toBe(false)
    expect(result.delta).toBeUndefined()
  })

  it('cache-miss: different fingerprint → changed=true, delta=input-changed', () => {
    const result = detectFingerprintDelta('000000000000000000000000000000000', BASE_BUNDLE)
    expect(result.changed).toBe(true)
    expect(result.delta).toContain('input-changed')
  })

  it('always returns newFingerprint regardless of cache state', () => {
    const fp = computeBriefFingerprint(BASE_BUNDLE)
    expect(detectFingerprintDelta(null, BASE_BUNDLE).newFingerprint).toBe(fp)
    expect(detectFingerprintDelta(fp, BASE_BUNDLE).newFingerprint).toBe(fp)
    expect(detectFingerprintDelta('old', BASE_BUNDLE).newFingerprint).toBe(fp)
  })
})

describe('diffDocCorpus', () => {
  it('empty prev + empty curr → all empty arrays', () => {
    const diff = diffDocCorpus({}, {})
    expect(diff.newDocs).toHaveLength(0)
    expect(diff.changedDocs).toHaveLength(0)
    expect(diff.removedDocs).toHaveLength(0)
    expect(diff.unchangedDocs).toHaveLength(0)
  })

  it('new doc in curr not in prev → appears in newDocs', () => {
    const diff = diffDocCorpus({}, { 'doc-1': '2026-04-01' })
    expect(diff.newDocs).toContain('doc-1')
    expect(diff.changedDocs).toHaveLength(0)
    expect(diff.removedDocs).toHaveLength(0)
  })

  it('doc removed from curr → appears in removedDocs', () => {
    const diff = diffDocCorpus({ 'doc-1': '2026-04-01' }, {})
    expect(diff.removedDocs).toContain('doc-1')
    expect(diff.newDocs).toHaveLength(0)
  })

  it('doc with same modifiedTime → appears in unchangedDocs not changedDocs', () => {
    const diff = diffDocCorpus({ 'doc-1': '2026-04-01' }, { 'doc-1': '2026-04-01' })
    expect(diff.unchangedDocs).toContain('doc-1')
    expect(diff.changedDocs).toHaveLength(0)
  })

  it('doc with different modifiedTime → appears in changedDocs not unchangedDocs', () => {
    const diff = diffDocCorpus({ 'doc-1': '2026-04-01' }, { 'doc-1': '2026-04-02' })
    expect(diff.changedDocs).toContain('doc-1')
    expect(diff.unchangedDocs).toHaveLength(0)
  })

  it('mixed state: new, changed, removed, unchanged all correct', () => {
    const prev = { 'a': 't1', 'b': 't1', 'c': 't1' }
    const curr = { 'a': 't1', 'b': 't2', 'd': 't3' }  // a=unchanged, b=changed, c=removed, d=new
    const diff = diffDocCorpus(prev, curr)
    expect(diff.unchangedDocs).toContain('a')
    expect(diff.changedDocs).toContain('b')
    expect(diff.removedDocs).toContain('c')
    expect(diff.newDocs).toContain('d')
  })
})

describe('shouldUseDeltaMode — truth table (lines 88-92)', () => {
  const makeDiff = (unchanged: number, newOrChanged: number): DocCorpusDiff => ({
    unchangedDocs: Array(unchanged).fill('x').map((_, i) => `u${i}`),
    newDocs: Array(Math.ceil(newOrChanged / 2)).fill('x').map((_, i) => `n${i}`),
    changedDocs: Array(Math.floor(newOrChanged / 2)).fill('x').map((_, i) => `c${i}`),
    removedDocs: [],
  })

  // hasPreviousBrief = false → always false
  it('no previous brief → false regardless of diff', () => {
    expect(shouldUseDeltaMode(makeDiff(5, 2), false)).toBe(false)
    expect(shouldUseDeltaMode(makeDiff(0, 0), false)).toBe(false)
  })

  // unchangedDocs < 3 → false
  it('fewer than 3 unchanged docs → false', () => {
    expect(shouldUseDeltaMode(makeDiff(0, 1), true)).toBe(false)
    expect(shouldUseDeltaMode(makeDiff(1, 1), true)).toBe(false)
    expect(shouldUseDeltaMode(makeDiff(2, 1), true)).toBe(false)
  })

  // unchangedDocs >= 3 but no new/changed → false
  it('3+ unchanged but no new/changed docs → false', () => {
    expect(shouldUseDeltaMode(makeDiff(3, 0), true)).toBe(false)
    expect(shouldUseDeltaMode(makeDiff(10, 0), true)).toBe(false)
  })

  // all conditions met → true
  it('3+ unchanged AND 1+ new/changed AND hasPreviousBrief → true', () => {
    expect(shouldUseDeltaMode(makeDiff(3, 1), true)).toBe(true)
    expect(shouldUseDeltaMode(makeDiff(5, 2), true)).toBe(true)
    expect(shouldUseDeltaMode(makeDiff(10, 3), true)).toBe(true)
  })

  // boundary: exactly 3 unchanged, exactly 1 new → true
  it('boundary condition: exactly 3 unchanged + 1 new → true', () => {
    expect(shouldUseDeltaMode(makeDiff(3, 1), true)).toBe(true)
  })
})
