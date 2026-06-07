/**
 * test/unit/carry-forward.test.ts
 * Tests for carry-forward escalation logic (#646)
 *
 * Covers:
 * - AC-3: computeEscalation returns consecutive count, firstRecommendedAt, evidence delta
 * - AC-5: first-time recommendations produce no escalation
 * - AC-6: repeated play produces correct consecutive count
 * - AC-7: new evidence since last prep appears in delta
 */
import { describe, it, expect } from 'bun:test'
import {
  computeEscalation,
  type RecommendedPlay,
  type EvidenceBlock,
} from '../../src/lib/carry-forward.ts'
import type { PrepHistoryEntry } from '../../src/meeting-prep-service.ts'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeBlock(playName: string, score: number, evidence: string[] = []): EvidenceBlock {
  return {
    playName,
    compositeScore: score,
    evidenceTrail: evidence.map(fact => ({ fact, source: 'test', recency: 'current' })),
    availableLevers: [],
    teamContext: 'SSP Test',
    proposedAsk: 'Ask something',
  }
}

function makeHistory(
  plays: RecommendedPlay[],
  generatedAt: string,
  recurringEventId: string = 'series-1',
): PrepHistoryEntry {
  return {
    meetingTitle: 'Weekly Sync',
    meetingStart: generatedAt,
    docUrl: 'https://docs.google.com/doc/1',
    title: 'Prep: Weekly Sync',
    generatedAt,
    customerName: 'Acme Corp',
    recurringEventId,
    recommendedPlays: plays,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('computeEscalation', () => {
  it('AC-5: returns empty map for first-time recommendations (no history)', () => {
    const currentBlocks = [makeBlock('RHEL Migration', 0.85)]
    const history: PrepHistoryEntry[] = []
    const result = computeEscalation(currentBlocks, history, 'series-1')
    expect(result.size).toBe(0)
  })

  it('AC-5: returns empty map when history has no recommendedPlays', () => {
    const currentBlocks = [makeBlock('RHEL Migration', 0.85)]
    const history: PrepHistoryEntry[] = [
      makeHistory([], '2026-05-01T10:00:00Z'),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    expect(result.size).toBe(0)
  })

  it('AC-6: repeated play produces correct consecutive count of 2', () => {
    const currentBlocks = [makeBlock('RHEL Migration', 0.85)]
    const history: PrepHistoryEntry[] = [
      makeHistory(
        [{ playName: 'RHEL Migration', compositeScore: 0.80 }],
        '2026-05-01T10:00:00Z',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    expect(result.has('RHEL Migration')).toBe(true)
    const esc = result.get('RHEL Migration')!
    expect(esc.consecutiveCount).toBe(2) // once in history + current
    expect(esc.firstRecommendedAt).toBe('2026-05-01T10:00:00Z')
  })

  it('AC-6: three consecutive preps produce count of 3', () => {
    const currentBlocks = [makeBlock('OpenShift AI', 0.90)]
    const history: PrepHistoryEntry[] = [
      makeHistory(
        [{ playName: 'OpenShift AI', compositeScore: 0.88 }],
        '2026-05-15T10:00:00Z',
      ),
      makeHistory(
        [{ playName: 'OpenShift AI', compositeScore: 0.82, firstRecommendedAt: '2026-05-01T10:00:00Z' }],
        '2026-05-08T10:00:00Z',
      ),
      makeHistory(
        [{ playName: 'OpenShift AI', compositeScore: 0.80 }],
        '2026-05-01T10:00:00Z',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    const esc = result.get('OpenShift AI')!
    expect(esc.consecutiveCount).toBe(4) // 3 in history + current
    expect(esc.firstRecommendedAt).toBe('2026-05-01T10:00:00Z')
  })

  it('AC-6: broken streak resets count', () => {
    const currentBlocks = [makeBlock('Ansible AAP', 0.75)]
    const history: PrepHistoryEntry[] = [
      // Most recent: Ansible AAP NOT present → breaks streak
      makeHistory(
        [{ playName: 'RHEL Migration', compositeScore: 0.80 }],
        '2026-05-15T10:00:00Z',
      ),
      // Older: Ansible AAP present
      makeHistory(
        [{ playName: 'Ansible AAP', compositeScore: 0.70 }],
        '2026-05-08T10:00:00Z',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    // The most recent history entry doesn't have Ansible AAP → no streak
    expect(result.has('Ansible AAP')).toBe(false)
  })

  it('AC-7: new evidence since first recommendation appears in delta', () => {
    const currentBlocks = [
      makeBlock('RHEL Migration', 0.90, [
        '47 RHEL 7 subs expiring 2027-06-30',
        'New: Sev1 case opened on RHEL 7 compat issue',
      ]),
    ]
    const history: PrepHistoryEntry[] = [
      makeHistory(
        [{
          playName: 'RHEL Migration',
          compositeScore: 0.80,
          firstRecommendedAt: '2026-04-01T10:00:00Z',
        }],
        '2026-05-01T10:00:00Z',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    const esc = result.get('RHEL Migration')!
    // Evidence delta should contain the current evidence facts
    expect(esc.evidenceDelta.length).toBeGreaterThan(0)
    expect(esc.evidenceDelta).toContain('47 RHEL 7 subs expiring 2027-06-30')
    expect(esc.evidenceDelta).toContain('New: Sev1 case opened on RHEL 7 compat issue')
  })

  it('only considers history entries matching the same recurringEventId', () => {
    const currentBlocks = [makeBlock('RHEL Migration', 0.85)]
    const history: PrepHistoryEntry[] = [
      // Different series
      makeHistory(
        [{ playName: 'RHEL Migration', compositeScore: 0.80 }],
        '2026-05-01T10:00:00Z',
        'different-series',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    expect(result.size).toBe(0)
  })

  it('AC-3: returns urgencyChange describing time progression', () => {
    const currentBlocks = [makeBlock('RHEL Migration', 0.90)]
    const history: PrepHistoryEntry[] = [
      makeHistory(
        [{
          playName: 'RHEL Migration',
          compositeScore: 0.80,
          firstRecommendedAt: '2026-04-01T10:00:00Z',
        }],
        '2026-05-01T10:00:00Z',
      ),
    ]
    const result = computeEscalation(currentBlocks, history, 'series-1')
    const esc = result.get('RHEL Migration')!
    expect(typeof esc.urgencyChange).toBe('string')
    expect(esc.urgencyChange.length).toBeGreaterThan(0)
  })
})
