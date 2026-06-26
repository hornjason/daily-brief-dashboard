/**
 * Structured Recommendations view — GitHub Issue #779
 *
 * #779: structuredRecommendations() is the SINGLE SOURCE OF TRUTH for
 *       recommendation filtering, sorting, and metadata flattening.
 *       The API endpoint delegates here; React components consume the flat shape.
 *
 * Layer 3 compliance: React components must NOT access signal.metadata directly.
 * This file extracts all metadata into typed flat fields, replacing
 * the signalToRecommendation() function that lived in the React component.
 */

import type { Signal } from '../../feature-module-registry.ts'

// ── Structured view types (#779) ────────────────────────────────────────────

export interface RecommendationPlayData {
  summary: string
  valueProps: string[]
  cloudAmplifiers: string[]
  relatedPlays: string[]
  category: string
  triggeredBy?: string
}

export interface RecommendationTdpData {
  name: string
  cheatsheetUrl?: string
  customerDeckUrl?: string
  whatToSay: Array<{ name: string; url?: string }>
  whatToShare: Array<{ name: string; url?: string }>
  whatToShow: Array<{ name: string; url?: string }>
  customerWins: Array<{ name: string; description?: string }>
  tactics: string[]
  documentCount: number
  serviceCount: number
}

export interface RecommendationView {
  headline: string
  detail: string
  confidence: 'HIGH' | 'MEDIUM' | 'EMERGING'
  solutionName: string
  solutionType: string
  triggerSignalCount: number
  redHatProducts: string[]
  actions: string[]
  assets: Array<{ name: string; url?: string; type: string; source?: string }>
  triggerSignals: Array<{ source: string; headline: string; recommendedAction?: string; nextStep?: string }>
  play?: RecommendationPlayData
  tdp?: RecommendationTdpData
  customerSlug: string
  solutionUrl: string
}

/**
 * SINGLE SOURCE OF TRUTH: structured recommendations view.
 * All filtering, sorting, and metadata flattening live here.
 * The API endpoint delegates to this function.
 *
 * Replaces signalToRecommendation() that previously lived in RecommendationCard.tsx.
 */
export function structuredRecommendations(signals: Signal[]): RecommendationView[] {
  const recSignals = signals.filter(s =>
    s.source === 'recommended-actions' && s.type === 'recommendation'
  )

  // Sort by triggerSignalCount desc
  const sorted = recSignals.slice().sort((a, b) => {
    const aCount = Number(a.metadata?.triggerSignalCount ?? 0)
    const bCount = Number(b.metadata?.triggerSignalCount ?? 0)
    return bCount - aCount
  })

  return sorted.map(s => {
    const m = s.metadata ?? {}

    const confidence = (['HIGH', 'MEDIUM', 'EMERGING'].includes(String(m.confidence ?? ''))
      ? String(m.confidence) as 'HIGH' | 'MEDIUM' | 'EMERGING'
      : 'EMERGING')

    return {
      headline: s.headline ?? '',
      detail: s.detail ?? '',
      confidence,
      solutionName: String(m.solutionName ?? ''),
      solutionType: String(m.solutionType ?? 'play'),
      triggerSignalCount: Number(m.triggerSignalCount ?? 0),
      redHatProducts: Array.isArray(m.redHatProducts) ? m.redHatProducts.map(String) : [],
      actions: Array.isArray(m.actions) ? m.actions.map(String) : [],
      assets: Array.isArray(m.assets) ? m.assets.map((a: any) => ({
        name: String(a?.name ?? ''),
        url: a?.url ? String(a.url) : undefined,
        type: String(a?.type ?? ''),
        source: a?.source ? String(a.source) : undefined,
      })) : [],
      triggerSignals: Array.isArray(m.triggerSignals) ? m.triggerSignals.map((ts: any) => ({
        source: String(ts?.source ?? ''),
        headline: String(ts?.headline ?? ''),
        recommendedAction: ts?.recommendedAction ? String(ts.recommendedAction) : undefined,
        nextStep: ts?.nextStep ? String(ts.nextStep) : undefined,
      })) : [],
      play: m.play ? {
        summary: String((m.play as any).summary ?? ''),
        valueProps: Array.isArray((m.play as any).valueProps) ? (m.play as any).valueProps.map(String) : [],
        cloudAmplifiers: Array.isArray((m.play as any).cloudAmplifiers) ? (m.play as any).cloudAmplifiers.map(String) : [],
        relatedPlays: Array.isArray((m.play as any).relatedPlays) ? (m.play as any).relatedPlays.map(String) : [],
        category: String((m.play as any).category ?? ''),
        triggeredBy: (m.play as any).triggeredBy ? String((m.play as any).triggeredBy) : undefined,
      } : undefined,
      tdp: m.tdp ? {
        name: String((m.tdp as any).name ?? ''),
        cheatsheetUrl: (m.tdp as any).cheatsheetUrl ? String((m.tdp as any).cheatsheetUrl) : undefined,
        customerDeckUrl: (m.tdp as any).customerDeckUrl ? String((m.tdp as any).customerDeckUrl) : undefined,
        whatToSay: Array.isArray((m.tdp as any).whatToSay) ? (m.tdp as any).whatToSay : [],
        whatToShare: Array.isArray((m.tdp as any).whatToShare) ? (m.tdp as any).whatToShare : [],
        whatToShow: Array.isArray((m.tdp as any).whatToShow) ? (m.tdp as any).whatToShow : [],
        customerWins: Array.isArray((m.tdp as any).customerWins) ? (m.tdp as any).customerWins : [],
        tactics: Array.isArray((m.tdp as any).tactics) ? (m.tdp as any).tactics.map(String) : [],
        documentCount: Number((m.tdp as any).documentCount ?? 0),
        serviceCount: Number((m.tdp as any).serviceCount ?? 0),
      } : undefined,
      customerSlug: String(m.customerSlug ?? ''),
      solutionUrl: String(s.url ?? m.solutionUrl ?? ''),
    }
  })
}
