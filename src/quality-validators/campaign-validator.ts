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
  // Try JSON path first (ADR-040 structured output)
  try {
    const parsed = JSON.parse(output)
    if (parsed.emails && Array.isArray(parsed.emails)) {
      return validateStructured(parsed)
    }
  } catch {
    // Not JSON — fall through to markdown validation
  }

  return validateMarkdown(output)
}

function validateMarkdown(output: string): QualityScorecard {
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

  // saleshub-positioning — recommended: check if SalesHub positioning language appears
  const lowerOutput = output.toLowerCase()
  const hasSalesHubLanguage = lowerOutput.includes('positions') || lowerOutput.includes('tactic') ||
    lowerOutput.includes('decision point') || lowerOutput.includes('action layer') ||
    lowerOutput.includes('modernize') || lowerOutput.includes('consolidate')
  checks.push({
    name: 'saleshub-positioning',
    passed: hasSalesHubLanguage || emailBlocks.length === 0,
    expected: 'SalesHub positioning language used when TDP signals present',
    actual: hasSalesHubLanguage ? 'SalesHub language detected' : 'generic positioning',
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Structured JSON validation (ADR-040) ────────────────────────────────────

function validateStructured(campaign: any): QualityScorecard {
  const checks: QualityCheck[] = []

  // Summary present and substantial
  checks.push({
    name: 'campaign-summary',
    passed: typeof campaign.campaignSummary === 'string' && campaign.campaignSummary.length >= 50,
    expected: 'Campaign Summary >= 50 chars',
    actual: campaign.campaignSummary ? `${campaign.campaignSummary.length} chars` : 'missing',
    severity: 'required',
  })

  // Customer context present
  checks.push({
    name: 'customer-context',
    passed: typeof campaign.customerContext === 'string' && campaign.customerContext.length >= 100,
    expected: 'Customer Context >= 100 chars',
    actual: campaign.customerContext ? `${campaign.customerContext.length} chars` : 'missing',
    severity: 'required',
  })

  // Positioning present
  checks.push({
    name: 'positioning',
    passed: typeof campaign.positioning === 'string' && campaign.positioning.length >= 100,
    expected: 'Positioning >= 100 chars',
    actual: campaign.positioning ? `${campaign.positioning.length} chars` : 'missing',
    severity: 'required',
  })

  // Email count
  const emails = campaign.emails ?? []
  checks.push({
    name: 'email-templates-count',
    passed: emails.length >= 4,
    expected: '>= 4 email templates',
    actual: `${emails.length} emails`,
    severity: 'required',
  })

  // Email subject lines
  const withSubjects = emails.filter((e: any) => e.subject && e.subject.length >= 5)
  checks.push({
    name: 'email-subject-lines',
    passed: emails.length > 0 && withSubjects.length === emails.length,
    expected: 'Every email has a subject line',
    actual: `${withSubjects.length}/${emails.length} have subjects`,
    severity: 'required',
  })

  // Email body length
  const withBodies = emails.filter((e: any) => e.body && e.body.length >= 150)
  checks.push({
    name: 'email-body-length',
    passed: emails.length > 0 && withBodies.length === emails.length,
    expected: 'Every email body >= 150 chars',
    actual: `${withBodies.length}/${emails.length} have sufficient bodies`,
    severity: 'required',
  })

  // Varied features across emails
  const bodies = emails.map((e: any) => (e.body ?? '').toLowerCase())
  const allIdentical = bodies.length >= 2 && bodies.every((b: string) => b === bodies[0])
  checks.push({
    name: 'email-varied-features',
    passed: !allIdentical,
    expected: 'Different content across emails',
    actual: allIdentical ? 'identical bodies' : 'varied content',
    severity: 'recommended',
  })

  // Relationship context
  const withRelationship = emails.filter((e: any) =>
    /Red Hat|RHEL|Enterprise Linux|your.*use|your.*teams|foundation/i.test(e.body ?? '')
  )
  checks.push({
    name: 'relationship-context',
    passed: withRelationship.length >= Math.ceil(emails.length * 0.5),
    expected: 'Relationship context in emails',
    actual: `${withRelationship.length}/${emails.length} have relationship context`,
    severity: 'recommended',
  })

  // No internal data in email bodies
  const internalDataLeaks: string[] = []
  for (const email of emails) {
    for (const pattern of INTERNAL_DATA_PATTERNS) {
      const match = (email.body ?? '').match(pattern)
      if (match) internalDataLeaks.push(match[0])
    }
  }
  checks.push({
    name: 'no-internal-data',
    passed: internalDataLeaks.length === 0,
    expected: 'No internal data in email bodies',
    actual: internalDataLeaks.length === 0 ? 'clean' : `found: ${internalDataLeaks.join(', ')}`,
    severity: 'required',
  })

  // Money connection (MA-4)
  const fullText = JSON.stringify(campaign)
  checks.push({
    name: 'money-connection',
    passed: /\$[\d,]+[kKmMbB]?|\bpipeline\b|\brenewal\b|\bexpansion\b/gi.test(fullText),
    expected: 'Financial connection present',
    actual: /\$[\d,]+/gi.test(fullText) ? 'dollar figures found' : 'financial terms only',
    severity: 'required',
  })

  // Action steps (MA-3)
  const withActionSteps = emails.filter((e: any) => e.actionStep && e.actionStep.length >= 20)
  checks.push({
    name: 'action-step-present',
    passed: withActionSteps.length >= Math.ceil(emails.length * 0.5),
    expected: 'Action steps in emails',
    actual: `${withActionSteps.length}/${emails.length} have action steps`,
    severity: 'required',
  })

  // Challenger insight (MA-6)
  checks.push({
    name: 'challenger-insight',
    passed: /\bchallenger\b|\bhidden\b|\bgap\b|\bdrag\b|\bcompetitive\b.*\bdisadvantage\b/i.test(campaign.positioning ?? ''),
    expected: 'Challenger insight in positioning',
    actual: /challenger|hidden|gap|drag/i.test(campaign.positioning ?? '') ? 'found' : 'missing',
    severity: 'recommended',
  })

  // ALL-NULLS CHECK — if every nullable field is null, that's a generation failure
  const nullableFields = emails.map((e: any) => e.peerProof)
  const allNull = nullableFields.length > 0 && nullableFields.every((f: any) => f === null || f === undefined)
  checks.push({
    name: 'not-all-nulls',
    passed: !allNull || emails.length === 0,
    expected: 'At least one peerProof is non-null (not all-nulls failure)',
    actual: allNull ? 'ALL peerProof fields are null — generation failure' : `${nullableFields.filter(Boolean).length}/${nullableFields.length} populated`,
    severity: 'required',
  })

  // FABRICATION CHECK — if output says "industry peers" without citing named customer
  const fabricationPatterns = /\bindustry peers?\b|\bcompanies like yours?\b|\bsimilar organizations?\b|\ba major\b.*\b(insurer|bank|telco|manufacturer)\b/i
  const hasFabrication = emails.some((e: any) => fabricationPatterns.test(e.peerProof ?? '') || fabricationPatterns.test(e.body ?? ''))
  checks.push({
    name: 'no-fabricated-peers',
    passed: !hasFabrication,
    expected: 'No generic/fabricated peer references',
    actual: hasFabrication ? 'FABRICATION: generic peer language detected' : 'clean — named or null',
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
