/**
 * Morning Summary Quality Validator — ADR-024, Consumer Contract v1.0
 *
 * Validates morning synthesis output against required structure and content:
 * - Synthesis present and >= 100 chars
 * - Signals array present with >= 3 signals
 * - No placeholder text (TBD, [Insert], TODO)
 * - Priority Today and Actions sections present with WHO/WHAT/WHEN pattern
 *
 * Threshold: 80
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
  extractSection,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'morning-summary'
const PASS_THRESHOLD = 80

/** Placeholder patterns that indicate incomplete content */
const PLACEHOLDER_PATTERNS = [
  /\bTBD\b/i,
  /\[Insert\b/i,
  /\bTODO\b/i,
  /\bplaceholder\b/i,
  /\[fill in\]/i,
  /\[your\b/i,
]

/** WHO/WHAT/WHEN indicators — at least one from each category needed */
const WHO_PATTERNS = [
  /\b(you|ASA|AE|SSA|SSP|team|manager|[A-Z][a-z]+\s+[A-Z][a-z]+)\b/,
]
const WHEN_PATTERNS = [
  /\b(today|tomorrow|this week|by\s+(Monday|Tuesday|Wednesday|Thursday|Friday|EOD|end of|close of))/i,
  /\b(immediately|ASAP|before|after|by\s+\d)/i,
]

function extractMarkdownSection(output: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im')
  return extractSection(output, pattern)
}

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Synthesis present and >= 100 chars
  checks.push({
    name: 'synthesis-present',
    passed: output.length >= 100,
    expected: 'Synthesis text >= 100 characters',
    actual: `${output.length} chars`,
    severity: 'required',
  })

  // 2. Priority Today section exists
  const priorityToday = extractMarkdownSection(output, 'Priority Today')
  checks.push({
    name: 'priority-today-present',
    passed: priorityToday.length > 0,
    expected: 'Priority Today section present',
    actual: priorityToday.length > 0 ? `${priorityToday.length} chars` : 'section not found',
    severity: 'required',
  })

  // 3. Actions section exists
  const actions = extractMarkdownSection(output, 'Actions')
  checks.push({
    name: 'actions-present',
    passed: actions.length > 0,
    expected: 'Actions section present',
    actual: actions.length > 0 ? `${actions.length} chars` : 'section not found',
    severity: 'required',
  })

  // 4. Watch section exists
  const watch = extractMarkdownSection(output, 'Watch')
  checks.push({
    name: 'watch-present',
    passed: watch.length > 0,
    expected: 'Watch section present',
    actual: watch.length > 0 ? `${watch.length} chars` : 'section not found',
    severity: 'recommended',
  })

  // 5. No placeholder text
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

  // 6. Priority Today has WHO/WHAT/WHEN pattern
  const priorityHasWho = priorityToday.length > 0 && WHO_PATTERNS.some(p => p.test(priorityToday))
  const priorityHasWhen = priorityToday.length > 0 && WHEN_PATTERNS.some(p => p.test(priorityToday))
  checks.push({
    name: 'priority-who-what-when',
    passed: priorityHasWho && priorityHasWhen,
    expected: 'Priority Today names WHO and WHEN (not generic "focus on X")',
    actual: priorityToday.length === 0
      ? 'section missing'
      : `WHO: ${priorityHasWho ? 'yes' : 'missing'}, WHEN: ${priorityHasWhen ? 'missing' : 'yes'}`.replace(
          /WHEN: missing/,
          priorityHasWhen ? 'WHEN: yes' : 'WHEN: missing',
        ),
    severity: 'required',
  })

  // 7. Actions have WHO/WHAT/WHEN pattern (check at least 2 of 3 action lines)
  const actionLines = actions.split('\n').filter(l => l.trim().startsWith('-')).slice(0, 3)
  const actionsWithWhoWhen = actionLines.filter(line => {
    const hasWho = WHO_PATTERNS.some(p => p.test(line))
    const hasWhen = WHEN_PATTERNS.some(p => p.test(line))
    return hasWho && hasWhen
  })
  const minActionCompliance = Math.min(2, actionLines.length)
  checks.push({
    name: 'actions-who-what-when',
    passed: actionsWithWhoWhen.length >= minActionCompliance,
    expected: `At least ${minActionCompliance} action items with WHO + WHEN`,
    actual: `${actionsWithWhoWhen.length} of ${actionLines.length} actions have WHO + WHEN`,
    severity: 'required',
  })

  // 8. Actions reference account names (bolded)
  const boldAccountPattern = /\*\*[A-Z][A-Za-z\s&,.'-]+\*\*/
  const actionsWithAccounts = actionLines.filter(line => boldAccountPattern.test(line))
  checks.push({
    name: 'actions-account-names',
    passed: actionsWithAccounts.length >= Math.min(2, actionLines.length),
    expected: 'Action items reference bolded account names',
    actual: `${actionsWithAccounts.length} of ${actionLines.length} actions have bolded account names`,
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const morningSummaryValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
