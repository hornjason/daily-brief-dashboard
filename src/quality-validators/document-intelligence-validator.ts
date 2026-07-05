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
  buildScorecard,
} from '../gemini-quality-gate.ts'

const VALID_CATEGORIES = new Set([
  'content-kit', 'messaging-guide', 'battlecard', 'case-study',
  'competitive-review', 'solution-brief', 'design-guide',
  'workshop', 'demo', 'reference-architecture', 'migration-guide', 'other',
])

const VALID_AUDIENCES = new Set(['internal', 'partner', 'customer', 'mixed'])
const VALID_BUYING_STAGES = new Set(['awareness', 'discovery', 'evaluation', 'justification', 'expansion'])

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

  // New mission-aligned checks — only counted when fields are present in output
  // (backward-compatible: existing enriched data without these fields is unaffected)
  if ('buyingStage' in parsed) {
    const buyingStage = parsed.buyingStage ?? 'awareness'
    const buyingStageValid = VALID_BUYING_STAGES.has(buyingStage)
    checks.push({
      name: 'valid-buying-stage',
      passed: buyingStageValid,
      expected: 'one of: awareness, discovery, evaluation, justification, expansion',
      actual: buyingStage || '(empty)',
      severity: 'required',
    })

    if (buyingStageValid) {
      const cat = parsed.documentCategory ?? ''
      const incoherent =
        (cat === 'case-study' && buyingStage === 'awareness') ||
        (cat === 'battlecard' && buyingStage === 'awareness') ||
        (cat === 'competitive-review' && buyingStage === 'awareness')
      checks.push({
        name: 'buying-stage-coherence',
        passed: !incoherent,
        expected: 'buying stage coherent with document category',
        actual: incoherent ? `${cat} classified as ${buyingStage}` : 'coherent',
        severity: 'recommended',
      })
    }
  }

  const isReferenceDoc = category === 'reference-architecture' || category === 'other'

  if ('customerProblem' in parsed) {
    const customerProblem = parsed.customerProblem ?? ''
    checks.push({
      name: 'has-customer-problem',
      passed: isReferenceDoc || customerProblem.length >= 20,
      expected: 'customer problem at least 20 chars for non-reference docs',
      actual: isReferenceDoc ? 'reference doc — skipped' : `${customerProblem.length} chars`,
      severity: 'recommended',
    })
  }

  if ('tdpAlignment' in parsed) {
    const tdpAlignment = parsed.tdpAlignment ?? []
    checks.push({
      name: 'has-tdp-alignment',
      passed: isReferenceDoc || tdpAlignment.length >= 1,
      expected: 'at least 1 TDP alignment for non-reference docs',
      actual: isReferenceDoc ? 'reference doc — skipped' : `${tdpAlignment.length} TDPs`,
      severity: 'recommended',
    })
  }

  if ('conversationOpener' in parsed) {
    const conversationOpener = parsed.conversationOpener ?? ''
    const isCustomerFacing = audience === 'customer' || audience === 'mixed'
    checks.push({
      name: 'has-conversation-opener',
      passed: !isCustomerFacing || conversationOpener.length >= 30,
      expected: 'conversation opener at least 30 chars for customer-facing docs',
      actual: !isCustomerFacing ? 'non-customer-facing — skipped' : `${conversationOpener.length} chars`,
      severity: 'recommended',
    })

    // #963: Reject null openers for customer-facing and mixed-audience docs
    checks.push({
      name: 'opener-not-null',
      passed: !isCustomerFacing || (conversationOpener !== '' && parsed.conversationOpener !== null),
      expected: 'non-null conversationOpener for customer-facing/mixed docs',
      actual: !isCustomerFacing ? 'non-customer-facing — skipped' : (parsed.conversationOpener === null ? 'null' : 'present'),
      severity: 'recommended',
    })

    // #963: Reject generic question-format openers
    const GENERIC_OPENER_RE = /^(Are you|Is your|Have you|Do you|Would you|Could you|Can you)/i
    const openerIsGeneric = conversationOpener.length > 0 && GENERIC_OPENER_RE.test(conversationOpener)
    checks.push({
      name: 'opener-not-generic',
      passed: !openerIsGeneric,
      expected: 'observation-based opener, not a question starting with Are you/Is your/Have you/Do you/Would you/Could you/Can you',
      actual: openerIsGeneric ? `starts with banned pattern: "${conversationOpener.slice(0, 40)}..."` : 'observation-based',
      severity: 'recommended',
    })
  }

  if ('techStackTriggers' in parsed) {
    const techStackTriggers = parsed.techStackTriggers ?? []
    const hasIntegrations = (parsed.integrationsReferenced ?? []).length > 0
    checks.push({
      name: 'has-tech-stack-triggers',
      passed: !hasIntegrations || techStackTriggers.length > 0,
      expected: 'tech stack triggers present when integrations are referenced',
      actual: !hasIntegrations ? 'no integrations — skipped' : `${techStackTriggers.length} triggers`,
      severity: 'recommended',
    })
  }

  return checks
}

export const documentIntelligenceValidator: QualityValidator = {
  contentType: 'document-intelligence',
  passThreshold: 85,
  validate(output: string): QualityScorecard {
    const checks = checkDocumentIntelligence(output)
    return buildScorecard('document-intelligence', 85, checks)
  },
}
