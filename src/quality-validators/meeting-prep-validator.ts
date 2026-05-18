/**
 * Meeting Prep Quality Validator — ADR-024
 *
 * Validates meeting prep output against the gold standard format:
 * 10 numbered sections with specific table/content requirements.
 * Threshold: 75
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
  extractNumberedSection,
  countTableRows,
  hasSpecificNames,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'meeting-prep'
const PASS_THRESHOLD = 75

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Meeting Objective — present, >= 50 chars
  const section1 = extractNumberedSection(output, 1)
  checks.push({
    name: 'meeting-objective',
    passed: section1.length >= 50,
    expected: 'Section 1 (Meeting Objective) present with >= 50 chars',
    actual: section1.length > 0 ? `${section1.length} chars` : 'section not found',
    severity: 'required',
  })

  // 2. Partner Context — present with pipe-delimited table
  const section2 = extractNumberedSection(output, 2)
  const section2HasTable = section2.includes('|') && section2.split('\n').filter(l => l.trim().startsWith('|')).length >= 3
  checks.push({
    name: 'partner-context',
    passed: section2.length > 0 && section2HasTable,
    expected: 'Section 2 (Partner Context) present with pipe-delimited table',
    actual: section2.length > 0
      ? (section2HasTable ? 'table found' : 'section present but no table')
      : 'section not found',
    severity: 'required',
  })

  // 3. Customer Snapshot — present with >= 3 bullet points
  const section3 = extractNumberedSection(output, 3)
  const bulletCount = (section3.match(/^[\s]*[-*]\s/gm) ?? []).length
  checks.push({
    name: 'customer-snapshot',
    passed: section3.length > 0 && bulletCount >= 3,
    expected: 'Section 3 (Customer Snapshot) present with >= 3 bullet points',
    actual: section3.length > 0
      ? `${bulletCount} bullet points`
      : 'section not found',
    severity: 'required',
  })

  // 4. Why Red Hat — present with pipe-delimited table, >= 4 rows
  const section4 = extractNumberedSection(output, 4)
  const section4Rows = countTableRows(section4)
  checks.push({
    name: 'why-red-hat',
    passed: section4.length > 0 && section4Rows >= 4,
    expected: 'Section 4 (Why Red Hat) present with table having >= 4 data rows',
    actual: section4.length > 0
      ? `${section4Rows} data rows`
      : 'section not found',
    severity: 'required',
  })

  // 5. What's New — present with table, >= 2 rows
  const section5 = extractNumberedSection(output, 5)
  const section5Rows = countTableRows(section5)
  checks.push({
    name: 'whats-new',
    passed: section5.length > 0 && section5Rows >= 2,
    expected: "Section 5 (What's New) present with table having >= 2 data rows",
    actual: section5.length > 0
      ? `${section5Rows} data rows`
      : 'section not found',
    severity: 'required',
  })

  // 6. Product Lifecycle — present with table
  const section6 = extractNumberedSection(output, 6)
  const section6HasTable = section6.includes('|') && section6.split('\n').filter(l => l.trim().startsWith('|')).length >= 3
  checks.push({
    name: 'product-lifecycle',
    passed: section6.length > 0 && section6HasTable,
    expected: 'Section 6 (Product Lifecycle) present with pipe-delimited table',
    actual: section6.length > 0
      ? (section6HasTable ? 'table found' : 'section present but no table')
      : 'section not found',
    severity: 'required',
  })

  // 7. Expansion Opportunities — present (even if "no signals")
  const section7 = extractNumberedSection(output, 7)
  checks.push({
    name: 'expansion-opportunities',
    passed: section7.length > 0,
    expected: 'Section 7 (Expansion Opportunities) present',
    actual: section7.length > 0 ? `${section7.length} chars` : 'section not found',
    severity: 'required',
  })

  // 8. Discussion Questions — present with table, >= 5 rows
  const section8 = extractNumberedSection(output, 8)
  const section8Rows = countTableRows(section8)
  checks.push({
    name: 'discussion-questions',
    passed: section8.length > 0 && section8Rows >= 5,
    expected: 'Section 8 (Discussion Questions) present with table having >= 5 data rows',
    actual: section8.length > 0
      ? `${section8Rows} data rows`
      : 'section not found',
    severity: 'required',
  })

  // 8b. Discussion Questions — "For" column has specific names
  checks.push({
    name: 'discussion-questions-named',
    passed: section8.length > 0 && hasSpecificNames(section8, 0),
    expected: '"For" column in Discussion Questions has specific attendee names',
    actual: section8.length > 0
      ? (hasSpecificNames(section8, 0) ? 'specific names found' : 'generic references only')
      : 'section not found',
    severity: 'recommended',
  })

  // 9. Open Cases & Renewals — present
  const section9 = extractNumberedSection(output, 9)
  checks.push({
    name: 'open-cases-renewals',
    passed: section9.length > 0,
    expected: 'Section 9 (Open Cases & Renewals) present',
    actual: section9.length > 0 ? `${section9.length} chars` : 'section not found',
    severity: 'required',
  })

  // 10. Action Items — present with table, >= 3 rows
  const section10 = extractNumberedSection(output, 10)
  const section10Rows = countTableRows(section10)
  checks.push({
    name: 'action-items',
    passed: section10.length > 0 && section10Rows >= 3,
    expected: 'Section 10 (Action Items) present with table having >= 3 data rows',
    actual: section10.length > 0
      ? `${section10Rows} data rows`
      : 'section not found',
    severity: 'required',
  })

  // 10b. Action Items — "Who" column has specific names
  checks.push({
    name: 'action-items-named',
    passed: section10.length > 0 && hasSpecificNames(section10, 0),
    expected: '"Who" column in Action Items has specific team member names',
    actual: section10.length > 0
      ? (hasSpecificNames(section10, 0) ? 'specific names found' : 'generic references only')
      : 'section not found',
    severity: 'recommended',
  })

  // 10c. Action Items — "When" column has dates or timeframes
  const hasDatePattern = /\b(\d{1,2}[\/-]\d{1,2}|\d{4}|week|month|day|before|after|during|pre-meeting|post-meeting|Q[1-4]|immediately|ASAP)\b/i
  const section10Lines = section10.split('\n').filter(l => l.trim().startsWith('|')).slice(2) // data rows
  const hasDates = section10Lines.some(line => {
    const cells = line.split('|').filter(c => c.trim() !== '')
    return cells.length >= 3 && hasDatePattern.test(cells[2])
  })
  checks.push({
    name: 'action-items-dated',
    passed: section10.length > 0 && hasDates,
    expected: '"When" column in Action Items has dates or timeframes',
    actual: section10.length > 0
      ? (hasDates ? 'dates/timeframes found' : 'no dates or timeframes')
      : 'section not found',
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const meetingPrepValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
