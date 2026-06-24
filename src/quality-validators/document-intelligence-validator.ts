/**
 * Quality Validator for DocumentIntelligence (ADR-041, ADR-024)
 *
 * Single universal validator replacing the 4 type-specific validators.
 * Pass threshold: 65 (per council decision).
 *
 * Hard fail gates (per council):
 * - productsReferenced must have >= 1 entry
 * - At least 1 of: integrationsReferenced, useCases, competitorsReferenced, partnerSolutions
 */

import {
  type QualityValidator,
  type QualityScorecard,
  type QualityCheck,
  initialScorecard,
} from '../gemini-quality-gate.ts'

const VALID_CATEGORIES = new Set([
  'content-kit', 'messaging-guide', 'battlecard', 'case-study',
  'competitive-review', 'solution-brief', 'design-guide',
  'workshop', 'demo', 'reference-architecture', 'migration-guide', 'other',
])

const VALID_AUDIENCES = new Set(['internal', 'partner', 'customer', 'mixed'])

function checkDocumentIntelligence(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({
      name: 'valid-json',
      passed: false,
      expected: 'valid JSON object',
      actual: 'parse error',
      severity: 'required',
    })
    return checks
  }
  checks.push({
    name: 'valid-json',
    passed: true,
    expected: 'valid JSON object',
    actual: 'valid JSON',
    severity: 'required',
  })

  // productsReferenced must have at least 1 (hard fail)
  const products = parsed.productsReferenced ?? []
  checks.push({
    name: 'has-products',
    passed: products.length >= 1,
    expected: 'at least 1 product referenced',
    actual: `${products.length} products`,
    severity: 'required',
  })

  // At least 1 classification field populated (hard fail gate per council)
  const integrations = parsed.integrationsReferenced ?? []
  const useCases = parsed.useCases ?? []
  const competitors = parsed.competitorsReferenced ?? []
  const partnerSols = parsed.partnerSolutions ?? []
  const hasClassification =
    integrations.length > 0 ||
    useCases.length > 0 ||
    competitors.length > 0 ||
    partnerSols.length > 0
  checks.push({
    name: 'has-classification',
    passed: hasClassification,
    expected: 'at least 1 of integrations, useCases, competitors, or partnerSolutions populated',
    actual: `integrations: ${integrations.length}, useCases: ${useCases.length}, competitors: ${competitors.length}, partners: ${partnerSols.length}`,
    severity: 'required',
  })

  // summary must exist (required) and be substantive (recommended — triggers retry)
  const summary = parsed.summary ?? ''
  checks.push({
    name: 'has-summary',
    passed: summary.length >= 20,
    expected: 'summary at least 20 chars',
    actual: `${summary.length} chars`,
    severity: 'required',
  })
  checks.push({
    name: 'summary-depth',
    passed: summary.length >= 300,
    expected: 'summary at least 300 chars for substantive context',
    actual: `${summary.length} chars`,
    severity: 'recommended',
  })

  // keyPoints >= 1
  const keyPoints = parsed.keyPoints ?? []
  checks.push({
    name: 'has-key-points',
    passed: keyPoints.length >= 1,
    expected: 'at least 1 key point',
    actual: `${keyPoints.length} key points`,
    severity: 'required',
  })

  // documentCategory is valid enum
  const category = parsed.documentCategory ?? ''
  checks.push({
    name: 'valid-category',
    passed: VALID_CATEGORIES.has(category),
    expected: 'valid document category',
    actual: category || '(empty)',
    severity: 'required',
  })

  // audience is valid enum
  const audience = parsed.audience ?? ''
  checks.push({
    name: 'valid-audience',
    passed: VALID_AUDIENCES.has(audience),
    expected: 'valid audience type',
    actual: audience || '(empty)',
    severity: 'required',
  })

  // links >= 1 (recommended, not hard fail)
  const links = parsed.links ?? []
  checks.push({
    name: 'has-links',
    passed: links.length >= 1,
    expected: 'at least 1 link',
    actual: `${links.length} links`,
    severity: 'recommended',
  })

  // talk tracks present (recommended — triggers retry for richer output)
  const talkTracks = parsed.talkTracks ?? []
  checks.push({
    name: 'has-talk-tracks',
    passed: talkTracks.length >= 1,
    expected: 'at least 1 talk track for AE conversations',
    actual: `${talkTracks.length} talk tracks`,
    severity: 'recommended',
  })

  return checks
}

export const documentIntelligenceValidator: QualityValidator = {
  contentType: 'document-intelligence',
  passThreshold: 65,
  validate(output: string): QualityScorecard {
    const checks = checkDocumentIntelligence(output)
    const passed = checks.filter(c => c.passed).length
    const total = checks.length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0
    return { ...initialScorecard(score), checks }
  },
}
