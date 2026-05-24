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

  const paths = [
    resolve(getConfigDir(), 'saleshub-knowledge.json'),
    resolve('config-templates', 'saleshub-knowledge.json'),
  ]

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
