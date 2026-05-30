/**
 * Competitive Intel Quality Validator — ADR-024
 *
 * Validates CompetitiveExtraction[] output for structural completeness:
 * valid JSON array, minimum extractions, required fields, no duplicates,
 * sales triggers coverage, and description length limits.
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'competitive-intel'
const PASS_THRESHOLD = 70

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

  // 2. min-extractions: >= 1
  checks.push({
    name: 'min-extractions',
    passed: parsed.length >= 1,
    expected: '>= 1 extraction',
    actual: `${parsed.length} extractions`,
    severity: 'required',
  })

  // 3. required-fields: each extraction has non-empty competitor, product, announcement, redHatCounter
  let missingFieldCount = 0
  const missingDetails: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const e = parsed[i]
    const fields = ['competitor', 'product', 'announcement', 'redHatCounter']
    for (const field of fields) {
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
    expected: 'Each extraction has non-empty competitor, product, announcement, redHatCounter',
    actual: missingFieldCount > 0
      ? `${missingFieldCount} missing fields: ${missingDetails.join(', ')}`
      : `${parsed.length} extractions, all required fields present`,
    severity: 'required',
  })

  // 4. no-duplicate-competitors: no duplicate competitor+product pairs
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const e of parsed) {
    const key = `${String(e.competitor ?? '').toLowerCase()}|${String(e.product ?? '').toLowerCase()}`
    if (key !== '|' && seen.has(key)) {
      duplicates.push(`${e.competitor}/${e.product}`)
    }
    if (key !== '|') seen.add(key)
  }
  checks.push({
    name: 'no-duplicate-competitors',
    passed: duplicates.length === 0,
    expected: 'No duplicate competitor+product pairs',
    actual: duplicates.length > 0
      ? `Duplicates found: ${duplicates.slice(0, 3).join(', ')}`
      : 'No duplicates',
    severity: 'required',
  })

  // 5. sales-triggers-present: at least 50% have salesTriggers
  const withTriggers = parsed.filter(e => Array.isArray(e.salesTriggers) && e.salesTriggers.length > 0).length
  const triggerPct = parsed.length > 0 ? Math.round((withTriggers / parsed.length) * 100) : 0
  checks.push({
    name: 'sales-triggers-present',
    passed: parsed.length === 0 || triggerPct >= 50,
    expected: 'At least 50% of extractions have salesTriggers',
    actual: `${withTriggers}/${parsed.length} (${triggerPct}%) have salesTriggers`,
    severity: 'recommended',
  })

  // 6. description-length: announcement and redHatCounter < 500 chars each
  let longFields = 0
  for (const e of parsed) {
    if (e.announcement && String(e.announcement).length >= 500) longFields++
    if (e.redHatCounter && String(e.redHatCounter).length >= 500) longFields++
  }
  checks.push({
    name: 'description-length',
    passed: longFields === 0,
    expected: 'announcement and redHatCounter < 500 chars each',
    actual: longFields > 0
      ? `${longFields} fields >= 500 chars`
      : 'All fields within limit',
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const competitiveIntelValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
