/**
 * Quality validator for SalesHub product enrichment (content kits, messaging guides, battlecards).
 * ADR-024: Every module that generates content via Gemini MUST have a quality validator.
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
