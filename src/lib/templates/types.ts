/**
 * Shared types for the Signal Template Engine.
 * Extracted from signal-templates.ts — GitHub Issue #684
 */

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
    upcomingEvents: string | null
    accountPlan: string | null
  }
  /** Structured data for rich consumers (React components, HTML renderers) */
  structured: {
    solutionPlays: SolutionPlaySnapshot[]
  }
}
