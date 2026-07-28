/**
 * Account Plan Quality Validator — ADR-024
 *
 * Validates account plan output for structural completeness:
 * section count, whitespace map table, initiatives, actions table,
 * team members, customer goals, Red Hat portfolio, and timeline.
 * Threshold: 75
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
  countTableRows,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'account-plan'
const PASS_THRESHOLD = 75

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Sections Present — at least 10 major sections (## headers)
  const sectionHeaders = output.match(/^##\s+.+$/gm) ?? []
  checks.push({
    name: 'sections-present',
    passed: sectionHeaders.length >= 10,
    expected: 'At least 10 major sections (## headers)',
    actual: `${sectionHeaders.length} sections found`,
    severity: 'required',
  })

  // 2. Whitespace Map — pipe-delimited table present
  const hasWhitespace = /whitespace/i.test(output)
  const whitespaceSection = findSectionByKeyword(output, 'whitespace')
  const whitespaceTableRows = whitespaceSection ? countTableRows(whitespaceSection) : 0
  checks.push({
    name: 'whitespace-map',
    passed: hasWhitespace && whitespaceTableRows > 0,
    expected: 'Whitespace map table present with data rows',
    actual: hasWhitespace
      ? (whitespaceTableRows > 0 ? `${whitespaceTableRows} data rows` : 'section present but no table')
      : 'whitespace map not found',
    severity: 'required',
  })

  // 3. Initiatives — >= 3 strategic initiatives
  const initiativesSection = findSectionByKeyword(output, 'initiative')
    || findSectionByKeyword(output, 'strategic')
  const initiativeBullets = initiativesSection
    ? (initiativesSection.match(/^[\s]*[-*]\s/gm) ?? []).length
      + (initiativesSection.match(/^\d+\.\s/gm) ?? []).length
    : 0
  // Also count ### subsections as initiatives
  const initiativeSubsections = initiativesSection
    ? (initiativesSection.match(/^###\s+/gm) ?? []).length
    : 0
  const totalInitiatives = Math.max(initiativeBullets, initiativeSubsections)
  checks.push({
    name: 'initiatives',
    passed: totalInitiatives >= 3,
    expected: '>= 3 strategic initiatives',
    actual: `${totalInitiatives} initiatives found`,
    severity: 'required',
  })

  // 4. Actions / Next Steps — table or structured list with ownership
  const actionsSection = findSectionByKeyword(output, 'action')
    || findSectionByKeyword(output, 'next step')
  const actionsTableRows = actionsSection ? countTableRows(actionsSection) : 0
  const hasOwnerRef = actionsSection
    ? /\|\s*owner\s*\|/i.test(actionsSection) || /\bowner\b/i.test(actionsSection) || /\bAE\b|\bASA\b/i.test(actionsSection)
    : false
  const hasActionContent = actionsSection ? actionsSection.length > 50 : false
  checks.push({
    name: 'actions-table',
    passed: hasActionContent && hasOwnerRef,
    expected: 'Actions/next steps section with ownership references',
    actual: hasActionContent
      ? (hasOwnerRef ? `${actionsTableRows} table rows, ownership refs found` : 'content present but no ownership references')
      : 'actions section not found',
    severity: 'required',
  })

  // 5. Team Members — section with AE and ASA names
  const teamSection = findSectionByKeyword(output, 'team')
  const hasAE = teamSection ? /\bAE\b|Account\s+Executive/i.test(teamSection) : false
  const hasASA = teamSection ? /\bASA\b|Account\s+Solution\s+Architect/i.test(teamSection) : false
  checks.push({
    name: 'team-members',
    passed: teamSection.length > 0 && hasAE && hasASA,
    expected: 'Team members section with AE and ASA roles identified',
    actual: teamSection.length > 0
      ? `AE: ${hasAE ? 'found' : 'missing'}, ASA: ${hasASA ? 'found' : 'missing'}`
      : 'team members section not found',
    severity: 'required',
  })

  // 6. Customer Goals — customer goals/objectives section present
  const goalsSection = findSectionByKeyword(output, 'goal')
    || findSectionByKeyword(output, 'objective')
    || findSectionByKeyword(output, 'priorities')
  checks.push({
    name: 'customer-goals',
    passed: goalsSection.length > 0,
    expected: 'Customer goals/objectives section present',
    actual: goalsSection.length > 0 ? `${goalsSection.length} chars` : 'section not found',
    severity: 'required',
  })

  // 7. Red Hat Portfolio — Red Hat products referenced with specific names
  const rhProducts = [
    /\bRHEL\b/i, /\bRed\s+Hat\s+Enterprise\s+Linux\b/i,
    /\bOpenShift\b/i,
    /\bAnsible\b/i, /\bAAP\b/,
    /\bSatellite\b/i,
    /\bAdvanced\s+Cluster\s+(?:Management|Security)\b/i, /\bACM\b/, /\bACS\b/,
    /\bQuay\b/i,
    /\bInsights\b/i,
  ]
  const productsFound = rhProducts.filter(p => p.test(output)).length
  checks.push({
    name: 'red-hat-portfolio',
    passed: productsFound >= 2,
    expected: 'Red Hat products referenced with specific names (>= 2)',
    actual: `${productsFound} Red Hat products referenced`,
    severity: 'required',
  })

  // 8. Timeline — timeline or quarterly plan present (important, not zero-out)
  const hasTimeline = /timeline|quarterly|Q[1-4]\s+20\d{2}|roadmap|milestones?|target\s+date/i.test(output)
  checks.push({
    name: 'timeline',
    passed: hasTimeline,
    expected: 'Timeline references present in plan',
    actual: hasTimeline ? 'timeline keywords found' : 'no timeline references found',
    severity: 'important',
  })

  // 9. Economic Buyer — CY27 requirement
  const hasEconomicBuyer = /economic\s+buyer/i.test(output)
  checks.push({
    name: 'economic-buyer',
    passed: hasEconomicBuyer,
    expected: 'Economic Buyer identified (CY27 requirement)',
    actual: hasEconomicBuyer ? 'economic buyer mentioned' : 'economic buyer not found',
    severity: 'required',
  })

  // 10. Partner Growth Strategy — CY27 requirement
  const hasPartnerGrowth = /partner.{0,20}growth|value.added.reseller|\bVAR\b|\bdistributor/i.test(output)
  checks.push({
    name: 'partner-growth-strategy',
    passed: hasPartnerGrowth,
    expected: 'Partner growth strategy content (VARs/distributors) present (CY27 requirement)',
    actual: hasPartnerGrowth ? 'partner growth strategy found' : 'partner growth strategy not found',
    severity: 'required',
  })

  // 11. Security & Sovereignty — CY27 requirement
  const hasSecuritySovereignty = /sovereignty|compliance|lightwell/i.test(output)
  checks.push({
    name: 'security-sovereignty',
    passed: hasSecuritySovereignty,
    expected: 'Security/Compliance/Sovereignty content present (CY27 requirement)',
    actual: hasSecuritySovereignty ? 'security/sovereignty content found' : 'security/sovereignty content not found',
    severity: 'required',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findSectionByKeyword(content: string, keyword: string): string {
  const pattern = new RegExp(`^#{2,3}\\s+[^\\n]*${keyword}[^\\n]*$`, 'im')
  const match = content.match(pattern)
  if (!match) return ''

  const startIdx = match.index! + match[0].length
  const level = (match[0].match(/^#+/) ?? ['##'])[0].length
  const nextPattern = new RegExp(`^#{1,${level}}\\s+`, 'm')
  const rest = content.slice(startIdx)
  const nextMatch = rest.match(nextPattern)
  const endIdx = nextMatch ? startIdx + nextMatch.index! : content.length

  return content.slice(startIdx, endIdx).trim()
}

export const accountPlanValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
