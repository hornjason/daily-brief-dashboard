/**
 * Value Positioning Quality Validator — ADR-024
 *
 * Validates value positioning brief output for structural completeness:
 * currentState, solutionAlignment, artOfPossible, nextSteps,
 * money connection, and no fabricated peers.
 * Threshold: 80
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'value-positioning'
const PASS_THRESHOLD = 80

/** Patterns that indicate fabricated/generic peer references */
const FABRICATION_PATTERNS = /\bindustry peers?\b|\bcompanies like yours?\b|\bsimilar organizations?\b|\ba major\b.*\b(insurer|bank|telco|manufacturer)\b/i

function validate(output: string): QualityScorecard {
  // Try JSON path first
  try {
    const parsed = JSON.parse(output)
    if (parsed.currentState !== undefined || parsed.solutionAlignment !== undefined) {
      return validateStructured(parsed)
    }
  } catch {
    // Not JSON — fall through to markdown validation
  }

  return validateMarkdown(output)
}

function validateStructured(positioning: any): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. currentState present and >= 50 chars
  const currentState = typeof positioning.currentState === 'string' ? positioning.currentState : ''
  checks.push({
    name: 'current-state',
    passed: currentState.length >= 50,
    expected: 'currentState present with >= 50 chars',
    actual: currentState.length > 0 ? `${currentState.length} chars` : 'missing',
    severity: 'required',
  })

  // 2. solutionAlignment present and >= 50 chars total
  const solutionAlignment = Array.isArray(positioning.solutionAlignment) ? positioning.solutionAlignment : []
  const saText = solutionAlignment.map((sa: any) =>
    `${sa.solution ?? ''} ${sa.alignment ?? ''} ${(sa.proofPoints ?? []).join(' ')}`
  ).join(' ')
  checks.push({
    name: 'solution-alignment',
    passed: saText.length >= 50,
    expected: 'solutionAlignment present with >= 50 chars of content',
    actual: solutionAlignment.length > 0 ? `${saText.length} chars across ${solutionAlignment.length} alignments` : 'missing or empty',
    severity: 'required',
  })

  // 3. artOfPossible present and >= 50 chars
  const artOfPossible = typeof positioning.artOfPossible === 'string' ? positioning.artOfPossible : ''
  checks.push({
    name: 'art-of-possible',
    passed: artOfPossible.length >= 50,
    expected: 'artOfPossible present with >= 50 chars',
    actual: artOfPossible.length > 0 ? `${artOfPossible.length} chars` : 'missing',
    severity: 'required',
  })

  // 4. nextSteps present and >= 50 chars total
  const nextSteps = Array.isArray(positioning.nextSteps) ? positioning.nextSteps : []
  const nsText = nextSteps.join(' ')
  checks.push({
    name: 'next-steps',
    passed: nsText.length >= 50,
    expected: 'nextSteps present with >= 50 chars of content',
    actual: nextSteps.length > 0 ? `${nsText.length} chars across ${nextSteps.length} steps` : 'missing or empty',
    severity: 'required',
  })

  // 5. Money connection — dollar amounts or pipeline/renewal/expansion terms
  const fullText = JSON.stringify(positioning)
  const financialTerms = /\$[\d,]+[kKmMbB]?|\bpipeline\b|\brenewal\b|\bexpansion\b|\bROI\b|\bsavings\b|\brevenue\b|\bARR\b|\bacv\b/gi
  const hasMoneyConnection = financialTerms.test(fullText)
  checks.push({
    name: 'money-connection',
    passed: hasMoneyConnection,
    expected: 'At least one financial connection ($amount, pipeline, renewal, expansion)',
    actual: hasMoneyConnection ? 'financial terms found' : 'no financial connection',
    severity: 'required',
  })

  // 6. No fabricated peers
  const hasFabrication = FABRICATION_PATTERNS.test(fullText)
  checks.push({
    name: 'no-fabricated-peers',
    passed: !hasFabrication,
    expected: 'No generic/fabricated peer references',
    actual: hasFabrication ? 'FABRICATION: generic peer language detected' : 'clean — named or absent',
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

function validateMarkdown(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Current State section present and >= 50 chars
  const currentStateMatch = output.match(/##?\s*(?:Current\s+State|Context)/i)
  const currentStateSection = currentStateMatch
    ? output.slice(currentStateMatch.index! + currentStateMatch[0].length, findNextSectionEnd(output, currentStateMatch.index! + currentStateMatch[0].length))
    : ''
  checks.push({
    name: 'current-state',
    passed: currentStateSection.trim().length >= 50,
    expected: 'Current State section present with >= 50 chars',
    actual: currentStateSection.trim().length > 0 ? `${currentStateSection.trim().length} chars` : 'section not found',
    severity: 'required',
  })

  // 2. Solution Alignment section present and >= 50 chars
  const saMatch = output.match(/##?\s*Solution\s+Alignment/i)
  const saSection = saMatch
    ? output.slice(saMatch.index! + saMatch[0].length, findNextSectionEnd(output, saMatch.index! + saMatch[0].length))
    : ''
  checks.push({
    name: 'solution-alignment',
    passed: saSection.trim().length >= 50,
    expected: 'Solution Alignment section present with >= 50 chars',
    actual: saSection.trim().length > 0 ? `${saSection.trim().length} chars` : 'section not found',
    severity: 'required',
  })

  // 3. Art of the Possible section present and >= 50 chars
  const artMatch = output.match(/##?\s*(?:Art\s+of\s+(?:the\s+)?Possible|Vision)/i)
  const artSection = artMatch
    ? output.slice(artMatch.index! + artMatch[0].length, findNextSectionEnd(output, artMatch.index! + artMatch[0].length))
    : ''
  checks.push({
    name: 'art-of-possible',
    passed: artSection.trim().length >= 50,
    expected: 'Art of the Possible section present with >= 50 chars',
    actual: artSection.trim().length > 0 ? `${artSection.trim().length} chars` : 'section not found',
    severity: 'required',
  })

  // 4. Next Steps section present and >= 50 chars
  const nsMatch = output.match(/##?\s*(?:Next\s+Steps|Suggested\s+Next)/i)
  const nsSection = nsMatch
    ? output.slice(nsMatch.index! + nsMatch[0].length, findNextSectionEnd(output, nsMatch.index! + nsMatch[0].length))
    : ''
  checks.push({
    name: 'next-steps',
    passed: nsSection.trim().length >= 50,
    expected: 'Next Steps section present with >= 50 chars',
    actual: nsSection.trim().length > 0 ? `${nsSection.trim().length} chars` : 'section not found',
    severity: 'required',
  })

  // 5. Money connection
  const financialTerms = /\$[\d,]+[kKmMbB]?|\bpipeline\b|\brenewal\b|\bexpansion\b|\bROI\b|\bsavings\b|\brevenue\b|\bARR\b|\bacv\b/gi
  const hasMoneyConnection = financialTerms.test(output)
  checks.push({
    name: 'money-connection',
    passed: hasMoneyConnection,
    expected: 'At least one financial connection ($amount, pipeline, renewal, expansion)',
    actual: hasMoneyConnection ? 'financial terms found' : 'no financial connection',
    severity: 'required',
  })

  // 6. No fabricated peers
  const hasFabrication = FABRICATION_PATTERNS.test(output)
  checks.push({
    name: 'no-fabricated-peers',
    passed: !hasFabrication,
    expected: 'No generic/fabricated peer references',
    actual: hasFabrication ? 'FABRICATION: generic peer language detected' : 'clean — named or absent',
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Helpers ────────────────────────────────────────────────────────────────

function findNextSectionEnd(content: string, fromIndex: number): number {
  const rest = content.slice(fromIndex)
  const nextHeader = rest.match(/\n##?\s+/m)
  return nextHeader ? fromIndex + nextHeader.index! : content.length
}

export const valuePositioningValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
