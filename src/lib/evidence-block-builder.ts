/**
 * src/lib/evidence-block-builder.ts
 * Pure function module: builds structured evidence blocks from scored tactics + signals (#643)
 *
 * Replaces formatScoredTacticsForPrompt() with richer, structured evidence
 * that includes levers (incentives, POC kits, partner resources) and team context.
 *
 * Dependencies:
 *   - tactic-scorer.ts — ScoredTactic, EvidenceItem types
 *   - feature-module-registry.ts — Signal type
 *   - types.ts — AccountTeamMember type
 */

import type { ScoredTactic, EvidenceItem as TacticEvidenceItem } from './tactic-scorer.ts'
import type { Signal } from '../feature-module-registry.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  /** Specific data point: "47 RHEL 7 subscriptions, EOS 2027-06-30" */
  fact: string
  /** Signal source: "subscriptions", "cases", "ccsp" */
  source: string
  /** Recency label: "current", "2d ago", "30d+ ago" */
  recency: string
}

export interface Lever {
  /** Human-readable name: "AWS migration credit 25%" */
  name: string
  /** Description of the lever */
  description: string
  /** Clickable source link */
  url: string
  /** Expiry date if applicable */
  validThrough?: string
  /** Origin module: "cloud-marketplace", "ecosystem-catalog", "partner-catalog" */
  source: string
}

export interface EvidenceBlock {
  /** Play/tactic name */
  playName: string
  /** Composite score from tactic scorer (0-1) */
  compositeScore: number
  /** Specific evidence trail from signals and graph */
  evidenceTrail: EvidenceItem[]
  /** Available incentives, POC kits, partner resources with URLs */
  availableLevers: Lever[]
  /** Named SSP/specialist from account team */
  teamContext: string
  /** Specific thing to request in the meeting */
  proposedAsk: string
}

export interface BuildEvidenceBlocksOptions {
  /** Maximum number of evidence blocks to return (default: 3) */
  maxBlocks?: number
}

// ── Product keyword mapping ─────────────────────────────────────────────────

/** Maps tactic/TDP domain keywords to product terms for signal matching */
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  'rhel': ['rhel', 'enterprise linux', 'red hat enterprise linux'],
  'openshift': ['openshift', 'container platform', 'kubernetes', 'cloud native'],
  'ansible': ['ansible', 'automation', 'it automation'],
  'satellite': ['satellite', 'smart management'],
  'cloud': ['cloud', 'marketplace', 'aws', 'azure', 'google cloud', 'gcp', 'oci'],
  'security': ['security', 'compliance', 'acs', 'advanced cluster security', 'crowdstrike', 'falcon'],
  'storage': ['storage', 'ceph', 'odf', 'data foundation'],
  'virtualization': ['virtualization', 'virt', 'hypervisor', 'migration'],
  'ai': ['ai', 'machine learning', 'ml', 'inference', 'openshift ai'],
  'app platform': ['application platform', 'middleware', 'jboss', 'quarkus', 'runtimes'],
}

/** Maps product keywords to SSP/specialist role matchers */
const PRODUCT_TO_ROLE_KEYWORDS: Record<string, string[]> = {
  'rhel': ['rhel'],
  'openshift': ['openshift'],
  'ansible': ['ansible'],
  'cloud': ['cloud'],
  'ai': ['ai'],
  'app platform': ['app platform', 'application platform', 'middleware'],
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build structured evidence blocks from scored tactics, signals, and team data.
 *
 * Takes the top N scored tactics and for each:
 * 1. Assembles evidence from the tactic's own evidence trail
 * 2. Finds matching levers from cloud-marketplace, ecosystem-catalog, partner-catalog signals
 * 3. Names the relevant SSP/specialist from account team
 * 4. Generates a proposed ask based on tactic type and evidence strength
 */
export function buildEvidenceBlocks(
  scoredTactics: ScoredTactic[],
  signals: Signal[],
  team: AccountTeamMember[],
  options?: BuildEvidenceBlocksOptions,
): EvidenceBlock[] {
  if (scoredTactics.length === 0) return []

  const maxBlocks = options?.maxBlocks ?? 3
  const topTactics = scoredTactics
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, maxBlocks)

  return topTactics.map(tactic => buildSingleBlock(tactic, signals, team))
}

// ── Internal helpers ────────────────────────────────────────────────────────

function buildSingleBlock(
  tactic: ScoredTactic,
  signals: Signal[],
  team: AccountTeamMember[],
): EvidenceBlock {
  const domainKeys = detectDomainKeys(tactic)
  const evidenceTrail = buildEvidenceTrail(tactic)
  const availableLevers = extractLevers(signals, domainKeys)
  const teamContext = findRelevantTeamMember(team, domainKeys)
  const proposedAsk = generateProposedAsk(tactic, evidenceTrail, availableLevers)

  return {
    playName: tactic.name,
    compositeScore: tactic.compositeScore,
    evidenceTrail,
    availableLevers,
    teamContext,
    proposedAsk,
  }
}

/**
 * Detect which domain keywords apply to this tactic based on its name and parentTdp.
 */
function detectDomainKeys(tactic: ScoredTactic): string[] {
  const searchText = `${tactic.name} ${tactic.parentTdp}`.toLowerCase()
  const matched: string[] = []

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    if (keywords.some(kw => searchText.includes(kw))) {
      matched.push(domain)
    }
  }

  // Always include 'cloud' for marketplace signals — they're always relevant
  if (matched.length === 0) matched.push('cloud')

  return matched
}

/**
 * Convert tactic evidence items to the EvidenceBlock format.
 */
function buildEvidenceTrail(tactic: ScoredTactic): EvidenceItem[] {
  return tactic.evidenceTrail
    .filter(e => e.weight > 0)
    .map(e => ({
      fact: e.fact,
      source: e.module,
      recency: e.recency,
    }))
}

/**
 * Extract levers (incentives, POC kits, partner resources) from signals
 * that match the tactic's domain.
 */
function extractLevers(signals: Signal[], domainKeys: string[]): Lever[] {
  const levers: Lever[] = []

  for (const signal of signals) {
    if (signal.source === 'cloud-marketplace') {
      levers.push(...extractCloudMarketplaceLevers(signal, domainKeys))
    } else if (signal.source === 'ecosystem-catalog') {
      levers.push(...extractEcosystemLevers(signal, domainKeys))
    } else if (signal.source === 'partner-catalog') {
      levers.push(...extractPartnerLevers(signal, domainKeys))
    }
  }

  return levers
}

function extractCloudMarketplaceLevers(signal: Signal, _domainKeys: string[]): Lever[] {
  const levers: Lever[] = []
  const meta = signal.metadata ?? {}

  // Extract incentives
  const incentives = (meta.incentives as any[]) ?? []
  for (const inc of incentives) {
    if (inc.url) {
      levers.push({
        name: inc.name,
        description: inc.description ?? inc.value ?? '',
        url: inc.url,
        validThrough: inc.validThrough,
        source: 'cloud-marketplace',
      })
    }
  }

  // Extract programs with URLs
  const programs = (meta.programs as any[]) ?? []
  for (const prog of programs) {
    if (prog.url) {
      levers.push({
        name: prog.name,
        description: prog.description ?? '',
        url: prog.url,
        validThrough: prog.validThrough,
        source: 'cloud-marketplace',
      })
    }
  }

  return levers
}

function extractEcosystemLevers(signal: Signal, _domainKeys: string[]): Lever[] {
  const levers: Lever[] = []
  const meta = signal.metadata ?? {}

  // The signal URL is the catalog link — use it as a lever
  if (signal.url) {
    levers.push({
      name: `${meta.solutionName ?? 'Solution'} — ${meta.partnerName ?? 'Partner'}`,
      description: signal.headline,
      url: signal.url,
      source: 'ecosystem-catalog',
    })
  }

  // Parse resource URLs from the detail text
  const resourceUrlPattern = /\[([^\]]+)\]\(([^)]+)\)\s*\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = resourceUrlPattern.exec(signal.detail)) !== null) {
    levers.push({
      name: match[1],
      description: `${match[3]} resource`,
      url: match[2],
      source: 'ecosystem-catalog',
    })
  }

  return levers
}

function extractPartnerLevers(signal: Signal, _domainKeys: string[]): Lever[] {
  const levers: Lever[] = []
  const meta = signal.metadata ?? {}

  const catalogUrl = (meta.catalogUrl as string) ?? signal.url
  if (catalogUrl) {
    levers.push({
      name: `${meta.partnerName ?? 'Partner'} — Certified Partner`,
      description: `Specializations: ${((meta.specializations as string[]) ?? []).join(', ')}`,
      url: catalogUrl,
      source: 'partner-catalog',
    })
  }

  return levers
}

/**
 * Find the most relevant SSP/specialist from the account team for this tactic's domain.
 * Falls back to the AE or ASA if no specialist matches.
 */
function findRelevantTeamMember(team: AccountTeamMember[], domainKeys: string[]): string {
  // Look for SSP/SSA matching the tactic's product domain
  for (const member of team) {
    if (member.role !== 'ssp' && member.role !== 'ssa') continue
    const titleLower = member.title.toLowerCase()

    for (const domain of domainKeys) {
      const roleKeywords = PRODUCT_TO_ROLE_KEYWORDS[domain] ?? [domain]
      if (roleKeywords.some(kw => titleLower.includes(kw))) {
        return `${member.name} (${member.title})`
      }
    }
  }

  // Fallback: ASA, then AE
  const asa = team.find(m => m.role === 'asa')
  if (asa) return `${asa.name} (${asa.title})`

  const ae = team.find(m => m.role === 'ae')
  if (ae) return `${ae.name} (${ae.title})`

  return 'Account Team'
}

/**
 * Extract a key data point from evidence for injection into proposed asks (#653).
 * Looks for subscription counts, dates, case numbers, dollar amounts — concrete facts.
 * Exported for testing.
 */
export function extractKeyDataPoint(evidence: EvidenceItem[]): string {
  for (const e of evidence) {
    // Subscription counts: "47 RHEL 7 subscriptions"
    const subMatch = e.fact.match(/(\d+)\s+\w[\w\s]*subscriptions?/i)
    if (subMatch) return subMatch[0]
    // Dates with context: "EOS 2027-06-30", "renewal 2026-12-01", "expiring 2027-01-15"
    const dateMatch = e.fact.match(/\b(EOS|EOL|expir\w*|renew\w*|closing)\s+(\d{4}-\d{2}-\d{2})/i)
    if (dateMatch) return `${dateMatch[1]} ${dateMatch[2]}`
    // Case numbers: "case #12345678" or "Case 12345678"
    const caseMatch = e.fact.match(/case\s*#?(\d{6,})/i)
    if (caseMatch) return `case #${caseMatch[1]}`
    // Dollar amounts: "$1,234,567" or "$50K"
    const dollarMatch = e.fact.match(/\$[\d,]+[KMB]?/i)
    if (dollarMatch) return dollarMatch[0]
  }
  // Fallback: first 60 chars of first evidence fact
  return evidence[0]?.fact?.slice(0, 60) || ''
}

/**
 * Generate a proposed ask based on the tactic type and evidence strength.
 * #653: Injects specific data points from evidence trail into ask text.
 */
function generateProposedAsk(
  tactic: ScoredTactic,
  evidence: EvidenceItem[],
  levers: Lever[],
): string {
  const name = tactic.name.toLowerCase()
  const keyDataPoint = extractKeyDataPoint(evidence)

  // Check for migration-related evidence
  const hasMigrationEvidence = evidence.some(e =>
    e.fact.toLowerCase().includes('eos') ||
    e.fact.toLowerCase().includes('migration') ||
    e.fact.toLowerCase().includes('end of')
  )

  // Check for case/support evidence
  const hasCaseEvidence = evidence.some(e => e.source === 'cases')

  // Check for renewal evidence
  const hasRenewalEvidence = evidence.some(e =>
    e.fact.toLowerCase().includes('renewal') ||
    e.fact.toLowerCase().includes('expir')
  )

  // Check for available incentives
  const hasIncentives = levers.some(l => l.source === 'cloud-marketplace')

  if (hasMigrationEvidence) {
    const detail = keyDataPoint ? `for ${keyDataPoint}` : 'with the customer\'s infrastructure team'
    return `Request migration planning ${detail}. ${hasIncentives ? 'Highlight available migration credits.' : ''}`.trim()
  }

  if (hasCaseEvidence && hasRenewalEvidence) {
    const caseDetail = evidence.find(e => e.source === 'cases')
    const casePoint = caseDetail ? extractKeyDataPoint([caseDetail]) : ''
    const renewalDetail = evidence.find(e => e.fact.toLowerCase().includes('renewal') || e.fact.toLowerCase().includes('expir'))
    const renewalPoint = renewalDetail ? extractKeyDataPoint([renewalDetail]) : ''
    return `Connect resolution of ${casePoint || 'open cases'} to ${renewalPoint || 'renewal timeline'}. Propose an upgrade path that addresses current issues.`
  }

  if (hasRenewalEvidence) {
    return `Align product roadmap discussion with upcoming renewal${keyDataPoint ? ` (${keyDataPoint})` : ''}. Position expansion value for renewal negotiation.`
  }

  if (hasCaseEvidence) {
    return `Address ${keyDataPoint || 'open cases'} as entry point. Propose architecture review to prevent recurrence.`
  }

  if (hasIncentives) {
    return `Present marketplace incentives and propose a POC leveraging available credits.`
  }

  // Default: specific to tactic + first evidence fact
  if (keyDataPoint) {
    return `Schedule deep-dive on ${tactic.name} — ${keyDataPoint}.`
  }
  return `Schedule deep-dive session on ${tactic.name} with the customer's technical leadership.`
}
