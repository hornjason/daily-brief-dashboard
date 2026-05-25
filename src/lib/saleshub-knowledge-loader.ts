/**
 * SalesHub Knowledge Base Loader (ADR-030, Slice 2)
 *
 * Reads saleshub-knowledge.json and provides lookup functions for
 * resolving cross-references: tactic → TDP → sales play.
 *
 * Used by customer-solution-context.ts to enrich solution plays
 * with actual SalesHub talk tracks and linked assets.
 */

import { readFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import type { SalesHubKnowledge, TacticNode, TdpNode, SalesPlayNode } from '../../scripts/saleshub-knowledge-extraction.ts'

function getConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config'
}

// ── Knowledge Cache (file-level, mtime-aware) ──────────────────────────

let _knowledgeCache: SalesHubKnowledge | null = null
let _knowledgeMtime: number = 0
const KNOWLEDGE_CHECK_INTERVAL_MS = 60_000

let _lastMtimeCheck = 0

function loadKnowledgeBase(): SalesHubKnowledge | null {
  const now = Date.now()

  // Only check file mtime every 60s to avoid excessive stat calls
  if (_knowledgeCache && now - _lastMtimeCheck < KNOWLEDGE_CHECK_INTERVAL_MS) {
    return _knowledgeCache
  }

  const paths = [resolve(getConfigDir(), 'saleshub-knowledge.json')]
  if (!process.env.CONFIG_DIR) {
    paths.push(resolve('config-templates', 'saleshub-knowledge.json'))
  }

  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const mtime = statSync(p).mtimeMs

      if (_knowledgeCache && mtime === _knowledgeMtime) {
        _lastMtimeCheck = now
        return _knowledgeCache
      }

      _knowledgeCache = JSON.parse(readFileSync(p, 'utf-8'))
      _knowledgeMtime = mtime
      _lastMtimeCheck = now
      return _knowledgeCache
    } catch { /* try next */ }
  }

  return null
}

// ── Lookup Functions ────────────────────────────────────────────────────

export function getTacticsByTdp(tdpName: string): TacticNode[] {
  const kb = loadKnowledgeBase()
  if (!kb) return []

  const normalizedTdp = tdpName.toLowerCase()

  // Find tactics whose parentTdp matches
  const directMatches = kb.tactics.filter(t =>
    t.parentTdp.toLowerCase().includes(normalizedTdp) ||
    normalizedTdp.includes(t.parentTdp.toLowerCase())
  )

  // Also find from TDP node's tactics array
  const tdpNode = kb.tdps.find(t =>
    t.name.toLowerCase().includes(normalizedTdp) ||
    normalizedTdp.includes(t.name.toLowerCase())
  )

  if (tdpNode) {
    for (const tacticName of tdpNode.tactics) {
      const tactic = kb.tactics.find(t => t.name === tacticName)
      if (tactic && !directMatches.some(d => d.name === tactic.name)) {
        directMatches.push(tactic)
      }
    }
  }

  return directMatches
}

export function getAssetsByPlay(playId: string, tdpName?: string): Array<{ name: string; url: string; type: string }> {
  const kb = loadKnowledgeBase()
  if (!kb) return []

  const normalizedId = playId.toLowerCase()
  const assets: Array<{ name: string; url: string; type: string }> = []

  for (const product of kb.products) {
    const hasRelevantTdp = product.tdpContent.some(tc =>
      tc.name.toLowerCase().includes(normalizedId)
    )

    if (hasRelevantTdp) {
      for (const deck of product.decks) {
        if (!assets.some(a => a.name === deck.name)) {
          assets.push(deck)
        }
      }
    }
  }

  // Only include tactic assets from tactics matching the play's TDP
  if (tdpName) {
    const tdpTactics = getTacticsByTdp(tdpName)
    for (const tactic of tdpTactics) {
      for (const share of tactic.whatToShare) {
        if (share.url && !assets.some(a => a.name === share.name)) {
          assets.push(share)
        }
      }
    }
  }

  return assets
}

export function getTalkTrack(tacticName: string): string {
  const kb = loadKnowledgeBase()
  if (!kb) return ''

  const normalized = tacticName.toLowerCase()
  const tactic = kb.tactics.find(t =>
    t.name.toLowerCase() === normalized ||
    t.name.toLowerCase().includes(normalized) ||
    normalized.includes(t.name.toLowerCase())
  )

  return tactic?.talkTrack ?? ''
}

export function getTdpDescription(tdpName: string): string {
  const kb = loadKnowledgeBase()
  if (!kb) return ''

  const normalized = tdpName.toLowerCase()
  const tdp = kb.tdps.find(t =>
    t.name.toLowerCase().includes(normalized) ||
    normalized.includes(t.name.toLowerCase())
  )

  return tdp?.description ?? ''
}

export function getTdpByName(tdpName: string): TdpNode | undefined {
  const kb = loadKnowledgeBase()
  if (!kb) return undefined
  const normalized = tdpName.toLowerCase()
  return kb.tdps.find(t =>
    t.name.toLowerCase().includes(normalized) ||
    normalized.includes(t.name.toLowerCase())
  )
}

export function getSalesPlayByName(playName: string): SalesPlayNode | undefined {
  const kb = loadKnowledgeBase()
  if (!kb) return undefined
  return kb.salesPlays.find(sp =>
    sp.name.toLowerCase() === playName.toLowerCase()
  )
}

// ── Coverage Types ─────────────────────────────────────────────────────────

export interface TdpCoverage {
  name: string
  sections: {
    customerWins: boolean
    whatToSay: boolean
    whatToShare: boolean
    whatToShow: boolean
    services: boolean
    cheatsheet: boolean
    customerDeck: boolean
  }
  sectionCount: number
  tacticCount: number
  extractedContentCount: number
}

export interface PlayCoverage {
  name: string
  sections: {
    customerLens: boolean
    realWorldExamples: boolean
    emailTemplate: boolean
    discoveryQuestions: boolean
    introPitchDeck: boolean
    personas: boolean
  }
  sectionCount: number
}

export interface KnowledgeCoverage {
  tdps: TdpCoverage[]
  plays: PlayCoverage[]
  totalLinkedDocs: number
  docsWithExtractedContent: number
  overallCoveragePercent: number
  scrapedAt: string | null
}

export function getKnowledgeCoverage(): KnowledgeCoverage {
  const kb = loadKnowledgeBase()
  if (!kb) return { tdps: [], plays: [], totalLinkedDocs: 0, docsWithExtractedContent: 0, overallCoveragePercent: 0, scrapedAt: null }

  const allUrls = new Set<string>()
  let docsWithExtractedContent = 0

  // Compute TDP coverage (null-safe — production data may predate #366/#368 field additions)
  const tdps: TdpCoverage[] = kb.tdps.map(tdp => {
    const sections = {
      customerWins: (tdp.customerWins ?? []).length > 0,
      whatToSay: (tdp.whatToSay ?? []).length > 0,
      whatToShare: (tdp.whatToShare ?? []).length > 0,
      whatToShow: (tdp.whatToShow ?? []).length > 0,
      services: (tdp.services ?? []).length > 0,
      cheatsheet: (tdp.cheatsheetUrl ?? '').length > 0,
      customerDeck: (tdp.customerDeckUrl ?? '').length > 0,
    }
    const sectionCount = Object.values(sections).filter(Boolean).length

    // Collect URLs from this TDP
    for (const item of tdp.whatToSay ?? []) { if (item.url) allUrls.add(item.url) }
    for (const item of tdp.whatToShare ?? []) { if (item.url) allUrls.add(item.url) }
    for (const item of tdp.whatToShow ?? []) { if (item.url) allUrls.add(item.url) }
    if (tdp.cheatsheetUrl) allUrls.add(tdp.cheatsheetUrl)
    if (tdp.customerDeckUrl) allUrls.add(tdp.customerDeckUrl)

    // Count tactics with extracted content for this TDP
    const tdpTactics = kb.tactics.filter(t => t.parentTdp === tdp.name)
    const extractedContentCount = tdpTactics.filter(t => (t.extractedContent ?? '').length > 0).length

    return { name: tdp.name, sections, sectionCount, tacticCount: (tdp.tactics ?? []).length, extractedContentCount }
  })

  // Compute Play coverage (null-safe — production data may predate #367 field additions)
  const plays: PlayCoverage[] = kb.salesPlays.map(play => {
    const lens = play.customerLens ?? { pain: [], outcomes: [], impact: [] }
    const hasCustomerLens = lens.pain.length > 0 || lens.outcomes.length > 0 || lens.impact.length > 0
    const sections = {
      customerLens: hasCustomerLens,
      realWorldExamples: (play.realWorldExamples ?? []).length > 0,
      emailTemplate: (play.emailTemplateUrl ?? '').length > 0,
      discoveryQuestions: (play.discoveryQuestionsUrl ?? '').length > 0,
      introPitchDeck: (play.introPitchDeckUrl ?? '').length > 0,
      personas: (play.personas ?? []).length > 0,
    }
    const sectionCount = Object.values(sections).filter(Boolean).length
    return { name: play.name, sections, sectionCount }
  })

  // Collect URLs from tactics and count extracted content
  for (const tactic of kb.tactics) {
    for (const item of tactic.whatToShare ?? []) { if (item.url) allUrls.add(item.url) }
    if ((tactic.extractedContent ?? '').length > 0) docsWithExtractedContent++
  }

  // Overall coverage: filled sections / total possible sections
  const tdpFilledSections = tdps.reduce((sum, t) => sum + t.sectionCount, 0)
  const tdpTotalSections = tdps.length * 7
  const playFilledSections = plays.reduce((sum, p) => sum + p.sectionCount, 0)
  const playTotalSections = plays.length * 6
  const totalPossible = tdpTotalSections + playTotalSections
  const overallCoveragePercent = totalPossible > 0
    ? Math.round(((tdpFilledSections + playFilledSections) / totalPossible) * 100)
    : 0

  return {
    tdps,
    plays,
    totalLinkedDocs: allUrls.size,
    docsWithExtractedContent,
    overallCoveragePercent,
    scrapedAt: kb.scrapedAt,
  }
}

export function getKnowledgeStats(): { tdpCount: number; tacticCount: number; salesPlayCount: number; productCount: number; scrapedAt: string | null } {
  const kb = loadKnowledgeBase()
  if (!kb) return { tdpCount: 0, tacticCount: 0, salesPlayCount: 0, productCount: 0, scrapedAt: null }

  return {
    tdpCount: kb.tdps.length,
    tacticCount: kb.tactics.length,
    salesPlayCount: kb.salesPlays.length,
    productCount: kb.products.length,
    scrapedAt: kb.scrapedAt,
  }
}

export function resetKnowledgeCache(): void {
  _knowledgeCache = null
  _knowledgeMtime = 0
  _lastMtimeCheck = 0
}
