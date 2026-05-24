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
import { getTacticsByTdp, getTdpDescription, getSalesPlayByName } from './saleshub-knowledge-loader.ts'
import { isValidCustomerWin, isValidAsset, isValidMetric } from './saleshub-filters.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SolutionPlaySnapshot {
  tdp: string
  playName: string
  triggerTechnologies: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  talkTrack?: string
  customerWins?: string[]
  linkedAssets?: Array<{ name: string; url: string }>
  matchReasoning?: string
  customerLens?: { pain: string[]; outcomes: string[]; impact: string[] }
  realWorldExamples?: Array<{ customer: string; outcome: string }>
  extractedMetrics?: Array<{ value: string; context: string }>
}

export interface TemplateOptions {
  /** Consumer context determines which sections to include */
  format: 'playbook' | 'brief' | 'campaign' | 'meeting-prep'
  /** Filter signals to these products only (undefined = show all) */
  productFilter?: string[]
  /** Max signals in narrativeContext for Gemini prompts (default: 20) */
  maxNarrative?: number
  /** Legacy intelligence.company text passthrough for backward compatibility */
  intelligenceContext?: string
  /** Customer slug — when provided, populates structured.solutionPlays */
  customerSlug?: string
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
    salesAlignment: string | null
    strategicOpportunities: string | null
    saleshubContext: string | null
  }
  /** Structured data for rich consumers (React components, HTML renderers) */
  structured: {
    solutionPlays: SolutionPlaySnapshot[]
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
  // #375: Also route signals with productTags (rh-rss) or productSlug (value-maps)
  if (m.redHatProducts || m.product || (Array.isArray(m.productTags) && m.productTags.length > 0) || m.productSlug) return 'product'

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
    // #375/#379: Also read productTags (rh-rss) and productSlug (value-maps)
    const firstTag = Array.isArray(m.productTags) && m.productTags.length > 0 ? m.productTags[0] : null
    const product = String(m.product ?? firstProduct ?? m.productSlug ?? firstTag ?? 'Unknown')
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
 * Strategic Opportunities section (ADR-030): solution plays triggered by
 * detected technologies. Routes signals where metadata.solutionPlayId is present.
 *
 * Renders: Play name, trigger technologies, products, business value
 */
export function templateStrategicOpportunities(signals: Signal[]): string | null {
  const stratSignals = signals.filter(s => s.metadata?.solutionPlayId)
  if (stratSignals.length === 0) return null

  // Dedupe by solutionPlayId — a play may match multiple technologies
  const seenPlays = new Set<string>()
  const uniqueSignals: Signal[] = []
  for (const s of stratSignals) {
    const playId = String(s.metadata!.solutionPlayId)
    if (!seenPlays.has(playId)) {
      seenPlays.add(playId)
      uniqueSignals.push(s)
    }
  }

  const parts: string[] = []

  // Solution Plays sub-section
  const playRows: string[] = []
  playRows.push('### Solution Plays')
  playRows.push('| TDP | Play | Trigger Technologies | Products | Business Value |')
  playRows.push('|-----|------|---------------------|----------|----------------|')

  for (const s of uniqueSignals.slice(0, 6)) {
    const m = s.metadata ?? {}
    const tdp = String(m.solutionTdp ?? '')
    const playName = String(m.solutionPlayName ?? 'Unknown')
    const techs = s.headline.replace(/ \(.*\)$/, '')
    const products = Array.isArray(m.redHatProducts) ? m.redHatProducts.join(', ') : ''
    // Prefer SalesHub talk track over generic valueProps
    const businessValue = m.talkTrack
      ? String(m.talkTrack).slice(0, 120)
      : (Array.isArray(m.valueProps) ? m.valueProps[0]?.slice(0, 80) ?? '' : '')
    playRows.push(`| ${tdp} | ${playName} | ${techs} | ${products} | ${businessValue} |`)
  }
  parts.push(playRows.join('\n'))

  // Customer wins proof points (from any signal with customerWins)
  const allWins: string[] = []
  for (const s of uniqueSignals) {
    const wins = s.metadata?.customerWins
    if (Array.isArray(wins)) {
      for (const w of wins) {
        if (typeof w === 'string' && w.length > 5 && !allWins.includes(w)) allWins.push(w)
      }
    }
  }
  if (allWins.length > 0) {
    parts.push('### Customer Proof Points\n' + allWins.slice(0, 5).map(w => `- ${w}`).join('\n'))
  }

  // Linked assets (decks, resources)
  const allAssets: Array<{ name: string; url: string }> = []
  for (const s of uniqueSignals) {
    const assets = s.metadata?.linkedAssets
    if (Array.isArray(assets)) {
      for (const a of assets as Array<{ name: string; url: string }>) {
        if (a.url && !allAssets.some(x => x.name === a.name)) allAssets.push(a)
      }
    }
  }
  if (allAssets.length > 0) {
    parts.push('### Linked Assets\n' + allAssets.slice(0, 8).map(a => `- [${a.name}](${a.url})`).join('\n'))
  }

  // Marketplace Opportunities sub-section (from signals with privateOfferEligible or provider+acvPlus)
  const marketplaceSignals = signals.filter(s => {
    const m = s.metadata ?? {}
    return m.hasCloudSpend && m.acvPlus && Number(m.acvPlus) > 0
  })
  if (marketplaceSignals.length > 0) {
    const seen = new Set<string>()
    const mktRows: string[] = []
    mktRows.push('### Marketplace Opportunities')
    mktRows.push('| Provider | Spend | Programs | Private Offer |')
    mktRows.push('|----------|-------|----------|---------------|')
    for (const s of marketplaceSignals) {
      const m = s.metadata ?? {}
      const provider = String(m.provider ?? m.cloudPartner ?? '')
      if (!provider || seen.has(provider)) continue
      seen.add(provider)
      const spend = `$${Math.round(Number(m.acvPlus ?? 0)).toLocaleString()}`
      const programs = Array.isArray(m.eligiblePrograms) ? m.eligiblePrograms.join(', ') : 'N/A'
      const privateOffer = m.privateOfferEligible ? 'Eligible' : '—'
      mktRows.push(`| ${provider} | ${spend} | ${programs} | ${privateOffer} |`)
    }
    if (mktRows.length > 3) parts.push(mktRows.join('\n'))
  }

  // Version Correlations sub-section (from signals with type='version-correlation')
  const versionSignals = signals.filter(s => s.metadata?.amplified)
  if (versionSignals.length > 0) {
    const vcRows: string[] = []
    vcRows.push('### Urgent Correlations')
    vcRows.push('| Product | Cases | Lifecycle Event |')
    vcRows.push('|---------|-------|-----------------|')
    for (const s of versionSignals.slice(0, 4)) {
      const m = s.metadata ?? {}
      const product = String(m.product ?? 'Unknown')
      const cases = String(m.activeCases ?? s.headline.match(/(\d+) active/)?.[1] ?? '?')
      const lifecycle = String(m.lifecycleEvent ?? '—')
      vcRows.push(`| ${product} | ${cases} | ${lifecycle} |`)
    }
    parts.push(vcRows.join('\n'))
  }

  return parts.join('\n\n')
}

/**
 * Orchestrator: Assemble all sections into a complete template result.
 *
/**
 * Sales Alignment section — shows which Sales Plays and TDPs apply to
 * this customer based on detected technologies. Designed for management
 * visibility: clear mapping from customer signals → TDP → Sales Play.
 *
 * Appears near the top of every output so leadership can immediately
 * see which sales motions are in play.
 */
export function templateSalesAlignment(signals: Signal[]): string | null {
  // Collect plays, deduplicating by playId and merging trigger technologies
  const playMap = new Map<string, { playName: string; tdp: string; techs: Set<string>; confidence: string }>()

  for (const s of signals) {
    const playId = s.metadata?.solutionPlayId
    const playName = s.metadata?.solutionPlayName
    const tdp = s.metadata?.solutionTdp
    const confidence = s.metadata?.confidence
    if (!playId || !playName || !tdp) continue

    const key = String(playId)
    const existing = playMap.get(key)
    if (existing) {
      // Merge trigger technologies
      const techs = Array.isArray(s.metadata?.matchedTechnologies)
        ? (s.metadata!.matchedTechnologies as string[])
        : [s.headline.replace(/ \(.*\)$/, '')]
      for (const t of techs) existing.techs.add(t)
      // Upgrade confidence (keep highest)
      if (confidence === 'HIGH') existing.confidence = 'HIGH'
      else if (confidence === 'MEDIUM' && existing.confidence !== 'HIGH') existing.confidence = 'MEDIUM'
    } else {
      const techs = new Set(
        Array.isArray(s.metadata?.matchedTechnologies)
          ? (s.metadata!.matchedTechnologies as string[])
          : [s.headline.replace(/ \(.*\)$/, '')]
      )
      playMap.set(key, {
        playName: String(playName),
        tdp: String(tdp),
        techs,
        confidence: String(confidence ?? 'MEDIUM'),
      })
    }
  }

  if (playMap.size === 0) return null

  // Group by TDP
  const byTdp = new Map<string, Array<{ name: string; techs: string[]; confidence: string }>>()
  for (const [, play] of playMap) {
    const existing = byTdp.get(play.tdp) ?? []
    existing.push({ name: play.playName, techs: Array.from(play.techs), confidence: play.confidence })
    byTdp.set(play.tdp, existing)
  }

  // Map TDPs to their parent sales plays
  const tdpToPlays: Record<string, string[]> = {
    'AI Platform': ['The AI-Ready Enterprise', 'Build and Run Applications'],
    'App Platform': ['Build and Run Applications', 'Modernize Infrastructure'],
    'Automation': ['IT Operations Efficiency', 'Modernize Infrastructure', 'The AI-Ready Enterprise'],
    'Virtualization': ['Modernize Infrastructure', 'IT Operations Efficiency'],
    'Server/Cloud OS': ['Modernize Infrastructure'],
    'Container Mgmt': ['Build and Run Applications', 'Modernize Infrastructure'],
  }

  const allTdps = Array.from(byTdp.keys())
  const activeSalesPlays = new Set<string>()
  for (const tdp of allTdps) {
    for (const play of tdpToPlays[tdp] ?? []) activeSalesPlays.add(play)
  }

  const lines: string[] = []

  // Active Sales Plays roll-up
  if (activeSalesPlays.size > 0) {
    lines.push(`Sales Plays: ${Array.from(activeSalesPlays).join(', ')}`)
  }

  // TDP → Play → Technologies
  for (const [tdp, plays] of byTdp) {
    lines.push(`TDP: ${tdp}`)
    for (const play of plays) {
      const rawConf = play.confidence
      const confBadge = (rawConf === 'LOW' || rawConf === 'low') ? '⚪' : (rawConf === 'MEDIUM' || rawConf === 'medium') ? '🟡' : '🟢'
      lines.push(`  ${confBadge} ${play.name} (${play.techs.join(', ')})`)
    }
  }

  // Enriched content from SalesHub knowledge (#371)
  for (const [tdp] of byTdp) {
    const tactics = getTacticsByTdp(tdp)
    const metricsFromTactics = tactics.flatMap(t => (t.metrics ?? []) as Array<{ value: string; context: string }>).filter(isValidMetric).slice(0, 3)
    if (metricsFromTactics.length > 0) {
      lines.push(`  Key Metrics:`)
      for (const m of metricsFromTactics) {
        lines.push(`    - ${m.value} -- ${m.context}`)
      }
    }
  }

  // Customer Lens from matched sales plays
  const seenPlays = new Set<string>()
  for (const [, plays] of byTdp) {
    for (const play of plays) {
      if (seenPlays.has(play.name)) continue
      seenPlays.add(play.name)
      const salesPlay = getSalesPlayByName(play.name)
      if (salesPlay?.customerLens?.pain?.length > 0) {
        lines.push(`  Customer Pain: ${salesPlay.customerLens.pain.slice(0, 2).join('; ')}`)
      }
      if (salesPlay?.realWorldExamples?.length > 0) {
        const ex = salesPlay.realWorldExamples[0]
        lines.push(`  Proof Point: ${ex.customer} -- ${ex.outcome}`)
      }
    }
  }

  return lines.join('\n')
}

/**
 * SalesHub Context section — aggregates ALL SalesHub knowledge relevant
 * to this customer's signals into a single section. This is the canonical
 * way SalesHub content enters every consumer (playbook, brief, campaign,
 * meeting-prep). Any new consumer that calls templateAll() gets this
 * automatically — no per-consumer wiring needed.
 *
 * Content: TDP positioning, tactic talk tracks, customer wins, linked assets.
 * Source: saleshub-knowledge.json via saleshub-knowledge-loader.ts.
 */
export function templateSalesHubContext(signals: Signal[]): string | null {
  // Find unique TDPs from signals that have solution play metadata
  const tdpSet = new Set<string>()
  for (const s of signals) {
    const tdp = s.metadata?.solutionTdp
    if (typeof tdp === 'string' && tdp) tdpSet.add(tdp)
  }

  if (tdpSet.size === 0) return null

  const parts: string[] = []

  for (const tdpName of tdpSet) {
    const tdpDesc = getTdpDescription(tdpName)
    const tactics = getTacticsByTdp(tdpName)

    if (!tdpDesc && tactics.length === 0) continue

    const tdpLines: string[] = []
    tdpLines.push(`### ${tdpName}`)
    if (tdpDesc) tdpLines.push(`> ${tdpDesc.slice(0, 300)}`)

    for (const tactic of tactics.slice(0, 5)) {
      tdpLines.push(`\n**${tactic.name}**`)
      if (tactic.talkTrack) {
        tdpLines.push(`*Talk track:* ${tactic.talkTrack.slice(0, 250)}`)
      }
      // Extracted content from SalesHub knowledge (#371)
      if (tactic.extractedContent) {
        tdpLines.push(`*Extracted insights:* ${tactic.extractedContent.slice(0, 200)}`)
      }
      const validMetrics = ((tactic.metrics ?? []) as Array<{ value: string; context: string }>).filter(isValidMetric).slice(0, 3)
      if (validMetrics.length > 0) {
        tdpLines.push('*Key metrics:*')
        for (const m of validMetrics) {
          tdpLines.push(`- ${m.value} -- ${m.context}`)
        }
      }
      const validWins = tactic.customerWins.filter(isValidCustomerWin)
      if (validWins.length > 0) {
        tdpLines.push('*Customer proof points:*')
        for (const win of validWins.slice(0, 3)) {
          tdpLines.push(`- ${win}`)
        }
      }
      if (tactic.whatToSay.length > 0) {
        tdpLines.push('*Key messaging:*')
        for (const say of tactic.whatToSay.slice(0, 3)) {
          tdpLines.push(`- ${say}`)
        }
      }
      if (tactic.whatToShare.length > 0) {
        const assets = tactic.whatToShare.filter(isValidAsset).slice(0, 5)
        if (assets.length > 0) {
          tdpLines.push('*Assets to share:*')
          for (const asset of assets) {
            tdpLines.push(`- [${asset.name}](${asset.url})`)
          }
        }
      }
    }

    parts.push(tdpLines.join('\n'))
  }

  return parts.length > 0 ? parts.join('\n\n') : null
}

/**
 * Orchestrator: Assemble all sections into a complete template result.
 *
 * @param signals - Scored signals from the registry
 * @param team - Account team members array from getAccountTeam() (optional)
 * @param options - Format and filtering options
 */
export async function templateAll(
  signals: Signal[],
  team?: AccountTeamMember[],
  options: TemplateOptions = { format: 'playbook' }
): Promise<TemplateResult> {
  // Apply product filter if specified
  const filteredSignals = filterByProduct(signals, options.productFilter)

  // Build individual sections
  const productAlignment = templateProductAlignment(filteredSignals)
  const cloudMarketplace = templateCloudMarketplace(filteredSignals)
  const renewals = templateRenewals(filteredSignals)
  const cases = templateCases(filteredSignals)
  const techStack = templateTechStack(filteredSignals)
  const keyRelationships = templateKeyRelationships(team)
  const salesAlignment = templateSalesAlignment(filteredSignals)
  const strategicOpportunities = templateStrategicOpportunities(filteredSignals)
  const saleshubContext = templateSalesHubContext(filteredSignals)

  // Assemble deterministic markdown output
  const sections: string[] = []

  // Sales Alignment at the top — management-visible TDP/Play mapping
  if (salesAlignment) sections.push(`## Sales Alignment\n\n${salesAlignment}`)
  // Strategic detail (solution plays table, marketplace, correlations) — consolidated under Sales Alignment
  if (strategicOpportunities) sections.push(strategicOpportunities)
  // Talk tracks and positioning detail — only in narrativeContext, not deterministic (avoids duplication)
  // saleshubContext feeds Gemini but doesn't render as a separate visible section
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

  // Append SalesHub talk tracks to narrative context so Gemini uses the language
  if (saleshubContext) {
    narrativeContext = `${narrativeContext}\n\nSales Plays, TDPs & Tactics (use this positioning language in your output):\n${saleshubContext}`
  }

  // Build structured solution play snapshots if customerSlug provided
  let solutionPlays: SolutionPlaySnapshot[] = []
  if (options.customerSlug) {
    try {
      const { getCustomerSolutionContext } = await import('./customer-solution-context.ts')
      const solutionCtx = getCustomerSolutionContext(options.customerSlug)
      solutionPlays = solutionCtx.activeSolutionPlays.map(p => {
        // Look up SalesPlay for customerLens and realWorldExamples (#371)
        const salesPlay = getSalesPlayByName(p.playName)
        // Collect metrics from tactics under this play's TDP
        const tdpTactics = getTacticsByTdp(p.tdp)
        const extractedMetrics = tdpTactics
          .flatMap(t => (t.metrics ?? []) as Array<{ value: string; context: string }>)
          .filter(isValidMetric)
          .slice(0, 5)

        return {
          tdp: p.tdp,
          playName: p.playName,
          triggerTechnologies: p.matchedTechnologies,
          confidence: p.confidence,
          talkTrack: p.talkTrack,
          customerWins: p.customerWins,
          linkedAssets: p.linkedAssets?.map(a => ({ name: a.name, url: a.url })),
          matchReasoning: p.matchReasoning,
          customerLens: salesPlay?.customerLens,
          realWorldExamples: salesPlay?.realWorldExamples?.slice(0, 3),
          extractedMetrics: extractedMetrics.length > 0 ? extractedMetrics : undefined,
        }
      })
    } catch {
      // Solution context unavailable — return empty array
    }
  }

  return {
    deterministic,
    narrativeContext,
    sections: {
      salesAlignment,
      productAlignment,
      cloudMarketplace,
      renewals,
      cases,
      techStack,
      keyRelationships,
      strategicOpportunities,
      saleshubContext,
    },
    structured: {
      solutionPlays,
    },
  }
}
