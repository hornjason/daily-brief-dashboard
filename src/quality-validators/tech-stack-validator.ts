/**
 * Tech Stack Quality Validator — ADR-024
 *
 * Validates TechEntry[] output for structural completeness:
 * valid JSON array, minimum technologies, required fields,
 * valid categories/contexts/confidence, and Red Hat product coverage.
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'tech-stack'
const PASS_THRESHOLD = 70

const VALID_CATEGORIES = ['proprietary', 'industry-tool']
const VALID_CONTEXTS = ['using', 'evaluating', 'migrating_from', 'developing']
const VALID_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW']

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  let parsed: any[]
  try {
    const raw = JSON.parse(output)
    parsed = Array.isArray(raw) ? raw : []
  } catch {
    checks.push({
      name: 'valid-json',
      passed: false,
      expected: 'Valid JSON array',
      actual: 'Failed to parse JSON',
      severity: 'required',
    })
    return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
  }

  // 1. valid-json passed
  checks.push({
    name: 'valid-json',
    passed: true,
    expected: 'Valid JSON array',
    actual: `Parsed array with ${parsed.length} items`,
    severity: 'required',
  })

  // 2. min-technologies: >= 1
  checks.push({
    name: 'min-technologies',
    passed: parsed.length >= 1,
    expected: '>= 1 technology',
    actual: `${parsed.length} technologies`,
    severity: 'required',
  })

  // 3. required-fields: each entry has non-empty name, category, description
  let missingFieldCount = 0
  const missingDetails: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i]
    for (const field of ['name', 'category', 'description']) {
      if (!e[field] || String(e[field]).trim() === '') {
        missingFieldCount++
        if (missingDetails.length < 3) {
          missingDetails.push(`[${i}].${field}`)
        }
      }
    }
  }
  checks.push({
    name: 'required-fields',
    passed: missingFieldCount === 0,
    expected: 'Each entry has non-empty name, category, description',
    actual: missingFieldCount > 0
      ? `${missingFieldCount} missing fields: ${missingDetails.join(', ')}`
      : `${parsed.length} entries, all required fields present`,
    severity: 'required',
  })

  // 4. valid-categories
  let invalidCategories = 0
  for (const e of parsed) {
    if (e.category && !VALID_CATEGORIES.includes(e.category)) {
      invalidCategories++
    }
  }
  checks.push({
    name: 'valid-categories',
    passed: invalidCategories === 0,
    expected: `category is one of: ${VALID_CATEGORIES.join(', ')}`,
    actual: invalidCategories > 0
      ? `${invalidCategories} entries have invalid categories`
      : 'All categories valid',
    severity: 'required',
  })

  // 5. valid-contexts
  let invalidContexts = 0
  for (const e of parsed) {
    if (e.context && !VALID_CONTEXTS.includes(e.context)) {
      invalidContexts++
    }
  }
  checks.push({
    name: 'valid-contexts',
    passed: invalidContexts === 0,
    expected: `context is one of: ${VALID_CONTEXTS.join(', ')}`,
    actual: invalidContexts > 0
      ? `${invalidContexts} entries have invalid contexts`
      : 'All contexts valid',
    severity: 'required',
  })

  // 6. valid-confidence
  let invalidConfidence = 0
  for (const e of parsed) {
    if (e.confidence && !VALID_CONFIDENCE.includes(e.confidence)) {
      invalidConfidence++
    }
  }
  checks.push({
    name: 'valid-confidence',
    passed: invalidConfidence === 0,
    expected: `confidence is one of: ${VALID_CONFIDENCE.join(', ')}`,
    actual: invalidConfidence > 0
      ? `${invalidConfidence} entries have invalid confidence`
      : 'All confidence values valid',
    severity: 'required',
  })

  // 7. has-red-hat-products: at least 50% have non-empty redHatProducts
  const withProducts = parsed.filter(e => Array.isArray(e.redHatProducts) && e.redHatProducts.length > 0).length
  const productPct = parsed.length > 0 ? Math.round((withProducts / parsed.length) * 100) : 0
  checks.push({
    name: 'has-red-hat-products',
    passed: parsed.length === 0 || productPct >= 50,
    expected: 'At least 50% of entries have non-empty redHatProducts array',
    actual: `${withProducts}/${parsed.length} (${productPct}%) have redHatProducts`,
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const techStackValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
