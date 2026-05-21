/**
 * Signal Template Engine — GitHub Issue #326
 *
 * Deterministic markdown template builder for customer signals.
 * Routes signals from the Feature Module Registry into structured markdown sections
 * that all 4 consumers (playbook, brief, campaign, meeting-prep) can reuse.
 *
 * NO GEMINI CALLS. Pure deterministic output.
 * Signals arrive already scored from the registry — this module only formats.
 */

import type { Signal } from '../feature-module-registry.ts'
import type { AccountTeamMember } from '../types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TemplateOptions {
  /** Consumer context determines which sections to include */
  format: 'playbook' | 'brief' | 'campaign' | 'meeting-prep'
  /** Filter signals to these products only (undefined = show all) */
  productFilter?: string[]
  /** Max signals in narrativeContext for Gemini prompts (default: 20) */
  maxNarrative?: number
  /** Legacy intelligence.company text passthrough for backward compatibility */
  intelligenceContext?: string
}

export interface TemplateResult {
  /** Deterministic markdown sections built from signal data (no Gemini) */
  deterministic: string
  /** Top N signals formatted for Gemini narrative prompts */
  narrativeContext: string
  /** Individual section outputs (null = no matching signals) */
  sections: {
    productAlignment: string | null
    cloudMarketplace: string | null
    renewals: string | null
    cases: string | null
    techStack: string | null
    keyRelationships: string | null
  }
}

// ── Signal Routing Helpers ──────────────────────────────────────────────────

/**
 * Route a signal to its primary category based on metadata keys FIRST,
 * then fall back to source name for legacy signals.
 *
 * Routing priority (most specific first):
 * 1. Cloud: hasCloudSpend OR provider metadata
 * 2. Case: severity OR caseNumber metadata
 * 3. Renewal: renewal flag OR (stage AND closeDate) metadata
 * 4. Tech: infrastructure metadata OR (confidence AND context with eval/migration keywords)
 * 5. Product: redHatProducts OR product metadata (fallback for subscription-like signals)
 */
function routeSignal(signal: Signal): 'product' | 'cloud' | 'renewal' | 'case' | 'tech' | 'other' {
  const m = signal.metadata ?? {}

  // Metadata-driven routing (most specific first)
  if (m.hasCloudSpend || m.provider) return 'cloud'
  if (m.severity !== undefined || m.caseNumber) return 'case'
  if (m.renewal || (m.stage && m.closeDate)) return 'renewal'

  // Tech stack: infrastructure metadata OR context with evaluation/migration keywords
  if (m.infrastructure) return 'tech'
  const context = String(m.context ?? '').toLowerCase()
  if (m.confidence && (context.includes('evaluat') || context.includes('migrat') || context.includes('migrating_from'))) {
    return 'tech'
  }

  // Product: subscription/ccsp/product metadata (default for RH product signals)
  if (m.redHatProducts || m.product) return 'product'

  // Fallback to source name for legacy signals
  if (signal.source === 'cloud-marketplace') return 'cloud'
  if (signal.source === 'cases') return 'case'
  if (signal.source === 'pipeline' && signal.type === 'subscription') return 'renewal'
  if (signal.source === 'tech-stack') return 'tech'
  if (signal.source === 'subscriptions' || signal.source === 'ccsp') return 'product'

  return 'other'
}

/**
 * Filter signals by product if productFilter is set.
 */
function filterByProduct(signals: Signal[], productFilter?: string[]): Signal[] {
  if (!productFilter || productFilter.length === 0) return signals

  return signals.filter(s => {
    const m = s.metadata ?? {}
    const products = m.redHatProducts ?? (m.product ? [m.product] : [])
    if (!Array.isArray(products)) return false
    return products.some(p => productFilter.includes(String(p).toLowerCase()))
  })
}

// ── Template Functions ──────────────────────────────────────────────────────

/**
 * Product Alignment section: subscription/ccsp/tech-stack signals showing
 * what Red Hat products the customer uses or is evaluating.
 *
 * Renders: Product name, confidence, use case context
 */
export function templateProductAlignment(signals: Signal[]): string | null {
  const productSignals = signals.filter(s => routeSignal(s) === 'product')
  if (productSignals.length === 0) return null

  const rows: string[] = []
  rows.push('| Product | Confidence | Use Case Context |')
  rows.push('|---------|------------|------------------|')

  for (const s of productSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const products = m.redHatProducts
    const firstProduct = Array.isArray(products) && products.length > 0 ? products[0] : null
    const product = String(m.product ?? firstProduct ?? 'Unknown')
    const confidence = String(m.confidence ?? '').toUpperCase() || 'MEDIUM'
    const context = String(m.context ?? s.detail.slice(0, 60)) || s.headline.slice(0, 60)
    rows.push(`| ${product} | ${confidence} | ${context} |`)
  }

  return rows.join('\n')
}

/**
 * Cloud Marketplace section: signals with hasCloudSpend/provider metadata,
 * showing cloud platform spend and offerings.
 *
 * Renders: Provider, ACV, Programs, Offerings
 */
export function templateCloudMarketplace(signals: Signal[]): string | null {
  const cloudSignals = signals.filter(s => routeSignal(s) === 'cloud')
  if (cloudSignals.length === 0) return null

  const rows: string[] = []
  rows.push('| Provider | ACV | Programs | Offerings |')
  rows.push('|----------|-----|----------|-----------|')

  for (const s of cloudSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const provider = String(m.provider ?? 'Unknown')
    const acv = m.acvPlus ? `$${Math.round(Number(m.acvPlus)).toLocaleString()}` : 'N/A'
    const programs = Array.isArray(m.programs) ? m.programs.join(', ') : 'N/A'
    const offerings = Array.isArray(m.productOfferingGroup)
      ? m.productOfferingGroup.join(', ')
      : String(m.productOfferingGroup ?? 'N/A')
    rows.push(`| ${provider} | ${acv} | ${programs} | ${offerings.slice(0, 40)} |`)
  }

  return rows.join('\n')
}

/**
 * Renewals section: pipeline signals with renewal metadata, sorted by closeDate.
 *
 * Renders: Product, Amount, Close Date, Stage
 */
export function templateRenewals(signals: Signal[]): string | null {
  const renewalSignals = signals.filter(s => routeSignal(s) === 'renewal')
  if (renewalSignals.length === 0) return null

  // Sort by closeDate ascending (soonest first)
  const sorted = renewalSignals.slice().sort((a, b) => {
    const dateA = a.metadata?.closeDate ? new Date(String(a.metadata.closeDate)).getTime() : Infinity
    const dateB = b.metadata?.closeDate ? new Date(String(b.metadata.closeDate)).getTime() : Infinity
    return dateA - dateB
  })

  const rows: string[] = []
  rows.push('| Product | Amount | Close Date | Stage |')
  rows.push('|---------|--------|------------|-------|')

  for (const s of sorted.slice(0, 8)) {
    const m = s.metadata ?? {}
    const product = String(m.product ?? s.headline.slice(0, 30))
    const amount = m.amount ? `$${Math.round(Number(m.amount)).toLocaleString()}` : 'N/A'
    const closeDate = m.closeDate ? new Date(String(m.closeDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'
    const stage = String(m.stage ?? 'Unknown')
    rows.push(`| ${product} | ${amount} | ${closeDate} | ${stage} |`)
  }

  return rows.join('\n')
}

/**
 * Cases section: signals with severity/caseNumber, sorted by severity (1 = highest).
 *
 * Renders: Case Number, Severity, Product, Age (days)
 */
export function templateCases(signals: Signal[]): string | null {
  const caseSignals = signals.filter(s => routeSignal(s) === 'case')
  if (caseSignals.length === 0) return null

  // Sort by severity ascending (1 = critical, higher = less severe)
  const sorted = caseSignals.slice().sort((a, b) => {
    const sevA = Number(a.metadata?.severity ?? 999)
    const sevB = Number(b.metadata?.severity ?? 999)
    return sevA - sevB
  })

  const rows: string[] = []
  rows.push('| Case Number | Severity | Product | Age |')
  rows.push('|-------------|----------|---------|-----|')

  for (const s of sorted.slice(0, 8)) {
    const m = s.metadata ?? {}
    const caseNumber = String(m.caseNumber ?? 'Unknown')
    const severity = String(m.severity ?? '?')
    const product = String(m.product ?? s.headline.slice(0, 30))

    // Calculate age from timestamp
    const age = s.timestamp
      ? Math.floor((Date.now() - new Date(s.timestamp).getTime()) / (1000 * 60 * 60 * 24))
      : 0
    const ageStr = age > 0 ? `${age}d` : 'New'

    rows.push(`| ${caseNumber} | Sev ${severity} | ${product} | ${ageStr} |`)
  }

  return rows.join('\n')
}

/**
 * Tech Stack section: signals with confidence metadata showing technology
 * evaluation/migration context.
 *
 * Renders: Technology, Red Hat Positioning, Confidence
 */
export function templateTechStack(signals: Signal[]): string | null {
  const techSignals = signals.filter(s => routeSignal(s) === 'tech')
  if (techSignals.length === 0) return null

  const rows: string[] = []
  rows.push('| Technology | Red Hat Positioning | Confidence |')
  rows.push('|------------|---------------------|------------|')

  for (const s of techSignals.slice(0, 8)) {
    const m = s.metadata ?? {}
    const tech = s.headline.slice(0, 40)
    const positioning = String(m.context ?? s.detail.slice(0, 60))
    const confidence = String(m.confidence ?? '').toUpperCase() || 'MEDIUM'
    rows.push(`| ${tech} | ${positioning} | ${confidence} |`)
  }

  return rows.join('\n')
}

/**
 * Key Relationships section: account team table.
 * Not signal-derived — takes AccountTeamMember array from getAccountTeam().
 *
 * Renders: Name, Role, Focus Area
 */
export function templateKeyRelationships(team?: AccountTeamMember[]): string | null {
  if (!team || team.length === 0) return null

  const roleLabels: Record<string, string> = {
    ae: 'Account Executive',
    asa: 'Solution Architect',
    ssp: 'Sales Specialist',
    ssa: 'Specialist SA',
    manager: 'Manager',
  }

  const focusAreas: Record<string, string> = {
    ae: 'Primary relationship, commercial',
    asa: 'Technical strategy, architecture',
    ssp: 'Product specialization, sales',
    ssa: 'Technical deep-dive, specialization',
    manager: 'Account oversight',
  }

  const rows: string[] = []
  rows.push('| Name | Role | Focus Area |')
  rows.push('|------|------|------------|')

  for (const member of team) {
    const roleLabel = roleLabels[member.role] ?? member.title
    const focusArea = focusAreas[member.role] ?? 'Account support'
    rows.push(`| ${member.name} | ${roleLabel} | ${focusArea} |`)
  }

  return rows.length > 2 ? rows.join('\n') : null
}

/**
 * Orchestrator: Assemble all sections into a complete template result.
 *
 * @param signals - Scored signals from the registry
 * @param team - Account team members array from getAccountTeam() (optional)
 * @param options - Format and filtering options
 */
export function templateAll(
  signals: Signal[],
  team?: AccountTeamMember[],
  options: TemplateOptions = { format: 'playbook' }
): TemplateResult {
  // Apply product filter if specified
  const filteredSignals = filterByProduct(signals, options.productFilter)

  // Build individual sections
  const productAlignment = templateProductAlignment(filteredSignals)
  const cloudMarketplace = templateCloudMarketplace(filteredSignals)
  const renewals = templateRenewals(filteredSignals)
  const cases = templateCases(filteredSignals)
  const techStack = templateTechStack(filteredSignals)
  const keyRelationships = templateKeyRelationships(team)

  // Assemble deterministic markdown output
  const sections: string[] = []

  if (productAlignment) sections.push(`## Product Alignment\n\n${productAlignment}`)
  if (cloudMarketplace) sections.push(`## Cloud Marketplace\n\n${cloudMarketplace}`)
  if (renewals) sections.push(`## Renewals & Pipeline\n\n${renewals}`)
  if (cases) sections.push(`## Support Cases\n\n${cases}`)
  if (techStack) sections.push(`## Technology Stack\n\n${techStack}`)
  if (keyRelationships) sections.push(`## Key Relationships\n\n${keyRelationships}`)

  const deterministic = sections.join('\n\n')

  // Build narrative context for Gemini (top N signals, format varies by consumer)
  const maxNarrative = options.maxNarrative ?? 20
  const topSignals = filteredSignals
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxNarrative)

  let narrativeContext = ''

  if (options.format === 'playbook') {
    // Playbook format: [source] headline: detail
    narrativeContext = topSignals
      .map(s => `[${s.source}] ${s.headline}: ${s.detail}`)
      .join('\n')
  } else if (options.format === 'brief') {
    // Brief format: [type] headline — detail (150 chars) (url)
    narrativeContext = topSignals
      .map(s => `[${s.type}] ${s.headline} — ${s.detail.slice(0, 150)}${s.url ? ` (${s.url})` : ''}`)
      .join('\n')
  } else if (options.format === 'campaign') {
    // Campaign format: [type] headline — detail (200 chars)
    narrativeContext = topSignals
      .map(s => `[${s.type}] ${s.headline}${s.detail ? ' — ' + s.detail.substring(0, 200) : ''}`)
      .join('\n')
  } else {
    // meeting-prep format: same as playbook
    narrativeContext = topSignals
      .map(s => `[${s.source}] ${s.headline}: ${s.detail}`)
      .join('\n')
  }

  // Legacy intelligence context passthrough (campaigns only)
  if (options.intelligenceContext && options.format === 'campaign') {
    narrativeContext = `${narrativeContext}\n\nCompany Intelligence:\n${options.intelligenceContext}`
  }

  return {
    deterministic,
    narrativeContext,
    sections: {
      productAlignment,
      cloudMarketplace,
      renewals,
      cases,
      techStack,
      keyRelationships,
    },
  }
}
