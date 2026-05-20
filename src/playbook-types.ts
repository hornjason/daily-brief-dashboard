/**
 * Playbook Types — ADR-026
 *
 * TypeScript interfaces for the Customer Engagement Playbook state file.
 * The playbook is a persistent, per-customer JSON file that accumulates
 * intelligence over time through auto-generation and meeting note ingestion.
 *
 * Gemini generates narrative sections; deterministic data (subscriptions,
 * cases, lifecycle, team) is injected post-Gemini and never LLM-generated.
 */

import type { AccountTeamMember } from './types.ts'
import type { QualityScorecard } from './gemini-quality-gate.ts'

// ── Core State ──────────────────────────────────────────────────────────────

export interface PlaybookState {
  version: 1                           // Schema version for future migration
  customerSlug: string
  customerName: string
  generatedAt: string                  // ISO 8601
  lastMeetingNoteAt: string | null     // ISO 8601 — when notes last ingested
  qualityScorecard?: QualityScorecard  // From ADR-024 quality gate

  sections: {
    strategicPosition: PlaybookSection
    keyRelationships: PlaybookSection
    currentPriorities: PlaybookSection
    productAlignment: ProductAlignmentSection  // One entry per product
    openActionItems: ActionItemsSection        // Tracked list
    engagementHistory: EngagementHistorySection // Append-only log
    expansionOpportunities: PlaybookSection
    renewalsAndRisk: PlaybookSection
    swotAnalysis: PlaybookSection
    meddpicc: MEDDPICCSection
  }

  // Deterministic data snapshots — injected post-Gemini, NOT LLM-generated
  deterministic: {
    subscriptions: SubscriptionSnapshot[]
    cases: CaseSnapshot[]
    lifecycle: LifecycleSnapshot[]
    teamMembers: AccountTeamMember[]
  }

  // Provenance: which sources contributed to the current state
  sources: PlaybookSource[]
}

// ── Section Types ───────────────────────────────────────────────────────────

export interface PlaybookSection {
  content: string           // Markdown — Gemini-generated narrative
  updatedAt: string         // ISO 8601
  sourceNotes: string[]     // Which meeting note IDs contributed
}

export interface ProductAlignmentEntry {
  productSlug: string
  displayName: string
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  useCase: string                   // Gemini narrative
  proofPoints: string               // From value maps — deterministic
  whatsNew: string                  // From product summaries — deterministic
  lifecycle: string                 // Version + EOL — deterministic
  featureTalkingPoints: string      // From customer product intel — deterministic
  dashboardLink: string             // /dashboard/products/:slug
}

export interface ProductAlignmentSection {
  products: ProductAlignmentEntry[]
  updatedAt: string
  sourceNotes: string[]
}

export interface ActionItem {
  id: string                         // nanoid
  text: string
  owner: string                      // From account team or meeting notes
  sourceNoteId: string | null        // Which meeting note created this
  createdAt: string
  completedAt: string | null
  status: 'open' | 'completed'
}

export interface ActionItemsSection {
  items: ActionItem[]
  updatedAt: string
}

export interface EngagementEntry {
  date: string
  type: 'meeting' | 'campaign' | 'decision' | 'note'
  summary: string                    // 1-2 sentence Gemini summary
  sourceNoteId: string | null
  attendees: string[]
}

export interface EngagementHistorySection {
  entries: EngagementEntry[]         // Append-only, newest first
  updatedAt: string
}

export interface MEDDPICCEntry {
  field: string                      // M, E, D1, D2, P, I, C1, C2
  displayName: string                // "Metrics", "Economic Buyer", etc.
  status: 'confirmed' | 'developing' | 'unknown'
  evidence: string                   // 1-2 sentence justification
  sourceNoteId: string | null
  updatedAt: string
}

export interface MEDDPICCSection {
  entries: MEDDPICCEntry[]
  qualificationScore: number         // 0-100
  updatedAt: string
  sourceNotes: string[]
}

// ── Provenance ──────────────────────────────────────────────────────────────

export interface PlaybookSource {
  type: 'auto-generate' | 'meeting-note' | 'manual-edit'
  sourceId: string                   // Google Doc ID for notes, 'auto' for generation
  ingestedAt: string
  sectionsUpdated: string[]          // Which sections this source touched
}

// ── Deterministic Snapshots ─────────────────────────────────────────────────

export interface SubscriptionSnapshot {
  sku: string
  productDescription: string
  quantity: number
  status: string
  startDate?: string
  endDate?: string
}

export interface CaseSnapshot {
  caseNumber: string
  summary: string
  status: string
  severity: string
  product?: string
  daysOpen: number
}

export interface LifecycleSnapshot {
  productSlug: string
  displayName: string
  currentVersion: string
  gaDate: string
  eolDate: string
  nextVersion?: string
  nextExpected?: string
}
