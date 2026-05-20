/**
 * Playbook Quality Validator — ADR-024
 *
 * Validates playbook output (JSON) against the PlaybookState schema.
 * Since the playbook uses responseSchema for structured JSON output,
 * we parse the JSON and check field presence/length/count.
 * Threshold: 75
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'
import type { PlaybookState } from '../playbook-types.ts'

const CONTENT_TYPE = 'playbook'
const PASS_THRESHOLD = 75

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // Parse JSON output
  let parsed: PlaybookState | null = null
  try {
    parsed = JSON.parse(output) as PlaybookState
  } catch {
    checks.push({
      name: 'json-parse',
      passed: false,
      expected: 'Valid JSON output',
      actual: 'JSON parse failed',
      severity: 'required',
    })
    return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
  }

  // strategic-position — present, >= 100 chars
  const strategicPos = parsed.sections?.strategicPosition?.content ?? ''
  checks.push({
    name: 'strategic-position',
    passed: strategicPos.length >= 100,
    expected: 'Strategic Position section present with >= 100 chars',
    actual: strategicPos.length > 0 ? `${strategicPos.length} chars` : 'section not found',
    severity: 'required',
  })

  // key-relationships — present, >= 50 chars
  const keyRel = parsed.sections?.keyRelationships?.content ?? ''
  checks.push({
    name: 'key-relationships',
    passed: keyRel.length >= 50,
    expected: 'Key Relationships section present with >= 50 chars',
    actual: keyRel.length > 0 ? `${keyRel.length} chars` : 'section not found',
    severity: 'required',
  })

  // current-priorities — present, >= 50 chars
  const priorities = parsed.sections?.currentPriorities?.content ?? ''
  checks.push({
    name: 'current-priorities',
    passed: priorities.length >= 50,
    expected: 'Current Priorities section present with >= 50 chars',
    actual: priorities.length > 0 ? `${priorities.length} chars` : 'section not found',
    severity: 'required',
  })

  // product-alignment-count — at least 1 product entry
  const products = parsed.sections?.productAlignment?.products ?? []
  checks.push({
    name: 'product-alignment-count',
    passed: products.length >= 1,
    expected: 'At least 1 product in Product Alignment',
    actual: `${products.length} products`,
    severity: 'required',
  })

  // product-alignment-confidence — all products have confidence set
  const hasConfidence = products.length > 0 && products.every(p =>
    p.confidence === 'HIGH' || p.confidence === 'MEDIUM' || p.confidence === 'LOW'
  )
  checks.push({
    name: 'product-alignment-confidence',
    passed: hasConfidence,
    expected: 'All products have confidence set (HIGH/MEDIUM/LOW)',
    actual: hasConfidence
      ? 'all products have confidence'
      : products.length === 0
        ? 'no products'
        : 'one or more products missing confidence',
    severity: 'required',
  })

  // product-alignment-proof-points — at least 1 product has non-empty proof points
  const hasProofPoints = products.some(p => (p.proofPoints ?? '').trim().length > 0)
  checks.push({
    name: 'product-alignment-proof-points',
    passed: hasProofPoints,
    expected: 'At least 1 product has non-empty proof points',
    actual: hasProofPoints
      ? 'proof points found'
      : products.length === 0
        ? 'no products'
        : 'no products with proof points',
    severity: 'required',
  })

  // product-alignment-links — all products have dashboardLink set
  const hasLinks = products.length > 0 && products.every(p =>
    (p.dashboardLink ?? '').trim().length > 0
  )
  checks.push({
    name: 'product-alignment-links',
    passed: hasLinks,
    expected: 'All products have dashboardLink set',
    actual: hasLinks
      ? 'all products have dashboard links'
      : products.length === 0
        ? 'no products'
        : 'one or more products missing dashboard link',
    severity: 'required',
  })

  // expansion-opportunities — section present
  const expansion = parsed.sections?.expansionOpportunities?.content ?? ''
  checks.push({
    name: 'expansion-opportunities',
    passed: expansion.length > 0,
    expected: 'Expansion Opportunities section present',
    actual: expansion.length > 0 ? `${expansion.length} chars` : 'section not found',
    severity: 'required',
  })

  // renewals-risk — section present
  const renewals = parsed.sections?.renewalsAndRisk?.content ?? ''
  checks.push({
    name: 'renewals-risk',
    passed: renewals.length > 0,
    expected: 'Renewals & Risk section present',
    actual: renewals.length > 0 ? `${renewals.length} chars` : 'section not found',
    severity: 'required',
  })

  // SWOT Analysis — present, >= 100 chars
  const swot = parsed.sections?.swotAnalysis?.content ?? ''
  checks.push({
    name: 'swot-present',
    passed: swot.length >= 100,
    expected: '>= 100 chars',
    actual: `${swot.length} chars`,
    severity: 'required',
  })

  // MEDDPICC — 8 entries
  const meddpicEntries = parsed.sections?.meddpicc?.entries ?? []
  checks.push({
    name: 'meddpicc-entries',
    passed: meddpicEntries.length === 8,
    expected: '8 entries',
    actual: `${meddpicEntries.length} entries`,
    severity: 'required',
  })

  // MEDDPICC — not all unknown
  const hasKnownFields = meddpicEntries.some(e => e.status !== 'unknown')
  checks.push({
    name: 'meddpicc-not-all-unknown',
    passed: hasKnownFields,
    expected: 'at least 1 non-unknown',
    actual: `${meddpicEntries.filter(e => e.status !== 'unknown').length} known`,
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const playbookValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
