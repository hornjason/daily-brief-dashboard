/**
 * Playbook Section Tier Configuration — GitHub Issue #687
 *
 * Single source of truth for playbook section ordering and progressive disclosure.
 * Importable by both backend (src/) and frontend (dashboard/src/).
 *
 * Tier 1: Always visible — highest-value sections for quick scanning
 * Tier 2: Collapsed by default — strategic detail, expanded on demand
 * Tier 3: Collapsed, at bottom — reference data, rarely needed inline
 */

export type PlaybookTier = 1 | 2 | 3

export type PlaybookSectionKey =
  | 'expansionOpportunities'
  | 'openActionItems'
  | 'renewalsAndRisk'
  | 'solutionPlays'
  | 'currentPriorities'
  | 'strategicPosition'
  | 'keyRelationships'
  | 'productAlignment'
  | 'swotAnalysis'
  | 'meddpicc'
  | 'engagementHistory'
  | 'subscriptions'
  | 'cases'
  | 'lifecycle'
  | 'teamMembers'

export interface PlaybookTierEntry {
  key: PlaybookSectionKey
  tier: PlaybookTier
  /** Human-readable display title */
  title: string
}

/**
 * All 15 playbook sections, ordered by tier then by priority within each tier.
 * This array defines both the rendering order and the tier assignments.
 */
export const PLAYBOOK_SECTION_TIERS: PlaybookTierEntry[] = [
  // Tier 1 — always visible
  { key: 'expansionOpportunities', tier: 1, title: 'Expansion Opportunities' },
  { key: 'openActionItems',       tier: 1, title: 'Open Action Items' },
  { key: 'renewalsAndRisk',       tier: 1, title: 'Renewals and Risk' },
  { key: 'solutionPlays',         tier: 1, title: 'Solution Plays' },
  { key: 'currentPriorities',     tier: 1, title: 'Current Priorities' },

  // Tier 2 — collapsed by default
  { key: 'strategicPosition',     tier: 2, title: 'Strategic Position' },
  { key: 'keyRelationships',      tier: 2, title: 'Key Relationships' },
  { key: 'productAlignment',      tier: 2, title: 'Product Alignment' },
  { key: 'swotAnalysis',          tier: 2, title: 'SWOT Analysis' },
  { key: 'meddpicc',              tier: 2, title: 'MEDDPICC Qualification' },

  // Tier 3 — collapsed, at bottom
  { key: 'engagementHistory',     tier: 3, title: 'Engagement History' },
  { key: 'subscriptions',         tier: 3, title: 'Subscriptions' },
  { key: 'cases',                 tier: 3, title: 'Support Cases' },
  { key: 'lifecycle',             tier: 3, title: 'Product Lifecycle' },
  { key: 'teamMembers',           tier: 3, title: 'Account Team' },
]

/** All 15 section keys — derived from the tier config, not hardcoded separately */
export const ALL_PLAYBOOK_SECTION_KEYS: PlaybookSectionKey[] =
  PLAYBOOK_SECTION_TIERS.map(e => e.key)

/** Sections that are always expanded (Tier 1) */
export const TIER_1_KEYS: PlaybookSectionKey[] =
  PLAYBOOK_SECTION_TIERS.filter(e => e.tier === 1).map(e => e.key)

/** Sections collapsed by default (Tier 2) */
export const TIER_2_KEYS: PlaybookSectionKey[] =
  PLAYBOOK_SECTION_TIERS.filter(e => e.tier === 2).map(e => e.key)

/** Sections collapsed, at bottom (Tier 3) */
export const TIER_3_KEYS: PlaybookSectionKey[] =
  PLAYBOOK_SECTION_TIERS.filter(e => e.tier === 3).map(e => e.key)

/** Get tier for a section key */
export function getSectionTier(key: string): PlaybookTier | undefined {
  return PLAYBOOK_SECTION_TIERS.find(e => e.key === key)?.tier
}

/** Check if a section should be initially expanded */
export function isSectionExpanded(key: string): boolean {
  return getSectionTier(key) === 1
}
