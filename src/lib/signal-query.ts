/**
 * src/lib/signal-query.ts — Cross-referencing query helper
 * GitHub Issue #482, ADR-032 §6
 *
 * Pure function that cross-references customer signals against the solution
 * portfolio (solution plays, ecosystem partners, cloud marketplace, saleshub)
 * and returns ranked recommended actions.
 *
 * No Gemini calls — all logic is deterministic rule-based matching.
 * The `narrative` field stays undefined (lazy generation comes later).
 */

import type { Signal } from '../feature-module-registry.ts'
import type { EcosystemPartnerCache } from './ecosystem-catalog.ts'

/**
 * Check if any target strings match against tech names (case-insensitive substring).
 * Inlined from customer-context-loader.ts to avoid dependency on file that may not exist in all contexts.
 */
function matchesTechStack(targets: string[], customerTechs: string[]): boolean {
  if (customerTechs.length === 0 || targets.length === 0) return false
  for (const target of targets) {
    const targetLower = target.toLowerCase()
    for (const tech of customerTechs) {
      if (tech.includes(targetLower) || targetLower.includes(tech)) {
        return true
      }
    }
  }
  return false
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecommendedAction {
  /** Composite narrative placeholder until Gemini fills it */
  action: string
  /** Confidence based on signal corroboration count */
  confidence: 'high' | 'medium' | 'emerging'
  /** The signals that triggered this recommendation */
  triggerSignals: Signal[]
  /** The matched solution from the portfolio */
  solution: {
    name: string
    type: 'play' | 'partner' | 'program' | 'product' | 'incentive'
    url?: string
    assets?: Array<{ name: string; url: string; type: string }>
  }
  /** One-click actions for the consumer UI */
  actions: string[]
  /** Gemini-generated "why this, why now" — populated lazily, may be absent */
  narrative?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RECOMMENDATIONS = 10

// ── Play URL & Asset Resolution (#662) ───────────────────────────────────────

/** Resolve a play's URL from linkedAssets, TDP cheatsheetUrl/customerDeckUrl, or ecosystem catalog */
function resolvePlayUrl(play: any, saleshubKnowledge: any): string | undefined {
  // 1. Check play.linkedAssets[0].url
  if (Array.isArray(play.linkedAssets) && play.linkedAssets.length > 0) {
    const firstAsset = play.linkedAssets.find((a: any) => a.url)
    if (firstAsset?.url) return firstAsset.url
  }

  // 2. Check TDP data from saleshub-knowledge for cheatsheetUrl/customerDeckUrl
  if (play.tdp && saleshubKnowledge?.tdps) {
    const tdpEntries = saleshubKnowledge.tdpDetails ?? saleshubKnowledge.tdps
    if (Array.isArray(tdpEntries)) {
      const tdp = tdpEntries.find((t: any) =>
        typeof t === 'object' && t.name?.toLowerCase() === play.tdp?.toLowerCase()
      )
      if (tdp?.cheatsheetUrl) return tdp.cheatsheetUrl
      if (tdp?.customerDeckUrl) return tdp.customerDeckUrl
    }
  }

  return undefined
}

/** Resolve play assets from linkedAssets and TDP data */
function resolvePlayAssets(play: any, saleshubKnowledge: any): Array<{ name: string; url: string; type: string }> | undefined {
  const assets: Array<{ name: string; url: string; type: string }> = []

  // Collect linkedAssets
  if (Array.isArray(play.linkedAssets)) {
    for (const a of play.linkedAssets) {
      if (a.url) assets.push({ name: a.name || play.name, url: a.url, type: a.type || 'document' })
    }
  }

  // Collect TDP assets
  if (play.tdp && saleshubKnowledge?.tdps) {
    const tdpEntries = saleshubKnowledge.tdpDetails ?? saleshubKnowledge.tdps
    if (Array.isArray(tdpEntries)) {
      const tdp = tdpEntries.find((t: any) =>
        typeof t === 'object' && t.name?.toLowerCase() === play.tdp?.toLowerCase()
      )
      if (tdp?.cheatsheetUrl) assets.push({ name: `${play.tdp} Cheat Sheet`, url: tdp.cheatsheetUrl, type: 'cheat-sheet' })
      if (tdp?.customerDeckUrl) assets.push({ name: `${play.tdp} Customer Deck`, url: tdp.customerDeckUrl, type: 'customer-deck' })
    }
  }

  return assets.length > 0 ? assets : undefined
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract technology names from signal metadata or headline */
function extractTechNames(signal: Signal): string[] {
  const m = signal.metadata ?? {}
  const names: string[] = []

  // Direct techName field (from tech-stack-module)
  if (typeof m.techName === 'string') names.push(m.techName)

  // technologies array (from tech-stack-module)
  if (Array.isArray(m.technologies)) {
    for (const t of m.technologies) {
      if (typeof t === 'string') names.push(t)
    }
  }

  // matchedTechnologies (from solution-intelligence-module)
  if (Array.isArray(m.matchedTechnologies)) {
    for (const t of m.matchedTechnologies) {
      if (typeof t === 'string') names.push(t)
    }
  }

  // techMentions (from cases with tech context)
  if (Array.isArray(m.techMentions)) {
    for (const t of m.techMentions) {
      if (typeof t === 'string') names.push(t)
    }
  }

  return [...new Set(names)]
}

/** Extract keywords from text for fuzzy matching against trigger technologies */
function extractKeywordsFromText(text: string): string[] {
  // Common tech keywords to look for in free text
  const keywords = text.toLowerCase().split(/[\s,;:.!?()\[\]{}]+/).filter(w => w.length >= 3)
  return [...new Set(keywords)]
}

/** Check if any trigger technology matches the given tech names (case-insensitive) */
function matchesTriggers(techNames: string[], triggers: string[]): boolean {
  const techLower = techNames.map(t => t.toLowerCase())
  for (const trigger of triggers) {
    const triggerLower = trigger.toLowerCase()
    for (const tech of techLower) {
      if (tech === triggerLower || tech.includes(triggerLower) || triggerLower.includes(tech)) {
        return true
      }
    }
  }
  return false
}

/** Check if signal text mentions any trigger technology */
function textMentionsTrigger(signal: Signal, triggers: string[]): boolean {
  const text = `${signal.headline} ${signal.detail}`.toLowerCase()
  for (const trigger of triggers) {
    const triggerLower = trigger.toLowerCase()
    if (triggerLower.length >= 3 && text.includes(triggerLower)) {
      return true
    }
  }
  return false
}

// ── Confidence scoring (ADR-032 §6 Step 4) ────────────────────────────────────

/** #495: Weight customer-specific signals 3x to ensure recommendation diversity */
const CUSTOMER_SIGNAL_WEIGHT = 3
const PORTFOLIO_SIGNAL_WEIGHT = 1

function computeWeightedScore(triggers: Signal[]): number {
  let score = 0
  for (const s of triggers) {
    const isCustomerSpecific = !!s.metadata?.customerSlug
    score += isCustomerSpecific ? CUSTOMER_SIGNAL_WEIGHT : PORTFOLIO_SIGNAL_WEIGHT
  }
  return score
}

function computeConfidence(weightedScore: number): 'high' | 'medium' | 'emerging' {
  if (weightedScore >= 5) return 'high'
  if (weightedScore >= 3) return 'medium'
  return 'emerging'
}

// ── Cross-reference dimensions ────────────────────────────────────────────────

interface PendingRecommendation {
  solutionKey: string
  solutionName: string
  solutionType: 'play' | 'partner' | 'program' | 'product' | 'incentive'
  solutionUrl?: string
  assets?: Array<{ name: string; url: string; type: string }>
  triggerSignals: Signal[]
  actions: string[]
}

/**
 * Core cross-referencing function.
 * ADR-032 §6 — Algorithm Steps 1-5.
 *
 * Pure function, no framework dependencies, fully testable.
 */
export function getRecommendations(
  signals: Signal[],
  solutionPlays: any[],
  ecosystemPartners: any[],
  cloudMarketplace: any,
  saleshubKnowledge: any,
): RecommendedAction[] {
  if (signals.length === 0) return []
  if (solutionPlays.length === 0 && (!ecosystemPartners || ecosystemPartners.length === 0) && !cloudMarketplace) return []

  // Step 1: Bucket signals by type
  // ADR-032a: Only trigger signals create play matches; enrichment attaches assets
  const triggerOnly = signals.filter(s => s.role !== 'enrichment')
  const enrichmentOnly = signals.filter(s => s.role === 'enrichment')

  const techSignals = triggerOnly.filter(s => s.type === 'technology' || s.source === 'tech-stack')
  const caseSignals = triggerOnly.filter(s => s.type === 'case' || s.source === 'cases')
  const cloudSignals = triggerOnly.filter(s => s.type === 'cloud-spend' || s.source === 'ccsp')
  const subSignals = triggerOnly.filter(s => s.type === 'subscription' || s.source === 'subscriptions')
  const intelSignals = triggerOnly.filter(s => s.type === 'intelligence' || s.source === 'intelligence')

  // Accumulator: group by solution key to merge corroborating signals
  const pending = new Map<string, PendingRecommendation>()

  function addTrigger(key: string, defaults: Omit<PendingRecommendation, 'triggerSignals'>, signal: Signal) {
    const existing = pending.get(key)
    if (existing) {
      // Don't add duplicate signals
      if (!existing.triggerSignals.some(s => s === signal)) {
        existing.triggerSignals.push(signal)
      }
    } else {
      pending.set(key, { ...defaults, triggerSignals: [signal] })
    }
  }

  // Step 2a: Tech-stack x solution-plays
  for (const signal of techSignals) {
    const techNames = extractTechNames(signal)
    if (techNames.length === 0) continue

    for (const play of solutionPlays) {
      if (matchesTriggers(techNames, play.triggerTechnologies ?? [])) {
        // #662: Resolve play URL from linkedAssets or TDP data
        const playUrl = resolvePlayUrl(play, saleshubKnowledge)
        const playAssets = resolvePlayAssets(play, saleshubKnowledge)
        addTrigger(`play:${play.id}`, {
          solutionKey: `play:${play.id}`,
          solutionName: play.name,
          solutionType: 'play',
          solutionUrl: playUrl,
          assets: playAssets,
          actions: ['View play deck', 'Draft email', 'Prep meeting'],
        }, signal)
      }
    }
  }

  // Step 2b: Tech-stack x ecosystem-catalog
  if (ecosystemPartners && ecosystemPartners.length > 0) {
    for (const signal of techSignals) {
      const techNames = extractTechNames(signal)
      if (techNames.length === 0) continue

      for (const partner of ecosystemPartners as EcosystemPartnerCache[]) {
        for (const solution of partner.solutions) {
          // Match partner name or solution categories against tech names
          const targets = [
            partner.partnerName,
            ...solution.categories,
            solution.platform,
          ]
          if (matchesTechStack(targets, techNames.map(t => t.toLowerCase()))) {
            const assets = solution.resources?.map(r => ({
              name: r.title,
              url: r.url,
              type: r.type,
            }))
            addTrigger(`partner:${partner.partnerSlug}:${solution.name}`, {
              solutionKey: `partner:${partner.partnerSlug}:${solution.name}`,
              solutionName: `${partner.partnerName}: ${solution.name}`,
              solutionType: 'partner',
              solutionUrl: solution.url,
              assets,
              actions: ['View partner solution', 'Request joint call', 'Share with customer'],
            }, signal)
          }
        }
      }
    }
  }

  // Step 2c: Cloud-spend x cloud-marketplace programs
  if (cloudMarketplace?.clouds && cloudSignals.length > 0) {
    for (const signal of cloudSignals) {
      const provider = String(signal.metadata?.provider ?? signal.metadata?.cloudPartner ?? '')
      if (!provider) continue

      for (const cloud of cloudMarketplace.clouds) {
        if (cloud.provider.toLowerCase() === provider.toLowerCase() ||
            provider.toLowerCase().includes(cloud.provider.toLowerCase())) {
          for (const program of cloud.programs) {
            addTrigger(`program:${cloud.provider}:${program.name}`, {
              solutionKey: `program:${cloud.provider}:${program.name}`,
              solutionName: program.name,
              solutionType: 'program',
              solutionUrl: undefined,
              assets: undefined,
              actions: ['View program details', 'Check eligibility', 'Draft proposal'],
            }, signal)
          }
        }
      }
    }
  }

  // Step 2d: Case signals x solution-plays (technology mentions in cases)
  for (const signal of caseSignals) {
    const techMentions = extractTechNames(signal)

    // Also check case text for technology mentions
    for (const play of solutionPlays) {
      const triggers = play.triggerTechnologies ?? []
      if (
        (techMentions.length > 0 && matchesTriggers(techMentions, triggers)) ||
        textMentionsTrigger(signal, triggers)
      ) {
        // #662: Resolve play URL from linkedAssets or TDP data
        const playUrl = resolvePlayUrl(play, saleshubKnowledge)
        const playAssets = resolvePlayAssets(play, saleshubKnowledge)
        addTrigger(`play:${play.id}`, {
          solutionKey: `play:${play.id}`,
          solutionName: play.name,
          solutionType: 'play',
          solutionUrl: playUrl,
          assets: playAssets,
          actions: ['View play deck', 'Draft email', 'Prep meeting'],
        }, signal)
      }
    }
  }

  // Step 2e: Intelligence signals x solution-plays (business objectives alignment)
  for (const signal of intelSignals) {
    for (const play of solutionPlays) {
      const triggers = play.triggerTechnologies ?? []
      // Check if intelligence text mentions trigger technologies
      if (textMentionsTrigger(signal, triggers)) {
        // #662: Resolve play URL from linkedAssets or TDP data
        const playUrl = resolvePlayUrl(play, saleshubKnowledge)
        const playAssets = resolvePlayAssets(play, saleshubKnowledge)
        addTrigger(`play:${play.id}`, {
          solutionKey: `play:${play.id}`,
          solutionName: play.name,
          solutionType: 'play',
          solutionUrl: playUrl,
          assets: playAssets,
          actions: ['View play deck', 'Draft email', 'Prep meeting'],
        }, signal)
      }
    }
  }

  // Step 2f: Subscription x product-lifecycle (not implemented here — lifecycle data loading
  // is handled by solution-intelligence-module already, this would be for future enrichment)

  // Step 3: Convert pending to RecommendedAction[] with weighted scoring (#495)
  // Deduplication by solution name happens naturally via the pending Map (keyed by solution).
  const scored: Array<{ rec: RecommendedAction; weightedScore: number }> = []

  for (const rec of pending.values()) {
    const weightedScore = computeWeightedScore(rec.triggerSignals)
    const confidence = computeConfidence(weightedScore)

    // ADR-032a: Prefer customer-specific trigger signals in headline, not portfolio content
    const customerTriggers = rec.triggerSignals
      .filter(s => s.audience === 'customer-specific' || s.metadata?.customerSlug)
      .map(s => s.headline)
      .slice(0, 3)
      .join(' + ')

    const triggerSummary = customerTriggers || rec.triggerSignals.map(s => s.headline).slice(0, 2).join(' + ')

    scored.push({
      weightedScore,
      rec: {
        action: `${triggerSummary} → ${rec.solutionName}`,
        confidence,
        triggerSignals: rec.triggerSignals,
        solution: {
          name: rec.solutionName,
          type: rec.solutionType,
          url: rec.solutionUrl,
          assets: rec.assets,
        },
        actions: rec.actions,
        narrative: undefined, // Lazy Gemini generation — ADR-032 §5
      },
    })
  }

  // Step 4: Attach enrichment assets to matched recommendations (ADR-032a)
  // Only attach partner/ecosystem/saleshub content — not RSS news or outage alerts
  const ENRICHMENT_SOURCES = new Set(['SalesHub Content', 'ecosystem-catalog', 'partner-catalog', 'saleshub', 'competitive-intel'])
  for (const item of scored) {
    const enrichAssets: Array<{ name: string; url: string; type: string; source: string }> = []
    for (const es of enrichmentOnly) {
      if (!ENRICHMENT_SOURCES.has(es.source)) continue
      const playTriggers = solutionPlays.find(
        p => `play:${p.id}` === item.rec.solution.name || p.name === item.rec.solution.name
      )?.triggerTechnologies ?? []
      if (playTriggers.length > 0 && textMentionsTrigger(es, playTriggers)) {
        enrichAssets.push({
          name: es.headline,
          url: es.url ?? '',
          type: es.source,
          source: es.source,
        })
      }
    }
    if (enrichAssets.length > 0) {
      item.rec.solution.assets = [
        ...(item.rec.solution.assets ?? []),
        ...enrichAssets.slice(0, 5),
      ]
    }
  }

  // Step 5: Rank by weighted score (not raw trigger count), then by confidence tier (#495)
  const confidenceOrder = { high: 3, medium: 2, emerging: 1 }
  scored.sort((a, b) => {
    // Primary: weighted score (customer-specific signals count 3x)
    const scoreDiff = b.weightedScore - a.weightedScore
    if (scoreDiff !== 0) return scoreDiff
    // Tiebreaker: confidence tier
    return confidenceOrder[b.rec.confidence] - confidenceOrder[a.rec.confidence]
  })

  return scored.map(s => s.rec).slice(0, MAX_RECOMMENDATIONS)
}
