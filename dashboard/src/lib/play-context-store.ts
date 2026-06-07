/**
 * Play Context Store — sessionStorage-based context passing between pages
 * GitHub Issue #665
 *
 * When a user clicks an action button on a RecommendationCard, the play context
 * is stored in sessionStorage so downstream pages (CampaignConfigurator,
 * MeetingPrepPage) can consume it to auto-generate content.
 *
 * Consume-once pattern: getPlayContext() removes the stored data after reading.
 */

export interface PlayContext {
  playName: string
  products: string[]
  valueProps: string[]
  evidence: string[]
  customerSlug: string
  customerName: string
  confidence: string
  solutionUrl?: string
  assets: Array<{ name: string; url: string; type: string }>
  triggeredBy?: string  // meeting title that triggered this play
}

const STORAGE_KEY = 'pai-play-context'

export function storePlayContext(context: PlayContext): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context))
  } catch {
    // sessionStorage not available (SSR or storage full) — silently skip
  }
}

export function getPlayContext(): PlayContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)  // consume once
    try { return JSON.parse(raw) } catch { return null }
  } catch {
    return null
  }
}

/** Peek at the stored context without consuming it */
export function peekPlayContext(): PlayContext | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  } catch {
    return null
  }
}
