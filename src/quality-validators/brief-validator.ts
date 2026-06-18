/**
 * Customer Brief Quality Validator — ADR-024, Consumer Contract v1.0
 *
 * Validates brief output against required sections and content quality:
 * - Priority Action section exists and follows [Verb] [object] [date] formula
 * - At least 3 required sections present (Priority Action, What Changed, Next Steps)
 * - No placeholder text ("TBD", "[Insert]", "TODO")
 * - Minimum 30 words per section
 * - NEXT ACTION line present
 *
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
  extractSection,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'customer-brief'
const PASS_THRESHOLD = 70

/** Sections that MUST be present in every brief (enforced by BRIEF_RESPONSE_SCHEMA) */
const REQUIRED_SECTIONS = [
  'Priority Action',
  'What Changed',
  'Next Steps',
  'What They May Not Know',
]

/** Placeholder patterns that indicate incomplete content */
const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /\[Insert\b/i,
  /\bTODO\b/i,
  /\bplaceholder\b/i,
  /\[fill in\]/i,
  /\[your\b/i,
]

function extractMarkdownSection(output: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im')
  return extractSection(output, pattern)
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Priority Action section exists
  const priorityAction = extractMarkdownSection(output, 'Priority Action')
  checks.push({
    name: 'priority-action-present',
    passed: priorityAction.length > 0,
    expected: 'Priority Action section present',
    actual: priorityAction.length > 0 ? `${priorityAction.length} chars` : 'section not found',
    severity: 'required',
  })

  // 2. Priority Action follows [Verb] [object] [date] formula
  const actionVerbs = /^(Schedule|Escalate|Call|Email|Draft|Review|Confirm|Submit|Send|Book|Follow-up|Follow up|Prepare|Contact|Request|Engage|Discuss|Set up|Arrange|Initiate)/im
  const hasActionVerb = actionVerbs.test(priorityAction.trim())
  checks.push({
    name: 'priority-action-formula',
    passed: hasActionVerb,
    expected: 'Priority Action starts with action verb (Schedule, Escalate, Call, etc.)',
    actual: hasActionVerb ? 'starts with action verb' : 'missing action verb opening',
    severity: 'recommended',
  })

  // 3. What Changed section exists
  const whatChanged = extractMarkdownSection(output, 'What Changed')
  checks.push({
    name: 'what-changed-present',
    passed: whatChanged.length > 0,
    expected: 'What Changed section present',
    actual: whatChanged.length > 0 ? `${whatChanged.length} chars` : 'section not found',
    severity: 'required',
  })

  // 4. Next Steps section exists
  const nextSteps = extractMarkdownSection(output, 'Next Steps')
  checks.push({
    name: 'next-steps-present',
    passed: nextSteps.length > 0,
    expected: 'Next Steps section present',
    actual: nextSteps.length > 0 ? `${nextSteps.length} chars` : 'section not found',
    severity: 'required',
  })

  // 5. What They May Not Know section exists (Challenger Sale insight)
  const whatTheyMayNotKnow = extractMarkdownSection(output, 'What They May Not Know')
  checks.push({
    name: 'what-they-may-not-know-present',
    passed: whatTheyMayNotKnow.length > 0,
    expected: 'What They May Not Know section present',
    actual: whatTheyMayNotKnow.length > 0 ? `${whatTheyMayNotKnow.length} chars` : 'section not found',
    severity: 'required',
  })

  // 6. Minimum required section count (at least 4 of the required sections)
  const presentRequiredSections = REQUIRED_SECTIONS.filter(
    s => extractMarkdownSection(output, s).length > 0
  )
  checks.push({
    name: 'min-required-sections',
    passed: presentRequiredSections.length >= 4,
    expected: 'At least 4 required sections present',
    actual: `${presentRequiredSections.length} of ${REQUIRED_SECTIONS.length} required sections found`,
    severity: 'required',
  })

  // 6. No placeholder text
  const foundPlaceholders = PLACEHOLDER_PATTERNS.filter(p => p.test(output))
  checks.push({
    name: 'no-placeholder-text',
    passed: foundPlaceholders.length === 0,
    expected: 'No placeholder text (TBD, [Insert], TODO)',
    actual: foundPlaceholders.length === 0
      ? 'no placeholders found'
      : `found: ${foundPlaceholders.map(p => p.source).join(', ')}`,
    severity: 'required',
  })

  // 7. Minimum content depth — at least 30 words per present required section
  const thinSections: string[] = []
  for (const sectionName of REQUIRED_SECTIONS) {
    const sectionContent = extractMarkdownSection(output, sectionName)
    if (sectionContent.length > 0 && countWords(sectionContent) < 30) {
      thinSections.push(`${sectionName} (${countWords(sectionContent)} words)`)
    }
  }
  checks.push({
    name: 'min-words-per-section',
    passed: thinSections.length === 0,
    expected: 'Each required section has >= 30 words',
    actual: thinSections.length === 0
      ? 'all sections meet minimum depth'
      : `thin sections: ${thinSections.join(', ')}`,
    severity: 'recommended',
  })

  // 8. NEXT ACTION line present
  const hasNextAction = /NEXT ACTION:/i.test(output)
  checks.push({
    name: 'next-action-line',
    passed: hasNextAction,
    expected: 'NEXT ACTION line present at end of brief',
    actual: hasNextAction ? 'found' : 'missing',
    severity: 'recommended',
  })

  // 9. DATA FRESHNESS section or mention
  const hasFreshness = /DATA FRESHNESS|Data Freshness/i.test(output)
  checks.push({
    name: 'data-freshness',
    passed: hasFreshness,
    expected: 'Data Freshness information present',
    actual: hasFreshness ? 'found' : 'missing',
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const briefValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
