/**
 * Quality validator for SalesHub product enrichment (content kits, messaging guides,
 * battlecards, case studies, competitive reviews).
 * ADR-024: Every module that generates content via Gemini MUST have a quality validator.
 *
 * Validators added in #868: caseStudyValidator, competitiveReviewValidator.
 */

import {
  type QualityValidator,
  type QualityScorecard,
  type QualityCheck,
  initialScorecard,
} from '../gemini-quality-gate.ts'

function checkContentKit(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({ name: 'valid-json', passed: false, expected: 'valid JSON object', actual: 'parse error', severity: 'required' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, expected: 'valid JSON object', actual: 'valid JSON', severity: 'required' })

  // Actionable steps must exist and have at least 2
  const steps = parsed.actionableSteps ?? []
  checks.push({
    name: 'has-actionable-steps',
    passed: steps.length >= 2,
    expected: 'at least 2 actionable steps',
    actual: `${steps.length} actionable steps`,
    severity: 'required',
  })

  // URLs must be preserved — check that steps with URLs have valid http URLs
  const stepsWithUrls = steps.filter((s: any) => s.url)
  const validUrls = stepsWithUrls.filter((s: any) => s.url.startsWith('http'))
  checks.push({
    name: 'urls-preserved',
    passed: stepsWithUrls.length === 0 || validUrls.length === stepsWithUrls.length,
    expected: 'all step URLs start with http',
    actual: `${validUrls.length}/${stepsWithUrls.length} valid`,
    severity: 'required',
  })

  // Workshops or demos should be populated if the document mentions them
  const workshops = parsed.workshops ?? []
  const demos = parsed.demos ?? []
  const internalMaterials = parsed.internalMaterials ?? []
  checks.push({
    name: 'has-resources',
    passed: workshops.length > 0 || demos.length > 0 || internalMaterials.length > 0,
    expected: 'at least 1 workshop, demo, or internal material',
    actual: `${workshops.length} workshops, ${demos.length} demos, ${internalMaterials.length} materials`,
    severity: 'recommended',
  })

  // Sales play alignment should exist
  const alignment = parsed.salesPlayAlignment ?? []
  checks.push({
    name: 'has-play-alignment',
    passed: alignment.length > 0,
    expected: 'at least 1 play alignment entry',
    actual: `${alignment.length} entries`,
    severity: 'recommended',
  })

  return checks
}

function checkDocumentExtraction(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({ name: 'valid-json', passed: false, expected: 'valid JSON object', actual: 'parse error', severity: 'required' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, expected: 'valid JSON object', actual: 'valid JSON', severity: 'required' })

  // Summary must be substantive
  const summary = parsed.summary ?? ''
  checks.push({
    name: 'has-summary',
    passed: summary.length >= 20,
    expected: 'summary at least 20 chars',
    actual: `${summary.length} chars`,
    severity: 'required',
  })

  // Key points must exist
  const keyPoints = parsed.keyPoints ?? []
  checks.push({
    name: 'has-key-points',
    passed: keyPoints.length >= 2,
    expected: 'at least 2 key points',
    actual: `${keyPoints.length} key points`,
    severity: 'required',
  })

  return checks
}

export const contentKitValidator: QualityValidator = {
  contentType: 'content-kit-extraction',
  passThreshold: 60,
  validate(output: string): QualityScorecard {
    const checks = checkContentKit(output)
    const passed = checks.filter(c => c.passed).length
    const total = checks.length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0
    return { ...initialScorecard(score), checks }
  },
}

export const documentExtractionValidator: QualityValidator = {
  contentType: 'document-extraction',
  passThreshold: 60,
  validate(output: string): QualityScorecard {
    const checks = checkDocumentExtraction(output)
    const passed = checks.filter(c => c.passed).length
    const total = checks.length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0
    return { ...initialScorecard(score), checks }
  },
}

// ── Case Study validator (#868) ────────────────────────────────────────────

function checkCaseStudy(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({ name: 'valid-json', passed: false, expected: 'valid JSON object', actual: 'parse error', severity: 'required' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, expected: 'valid JSON object', actual: 'valid JSON', severity: 'required' })

  // customerName must be non-empty
  const customerName = (parsed.customerName ?? '').trim()
  checks.push({
    name: 'has-customer-name',
    passed: customerName.length > 0,
    expected: 'non-empty customerName',
    actual: customerName.length > 0 ? customerName : '(empty)',
    severity: 'required',
  })

  // challenge must be non-empty
  const challenge = (parsed.challenge ?? '').trim()
  checks.push({
    name: 'has-challenge',
    passed: challenge.length > 0,
    expected: 'non-empty challenge description',
    actual: challenge.length > 0 ? `${challenge.length} chars` : '(empty)',
    severity: 'required',
  })

  // solution must be non-empty
  const solution = (parsed.solution ?? '').trim()
  checks.push({
    name: 'has-solution',
    passed: solution.length > 0,
    expected: 'non-empty solution description',
    actual: solution.length > 0 ? `${solution.length} chars` : '(empty)',
    severity: 'required',
  })

  // results array must have at least 1 item
  const results = parsed.results ?? []
  checks.push({
    name: 'has-results',
    passed: results.length >= 1,
    expected: 'at least 1 measurable result',
    actual: `${results.length} results`,
    severity: 'required',
  })

  return checks
}

export const caseStudyValidator: QualityValidator = {
  contentType: 'case-study-extraction',
  passThreshold: 60,
  validate(output: string): QualityScorecard {
    const checks = checkCaseStudy(output)
    const passed = checks.filter(c => c.passed).length
    const total = checks.length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0
    return { ...initialScorecard(score), checks }
  },
}

// ── Competitive Review validator (#868) ────────────────────────────────────

function checkCompetitiveReview(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({ name: 'valid-json', passed: false, expected: 'valid JSON object', actual: 'parse error', severity: 'required' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, expected: 'valid JSON object', actual: 'valid JSON', severity: 'required' })

  // competitor must be non-empty
  const competitor = (parsed.competitor ?? '').trim()
  checks.push({
    name: 'has-competitor',
    passed: competitor.length > 0,
    expected: 'non-empty competitor name',
    actual: competitor.length > 0 ? competitor : '(empty)',
    severity: 'required',
  })

  // keyDifferentiators must have at least 1 item
  const differentiators = parsed.keyDifferentiators ?? []
  checks.push({
    name: 'has-differentiators',
    passed: differentiators.length >= 1,
    expected: 'at least 1 key differentiator',
    actual: `${differentiators.length} differentiators`,
    severity: 'required',
  })

  return checks
}

export const competitiveReviewValidator: QualityValidator = {
  contentType: 'competitive-review-extraction',
  passThreshold: 60,
  validate(output: string): QualityScorecard {
    const checks = checkCompetitiveReview(output)
    const passed = checks.filter(c => c.passed).length
    const total = checks.length
    const score = total > 0 ? Math.round((passed / total) * 100) : 0
    return { ...initialScorecard(score), checks }
  },
}
