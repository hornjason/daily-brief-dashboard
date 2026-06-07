/**
 * test/unit/meeting-prep-validation.test.ts
 * Unit tests for post-generation validation in meeting prep (#643)
 *
 * TDD Red Phase: Tests written first, expected to FAIL until implementation.
 */

import { describe, it, expect } from 'bun:test'
import {
  validateMeetingPrepOutput,
  type ValidationResult,
} from '../../src/lib/meeting-prep-validation.ts'
import type { EvidenceBlock, EvidenceItem, Lever } from '../../src/lib/evidence-block-builder.ts'
import type { AccountTeamMember } from '../../src/types.ts'

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeEvidenceBlock(overrides: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    playName: 'RHEL Migration',
    compositeScore: 0.85,
    evidenceTrail: [
      { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', source: 'subscriptions', recency: 'current' },
      { fact: 'Case 12345678: kernel panic on RHEL 7.9', source: 'cases', recency: '2d ago' },
    ],
    availableLevers: [
      { name: 'AWS migration credit 25%', description: 'Migration credit', url: 'https://aws.example.com', source: 'cloud-marketplace', validThrough: '2026-12-31' },
    ],
    teamContext: 'Carol Davis (RHEL SSP)',
    proposedAsk: 'Schedule POC for RHEL 9 migration',
    ...overrides,
  }
}

const mockTeam: AccountTeamMember[] = [
  { name: 'Alice Johnson', title: 'Account Executive', role: 'ae' },
  { name: 'Bob Smith', title: 'Account Solution Architect', role: 'asa' },
  { name: 'Carol Davis', title: 'RHEL SSP', role: 'ssp' },
]

// ── Tests ───────────────────────────────────────────────────────────────────

describe('validateMeetingPrepOutput()', () => {
  const evidenceBlocks = [makeEvidenceBlock()]

  it('returns valid when output uses only real data', () => {
    const output = `
## Meeting Objective
Push RHEL 9 migration because 47 RHEL 7 subscriptions hit EOS 2027-06-30.

## Recommended Plays
### RHEL Migration
Case 12345678 shows kernel panic issues on RHEL 7.9.
Carol Davis (RHEL SSP) should lead the technical discussion.
Alice Johnson to coordinate with procurement.
$150,000 renewal opportunity.
    `.trim()

    // Only case numbers and dollar amounts that exist in evidence blocks
    const result = validateMeetingPrepOutput(output, [
      makeEvidenceBlock({
        evidenceTrail: [
          { fact: '47 RHEL 7 subscriptions, EOS 2027-06-30', source: 'subscriptions', recency: 'current' },
          { fact: 'Case 12345678: kernel panic on RHEL 7.9', source: 'cases', recency: '2d ago' },
          { fact: '$150,000 renewal due 2026-09-15', source: 'pipeline', recency: 'current' },
        ],
        availableLevers: [],
        teamContext: 'Carol Davis (RHEL SSP)',
        proposedAsk: 'Schedule POC',
      }),
    ], mockTeam)

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('AC-9: catches fabricated case numbers not in input', () => {
    const output = `
## Recommended Plays
Case 12345678 is a real case.
Case 99999999 is fabricated by Gemini.
Case 87654321 is also fabricated.
    `.trim()

    const result = validateMeetingPrepOutput(output, evidenceBlocks, mockTeam)

    expect(result.valid).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some(w => w.includes('99999999'))).toBe(true)
    expect(result.warnings.some(w => w.includes('87654321'))).toBe(true)
    // Real case 12345678 should NOT trigger a warning
    expect(result.warnings.some(w => w.includes('12345678'))).toBe(false)
  })

  it('AC-10: catches fabricated dollar amounts not in input', () => {
    const output = `
## Recommended Plays
The $150,000 renewal is real data.
But $5,000,000 is fabricated.
And $2.5M is also fabricated.
    `.trim()

    const blocksWithDollar = [makeEvidenceBlock({
      evidenceTrail: [
        { fact: '$150,000 renewal due 2026-09-15', source: 'pipeline', recency: 'current' },
      ],
    })]

    const result = validateMeetingPrepOutput(output, blocksWithDollar, mockTeam)

    expect(result.valid).toBe(false)
    expect(result.warnings.some(w => w.includes('5,000,000') || w.includes('5000000'))).toBe(true)
  })

  it('AC-11: catches fabricated person names not in input', () => {
    const output = `
## Who is in the Room
Alice Johnson will lead the discussion.
Bob Smith provides technical depth.
Dr. Fabricated McPerson is the VP of Engineering.
    `.trim()

    const result = validateMeetingPrepOutput(output, evidenceBlocks, mockTeam)

    expect(result.valid).toBe(false)
    expect(result.warnings.some(w => w.includes('Fabricated McPerson') || w.includes('Dr. Fabricated'))).toBe(true)
  })

  it('returns valid true with empty warnings when no fabrication detected', () => {
    const output = `
## Meeting Objective
Discuss RHEL migration with the account team.

## Recommended Plays
Carol Davis should present the migration path.
Alice Johnson will handle procurement coordination.
    `.trim()

    const result = validateMeetingPrepOutput(output, evidenceBlocks, mockTeam)

    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('handles empty output gracefully', () => {
    const result = validateMeetingPrepOutput('', evidenceBlocks, mockTeam)
    expect(result.valid).toBe(true) // Empty output has nothing fabricated
    expect(result.warnings).toHaveLength(0)
  })

  it('handles empty evidence blocks gracefully', () => {
    const output = 'Some content with case 12345678'
    const result = validateMeetingPrepOutput(output, [], mockTeam)
    // With no evidence to validate against, case numbers are flagged
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
