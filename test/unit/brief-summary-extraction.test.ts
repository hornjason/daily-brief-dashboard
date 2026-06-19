/**
 * REG-036: extractBriefSummary handles both old (Account Overview) and new (Priority Action) schema formats (#843)
 *
 * Bug: extractBriefSummary() regex only matches '## Account Overview' but the new
 * BRIEF_RESPONSE_SCHEMA generates briefs starting with '## Priority Action'. This causes
 * EMPTY collapsed brief cards in the UI for any customer with a newly-generated brief.
 */
import { describe, test, expect } from 'bun:test'
import { extractBriefSummary } from '../../src/customer-service'

const OLD_FORMAT_BRIEF = `## Account Overview
This is the account overview for Acme Corp. They are a large enterprise customer with significant Red Hat investment.

## Talking Points & Prep (Jun 18, 2026)
- Discuss upcoming renewal timeline
- Review expansion into OpenShift
- Address support case backlog

## Open Support Cases
3 open cases, 1 critical (case #12345 — cluster upgrade failure)

## Pipeline
$2.1M in active opportunities
`

const NEW_FORMAT_BRIEF = `## Priority Action
Urgent: Schedule executive briefing before Q3 renewal. Customer evaluating Azure alternatives.

## What Changed
- New CTO appointed last week
- 2 support cases escalated to severity 1
- Competitor POC detected in IT procurement

## Talking Points & Prep (Jun 18, 2026)
- Address CTO concerns about hybrid cloud strategy
- Present OpenShift vs AKS comparison
- Propose executive sponsor alignment

## Open Support Cases
2 critical cases requiring immediate attention
`

describe('REG-036: extractBriefSummary handles both brief schema formats (#843)', () => {
  test('returns non-empty overview for old format (## Account Overview)', () => {
    const result = extractBriefSummary(OLD_FORMAT_BRIEF)
    expect(result.overview).toBeTruthy()
    expect(result.overview).toContain('Acme Corp')
  })

  test('returns non-empty overview for new format (## Priority Action)', () => {
    const result = extractBriefSummary(NEW_FORMAT_BRIEF)
    expect(result.overview).toBeTruthy()
    expect(result.overview).toContain('executive briefing')
  })

  test('talking points extracted from both formats', () => {
    const oldResult = extractBriefSummary(OLD_FORMAT_BRIEF)
    const newResult = extractBriefSummary(NEW_FORMAT_BRIEF)
    expect(oldResult.talkingPoints.length).toBeGreaterThan(0)
    expect(newResult.talkingPoints.length).toBeGreaterThan(0)
  })

  test('open cases note extracted from both formats', () => {
    const oldResult = extractBriefSummary(OLD_FORMAT_BRIEF)
    const newResult = extractBriefSummary(NEW_FORMAT_BRIEF)
    expect(oldResult.openCasesNote).toBeTruthy()
    expect(newResult.openCasesNote).toBeTruthy()
  })

  test('return type structure is preserved for both formats', () => {
    const oldResult = extractBriefSummary(OLD_FORMAT_BRIEF)
    const newResult = extractBriefSummary(NEW_FORMAT_BRIEF)
    for (const result of [oldResult, newResult]) {
      expect(typeof result.overview).toBe('string')
      expect(Array.isArray(result.talkingPoints)).toBe(true)
      expect(typeof result.openCasesNote).toBe('string')
    }
  })
})
