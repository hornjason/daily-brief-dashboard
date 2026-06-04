/**
 * src/lib/deal-outcome-history.ts
 * Deal outcome history loader — GitHub Issue #622
 *
 * Reads persisted intelligence graphs to extract won deals and the tactics
 * that were attributed to them. Used by tactic-scorer.ts to boost tactics
 * that have proven outcomes in similar customers.
 *
 * No framework imports. No side effects. Independently testable.
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import type { CustomerGraph } from './intelligence-graph-types.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TacticOutcome {
  tacticName: string
  customerSlug: string
  customerName: string
  dealAmount: number
  closedAt: string
  /** 0.0-1.0 strength of attribution between tactic and deal */
  attributionScore: number
}

// ── Core function ────────────────────────────────────────────────────────────

/**
 * Load outcome history by scanning all customer intelligence graphs for
 * won deals and correlating them with recommended tactics from motion history.
 *
 * Walks the cache directory looking for intelligence-graph.json files,
 * extracts deal nodes with stage "Closed Won", and matches them against
 * the motion history's recommended tactics.
 *
 * @param cacheDir - Base data directory containing {slug}/intelligence-graph.json
 * @returns Array of TacticOutcome objects
 */
export function loadOutcomeHistory(cacheDir: string): TacticOutcome[] {
  if (!existsSync(cacheDir)) return []

  const outcomes: TacticOutcome[] = []

  let entries: string[]
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch {
    return []
  }

  for (const slug of entries) {
    // Validate slug to prevent path traversal
    if (/[^a-zA-Z0-9_-]/.test(slug)) continue

    const graphPath = resolve(cacheDir, slug, 'intelligence-graph.json')
    if (!existsSync(graphPath)) continue

    let graph: CustomerGraph
    try {
      const raw = readFileSync(graphPath, 'utf-8')
      graph = JSON.parse(raw) as CustomerGraph
    } catch {
      continue
    }

    // Find won deals
    const wonDeals = Object.values(graph.nodes).filter(n =>
      n.type === 'deal' &&
      String(n.properties.stage ?? '').toLowerCase().includes('closed won')
    )

    if (wonDeals.length === 0) continue

    // Extract tactic names from motion history
    const tacticNames = (graph.history ?? []).map(m => m.title)
    if (tacticNames.length === 0) continue

    // Cross-reference: each won deal gets attributed to each recommended tactic
    for (const deal of wonDeals) {
      const amount = Number(deal.properties.amount ?? 0)
      const closedAt = String(deal.properties.closedAt ?? deal.properties.closeDate ?? graph.builtAt ?? '')

      for (const tacticName of tacticNames) {
        outcomes.push({
          tacticName,
          customerSlug: slug,
          customerName: graph.customerName,
          dealAmount: amount,
          closedAt,
          attributionScore: 0.5, // Default moderate attribution
        })
      }
    }
  }

  return outcomes
}
