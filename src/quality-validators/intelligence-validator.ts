/**
 * Intelligence Quality Validator — ADR-024
 *
 * Validates account intelligence (company brief) output for:
 * executive summary, industry structure, technology landscape,
 * competitive signals, company overview, financial data, risk signals,
 * regional coverage, and source citations.
 * Threshold: 80
 */

import {
  type QualityValidator,
  type QualityCheck,
  type QualityScorecard,
  buildScorecard,
} from '../gemini-quality-gate.ts'

const CONTENT_TYPE = 'intelligence'
const PASS_THRESHOLD = 80

function validate(output: string): QualityScorecard {
  const checks: QualityCheck[] = []

  // 1. Executive Summary — present, >= 200 chars
  const execSummary = findSection(output, /executive\s+summary/i)
  checks.push({
    name: 'executive-summary',
    passed: execSummary.length >= 200,
    expected: 'Executive Summary section present with >= 200 chars',
    actual: execSummary.length > 0 ? `${execSummary.length} chars` : 'section not found',
    severity: 'required',
  })

  // 2. Industry Structure — present with market size data
  const industrySec = findSection(output, /industry\s+(?:structure|overview|landscape)/i)
  const hasMarketSize = /\$[\d.,]+\s*(?:billion|million|B|M|trillion|T)\b/i.test(industrySec)
    || /market\s+size/i.test(industrySec)
    || /\bTAM\b/.test(industrySec)
  checks.push({
    name: 'industry-structure',
    passed: industrySec.length > 0 && hasMarketSize,
    expected: 'Industry structure section present with market size data',
    actual: industrySec.length > 0
      ? (hasMarketSize ? 'market size data found' : 'section present but no market size data')
      : 'section not found',
    severity: 'required',
  })

  // 3. Technology Landscape — present
  const techLandscape = findSection(output, /technolog(?:y|ical)\s+(?:landscape|stack|environment|infrastructure)/i)
  checks.push({
    name: 'technology-landscape',
    passed: techLandscape.length > 0,
    expected: 'Technology landscape section present',
    actual: techLandscape.length > 0 ? `${techLandscape.length} chars` : 'section not found',
    severity: 'required',
  })

  // 4. Competitive Signals — >= 3
  const competitive = findSection(output, /competit(?:ive|or|ion)\s+(?:signals?|landscape|analysis|overview)/i)
  // Count bullet points, numbered items, or competitor mentions
  const competitorBullets = (competitive.match(/^[\s]*[-*]\s/gm) ?? []).length
    + (competitive.match(/^\d+\.\s/gm) ?? []).length
  // Also check for competitor name mentions as a fallback
  const competitorMentions = (competitive.match(/\b(?:AWS|Azure|Microsoft|Google|VMware|IBM|Oracle|Cisco|HPE|Dell|SAP|Salesforce|HashiCorp|Docker|Kubernetes|Rancher|SUSE|Canonical|Ubuntu)\b/gi) ?? [])
  const uniqueCompetitors = new Set(competitorMentions.map(c => c.toLowerCase())).size
  const signalCount = Math.max(competitorBullets, uniqueCompetitors)
  checks.push({
    name: 'competitive-signals',
    passed: signalCount >= 3,
    expected: '>= 3 competitive signals (bullets or competitor mentions)',
    actual: `${signalCount} signals (${competitorBullets} bullets, ${uniqueCompetitors} unique competitors)`,
    severity: 'required',
  })

  // 5. Company Overview — present, >= 200 chars
  const companyOverview = findSection(output, /company\s+(?:overview|profile|background|snapshot)/i)
  checks.push({
    name: 'company-overview',
    passed: companyOverview.length >= 200,
    expected: 'Company overview section present with >= 200 chars',
    actual: companyOverview.length > 0 ? `${companyOverview.length} chars` : 'section not found',
    severity: 'required',
  })

  // 6. Revenue data — revenue or financial data present anywhere
  const hasRevenue = /\$[\d.,]+\s*(?:billion|million|B|M)\b/i.test(output)
    || /revenue\s*(?:of|:|\|)\s*\$?[\d.,]+/i.test(output)
    || /annual\s+revenue/i.test(output)
    || /fiscal\s+(?:year|20\d{2})/i.test(output)
  checks.push({
    name: 'revenue-data',
    passed: hasRevenue,
    expected: 'Revenue or financial data present in output',
    actual: hasRevenue ? 'financial data found' : 'no revenue/financial data found',
    severity: 'required',
  })

  // 7. Employee data — employee count or headcount mentioned
  const hasEmployees = /\b[\d,]+\s*(?:employees?|associates?|staff|headcount|workforce)\b/i.test(output)
    || /employee\s*(?:count|base|size)/i.test(output)
    || /headcount/i.test(output)
  checks.push({
    name: 'employee-data',
    passed: hasEmployees,
    expected: 'Employee count or headcount mentioned',
    actual: hasEmployees ? 'employee data found' : 'no employee data found',
    severity: 'required',
  })

  // 8. Risk Signals — risk section present
  const riskSection = findSection(output, /risk\s+(?:signals?|factors?|assessment|analysis|considerations)/i)
  checks.push({
    name: 'risk-signals',
    passed: riskSection.length > 0,
    expected: 'Risk signals section present',
    actual: riskSection.length > 0 ? `${riskSection.length} chars` : 'section not found',
    severity: 'required',
  })

  // 9. Regional Coverage — at least 2 geographic regions mentioned
  const regionPatterns = [
    /\b(?:North\s+America|US|United\s+States|Americas?)\b/i,
    /\b(?:Europe|EU|EMEA|UK|United\s+Kingdom)\b/i,
    /\b(?:Asia|APAC|Asia[\s-]Pacific|Japan|China|India)\b/i,
    /\b(?:Latin\s+America|LATAM|South\s+America|Brazil)\b/i,
    /\b(?:Middle\s+East|Africa|MEA)\b/i,
    /\b(?:global|worldwide|international)\b/i,
  ]
  const regionsFound = regionPatterns.filter(p => p.test(output)).length
  checks.push({
    name: 'regional-coverage',
    passed: regionsFound >= 2,
    expected: 'At least 2 geographic regions mentioned',
    actual: `${regionsFound} regions referenced`,
    severity: 'recommended',
  })

  // 10. Source Citations — at least 3 inline citations or sources
  const citationPatterns = [
    /\[source\]/gi,
    /\(source:?\s/gi,
    /\bhttps?:\/\/\S+/gi,
    /\[[\d]+\]/g,       // numbered references [1], [2]
    /according\s+to\b/gi,
    /\bcited\b/gi,
    /\breported\s+by\b/gi,
  ]
  let citationCount = 0
  for (const p of citationPatterns) {
    citationCount += (output.match(p) ?? []).length
  }
  checks.push({
    name: 'source-citations',
    passed: citationCount >= 3,
    expected: 'At least 3 inline citations or source references',
    actual: `${citationCount} citations found`,
    severity: 'recommended',
  })

  return buildScorecard(CONTENT_TYPE, PASS_THRESHOLD, checks)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findSection(content: string, headerPattern: RegExp): string {
  // Try ## header first, then ### header
  for (const prefix of ['##', '###', '#']) {
    const fullPattern = new RegExp(`^${prefix.replace(/#/g, '\\#')}\\s+.*${headerPattern.source}.*$`, 'im')
    const match = content.match(fullPattern)
    if (match) {
      const startIdx = match.index! + match[0].length
      // Find next header of same or higher level
      const level = prefix.length
      const nextPattern = new RegExp(`^#{1,${level}}\\s+`, 'm')
      const rest = content.slice(startIdx)
      const nextMatch = rest.match(nextPattern)
      const endIdx = nextMatch ? startIdx + nextMatch.index! : content.length
      return content.slice(startIdx, endIdx).trim()
    }
  }
  return ''
}

export const intelligenceValidator: QualityValidator = {
  contentType: CONTENT_TYPE,
  passThreshold: PASS_THRESHOLD,
  validate,
}
