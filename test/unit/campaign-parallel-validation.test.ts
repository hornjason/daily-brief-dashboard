import { describe, test, expect } from 'bun:test'

// Test the scoreStructuredOutput function and convergence tracking
// These are pure functions extractable from campaign-service.ts

describe('scoreStructuredOutput', () => {
  let scoreStructuredOutput: (html: string) => { sections: number; emails: number; words: number }

  test('counts h2 and h3 sections', async () => {
    const mod = await import('../../src/campaign-service.ts')
    scoreStructuredOutput = (mod as any).scoreStructuredOutput
    expect(scoreStructuredOutput).toBeDefined()

    const html = '<h2>Section 1</h2><p>Content</p><h3>Sub</h3><p>More</p><h2>Section 2</h2>'
    const result = scoreStructuredOutput(html)
    expect(result.sections).toBe(3)
  })

  test('counts email emoji markers', async () => {
    const mod = await import('../../src/campaign-service.ts')
    scoreStructuredOutput = (mod as any).scoreStructuredOutput
    const html = '<p>📧 Email 1</p><p>📧 Email 2</p><p>📧 Email 3</p>'
    const result = scoreStructuredOutput(html)
    expect(result.emails).toBe(3)
  })

  test('counts words excluding HTML tags', async () => {
    const mod = await import('../../src/campaign-service.ts')
    scoreStructuredOutput = (mod as any).scoreStructuredOutput
    const html = '<h2>Title Here</h2> <p>Some content with five words</p>'
    const result = scoreStructuredOutput(html)
    expect(result.words).toBe(7)
  })

  test('handles empty HTML', async () => {
    const mod = await import('../../src/campaign-service.ts')
    scoreStructuredOutput = (mod as any).scoreStructuredOutput
    const result = scoreStructuredOutput('')
    expect(result.sections).toBe(0)
    expect(result.emails).toBe(0)
    expect(result.words).toBe(0)
  })
})

describe('convergence tracking', () => {
  let loadConvergenceRecords: () => any[]
  let appendConvergenceRecord: (record: any) => void
  let checkCutoverReady: (records: any[]) => boolean

  test('exports convergence functions', async () => {
    const mod = await import('../../src/campaign-service.ts')
    loadConvergenceRecords = (mod as any).loadConvergenceRecords
    appendConvergenceRecord = (mod as any).appendConvergenceRecord
    checkCutoverReady = (mod as any).checkCutoverReady
    expect(loadConvergenceRecords).toBeDefined()
    expect(appendConvergenceRecord).toBeDefined()
    expect(checkCutoverReady).toBeDefined()
  })

  test('checkCutoverReady returns true after 3 consecutive structured wins', async () => {
    const mod = await import('../../src/campaign-service.ts')
    checkCutoverReady = (mod as any).checkCutoverReady

    const records = [
      { timestamp: '2026-08-10', customer: 'A', structuredScore: 80, freeformScore: 70, winner: 'structured' },
      { timestamp: '2026-08-11', customer: 'B', structuredScore: 85, freeformScore: 75, winner: 'structured' },
      { timestamp: '2026-08-12', customer: 'C', structuredScore: 90, freeformScore: 80, winner: 'structured' },
    ]
    expect(checkCutoverReady(records)).toBe(true)
  })

  test('checkCutoverReady returns false with freeform win in last 3', async () => {
    const mod = await import('../../src/campaign-service.ts')
    checkCutoverReady = (mod as any).checkCutoverReady

    const records = [
      { timestamp: '2026-08-10', customer: 'A', structuredScore: 80, freeformScore: 70, winner: 'structured' },
      { timestamp: '2026-08-11', customer: 'B', structuredScore: 65, freeformScore: 85, winner: 'freeform' },
      { timestamp: '2026-08-12', customer: 'C', structuredScore: 90, freeformScore: 80, winner: 'structured' },
    ]
    expect(checkCutoverReady(records)).toBe(false)
  })

  test('checkCutoverReady returns false with fewer than 3 records', async () => {
    const mod = await import('../../src/campaign-service.ts')
    checkCutoverReady = (mod as any).checkCutoverReady
    expect(checkCutoverReady([])).toBe(false)
    expect(checkCutoverReady([
      { timestamp: '2026-08-10', customer: 'A', structuredScore: 80, freeformScore: 70, winner: 'structured' },
    ])).toBe(false)
  })
})

describe('env var flags', () => {
  test('CAMPAIGN_PARALLEL_VALIDATION flag is declared', async () => {
    const source = await Bun.file('/Users/jhorn/Projects/DailyBriefDashboard/src/campaign-service.ts').text()
    expect(source).toContain('CAMPAIGN_PARALLEL_VALIDATION')
  })

  test('CAMPAIGN_FREEFORM_REMOVED flag is declared', async () => {
    const source = await Bun.file('/Users/jhorn/Projects/DailyBriefDashboard/src/campaign-service.ts').text()
    expect(source).toContain('CAMPAIGN_FREEFORM_REMOVED')
  })

  test('CUTOVER READY log message exists', async () => {
    const source = await Bun.file('/Users/jhorn/Projects/DailyBriefDashboard/src/campaign-service.ts').text()
    expect(source).toContain('CUTOVER READY')
  })
})
