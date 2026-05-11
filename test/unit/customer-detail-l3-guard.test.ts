/**
 * Regression test for GitHub issue #96
 * BKL-HERO-18: L3 guard too aggressive — hides Drive-sourced data on hero installs
 *
 * Pipeline and CCSP data read from Google Sheets (L3 operation).
 * Only SCRAPING those sheets requires L4 (browser automation).
 * Reading them is L3 — should render on hero installs.
 *
 * Cases genuinely require L4 (live RH Portal) — guard should remain.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('CustomerDetailPage L3 guard verification', () => {
  const sourceFile = resolve(__dirname, '../../dashboard/src/pages/CustomerDetailPage.tsx')
  const sourceCode = readFileSync(sourceFile, 'utf-8')

  test('PipelineCard must NOT be wrapped with isL3Only guard', () => {
    // Search for the PipelineCard component usage
    const pipelineCardLine = sourceCode.split('\n').find((line) =>
      line.includes('<PipelineCard')
    )

    expect(pipelineCardLine).toBeDefined()
    expect(pipelineCardLine).not.toContain('!isL3Only')
  })

  test('CloudSpendCard must NOT be wrapped with isL3Only guard', () => {
    // Search for the CloudSpendCard component usage
    const cloudSpendCardLine = sourceCode.split('\n').find((line) =>
      line.includes('<CloudSpendCard')
    )

    expect(cloudSpendCardLine).toBeDefined()
    expect(cloudSpendCardLine).not.toContain('!isL3Only')
  })

  test('CasesSection MUST still have the isL3Only guard (requires live L4)', () => {
    // Search for the CasesSection component usage
    const casesSectionLine = sourceCode.split('\n').find((line) =>
      line.includes('<CasesSection')
    )

    expect(casesSectionLine).toBeDefined()
    expect(casesSectionLine).toContain('!isL3Only')
  })
})
