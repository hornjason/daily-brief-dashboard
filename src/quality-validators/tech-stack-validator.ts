/**
 * Tech Stack Quality Validator — ADR-024
 *
 * Validates Gemini tech-stack extraction output (JSON array of TechEntry objects)
 * for completeness, specificity, and evidence quality.
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

/** Generic technology names that are too vague to be actionable */
const GENERIC_NAMES = new Set([
  'ai',
  'cloud',
  'automation',
  'analytics',
  'devops',
  'security',
  'networking',
  'database',
  'middleware',
  'infrastructure',
  'platform',
  'saas',
  'paas',
  'iaas',
  'iot',
  'ml',
  'big data',
  'data',
  'api',
  'microservices',
])

const VALID_CONTEXTS = new Set(['using', 'evaluating', 'migrating_from', 'developing'])

interface TechEntryForValidation {
  name?: string
  category?: string
  context?: string
  description?: string
  why?: string
  source?: string
  redHatProducts?: string[]
}

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  let entries: TechEntryForValidation[] = []
  try {
    entries = JSON.parse(output)
    if (!Array.isArray(entries)) entries = []
  } catch {
    // If we can't parse at all, every check fails
    entries = []
  }

  // ── Required checks ──────────────────────────────────────────────────────

  // 1. min-technologies: At least 3 technologies detected
  checks.push({
    name: 'min-technologies',
    passed: entries.length >= 3,
    expected: 'At least 3 technologies detected',
    actual: `${entries.length} technologies`,
    severity: 'required',
  })

  // 2. has-industry-tools: At least 1 industry-tool category entry
  const industryToolCount = entries.filter(e => e.category === 'industry-tool').length
  checks.push({
    name: 'has-industry-tools',
    passed: industryToolCount >= 1,
    expected: 'At least 1 industry-tool category entry',
    actual: `${industryToolCount} industry-tool entries`,
    severity: 'required',
  })

  // 3. names-specific: No generic standalone names
  const genericNames = entries.filter(e => {
    const name = (e.name ?? '').trim().toLowerCase()
    return GENERIC_NAMES.has(name)
  })
  checks.push({
    name: 'names-specific',
    passed: genericNames.length === 0,
    expected: 'No generic standalone names (AI, Cloud, Automation, etc.)',
    actual: genericNames.length === 0
      ? 'all names are specific'
      : `generic names found: ${genericNames.map(e => e.name).join(', ')}`,
    severity: 'required',
  })

  // 4. has-context: Every entry has a valid context value
  const invalidContext = entries.filter(e => !VALID_CONTEXTS.has(e.context ?? ''))
  checks.push({
    name: 'has-context',
    passed: entries.length > 0 && invalidContext.length === 0,
    expected: 'Every entry has a valid context (using/evaluating/migrating_from/developing)',
    actual: entries.length === 0
      ? 'no entries to check'
      : invalidContext.length === 0
        ? 'all entries have valid context'
        : `${invalidContext.length} entries with invalid context`,
    severity: 'required',
  })

  // 5. has-descriptions: At least 80% of entries have non-empty descriptions
  const withDescription = entries.filter(e => (e.description ?? '').trim().length > 0).length
  const descPct = entries.length > 0 ? Math.round((withDescription / entries.length) * 100) : 0
  checks.push({
    name: 'has-descriptions',
    passed: entries.length > 0 && descPct >= 80,
    expected: 'At least 80% of entries have non-empty descriptions',
    actual: entries.length === 0
      ? 'no entries to check'
      : `${descPct}% (${withDescription}/${entries.length}) have descriptions`,
    severity: 'required',
  })

  // ── Recommended checks ───────────────────────────────────────────────────

  // 6. has-why: At least 50% of entries have a why field
  const withWhy = entries.filter(e => (e.why ?? '').trim().length > 0).length
  const whyPct = entries.length > 0 ? Math.round((withWhy / entries.length) * 100) : 0
  checks.push({
    name: 'has-why',
    passed: entries.length > 0 && whyPct >= 50,
    expected: 'At least 50% of entries have a why field',
    actual: entries.length === 0
      ? 'no entries to check'
      : `${whyPct}% (${withWhy}/${entries.length}) have why`,
    severity: 'recommended',
  })

  // 7. has-sources: At least 30% of entries have a non-empty source field
  const withSource = entries.filter(e => {
    const src = (e.source ?? '').trim()
    return src.length > 0 && src !== 'provided-context'
  }).length
  const srcPct = entries.length > 0 ? Math.round((withSource / entries.length) * 100) : 0
  checks.push({
    name: 'has-sources',
    passed: entries.length > 0 && srcPct >= 30,
    expected: 'At least 30% of entries have a non-empty source field',
    actual: entries.length === 0
      ? 'no entries to check'
      : `${srcPct}% (${withSource}/${entries.length}) have sources`,
    severity: 'recommended',
  })

  // 8. has-red-hat-products: At least 30% of entries have redHatProducts populated
  const withRhProducts = entries.filter(e =>
    Array.isArray(e.redHatProducts) && e.redHatProducts.length > 0
  ).length
  const rhPct = entries.length > 0 ? Math.round((withRhProducts / entries.length) * 100) : 0
  checks.push({
    name: 'has-red-hat-products',
    passed: entries.length > 0 && rhPct >= 30,
    expected: 'At least 30% of entries have redHatProducts populated',
    actual: entries.length === 0
      ? 'no entries to check'
      : `${rhPct}% (${withRhProducts}/${entries.length}) have redHatProducts`,
    severity: 'recommended',
  })

  // 9. context-variety: Not all entries are "using"
  const contextSet = new Set(entries.map(e => e.context).filter(Boolean))
  const hasVariety = contextSet.size > 1 || entries.length === 0
  checks.push({
    name: 'context-variety',
    passed: entries.length === 0 || hasVariety,
    expected: 'Not all entries are "using" — at least 1 evaluating or migrating_from',
    actual: entries.length === 0
      ? 'no entries to check'
      : hasVariety
        ? `${contextSet.size} distinct contexts: ${[...contextSet].join(', ')}`
        : 'all entries are "using"',
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

export const techStackValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
