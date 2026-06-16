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
    checks.push({ name: 'valid-json', passed: false, detail: 'Output is not valid JSON' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, detail: 'Valid JSON' })

  // Actionable steps must exist and have at least 2
  const steps = parsed.actionableSteps ?? []
  checks.push({
    name: 'has-actionable-steps',
    passed: steps.length >= 2,
    detail: `${steps.length} actionable steps (min 2)`,
  })

  // URLs must be preserved — check that steps with URLs have valid http URLs
  const stepsWithUrls = steps.filter((s: any) => s.url)
  const validUrls = stepsWithUrls.filter((s: any) => s.url.startsWith('http'))
  checks.push({
    name: 'urls-preserved',
    passed: stepsWithUrls.length === 0 || validUrls.length === stepsWithUrls.length,
    detail: `${validUrls.length}/${stepsWithUrls.length} step URLs are valid`,
  })

  // Workshops or demos should be populated if the document mentions them
  const workshops = parsed.workshops ?? []
  const demos = parsed.demos ?? []
  checks.push({
    name: 'has-resources',
    passed: workshops.length > 0 || demos.length > 0 || (parsed.internalMaterials ?? []).length > 0,
    detail: `${workshops.length} workshops, ${demos.length} demos, ${(parsed.internalMaterials ?? []).length} internal materials`,
  })

  // Sales play alignment should exist
  const alignment = parsed.salesPlayAlignment ?? []
  checks.push({
    name: 'has-play-alignment',
    passed: alignment.length > 0,
    detail: `${alignment.length} play alignment entries`,
  })

  return checks
}

function checkDocumentExtraction(output: string): QualityCheck[] {
  const checks: QualityCheck[] = []
  let parsed: any

  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({ name: 'valid-json', passed: false, detail: 'Output is not valid JSON' })
    return checks
  }
  checks.push({ name: 'valid-json', passed: true, detail: 'Valid JSON' })

  // Summary must be substantive
  const summary = parsed.summary ?? ''
  checks.push({
    name: 'has-summary',
    passed: summary.length >= 20,
    detail: `Summary length: ${summary.length} chars (min 20)`,
  })

  // Key points must exist
  const keyPoints = parsed.keyPoints ?? []
  checks.push({
    name: 'has-key-points',
    passed: keyPoints.length >= 2,
    detail: `${keyPoints.length} key points (min 2)`,
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
