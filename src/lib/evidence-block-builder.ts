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
import { getAllSlugs, getAliases } from './product-vocabulary.ts'

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

// ── Product keyword mapping (derived from product-vocabulary.ts) ────────────

/** Domain-only keywords not covered by product vocabulary */
const DOMAIN_ONLY_KEYWORDS: Record<string, string[]> = {
  'cloud': ['cloud', 'marketplace', 'aws', 'azure', 'google cloud', 'gcp', 'oci'],
  'security': ['security', 'compliance', 'acs', 'advanced cluster security', 'crowdstrike', 'falcon'],
  'storage': ['storage', 'ceph', 'odf', 'data foundation'],
  'virtualization': ['virtualization', 'virt', 'hypervisor', 'migration'],
  'app platform': ['application platform', 'middleware', 'jboss', 'quarkus', 'runtimes'],
}

/**
 * Build domain keywords map: product vocabulary aliases + domain-specific static entries.
 * Product entries keyed by slug with lowercase aliases for matching.
 */
function getDomainKeywords(): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const slug of getAllSlugs()) {
    map[slug] = getAliases(slug).map(a => a.toLowerCase())
  }
  // Merge domain-only keywords (not in vocabulary)
  for (const [domain, keywords] of Object.entries(DOMAIN_ONLY_KEYWORDS)) {
    if (!map[domain]) {
      map[domain] = keywords
    }
  }
  return map
}

/** Domain-only role keywords not covered by product vocabulary */
const DOMAIN_ONLY_ROLE_KEYWORDS: Record<string, string[]> = {
  'cloud': ['cloud'],
  'app platform': ['app platform', 'application platform', 'middleware'],
}

/**
 * Build product-to-role keyword map from vocabulary + domain-specific entries.
 * Each product slug maps to keywords used to match SSP/specialist titles.
 */
function getProductToRoleKeywords(): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const slug of getAllSlugs()) {
    // Use the slug itself as the primary role keyword
    map[slug] = [slug, ...getAliases(slug).map(a => a.toLowerCase()).filter(a => a.length > 2)]
  }
  // Merge domain-only role keywords
  for (const [domain, keywords] of Object.entries(DOMAIN_ONLY_ROLE_KEYWORDS)) {
    if (!map[domain]) {
      map[domain] = keywords
    }
  }
  return map
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
  const domainKeywords = getDomainKeywords()

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
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
  const productToRoleKeywords = getProductToRoleKeywords()
  for (const member of team) {
    if (member.role !== 'ssp' && member.role !== 'ssa') continue
    const titleLower = member.title.toLowerCase()

    for (const domain of domainKeys) {
      const roleKeywords = productToRoleKeywords[domain] ?? [domain]
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
 * Structured data point extracted from evidence (#658).
 * Primary is highest-priority match; secondary provides compound context.
 */
export interface DataPoint {
  primary: string
  secondary?: string
}

/**
 * Extract key data points from evidence for injection into proposed asks (#653, #658).
 * Scans ALL evidence items and collects matches by type.
 * Priority order: EOS/expiry dates > dollar amounts > case numbers > subscription counts.
 * Returns primary + optional secondary data point for compound asks.
 * Exported for testing.
 */
export function extractKeyDataPoint(evidence: EvidenceItem[]): DataPoint {
  const dates: string[] = []
  const dollars: string[] = []
  const cases: string[] = []
  const subs: string[] = []

  for (const e of evidence) {
    const dateMatch = e.fact.match(/\b(EOS|EOL|expir\w*|renew\w*|closing)\s+(\d{4}-\d{2}-\d{2})/i)
    if (dateMatch) dates.push(`${dateMatch[1]} ${dateMatch[2]}`)
    const dollarMatch = e.fact.match(/\$[\d,]+[KMB]?/i)
    if (dollarMatch) dollars.push(dollarMatch[0])
    const caseMatch = e.fact.match(/case\s*#?(\d{6,})/i)
    if (caseMatch) cases.push(`case #${caseMatch[1]}`)
    const subMatch = e.fact.match(/(\d+)\s+\w[\w\s]*subscriptions?/i)
    if (subMatch) subs.push(subMatch[0])
  }

  // Priority order: dates > dollars > cases > subs
  const all = [...dates, ...dollars, ...cases, ...subs]
  if (all.length === 0) return { primary: evidence[0]?.fact?.slice(0, 60) || '' }

  return {
    primary: all[0],
    secondary: all.length > 1 ? all[1] : undefined,
  }
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
  const dataPoint = extractKeyDataPoint(evidence)
  const keyDataPoint = dataPoint.primary

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
    const detail = keyDataPoint
      ? `for ${keyDataPoint}${dataPoint.secondary ? ` (${dataPoint.secondary})` : ''}`
      : 'with the customer\'s infrastructure team'
    return `Request migration planning ${detail}. ${hasIncentives ? 'Highlight available migration credits.' : ''}`.trim()
  }

  if (hasCaseEvidence && hasRenewalEvidence) {
    const caseDetail = evidence.find(e => e.source === 'cases')
    const casePoint = caseDetail ? extractKeyDataPoint([caseDetail]).primary : ''
    const renewalDetail = evidence.find(e => e.fact.toLowerCase().includes('renewal') || e.fact.toLowerCase().includes('expir'))
    const renewalPoint = renewalDetail ? extractKeyDataPoint([renewalDetail]).primary : ''
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
