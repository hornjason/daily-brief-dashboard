/**
 * scripts/enrich-solution-plays.ts — Auto-enrich solution-plays.json from SalesHub knowledge
 *
 * Maps scraped tactic descriptions → valueProps and scraped deck links → linkedAssets.
 * Preserves manual entries when no SalesHub match is found.
 *
 * Called as a post-scrape step in the daemon trigger handler.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { writeJsonAtomic } from '../src/lib/atomic-write.ts'
import type { SalesHubKnowledge } from './saleshub-knowledge-extraction.ts'

const CONFIG_DIR = process.env.CONFIG_DIR ?? 'config'
const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'

interface SolutionPlay {
  id: string
  name: string
  tdp: string
  summary: string
  triggerTechnologies: string[]
  redHatProducts: string[]
  valueProps: string[]
  cloudAmplifiers?: string[]
  relatedPlays?: string[]
  category: string
  tactics?: string[]
  linkedAssets?: Array<{ name: string; url: string; type: string }>
}

interface SolutionPlayCatalog {
  version: number
  tdps: string[]
  plays: SolutionPlay[]
}

export function enrichSolutionPlays(): { enriched: number; total: number } {
  const catalogPath = resolve(CONFIG_DIR, 'solution-plays.json')
  if (!existsSync(catalogPath)) {
    console.warn('[enrich] solution-plays.json not found — skipping enrichment')
    return { enriched: 0, total: 0 }
  }

  const knowledgePath = resolve(CACHE_DIR, 'saleshub', 'saleshub-knowledge.json')
  if (!existsSync(knowledgePath)) {
    console.warn('[enrich] saleshub-knowledge.json not found — skipping enrichment')
    return { enriched: 0, total: 0 }
  }

  const catalog: SolutionPlayCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'))
  const knowledge: SalesHubKnowledge = JSON.parse(readFileSync(knowledgePath, 'utf-8'))

  let enrichedCount = 0

  for (const play of catalog.plays) {
    const tdpName = play.tdp

    // Find matching TDP in knowledge base
    const matchingTdp = knowledge.tdps.find(t =>
      t.name.toLowerCase().includes(tdpName.toLowerCase()) ||
      tdpName.toLowerCase().includes(t.name.toLowerCase().replace(' tdp', ''))
    )

    // Find tactics under this TDP
    const matchingTactics = knowledge.tactics.filter(t =>
      t.parentTdp.toLowerCase().includes(tdpName.toLowerCase()) ||
      tdpName.toLowerCase().includes(t.parentTdp.toLowerCase().replace(' tdp', ''))
    )

    let wasEnriched = false

    // Enrich valueProps with TDP description + tactic talk tracks
    if (matchingTdp && matchingTdp.description.length > 50) {
      const existingProps = play.valueProps.join(' ').toLowerCase()
      if (!existingProps.includes(matchingTdp.description.slice(0, 30).toLowerCase())) {
        play.valueProps = [matchingTdp.description, ...play.valueProps]
        wasEnriched = true
      }
    }

    // Add tactic names
    if (matchingTactics.length > 0) {
      play.tactics = matchingTactics.map(t => t.name)
      wasEnriched = true
    }

    // Add linked assets from matching products
    const assets: Array<{ name: string; url: string; type: string }> = []
    for (const product of knowledge.products) {
      const hasMatchingTdp = product.tdpContent.some(tc =>
        tc.name.toLowerCase().includes(tdpName.toLowerCase())
      )
      if (hasMatchingTdp) {
        for (const deck of product.decks) {
          if (deck.url && !assets.some(a => a.name === deck.name)) {
            assets.push(deck)
          }
        }
      }
    }

    // Also add tactic whatToShare assets
    for (const tactic of matchingTactics) {
      for (const share of tactic.whatToShare) {
        if (share.url && !assets.some(a => a.name === share.name)) {
          assets.push(share)
        }
      }
    }

    if (assets.length > 0) {
      play.linkedAssets = assets
      wasEnriched = true
    }

    if (wasEnriched) enrichedCount++
  }

  writeJsonAtomic(catalogPath, catalog)
  console.log(`[enrich] Enriched ${enrichedCount}/${catalog.plays.length} solution plays`)

  return { enriched: enrichedCount, total: catalog.plays.length }
}

if (import.meta.main) {
  enrichSolutionPlays()
}
