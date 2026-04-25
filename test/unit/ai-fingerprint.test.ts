// BKL-AI-FP-02: Unit tests for detectFingerprintDelta and computeBriefFingerprint
// Red-green TDD cycle: these tests were written before implementation.

import { describe, it, expect } from 'bun:test'
import { computeBriefFingerprint, detectFingerprintDelta, type BriefInputBundle } from '../../src/ai-fingerprint.ts'

const baseBundle: BriefInputBundle = {
  emailTuples: [
    { subject: 'Q2 review', sender: 'alice@acme.com', date: '2026-04-10' },
    { subject: 'Renewal check', sender: 'bob@acme.com', date: '2026-04-05' },
  ],
  meetingTuples: [
    { title: 'QBR', attendees: ['alice@acme.com', 'bob@acme.com'], date: '2026-04-15' },
  ],
  ccspTier: 'advanced',
  pipelineStage: 'proposal',
  openCaseCounts: { '1': 2, '2': 1 },
  preferencesHash: 'abc123',
}

describe('computeBriefFingerprint', () => {
  it('returns a 32-char hex string', () => {
    const fp = computeBriefFingerprint(baseBundle)
    expect(fp).toHaveLength(32)
    expect(fp).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic for the same bundle', () => {
    const fp1 = computeBriefFingerprint(baseBundle)
    const fp2 = computeBriefFingerprint(baseBundle)
    expect(fp1).toBe(fp2)
  })

  it('is deterministic regardless of email input order', () => {
    // emails sorted by date desc internally — order of input array should not matter
    const shuffled: BriefInputBundle = {
      ...baseBundle,
      emailTuples: [...baseBundle.emailTuples].reverse(),
    }
    expect(computeBriefFingerprint(baseBundle)).toBe(computeBriefFingerprint(shuffled))
  })

  it('is deterministic regardless of attendee order in meetings', () => {
    const reorderedAttendees: BriefInputBundle = {
      ...baseBundle,
      meetingTuples: [
        { title: 'QBR', attendees: ['bob@acme.com', 'alice@acme.com'], date: '2026-04-15' },
      ],
    }
    expect(computeBriefFingerprint(baseBundle)).toBe(computeBriefFingerprint(reorderedAttendees))
  })
})

describe('detectFingerprintDelta', () => {
  it('cold cache (no previous) → changed:true, delta:[cold-cache]', () => {
    const result = detectFingerprintDelta(null, baseBundle)
    expect(result.changed).toBe(true)
    expect(result.delta).toEqual(['cold-cache'])
    expect(result.newFingerprint).toHaveLength(32)
  })

  it('undefined previous → changed:true, delta:[cold-cache]', () => {
    const result = detectFingerprintDelta(undefined, baseBundle)
    expect(result.changed).toBe(true)
    expect(result.delta).toEqual(['cold-cache'])
  })

  it('identical bundle → changed:false, no delta', () => {
    const fp = computeBriefFingerprint(baseBundle)
    const result = detectFingerprintDelta(fp, baseBundle)
    expect(result.changed).toBe(false)
    expect(result.delta).toBeUndefined()
    expect(result.newFingerprint).toBe(fp)
  })

  it('email added → changed:true', () => {
    const bundleWithExtra: BriefInputBundle = {
      ...baseBundle,
      emailTuples: [
        ...baseBundle.emailTuples,
        { subject: 'New thread', sender: 'carol@acme.com', date: '2026-04-12' },
      ],
    }
    const fp = computeBriefFingerprint(baseBundle)
    const result = detectFingerprintDelta(fp, bundleWithExtra)
    expect(result.changed).toBe(true)
    expect(result.delta).toEqual(['input-changed'])
  })

  it('meeting title changed → changed:true', () => {
    const bundleModifiedMeeting: BriefInputBundle = {
      ...baseBundle,
      meetingTuples: [
        { title: 'EBR', attendees: ['alice@acme.com', 'bob@acme.com'], date: '2026-04-15' },
      ],
    }
    const fp = computeBriefFingerprint(baseBundle)
    const result = detectFingerprintDelta(fp, bundleModifiedMeeting)
    expect(result.changed).toBe(true)
  })

  it('case count changed → changed:true', () => {
    const bundleMoreCases: BriefInputBundle = {
      ...baseBundle,
      openCaseCounts: { '1': 3, '2': 1 },
    }
    const fp = computeBriefFingerprint(baseBundle)
    const result = detectFingerprintDelta(fp, bundleMoreCases)
    expect(result.changed).toBe(true)
  })

  it('fingerprint is stable across equivalent bundles (deterministic)', () => {
    // Same data, different JS object instances — fingerprint must be identical
    const bundle1: BriefInputBundle = {
      emailTuples: [{ subject: 'Hello', sender: 'x@y.com', date: '2026-01-01' }],
      meetingTuples: [{ title: 'Sync', attendees: ['x@y.com'], date: '2026-01-02' }],
      ccspTier: null,
      pipelineStage: null,
      openCaseCounts: {},
      preferencesHash: '',
    }
    const bundle2: BriefInputBundle = JSON.parse(JSON.stringify(bundle1))
    expect(computeBriefFingerprint(bundle1)).toBe(computeBriefFingerprint(bundle2))
  })
})
