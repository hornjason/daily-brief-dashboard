/**
 * Campaign Quality Validator — ADR-024
 *
 * Validates campaign generation output for structural completeness:
 * summary, context, positioning, email templates with subject lines,
 * body length, varied features, and no internal data leakage.
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'campaign'
const PASS_THRESHOLD = 70

/** Patterns that indicate leaked internal subscription/SKU data */
const INTERNAL_DATA_PATTERNS = [
  /\b\d+\s*(nodes?|subscriptions?|seats?|licenses?|units?)\b/i,
  /\bSKU[:\s#-]*[A-Z0-9]+/i,
  /\b(MW|MCT|SER)\d{5}\b/,  // RH SKU patterns
]

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Campaign Summary — present, >= 50 chars
  const summaryMatch = output.match(/##?\s*(?:1\.\s*)?Campaign\s+Summary/i)
  const summarySection = summaryMatch
    ? output.slice(summaryMatch.index! + summaryMatch[0].length, findNextSectionEnd(output, summaryMatch.index! + summaryMatch[0].length))
    : ''
  checks.push({
    name: 'campaign-summary',
    passed: summarySection.trim().length >= 50,
    expected: 'Campaign Summary section present with >= 50 chars',
    actual: summarySection.trim().length > 0
      ? `${summarySection.trim().length} chars`
      : 'section not found',
    severity: 'required',
  })

  // 2. Customer Context — present, >= 100 chars
  const contextMatch = output.match(/##?\s*(?:2\.\s*)?Customer\s+Context/i)
  const contextSection = contextMatch
    ? output.slice(contextMatch.index! + contextMatch[0].length, findNextSectionEnd(output, contextMatch.index! + contextMatch[0].length))
    : ''
  checks.push({
    name: 'customer-context',
    passed: contextSection.trim().length >= 100,
    expected: 'Customer Context section present with >= 100 chars',
    actual: contextSection.trim().length > 0
      ? `${contextSection.trim().length} chars`
      : 'section not found',
    severity: 'required',
  })

  // 3. Positioning — present, >= 2 positioning points
  const posMatch = output.match(/##?\s*(?:3\.\s*)?Positioning/i)
  const posSection = posMatch
    ? output.slice(posMatch.index! + posMatch[0].length, findNextSectionEnd(output, posMatch.index! + posMatch[0].length))
    : ''
  const posPoints = (posSection.match(/^[\s]*[-*]\s/gm) ?? []).length
    + (posSection.match(/^\d+\.\s/gm) ?? []).length
  checks.push({
    name: 'positioning',
    passed: posSection.trim().length > 0 && posPoints >= 2,
    expected: 'Positioning section present with >= 2 positioning points',
    actual: posSection.trim().length > 0
      ? `${posPoints} positioning points`
      : 'section not found',
    severity: 'required',
  })

  // 4-9. Email template checks
  // Extract email blocks — they start with ## headers containing persona/tier info
  const emailBlocks = extractEmailBlocks(output)

  // 4. Email templates count — >= 4
  checks.push({
    name: 'email-templates-count',
    passed: emailBlocks.length >= 4,
    expected: '>= 4 email templates (exec + manager tiers)',
    actual: `${emailBlocks.length} email templates found`,
    severity: 'required',
  })

  // 5. Email subject lines — each email has a Subject line
  const subjectCount = emailBlocks.filter(b => /Subject:\s*.{5,}/i.test(b)).length
  checks.push({
    name: 'email-subject-lines',
    passed: emailBlocks.length > 0 && subjectCount === emailBlocks.length,
    expected: 'Each email template has a Subject line',
    actual: emailBlocks.length > 0
      ? `${subjectCount}/${emailBlocks.length} have subject lines`
      : 'no email templates found',
    severity: 'required',
  })

  // 6. Email body length — each email body >= 150 chars
  const bodyLengths = emailBlocks.map(b => {
    const bodyStart = b.match(/Subject:.*\n/i)
    if (!bodyStart) return b.length
    return b.slice(bodyStart.index! + bodyStart[0].length).trim().length
  })
  const longEnough = bodyLengths.filter(l => l >= 150).length
  checks.push({
    name: 'email-body-length',
    passed: emailBlocks.length > 0 && longEnough === emailBlocks.length,
    expected: 'Each email body >= 150 chars',
    actual: emailBlocks.length > 0
      ? `${longEnough}/${emailBlocks.length} have >= 150 char bodies (shortest: ${Math.min(...bodyLengths)} chars)`
      : 'no email templates found',
    severity: 'required',
  })

  // 7. Email varied features — different feature bullets across emails
  const featureSets = emailBlocks.map(b => {
    const bullets = (b.match(/^[\s]*[-*]\s+(.+)$/gm) ?? []).map(l => l.trim().toLowerCase())
    return new Set(bullets)
  })
  const allIdentical = featureSets.length >= 2 &&
    featureSets.every((s, _, arr) => {
      const first = [...arr[0]]
      return first.length === [...s].length && first.every(item => s.has(item))
    })
  checks.push({
    name: 'email-varied-features',
    passed: emailBlocks.length >= 2 && !allIdentical,
    expected: 'Different feature bullets across emails (not all identical)',
    actual: emailBlocks.length >= 2
      ? (allIdentical ? 'all emails have identical feature bullets' : 'varied features across emails')
      : 'insufficient emails to compare',
    severity: 'recommended',
  })

  // 8. Relationship context — each email has a relationship context line
  const relationshipCount = emailBlocks.filter(b =>
    /relationship|context|connection|rapport|history/i.test(b)
  ).length
  checks.push({
    name: 'relationship-context',
    passed: emailBlocks.length > 0 && relationshipCount >= Math.ceil(emailBlocks.length * 0.5),
    expected: 'Each email has relationship context',
    actual: emailBlocks.length > 0
      ? `${relationshipCount}/${emailBlocks.length} have relationship context`
      : 'no email templates found',
    severity: 'recommended',
  })

  // 9. No internal data — no subscription counts, node counts, SKU numbers
  const internalDataLeaks: string[] = []
  // Only check email bodies, not the intelligence/context sections
  for (const block of emailBlocks) {
    for (const pattern of INTERNAL_DATA_PATTERNS) {
      const match = block.match(pattern)
      if (match) internalDataLeaks.push(match[0])
    }
  }
  checks.push({
    name: 'no-internal-data',
    passed: internalDataLeaks.length === 0,
    expected: 'No subscription counts, node counts, or SKU numbers in email bodies',
    actual: internalDataLeaks.length === 0
      ? 'no internal data leaked'
      : `found internal data: ${internalDataLeaks.slice(0, 3).join(', ')}`,
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findNextSectionEnd(content: string, fromIndex: number): number {
  const rest = content.slice(fromIndex)
  const nextHeader = rest.match(/\n##?\s+/m)
  return nextHeader ? fromIndex + nextHeader.index! : content.length
}

function extractEmailBlocks(output: string): string[] {
  // Email blocks are delimited by ## headers that typically contain persona info
  // Pattern: "## VP Infrastructure - Executive Tier" or "## CIO — C-Level"
  const emailHeaderPattern = /^##\s+.+(?:tier|level|executive|manager|director|vp|cio|cto|cfo)/gim
  const blocks: string[] = []
  let lastIndex = -1
  let match: RegExpExecArray | null

  // Reset lastIndex
  emailHeaderPattern.lastIndex = 0

  while ((match = emailHeaderPattern.exec(output)) !== null) {
    if (lastIndex >= 0) {
      blocks.push(output.slice(lastIndex, match.index))
    }
    lastIndex = match.index
  }

  // Last block
  if (lastIndex >= 0) {
    blocks.push(output.slice(lastIndex))
  }

  // If the persona-based pattern found nothing, try Subject:-based splitting
  if (blocks.length === 0) {
    const subjectPattern = /^Subject:\s*.+$/gm
    const subjects: number[] = []
    let sm: RegExpExecArray | null
    subjectPattern.lastIndex = 0
    while ((sm = subjectPattern.exec(output)) !== null) {
      subjects.push(sm.index)
    }
    for (let i = 0; i < subjects.length; i++) {
      const start = subjects[i]
      const end = i + 1 < subjects.length ? subjects[i + 1] : output.length
      // Include some context before Subject line (look back for ## header)
      const lookback = output.lastIndexOf('\n##', start)
      const blockStart = lookback >= 0 && start - lookback < 200 ? lookback : start
      blocks.push(output.slice(blockStart, end))
    }
  }

  return blocks
}

export const campaignValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
