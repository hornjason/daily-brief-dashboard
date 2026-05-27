/**
 * Meeting Prep Quality Validator — ADR-024
 *
 * Validates meeting prep output against the 7-section slim format (#426):
 * 1. Meeting Objective, 2. Who's in the Room, 3. Recent Interactions,
 * 4. Value Play, 5. Discussion Questions, 6. Open Items (conditional),
 * 7. Action Items
 *
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

  // 1. Meeting Objective — present, 1-5 lines, >= 50 chars
  const section1 = extractNumberedSection(output, 1)
  const section1Lines = section1.split('\n').filter(l => l.trim().length > 0).length
  checks.push({
    name: 'meeting-objective',
    passed: section1.length >= 50 && section1Lines <= 5,
    expected: 'Section 1 (Meeting Objective) present with >= 50 chars, 1-5 lines',
    actual: section1.length > 0 ? `${section1.length} chars, ${section1Lines} lines` : 'section not found',
    severity: 'required',
  })

  // 2. Who's in the Room — present, one-liner per attendee (table or list OK)
  const section2 = extractNumberedSection(output, 2)
  const section2HasContent = section2.length > 20
  checks.push({
    name: 'whos-in-the-room',
    passed: section2HasContent,
    expected: "Section 2 (Who's in the Room) present with attendee info",
    actual: section2HasContent ? `${section2.length} chars` : 'section not found or too short',
    severity: 'required',
  })

  // 3. Recent Interactions — present with 2-5 bullet points
  const section3 = extractNumberedSection(output, 3)
  const section3Bullets = (section3.match(/^[\s]*[-*]\s/gm) ?? []).length
  checks.push({
    name: 'recent-interactions',
    passed: section3.length > 0 && section3Bullets >= 2,
    expected: 'Section 3 (Recent Interactions) present with >= 2 bullets',
    actual: section3.length > 0
      ? `${section3Bullets} bullet points`
      : 'section not found',
    severity: 'required',
  })

  // 4. Value Play — present, 1-3 paragraphs, NO tables
  const section4 = extractNumberedSection(output, 4)
  const section4HasTable = section4.includes('|') && section4.split('\n').filter(l => l.trim().startsWith('|')).length >= 3
  const section4Paras = section4.split('\n\n').filter(p => p.trim().length > 0).length
  checks.push({
    name: 'value-play',
    passed: section4.length >= 50 && !section4HasTable,
    expected: 'Section 4 (Value Play) present with narrative (no tables), >= 50 chars',
    actual: section4.length > 0
      ? `${section4.length} chars, ${section4Paras} paragraphs${section4HasTable ? ', HAS TABLE (bad)' : ''}`
      : 'section not found',
    severity: 'required',
  })

  // 5. Discussion Questions — present, 5-7 items with attendee names and purpose
  const section5 = extractNumberedSection(output, 5)
  // Count items: either bullet points or numbered list items
  const section5Bullets = (section5.match(/^[\s]*[-*]\s|^[\s]*\d+\.\s/gm) ?? []).length
  // Also count table rows as fallback
  const section5TableRows = countTableRows(section5)
  const section5ItemCount = Math.max(section5Bullets, section5TableRows)
  checks.push({
    name: 'discussion-questions',
    passed: section5.length > 0 && section5ItemCount >= 5,
    expected: 'Section 5 (Discussion Questions) present with >= 5 items',
    actual: section5.length > 0
      ? `${section5ItemCount} items`
      : 'section not found',
    severity: 'required',
  })

  // 5b. Discussion Questions — contain specific attendee names
  const hasAttendeeNames = section5.length > 0 && (
    hasSpecificNames(section5, 0) || // table format
    /\b[A-Z][a-z]+\s[A-Z][a-z]+\b/.test(section5) // inline names in bullets
  )
  checks.push({
    name: 'discussion-questions-named',
    passed: hasAttendeeNames,
    expected: 'Discussion Questions reference specific attendee names',
    actual: hasAttendeeNames ? 'specific names found' : 'generic references only',
    severity: 'recommended',
  })

  // 6. Open Items — OPTIONAL (conditional section, may be absent)
  const section6 = extractNumberedSection(output, 6)
  // Only validate if present — absence is OK
  if (section6.length > 0) {
    checks.push({
      name: 'open-items',
      passed: true,
      expected: 'Section 6 (Open Items) present when relevant',
      actual: `${section6.length} chars`,
      severity: 'recommended',
    })
  }

  // 7. Action Items — present with >= 3 items, names and dates
  const section7 = extractNumberedSection(output, 7)
  const section7Bullets = (section7.match(/^[\s]*[-*]\s|^[\s]*\d+\.\s/gm) ?? []).length
  const section7TableRows = countTableRows(section7)
  const section7ItemCount = Math.max(section7Bullets, section7TableRows)
  checks.push({
    name: 'action-items',
    passed: section7.length > 0 && section7ItemCount >= 3,
    expected: 'Section 7 (Action Items) present with >= 3 items',
    actual: section7.length > 0
      ? `${section7ItemCount} items`
      : 'section not found',
    severity: 'required',
  })

  // 7b. Action Items — contain specific names
  const section7HasNames = section7.length > 0 && (
    hasSpecificNames(section7, 0) || // table format
    /\b[A-Z][a-z]+\s[A-Z][a-z]+\b/.test(section7) // inline names
  )
  checks.push({
    name: 'action-items-named',
    passed: section7HasNames,
    expected: 'Action Items have specific team member names',
    actual: section7HasNames ? 'specific names found' : 'generic references only',
    severity: 'recommended',
  })

  // 7c. Action Items — contain dates or timeframes
  const hasDatePattern = /\b(\d{1,2}[\/-]\d{1,2}|\d{4}|week|month|day|before|after|during|pre-meeting|post-meeting|Q[1-4]|immediately|ASAP)\b/i
  checks.push({
    name: 'action-items-dated',
    passed: section7.length > 0 && hasDatePattern.test(section7),
    expected: 'Action Items have dates or timeframes',
    actual: section7.length > 0
      ? (hasDatePattern.test(section7) ? 'dates/timeframes found' : 'no dates or timeframes')
      : 'section not found',
    severity: 'recommended',
  })

  // Format check: no tables outside section 2
  const sectionsNoTables = [section1, section3, section4]
  const tableLeakFound = sectionsNoTables.some(s =>
    s.includes('|') && s.split('\n').filter(l => l.trim().startsWith('|')).length >= 3
  )
  checks.push({
    name: 'no-table-leak',
    passed: !tableLeakFound,
    expected: 'No markdown tables outside "Who\'s in the Room" section',
    actual: tableLeakFound ? 'table found in non-attendee section' : 'clean — bullets/narrative only',
    severity: 'recommended',
  })

  // Removed sections check: these old sections must NOT appear
  const removedSections = ['Customer Snapshot', 'Product Lifecycle', 'Expansion Opportunities', "What's New"]
  const removedFound = removedSections.filter(name =>
    new RegExp(`^#{2,3}\\s+\\d+\\.\\s+${name.replace(/'/g, "'")}`, 'mi').test(output)
  )
  checks.push({
    name: 'no-removed-sections',
    passed: removedFound.length === 0,
    expected: 'No removed sections (Customer Snapshot, Product Lifecycle, Expansion Opps, What\'s New)',
    actual: removedFound.length === 0 ? 'clean' : `found: ${removedFound.join(', ')}`,
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

/**
 * Re-score output — runs full validation on the final content.
 * Simplified from old enrichment-based rescore since enrichment tables
 * are no longer injected post-Gemini (#426).
 */
export function rescoreEnrichedOutput(output: string): QualityScorecard {
  return validate(output)
}

export const meetingPrepValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
