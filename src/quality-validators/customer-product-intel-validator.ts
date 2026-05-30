/**
 * Customer Product Intel Quality Validator — ADR-024
 *
 * Validates CustomerProductIntel output for structural completeness:
 * valid JSON object, relevance score enum, priority action present,
 * roadmap relevance fields, and expansion opportunity fields.
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'customer-product-intel'
const PASS_THRESHOLD = 70

const VALID_RELEVANCE_SCORES = ['HIGH', 'MEDIUM', 'LOW', 'NONE', 'EXPANSION']

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  let parsed: any
  try {
    parsed = JSON.parse(output)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      checks.push({
        name: 'valid-json',
        passed: false,
        expected: 'Valid JSON object',
        actual: Array.isArray(parsed) ? 'Got array instead of object' : `Got ${typeof parsed}`,
        severity: 'required',
      })
      return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
    }
  } catch {
    checks.push({
      name: 'valid-json',
      passed: false,
      expected: 'Valid JSON object',
      actual: 'Failed to parse JSON',
      severity: 'required',
    })
    return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
  }

  // 1. valid-json passed
  checks.push({
    name: 'valid-json',
    passed: true,
    expected: 'Valid JSON object',
    actual: 'Parsed successfully',
    severity: 'required',
  })

  // 2. relevance-score
  const hasValidRelevance = VALID_RELEVANCE_SCORES.includes(parsed.relevanceScore)
  checks.push({
    name: 'relevance-score',
    passed: hasValidRelevance,
    expected: `relevanceScore is one of: ${VALID_RELEVANCE_SCORES.join(', ')}`,
    actual: hasValidRelevance
      ? `relevanceScore: ${parsed.relevanceScore}`
      : `relevanceScore: "${parsed.relevanceScore ?? 'missing'}"`,
    severity: 'required',
  })

  // 3. priority-action
  const hasPriorityAction = typeof parsed.priorityAction === 'string' && parsed.priorityAction.trim() !== ''
  checks.push({
    name: 'priority-action',
    passed: hasPriorityAction,
    expected: 'priorityAction is non-empty string',
    actual: hasPriorityAction
      ? `priorityAction: "${parsed.priorityAction.slice(0, 80)}..."`
      : 'priorityAction is empty or missing',
    severity: 'required',
  })

  // 4. roadmap-relevance: is array with >= 1 entry
  const roadmap = parsed.roadmapRelevance
  const hasRoadmap = Array.isArray(roadmap) && roadmap.length >= 1
  checks.push({
    name: 'roadmap-relevance',
    passed: hasRoadmap,
    expected: 'roadmapRelevance is array with >= 1 entry',
    actual: Array.isArray(roadmap)
      ? `${roadmap.length} entries`
      : 'Not an array or missing',
    severity: 'recommended',
  })

  // 5. roadmap-fields: each entry has feature, customerConnection, talkingPoint
  if (Array.isArray(roadmap) && roadmap.length > 0) {
    let missingRoadmapFields = 0
    for (const entry of roadmap) {
      for (const field of ['feature', 'customerConnection', 'talkingPoint']) {
        if (!entry[field] || String(entry[field]).trim() === '') {
          missingRoadmapFields++
        }
      }
    }
    checks.push({
      name: 'roadmap-fields',
      passed: missingRoadmapFields === 0,
      expected: 'Each roadmapRelevance entry has feature, customerConnection, talkingPoint',
      actual: missingRoadmapFields > 0
        ? `${missingRoadmapFields} missing fields across ${roadmap.length} entries`
        : `${roadmap.length} entries, all fields present`,
      severity: 'required',
    })
  }

  // 6. expansion-opportunities: is array
  const expansion = parsed.expansionOpportunities
  const hasExpansion = Array.isArray(expansion)
  checks.push({
    name: 'expansion-opportunities',
    passed: hasExpansion,
    expected: 'expansionOpportunities is array',
    actual: hasExpansion
      ? `${expansion.length} entries`
      : 'Not an array or missing',
    severity: 'recommended',
  })

  // 7. expansion-fields: each entry has gap, product, rationale
  if (Array.isArray(expansion) && expansion.length > 0) {
    let missingExpansionFields = 0
    for (const entry of expansion) {
      for (const field of ['gap', 'product', 'rationale']) {
        if (!entry[field] || String(entry[field]).trim() === '') {
          missingExpansionFields++
        }
      }
    }
    checks.push({
      name: 'expansion-fields',
      passed: missingExpansionFields === 0,
      expected: 'Each expansion entry has gap, product, rationale',
      actual: missingExpansionFields > 0
        ? `${missingExpansionFields} missing fields across ${expansion.length} entries`
        : `${expansion.length} entries, all fields present`,
      severity: 'required',
    })
  }

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const customerProductIntelValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
