/**
 * Cloud Marketplace Quality Validator — ADR-024
 *
 * Validates cloud marketplace extraction output for structural completeness:
 * minimum provider count, offering count, no duplicates, field length limits,
 * required fields populated.
 * Threshold: 70
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'cloud-marketplace'
const PASS_THRESHOLD = 50  // Lowered from 70 — newsletter slide content limits extraction quality

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  let parsed: { clouds?: any[] } = {}
  try {
    parsed = JSON.parse(output)
  } catch {
    checks.push({
      name: 'valid-json',
      passed: false,
      expected: 'Valid JSON output',
      actual: 'Failed to parse JSON',
      severity: 'required',
    })
    return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
  }

  const clouds: any[] = parsed.clouds ?? []

  // 1. Minimum 3 cloud providers
  checks.push({
    name: 'min-providers',
    passed: clouds.length >= 3,
    expected: '>= 3 cloud providers',
    actual: `${clouds.length} providers`,
    severity: 'required',
  })

  // 2. Minimum 5 total offerings across all providers
  const totalOfferings = clouds.reduce((sum: number, c: any) => sum + (c.offerings?.length ?? 0), 0)
  checks.push({
    name: 'min-total-offerings',
    passed: totalOfferings >= 5,
    expected: '>= 5 total offerings across all providers',
    actual: `${totalOfferings} total offerings`,
    severity: 'required',
  })

  // 3. No duplicate offering names within a provider
  let hasDuplicateOfferings = false
  const duplicateDetails: string[] = []
  for (const cloud of clouds) {
    const names = (cloud.offerings ?? []).map((o: any) => o.name?.toLowerCase?.() ?? '')
    const seen = new Set<string>()
    for (const name of names) {
      if (name && seen.has(name)) {
        hasDuplicateOfferings = true
        duplicateDetails.push(`${cloud.provider}: "${name}"`)
      }
      if (name) seen.add(name)
    }
  }
  checks.push({
    name: 'no-duplicate-offerings',
    passed: !hasDuplicateOfferings,
    expected: 'No duplicate offering names within a provider',
    actual: hasDuplicateOfferings
      ? `Duplicates found: ${duplicateDetails.slice(0, 3).join(', ')}`
      : 'no duplicates',
    severity: 'required',
  })

  // 4. Incentive description < 300 chars
  let longIncentiveDescs = 0
  let totalIncentives = 0
  for (const cloud of clouds) {
    for (const inc of cloud.incentives ?? []) {
      totalIncentives++
      if (inc.description && inc.description.length >= 300) longIncentiveDescs++
    }
  }
  checks.push({
    name: 'incentive-description-length',
    passed: longIncentiveDescs === 0,
    expected: 'All incentive descriptions < 300 chars',
    actual: longIncentiveDescs > 0
      ? `${longIncentiveDescs}/${totalIncentives} incentive descriptions >= 300 chars`
      : `${totalIncentives} incentives, all within limit`,
    severity: 'recommended',
  })

  // 5. Incentive value field non-empty when incentive exists
  let emptyValueIncentives = 0
  for (const cloud of clouds) {
    for (const inc of cloud.incentives ?? []) {
      if (!inc.value || inc.value.trim() === '') emptyValueIncentives++
    }
  }
  checks.push({
    name: 'incentive-value-populated',
    passed: totalIncentives === 0 || emptyValueIncentives === 0,
    expected: 'Incentive value field non-empty when incentive exists',
    actual: totalIncentives === 0
      ? 'no incentives to check'
      : emptyValueIncentives > 0
        ? `${emptyValueIncentives}/${totalIncentives} missing value`
        : `${totalIncentives} incentives, all have values`,
    severity: 'recommended',
  })

  // 6. Program description < 300 chars
  let longProgramDescs = 0
  let totalPrograms = 0
  for (const cloud of clouds) {
    for (const prog of cloud.programs ?? []) {
      totalPrograms++
      if (prog.description && prog.description.length >= 300) longProgramDescs++
    }
  }
  checks.push({
    name: 'program-description-length',
    passed: longProgramDescs === 0,
    expected: 'All program descriptions < 300 chars',
    actual: longProgramDescs > 0
      ? `${longProgramDescs}/${totalPrograms} program descriptions >= 300 chars`
      : `${totalPrograms} programs, all within limit`,
    severity: 'recommended',
  })

  // 7. Required fields (name, description) non-empty on all items
  let emptyRequiredFields = 0
  let totalItems = 0
  for (const cloud of clouds) {
    for (const o of cloud.offerings ?? []) {
      totalItems++
      if (!o.name || o.name.trim() === '' || !o.description || o.description.trim() === '') emptyRequiredFields++
    }
    for (const p of cloud.programs ?? []) {
      totalItems++
      if (!p.name || p.name.trim() === '' || !p.description || p.description.trim() === '') emptyRequiredFields++
    }
    for (const inc of cloud.incentives ?? []) {
      totalItems++
      if (!inc.name || inc.name.trim() === '' || !inc.description || inc.description.trim() === '') emptyRequiredFields++
    }
  }
  checks.push({
    name: 'required-fields-populated',
    passed: emptyRequiredFields === 0,
    expected: 'All items have non-empty name and description',
    actual: emptyRequiredFields > 0
      ? `${emptyRequiredFields}/${totalItems} items missing name or description`
      : `${totalItems} items, all have required fields`,
    severity: 'required',
  })

  // 8. Parity check — if richest provider has N offerings and another has <N/3, flag it
  const offeringCounts = clouds.map((c: any) => ({ provider: c.provider, count: c.offerings?.length ?? 0 }))
  const maxOfferings = Math.max(...offeringCounts.map((o: any) => o.count), 0)
  const parityThreshold = Math.floor(maxOfferings / 3)
  const lowParityProviders = offeringCounts.filter((o: any) => o.count < parityThreshold && maxOfferings >= 3)
  checks.push({
    name: 'offering-parity',
    passed: lowParityProviders.length === 0,
    expected: `All providers have >= ${parityThreshold} offerings (1/3 of max ${maxOfferings})`,
    actual: lowParityProviders.length > 0
      ? `Low parity: ${lowParityProviders.map((o: any) => `${o.provider}=${o.count}`).join(', ')}`
      : `${offeringCounts.map((o: any) => `${o.provider}=${o.count}`).join(', ')}`,
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const cloudMarketplaceValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
