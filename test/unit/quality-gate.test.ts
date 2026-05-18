/**
 * Unit tests for gemini-quality-gate.ts — validateAndRetry loop
 *
 * Tests: pass first try, pass after retry, best-of-3 when all fail,
 * retryFn failure handling.
 */

import { describe, it, expect, mock } from 'bun:test'
import {
  validateAndRetry,
  buildScorecard,
  countTableRows,
  extractNumberedSection,
  hasSpecificNames,
  formatFailureFeedback,
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
} from '../../src/gemini-quality-gate.ts'

// ── Test helpers ────────────────────────────────────────────────────────────

function makeValidator(scores: number[], threshold = 70): QualityValidator {
  let callIndex = 0
  return {
    contentType: 'test',
    passThreshold: threshold,
    validate(output: string): QualityScorecard {
      const score = scores[callIndex] ?? scores[scores.length - 1]
      callIndex++
      // Generate checks that produce the exact requested score percentage
      // Use 10 checks and pass the right number to hit the score
      const totalChecks = 10
      const passCount = Math.round((score / 100) * totalChecks)
      const checks: QualityCheck[] = []
      for (let i = 0; i < totalChecks; i++) {
        checks.push({
          name: `check-${i}`,
          passed: i < passCount,
          expected: `check ${i} should pass`,
          actual: i < passCount ? 'passed' : 'failed',
          severity: 'required' as const,
        })
      }
      return buildScorecard('test', threshold, checks)
    },
  }
}

// ── validateAndRetry tests ──────────────────────────────────────────────────

describe('validateAndRetry', () => {
  it('passes on first attempt when score meets threshold', async () => {
    const validator = makeValidator([100])
    const retryFn = mock(() => Promise.resolve('retry output'))

    const result = await validateAndRetry('good output', { validator }, retryFn)

    expect(result.output).toBe('good output')
    expect(result.scorecard.passed).toBe(true)
    expect(result.attempts).toBe(1)
    expect(result.retriesExhausted).toBe(false)
    expect(retryFn).not.toHaveBeenCalled()
  })

  it('retries and passes on second attempt', async () => {
    const validator = makeValidator([40, 80])
    const retryFn = mock(() => Promise.resolve('improved output'))

    const result = await validateAndRetry('bad output', { validator }, retryFn)

    expect(result.output).toBe('improved output')
    expect(result.scorecard.passed).toBe(true)
    expect(result.attempts).toBe(2)
    expect(result.retriesExhausted).toBe(false)
    expect(retryFn).toHaveBeenCalledTimes(1)
  })

  it('returns best attempt when all 3 fail', async () => {
    // Scores: 30, 60, 40 — best is attempt 2 (score 60)
    const validator = makeValidator([30, 60, 40])
    let callCount = 0
    const retryFn = mock(() => {
      callCount++
      return Promise.resolve(`retry output ${callCount}`)
    })

    const result = await validateAndRetry('initial', { validator }, retryFn)

    expect(result.retriesExhausted).toBe(true)
    expect(result.scorecard.passed).toBe(false)
    expect(result.output).toBe('retry output 1') // attempt 2 had score 60 (best)
    expect(retryFn).toHaveBeenCalledTimes(2) // 2 retries
  })

  it('handles retryFn failure gracefully', async () => {
    const validator = makeValidator([40])
    const retryFn = mock(() => Promise.reject(new Error('Gemini API timeout')))

    const result = await validateAndRetry('original', { validator }, retryFn)

    expect(result.output).toBe('original')
    expect(result.retriesExhausted).toBe(true)
    expect(result.scorecard.passed).toBe(false)
  })

  it('respects maxRetries option', async () => {
    const validator = makeValidator([40, 40])
    const retryFn = mock(() => Promise.resolve('retry'))

    const result = await validateAndRetry('original', { validator, maxRetries: 1 }, retryFn)

    expect(retryFn).toHaveBeenCalledTimes(1) // only 1 retry
    expect(result.retriesExhausted).toBe(true)
  })

  it('passes retryFn the failures from the scorecard', async () => {
    const validator = makeValidator([40, 80])
    const retryFn = mock((failures: QualityCheck[], attempt: number) => {
      expect(failures.length).toBeGreaterThan(0)
      expect(failures[0].passed).toBe(false)
      expect(attempt).toBe(2)
      return Promise.resolve('fixed output')
    })

    await validateAndRetry('bad', { validator }, retryFn)
    expect(retryFn).toHaveBeenCalledTimes(1)
  })
})

// ── Utility function tests ──────────────────────────────────────────────────

describe('buildScorecard', () => {
  it('calculates score as percentage of passed checks', () => {
    const checks: QualityCheck[] = [
      { name: 'a', passed: true, expected: '', actual: '', severity: 'required' },
      { name: 'b', passed: true, expected: '', actual: '', severity: 'required' },
      { name: 'c', passed: false, expected: '', actual: '', severity: 'required' },
      { name: 'd', passed: true, expected: '', actual: '', severity: 'recommended' },
    ]
    const sc = buildScorecard('test', 70, checks)
    expect(sc.score).toBe(75) // 3/4 = 75%
    expect(sc.passed).toBe(true)
    expect(sc.failures.length).toBe(1)
    expect(sc.failures[0].name).toBe('c')
  })

  it('handles empty checks', () => {
    const sc = buildScorecard('test', 70, [])
    expect(sc.score).toBe(0)
    expect(sc.passed).toBe(false)
  })
})

describe('countTableRows', () => {
  it('counts data rows in a pipe-delimited table', () => {
    const table = `| Header1 | Header2 |
|---|---|
| data1 | data2 |
| data3 | data4 |
| data5 | data6 |`
    expect(countTableRows(table)).toBe(3)
  })

  it('returns 0 for header-only table', () => {
    const table = `| Header1 | Header2 |
|---|---|`
    expect(countTableRows(table)).toBe(0)
  })

  it('returns 0 for non-table text', () => {
    expect(countTableRows('just some text')).toBe(0)
  })
})

describe('extractNumberedSection', () => {
  it('extracts section by number', () => {
    const content = `### 1. Meeting Objective
This is the objective paragraph.

### 2. Partner Context
| Partner | Role |
|---|---|
| Acme | SI |`
    const section = extractNumberedSection(content, 1)
    expect(section).toContain('objective paragraph')
    expect(section).not.toContain('Partner Context')
  })

  it('returns empty string for missing section', () => {
    expect(extractNumberedSection('no sections here', 5)).toBe('')
  })

  it('handles last section without next header', () => {
    const content = `### 10. Action Items
| Who | Action | When |
|---|---|---|
| Jason | Follow up | Next week |`
    const section = extractNumberedSection(content, 10)
    expect(section).toContain('Jason')
  })
})

describe('hasSpecificNames', () => {
  it('detects specific names', () => {
    const table = `| For | Question |
|---|---|
| John Smith | What are your priorities? |
| Sarah Jones | How is the migration going? |`
    expect(hasSpecificNames(table, 0)).toBe(true)
  })

  it('rejects generic references', () => {
    const table = `| For | Question |
|---|---|
| the customer | What are your priorities? |
| them | How is the migration going? |`
    expect(hasSpecificNames(table, 0)).toBe(false)
  })
})

describe('formatFailureFeedback', () => {
  it('formats failures as structured feedback', () => {
    const failures: QualityCheck[] = [
      { name: 'test-check', passed: false, expected: 'section present', actual: 'not found', severity: 'required' },
    ]
    const feedback = formatFailureFeedback(failures)
    expect(feedback).toContain('test-check')
    expect(feedback).toContain('FAILED')
    expect(feedback).toContain('section present')
  })

  it('returns empty string for no failures', () => {
    expect(formatFailureFeedback([])).toBe('')
  })
})
