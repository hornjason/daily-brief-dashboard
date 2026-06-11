/**
 * Structured Tech Stack view — GitHub Issue #779
 *
 * #779: structuredTechStack() is the SINGLE SOURCE OF TRUTH for
 *       tech stack filtering, sorting, and metadata flattening.
 *       The API endpoint delegates here; React components consume the flat shape.
 *
 * Layer 3 compliance: React components must NOT access signal.metadata directly.
 * This file extracts all metadata into typed flat fields.
 */

import type { Signal } from '../../feature-module-registry.ts'
import { routeSignal } from './route-signal.ts'

// ── Structured view types (#779) ────────────────────────────────────────────

export interface TechStackItemView {
  name: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  context: 'using' | 'evaluating' | 'migrating_from' | 'developing' | 'unknown'
  category: 'proprietary' | 'industry-tool' | 'unknown'
  infrastructure: string[]
  redHatProducts: string[]
  why: string
  source: string
  detail: string
  positioning: string
  timestamp: string
  solutionPlayId: string
  solutionPlayName: string
  solutionTdp: string
  valueProps: string[]
}

export interface TechStackView {
  items: TechStackItemView[]
  proprietaryCount: number
  industryToolCount: number
  migratingCount: number
  evaluatingCount: number
}

// ── Context priority for sorting ────────────────────────────────────────────

const CONTEXT_PRIORITY: Record<string, number> = {
  migrating_from: 0,
  evaluating: 1,
  using: 2,
  developing: 3,
  unknown: 4,
}

/**
 * SINGLE SOURCE OF TRUTH: structured tech stack view.
 * All filtering, sorting, and metadata flattening live here.
 * The API endpoint delegates to this function.
 */
export function structuredTechStack(signals: Signal[]): TechStackView {
  const techSignals = signals.filter(s =>
    s.source === 'tech-stack' || routeSignal(s) === 'tech'
  )

  // Sort by context priority (migrating_from > evaluating > using > developing)
  const sorted = techSignals.slice().sort((a, b) => {
    const aCtx = String(a.metadata?.context ?? 'unknown')
    const bCtx = String(b.metadata?.context ?? 'unknown')
    return (CONTEXT_PRIORITY[aCtx] ?? 4) - (CONTEXT_PRIORITY[bCtx] ?? 4)
  })

  const items: TechStackItemView[] = sorted.map(s => {
    const m = s.metadata ?? {}
    const headline = s.headline ?? ''
    const name = headline.split(' (')[0] || headline
    const detail = s.detail ?? ''
    const positioning = detail.split('Red Hat positioning:')[1]?.trim() ?? ''

    return {
      name,
      confidence: (['HIGH', 'MEDIUM', 'LOW'].includes(String(m.confidence ?? ''))
        ? String(m.confidence) as 'HIGH' | 'MEDIUM' | 'LOW'
        : 'UNKNOWN'),
      context: (['using', 'evaluating', 'migrating_from', 'developing'].includes(String(m.context ?? ''))
        ? String(m.context) as 'using' | 'evaluating' | 'migrating_from' | 'developing'
        : 'unknown'),
      category: (['proprietary', 'industry-tool'].includes(String(m.category ?? ''))
        ? String(m.category) as 'proprietary' | 'industry-tool'
        : 'unknown'),
      infrastructure: Array.isArray(m.infrastructure) ? m.infrastructure.map(String) : [],
      redHatProducts: Array.isArray(m.redHatProducts) ? m.redHatProducts.map(String) : [],
      why: String(m.why ?? ''),
      source: String(m.source ?? ''),
      detail,
      positioning,
      timestamp: s.timestamp ?? '',
      solutionPlayId: String(m.solutionPlayId ?? ''),
      solutionPlayName: String(m.solutionPlayName ?? ''),
      solutionTdp: String(m.solutionTdp ?? ''),
      valueProps: Array.isArray(m.valueProps) ? m.valueProps.map(String) : [],
    }
  })

  return {
    items,
    proprietaryCount: items.filter(i => i.category === 'proprietary').length,
    industryToolCount: items.filter(i => i.category === 'industry-tool').length,
    migratingCount: items.filter(i => i.context === 'migrating_from').length,
    evaluatingCount: items.filter(i => i.context === 'evaluating').length,
  }
}
