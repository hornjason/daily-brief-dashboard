/**
 * Meeting Prep Service — Domain Logic for Meeting Prep Generation
 *
 * Pure business logic extracted from meeting-prep-routes.ts.
 * All Gemini prompts, signal processing, intelligence gathering,
 * attendee research, and meeting prep orchestration live here.
 *
 * Routes file (meeting-prep-routes.ts) is now a thin HTTP adapter.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { Readable } from 'stream'
import { google } from 'googleapis'
import { callGemini } from './gemini-call.ts'
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { meetingPrepValidator } from './quality-validators/meeting-prep-validator.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { toSlug } from './cache-layer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import { assembleMeetingPrep } from './calendar-extraction.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { getAccountTeam, toPromptContext } from './account-team.ts'
import { getValueMap } from './value-map-loader.ts'
import { fetchCases } from './redhat.ts'
import type { Customer, CalendarEvent, SupportCase, CustomerSubscription } from './types.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { readProductLifecycleCache } from './product-lifecycle.ts'
import { getAllProductSummaries } from './product-release-radar.ts'
import { getCachedCustomerProductIntel } from './customer-product-intel.ts'
import { getTdpByName, getSalesPlayByName } from './lib/saleshub-knowledge-loader.ts'
// expansion-opportunities removed from meeting prep (#426) — data feeds into enrichment context
import { runIntelligencePipeline, getJobStatus } from './account-intelligence.ts'
import { readCCSPCache } from './cache-layer.ts'
import { generateMeetingPrepHTML } from './meeting-prep-html-template.ts'
import { buildEnrichmentPromptContext, buildSalesAlignmentBlock } from './meeting-prep-enrichment.ts'
import { templateAll } from './lib/signal-templates.ts'
import { enrichMeetingSignals } from './lib/meeting-prep-signals.ts'
import { readPlaybook } from './playbook-generator.ts'
import { loadAndScoreTactics, formatScoredTacticsForPrompt, formatGraphDiffForPrompt } from './lib/meeting-prep-graph-integration.ts'
import { buildEvidenceBlocks, type EvidenceBlock } from './lib/evidence-block-builder.ts'
import { applyDeterministicOverrides } from './lib/deterministic-overrides.ts'
import { CACHE_DIR, DATA_CONFIG_DIR } from './lib/paths.ts'
import {
  extractActionItems,
  findPreviousPrepForSeries,
  buildCarryForwardContext,
  type PrepHistoryWithSeries,
} from './recurring-meeting-intel.ts'
import {
  filterForAudience,
  detectAudienceType,
  crossReferencePartnerCustomers,
  type AudienceType,
} from './lib/audience-filter.ts'
import { resolveAttendees, type AttendeeProfile } from './lib/attendee-profile-cache.ts'
import { computeEscalation, formatEscalationForPrompt } from './lib/carry-forward.ts'

// @consumer-contract v1.0

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_DIR = DATA_CONFIG_DIR

// ── Evidence Block Formatting (#643) ────────────────────────────────────────

/**
 * Format evidence blocks into structured text for the Gemini prompt.
 * Replaces raw enrichment context with actionable, structured data.
 */
function formatEvidenceBlocksForPrompt(blocks: EvidenceBlock[]): string {
  if (blocks.length === 0) return ''

  const sections: string[] = ['## Pre-Scored Evidence Blocks (use these to build Recommended Plays)']

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    sections.push(`### Play ${i + 1}: ${b.playName} (confidence: ${b.compositeScore.toFixed(2)})`)

    if (b.evidenceTrail.length > 0) {
      sections.push('**Evidence:**')
      for (const e of b.evidenceTrail) {
        sections.push(`- ${e.fact} — source: ${e.source}, ${e.recency}`)
      }
    }

    if (b.availableLevers.length > 0) {
      sections.push('**Available Levers:**')
      for (const l of b.availableLevers) {
        const expiry = l.validThrough ? ` (valid through ${l.validThrough})` : ''
        sections.push(`- [${l.name}](${l.url}) — ${l.description}${expiry}`)
      }
    }

    sections.push(`**Team Lead:** ${b.teamContext}`)
    sections.push(`**Proposed Ask:** ${b.proposedAsk}`)
    sections.push('')
  }

  return sections.join('\n')
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MeetingPrepRequest {
  meetingTitle: string
  meetingStart: string
  attendees: string[]
  attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }>
  recurringEventId?: string // #269: for series tracking
  audience?: AudienceType // #644: manual audience override
  context?: {
    objective?: string
    productFocus?: string[]
    notes?: string
    driveDocUrls?: string[]
  }
}

export interface MeetingPrepResult {
  docUrl: string
  title: string
  generatedAt: string
}

export interface PrepHistoryEntry {
  meetingTitle: string
  meetingStart: string
  docUrl: string
  title: string
  generatedAt: string
  customerName?: string
  recurringEventId?: string // #269: series tracking
  actionItems?: string[]    // #269: extracted for carry-forward
  docId?: string            // #641: Drive doc ID for update-in-place
  attendeeEmails?: string[] // #655: attendee emails for cross-ref resolution
  recommendedPlays?: Array<{  // #646: carry-forward escalation
    playName: string
    compositeScore: number
    firstRecommendedAt?: string
    evidenceSnapshot?: string[]  // #650: evidence facts at time of recommendation for delta diffing
  }>
}

interface PartnerConfig {
  name: string
  aliases: string[]
  domain: string
  partnershipLevel: string
  specializations: string[]
  geo: string
  country: string
  catalogUrl?: string
  sourceUrl?: string
}

interface ProductRoadmapEntry {
  product: string
  displayName: string
  nextVersion: string
  expectedDate: string
  highlights: string[]
  source: string
}

// ── ADR-040 Response Schemas ─────────────────────────────────────────────────

/**
 * 4-section response schema (used when evidence blocks are available).
 * Each field has descriptive annotations referencing the provided context.
 */
const MEETING_PREP_RESPONSE_SCHEMA_4S = {
  type: 'OBJECT',
  properties: {
    meetingObjective: {
      type: 'STRING',
      description: '2-3 sentences stating the recommended outcome for this meeting. Be specific — not "discuss renewal" but "secure commitment to upgrade 47 RHEL 7 subscriptions before EOS 2027-06-30". Must reference specific data from the provided context.',
    },
    whatChanged: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'Date of the change (from provided intelligence context)' },
          description: { type: 'STRING', description: 'What changed — must reference specific data from the provided context' },
        },
        required: ['date', 'description'],
      },
      description: 'Bulleted list of changes since last meeting or recent intelligence updates. Each item: date + what changed. Use ONLY data from the "What Changed Recently" section. If no changes exist in the provided data, return an empty array.',
    },
    recommendedPlays: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          assertion: { type: 'STRING', description: 'Bold assertion of what to push and why, naming the SSP/specialist from the provided account team context' },
          evidence: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: '2-3 bullets with specific data from the provided evidence blocks — case numbers, subscription counts, dollar amounts, dates. Never fabricate data points.',
          },
          levers: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING', description: 'Resource name from the evidence blocks' },
                url: { type: 'STRING', description: 'URL from the evidence blocks — must be copied exactly, never fabricated' },
              },
              required: ['name', 'url'],
            },
            description: 'Available levers from the evidence blocks, each as a clickable link',
          },
          ask: { type: 'STRING', description: 'Specific thing to request in this meeting — must be actionable and tied to the evidence' },
        },
        required: ['assertion', 'evidence', 'levers', 'ask'],
      },
      description: 'Top 2-3 plays from the provided evidence blocks. Each play must reference ONLY data from the evidence blocks section.',
    },
    openItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', description: 'Action item description from carry-forward or new items to track' },
          owner: { type: 'STRING', nullable: true, description: 'Owner name from the provided account team context. Set to null if unknown.' },
          dueDate: { type: 'STRING', nullable: true, description: 'Target date if specified in the provided context. Set to null if not available.' },
        },
        required: ['description'],
      },
      description: 'Carry-forward action items from previous meetings + new items to track. Use ONLY items from the provided context.',
    },
  },
  required: ['meetingObjective', 'whatChanged', 'recommendedPlays', 'openItems'],
}

/**
 * 7-section response schema (used when no evidence blocks — standard or playbook path).
 * Nullable fields allow Gemini to express "no data" instead of hallucinating.
 */
const MEETING_PREP_RESPONSE_SCHEMA_7S = {
  type: 'OBJECT',
  properties: {
    meetingObjective: {
      type: 'STRING',
      description: '2-3 lines: state the meeting purpose in context of the customer strategic position. Be specific about what needs to happen in THIS meeting. Reference specific data from the provided context.',
    },
    attendees: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Full name from the provided attendee research' },
          title: { type: 'STRING', nullable: true, description: 'Title from provided attendee research. Set to null if not found.' },
          insight: { type: 'STRING', description: 'One key insight from the provided attendee research or prior interactions. Must come from the provided context.' },
        },
        required: ['name', 'insight'],
      },
      description: 'One entry per person on the calendar invite ONLY — do NOT list the full account team. Use ONLY data from the attendee research section.',
    },
    recentInteractions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', description: 'Date of the interaction from the provided history' },
          summary: { type: 'STRING', description: 'What was discussed and decided — synthesized from the provided Recent Interactions context' },
          sourceUrl: { type: 'STRING', nullable: true, description: 'URL to source doc if referenced in provided context. Set to null if not available.' },
        },
        required: ['date', 'summary'],
      },
      description: '3-5 bullets synthesized from the provided Recent Interactions & History context. If recurring meeting, first item must be outstanding carry-forward items.',
    },
    valuePlay: {
      type: 'STRING',
      description: 'ONE paragraph, Command of the Message style. A teaching point tailored to THIS meeting attendees and agenda. Must reference specific data from provided context — products, quantities, renewal dates, case numbers. Never fabricate financial figures.',
    },
    salesAlignment: {
      type: 'STRING',
      nullable: true,
      description: 'Which Red Hat sales methodology this aligns to. Format: "[TDP Name] TDP > [Tactic Name] tactic | [Sales Play Name] play". Use ONLY plays from the provided Product & Market Intelligence or VERIFIED SOLUTION PLAYS. Set to null if no matching play exists in the provided data.',
    },
    discussionQuestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          attendeeName: { type: 'STRING', description: 'Name from the provided attendee list' },
          attendeeTitle: { type: 'STRING', nullable: true, description: 'Title from provided context. Set to null if not available.' },
          question: { type: 'STRING', description: 'Question text that advances the sale — discovers budget, timeline, decision criteria' },
          purpose: { type: 'STRING', description: 'Why this question matters, citing specific commercial data (subscription quantities, renewal dates, pipeline amounts) from the provided context. Never fabricate financial figures.' },
        },
        required: ['attendeeName', 'question', 'purpose'],
      },
      description: '5-7 questions. Each must name a specific attendee from the provided attendee list and weave commercial data from the provided context into the purpose.',
    },
    openItems: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', description: 'Active support case summary or urgent renewal detail from the provided context' },
          urgency: { type: 'STRING', nullable: true, description: 'Severity or timeline from the provided context. Set to null if not specified.' },
        },
        required: ['description'],
      },
      description: 'CONDITIONAL — only populate if there are active support cases or renewals within 90 days in the provided context. Set to null if nothing actionable.',
    },
    pipelineOpportunities: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Opportunity name from the provided pipeline data' },
          amount: { type: 'STRING', description: 'Dollar amount from the provided pipeline data — must match exactly, never round or fabricate' },
          closeDate: { type: 'STRING', description: 'Close date from the provided pipeline data' },
          stage: { type: 'STRING', nullable: true, description: 'Pipeline stage from provided data. Set to null if not specified.' },
          meetingRelevance: { type: 'STRING', description: 'How this meeting can advance this opportunity — tied to the meeting topic and attendees' },
        },
        required: ['name', 'amount', 'closeDate', 'meetingRelevance'],
      },
      description: 'ALL active pipeline opportunities from the provided pipeline data. Dollar amounts MUST match the provided data exactly.',
    },
    actionItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          phase: { type: 'STRING', description: 'Pre-meeting, During meeting, or Post-meeting' },
          owner: { type: 'STRING', description: 'Specific team member name from the provided account team context' },
          action: { type: 'STRING', description: 'Specific action tied to the meeting topic and provided context' },
          dueDate: { type: 'STRING', nullable: true, description: 'Target date or timeframe. Set to null if not time-bound.' },
        },
        required: ['phase', 'owner', 'action'],
      },
      description: 'Minimum 3 items with specific team member names from the provided account team context. Reference specific pipeline opportunities by name where relevant.',
    },
  },
  required: ['meetingObjective', 'attendees', 'recentInteractions', 'valuePlay', 'discussionQuestions', 'pipelineOpportunities', 'actionItems'],
}

// ── ADR-040 Grounding Rules Block ────────────────────────────────────────────

const GROUNDING_RULES_BLOCK = `
## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. Every claim, metric, dollar amount, date, and name MUST come from the provided context data.
2. If the context does not contain a specific data point for a field, set that field to null.
3. Never extrapolate, estimate, or generate plausible-sounding data that is not in the context.
4. When citing a customer win or peer metric, it MUST come from the VERIFIED SOLUTION PLAYS section. Use the EXACT company name and metric.
5. Generic peer references ("industry peers", "companies like yours", "similar organizations") are PROHIBITED. Either cite a named company from the solution plays data or set peerProof to null.
6. Pipeline dollar figures MUST match the amounts in the provided pipeline data. Do not round, estimate, or fabricate financial figures.
`

// ── ADR-040 Solution Plays Serializer ────────────────────────────────────────

function serializeVerifiedSolutionPlays(templateResult: { structured?: { solutionPlays?: any[] } }): string {
  const plays = templateResult.structured?.solutionPlays ?? []
  if (plays.length === 0) return ''

  let context = '\n## VERIFIED SOLUTION PLAYS (Source: SalesHub — cite these for peer proof, do not fabricate alternatives)\n\n'
  for (const play of plays) {
    context += `### Play: "${play.playName}"\n`
    context += `- TDP: ${play.tdp}\n`
    if (play.customerWins?.length) context += `- Customer Wins: ${JSON.stringify(play.customerWins)}\n`
    if (play.realWorldExamples?.length) context += `- Real-World Examples: ${JSON.stringify(play.realWorldExamples)}\n`
    if (play.extractedMetrics?.length) context += `- Verified Metrics: ${JSON.stringify(play.extractedMetrics)}\n`
    if (play.talkTrack) context += `- Talk Track: ${play.talkTrack.slice(0, 300)}\n`
    context += '\n'
  }
  return context
}

// ── ADR-040 JSON-to-Markdown Converters ──────────────────────────────────────

function convertMeetingPrep4SToMarkdown(parsed: any, header: string): string {
  const lines: string[] = [header, '']

  // Section 1: Meeting Objective
  lines.push('### 1. Meeting Objective')
  lines.push(parsed.meetingObjective ?? 'No objective provided')
  lines.push('')

  // Section 2: What Changed
  lines.push('### 2. What Changed')
  const changes = parsed.whatChanged ?? []
  if (changes.length === 0) {
    lines.push('No significant changes since last interaction.')
  } else {
    for (const c of changes) {
      lines.push(`- ${c.date}: ${c.description}`)
    }
  }
  lines.push('')

  // Section 3: Recommended Plays
  lines.push('### 3. Recommended Plays')
  for (const play of parsed.recommendedPlays ?? []) {
    lines.push(`**${play.assertion}**`)
    for (const e of play.evidence ?? []) {
      lines.push(`- Evidence: ${e}`)
    }
    const leverLinks = (play.levers ?? []).map((l: any) => `[${l.name}](${l.url})`).join(', ')
    if (leverLinks) lines.push(`- Levers: ${leverLinks}`)
    lines.push(`- **Ask:** ${play.ask}`)
    lines.push('')
  }

  // Section 4: Open Items
  lines.push('### 4. Open Items')
  const items = parsed.openItems ?? []
  if (items.length === 0) {
    lines.push('No outstanding items.')
  } else {
    for (const item of items) {
      const ownerPart = item.owner ? ` (${item.owner})` : ''
      const datePart = item.dueDate ? ` — by ${item.dueDate}` : ''
      lines.push(`- ${item.description}${ownerPart}${datePart}`)
    }
  }
  lines.push('')

  return lines.join('\n')
}

function convertMeetingPrep7SToMarkdown(parsed: any, header: string, isRecurring: boolean): string {
  const lines: string[] = [header, '']

  if (isRecurring) {
    lines.push('*Recurring meeting — outstanding items carried forward in Recent Interactions*')
    lines.push('')
  }

  // Section 1: Meeting Objective
  lines.push('### 1. Meeting Objective')
  lines.push(parsed.meetingObjective ?? 'No objective provided')
  lines.push('')

  // Section 2: Who's in the Room
  lines.push("### 2. Who's in the Room")
  for (const a of parsed.attendees ?? []) {
    const titlePart = a.title ? `, ${a.title}` : ''
    lines.push(`- **${a.name}**${titlePart} — ${a.insight}`)
  }
  lines.push('')

  // Section 3: Recent Interactions
  lines.push('### 3. Recent Interactions')
  for (const ri of parsed.recentInteractions ?? []) {
    const urlPart = ri.sourceUrl ? ` [source](${ri.sourceUrl})` : ''
    lines.push(`- ${ri.date}: ${ri.summary}${urlPart}`)
  }
  lines.push('')

  // Section 4: Value Play
  lines.push('### 4. Value Play')
  lines.push(parsed.valuePlay ?? 'No value play generated')
  lines.push('')
  if (parsed.salesAlignment) {
    lines.push(`> **Aligned to:** ${parsed.salesAlignment}`)
    lines.push('')
  }

  // Section 5: Discussion Questions
  lines.push('### 5. Discussion Questions')
  for (const q of parsed.discussionQuestions ?? []) {
    const titlePart = q.attendeeTitle ? ` (${q.attendeeTitle})` : ''
    lines.push(`- **${q.attendeeName}${titlePart}:** ${q.question} — PURPOSE: ${q.purpose}`)
  }
  lines.push('')

  // Section 6: Open Items (conditional)
  if (parsed.openItems && parsed.openItems.length > 0) {
    lines.push('### 6. Open Items')
    for (const oi of parsed.openItems) {
      const urgencyPart = oi.urgency ? ` (${oi.urgency})` : ''
      lines.push(`- ${oi.description}${urgencyPart}`)
    }
    lines.push('')
  }

  // Section 7: Pipeline Opportunities
  lines.push('### 7. Pipeline Opportunities')
  for (const po of parsed.pipelineOpportunities ?? []) {
    const stagePart = po.stage ? `, ${po.stage}` : ''
    lines.push(`- **${po.name}:** ${po.amount}, closing ${po.closeDate}${stagePart} — ${po.meetingRelevance}`)
  }
  lines.push('')

  // Section 8: Action Items
  lines.push('### 8. Action Items')
  for (const ai of parsed.actionItems ?? []) {
    const datePart = ai.dueDate ? ` (by ${ai.dueDate})` : ''
    lines.push(`- **${ai.phase}:** ${ai.owner} — ${ai.action}${datePart}`)
  }
  lines.push('')

  return lines.join('\n')
}

// ── Partner & Product Config Loaders ──────────────────────────────────────────

function loadProductRoadmap(): ProductRoadmapEntry[] {
  const roadmapPath = resolve(CONFIG_DIR, 'product-roadmap.json')
  if (!existsSync(roadmapPath)) return []
  try {
    const data = JSON.parse(readFileSync(roadmapPath, 'utf-8'))
    return data.releases ?? []
  } catch { return [] }
}

function loadPartnerConfig(): PartnerConfig[] {
  const configPath = resolve(CONFIG_DIR, 'partners.json')
  if (!existsSync(configPath)) return []
  try { return JSON.parse(readFileSync(configPath, 'utf-8')) } catch { return [] }
}

function findPartner(domain: string, partners: PartnerConfig[]): PartnerConfig | undefined {
  return partners.find(p => domain.endsWith(p.domain) || p.aliases.some(a => domain.includes(a.toLowerCase())))
}

// ── RSS Feed Loading ──────────────────────────────────────────────────────────

function loadRSSFeedItems(): Array<{ title: string; link: string; pubDate: string; source: string; productTags: string[] }> {
  const rssPath = resolve(CACHE_DIR, 'rss', 'rh-feeds.json')
  if (!existsSync(rssPath)) return []
  try {
    const cache = JSON.parse(readFileSync(rssPath, 'utf-8'))
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    return (cache.items ?? []).filter((item: any) =>
      new Date(item.pubDate).getTime() >= thirtyDaysAgo
    )
  } catch { return [] }
}

// ── Cache Helpers ─────────────────────────────────────────────────────────────

export function getPrepCacheDir(slug: string): string {
  return resolve(CACHE_DIR, 'meeting-prep')
}

export function getHistoryPath(slug: string): string {
  return resolve(getPrepCacheDir(slug), `${slug}-history.json`)
}

export function readHistory(slug: string): PrepHistoryEntry[] {
  const path = getHistoryPath(slug)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
}

export function appendHistory(slug: string, entry: PrepHistoryEntry): void {
  const dir = getPrepCacheDir(slug)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const history = readHistory(slug)
  history.unshift(entry) // newest first
  writeJsonAtomic(getHistoryPath(slug), history)
}

// ── CCSP Context Builder ──────────────────────────────────────────────────────

export function buildCCSPContext(customer: Customer): string {
  const cache = readCCSPCache()
  if (!cache?.records?.length) return ''

  const customerRecords = cache.records.filter(r =>
    r.accountName?.toLowerCase() === customer.name.toLowerCase()
  )
  if (customerRecords.length === 0) return ''

  const clouds = [...new Set(customerRecords.map(r => r.cloudPartner).filter(Boolean))]
  const products = [...new Set(customerRecords.map(r => r.productOfferingGroup).filter(Boolean))]
  const totalACV = customerRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
  const quarters = [...new Set(customerRecords.map(r => r.quarter).filter(Boolean))].sort()

  const lines: string[] = []
  lines.push(`Cloud Platforms: ${clouds.join(', ') || 'Unknown'}`)
  lines.push(`Cloud Products: ${products.join(', ') || 'Not specified'}`)
  lines.push(`Total Cloud ACV: $${Math.round(totalACV).toLocaleString()}`)
  lines.push(`Data Period: ${quarters[0] ?? '?'} to ${quarters[quarters.length - 1] ?? '?'}`)

  // Break down by cloud partner
  for (const cloud of clouds) {
    const cloudRecords = customerRecords.filter(r => r.cloudPartner === cloud)
    const cloudACV = cloudRecords.reduce((s, r) => s + (r.acvPlus || 0), 0)
    const cloudProducts = [...new Set(cloudRecords.map(r => r.productOfferingGroup).filter(Boolean))]
    lines.push(`  ${cloud}: $${Math.round(cloudACV).toLocaleString()} — ${cloudProducts.join(', ') || 'unspecified products'}`)
  }

  return lines.join('\n')
}

// ── Attendee & Partner Detection ──────────────────────────────────────────────

// Imported from lib/domain-detection.ts (#651)
import { deriveCompanyFromDomain } from './lib/domain-detection.ts'
// Re-exported for backward compat
export { deriveCompanyFromDomain }

export function getAttendeeDisplayName(meeting: { attendees: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> }, email: string): string {
  const detail = (meeting.attendeeDetails ?? []).find(d => d.email === email)
  if (detail?.displayName) return detail.displayName
  // Derive from email: courtney.jimenez@insight.com → Courtney Jimenez
  const local = email.split('@')[0] ?? ''
  return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/**
 * Format attendee name with title and company from resolved profiles (#648).
 * Returns "Name, Title at Company" for resolved profiles, or
 * "email (profile not found)" for unresolved, falling back to display name.
 */
export function getEnrichedAttendeeName(
  email: string,
  meeting: { attendees: string[]; attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> },
  profiles: AttendeeProfile[],
): string {
  const profile = profiles.find(p => p.email === email)
  if (profile?.resolved && profile.title) {
    return `${profile.name}, ${profile.title} at ${profile.company}`
  }
  if (profile && !profile.resolved) {
    return `${profile.name} (profile not found)`
  }
  // Fallback to calendar display name
  return getAttendeeDisplayName(meeting, email)
}

// Imported from lib/domain-detection.ts (#651)
import { detectPartnerDomains } from './lib/domain-detection.ts'
// Re-exported for backward compat
export { detectPartnerDomains }

// ── Product Slug Inference ────────────────────────────────────────────────────

export function getCustomerProductSlugs(customer: Customer): string[] {
  const { readSheetCache } = require('./cache-layer.ts')
  const subCache = readSheetCache(customer.name)
  if (!subCache?.rows) return []
  try {
    const nameToSlug: Record<string, string> = {
      'openshift': 'ocp', 'rhel': 'rhel', 'enterprise linux': 'rhel',
      'ansible': 'aap', 'satellite': 'satellite', 'quay': 'quay',
      'openshift ai': 'rhoai', 'developer hub': 'rhdh',
      'advanced cluster security': 'acs', 'advanced cluster management': 'acm',
    }
    const slugs: string[] = []
    const productNames = [...new Set(subCache.rows.map((r: any) => r.productDescription ?? '').filter(Boolean))] as string[]
    for (const name of productNames) {
      const lower = name.toLowerCase()
      for (const [key, val] of Object.entries(nameToSlug)) {
        if (lower.includes(key)) { slugs.push(val); break }
      }
    }
    return [...new Set(slugs)]
  } catch { return [] }
}

// ── Value Map Context Builder ─────────────────────────────────────────────────

export function buildValueMapContext(customer: Customer): string {
  const { readSheetCache } = require('./cache-layer.ts')
  const subCache = readSheetCache(customer.name)

  let productSlugs: string[] = []

  if (subCache?.rows) {
    try {
      // Extract product slugs from subscription data
      const productNames = [...new Set(
        subCache.rows.map((r: any) => r.productDescription ?? '').filter(Boolean)
      )] as string[]

      // Map product names to slugs
      const nameToSlug: Record<string, string> = {
        'openshift': 'ocp',
        'rhel': 'rhel',
        'enterprise linux': 'rhel',
        'ansible': 'aap',
        'satellite': 'satellite',
        'quay': 'quay',
        'openshift ai': 'rhoai',
        'developer hub': 'rhdh',
        'advanced cluster security': 'acs',
        'advanced cluster management': 'acm',
      }

      for (const name of productNames) {
        const lower = name.toLowerCase()
        for (const [key, val] of Object.entries(nameToSlug)) {
          if (lower.includes(key)) {
            productSlugs.push(val)
            break
          }
        }
      }
    } catch { /* no subscription data */ }
  }

  // If no subscriptions found, don't filter — but log a warning
  if (productSlugs.length === 0) {
    console.warn(`[meeting-prep] No subscription data found for ${customer.name} — showing all products`)
  }

  const sections: string[] = []
  for (const ps of [...new Set(productSlugs)]) {
    const valueMap = getValueMap(ps)
    if (valueMap) {
      // Truncate to keep prompt reasonable
      sections.push(`### ${ps.toUpperCase()}\n${valueMap.slice(0, 2000)}`)
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : ''
}

// ── Intelligence Context Builder ──────────────────────────────────────────────

export function buildIntelligenceContext(slug: string): string {
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  if (!existsSync(intelPath)) return ''

  try {
    const intel = JSON.parse(readFileSync(intelPath, 'utf-8'))
    // Extract key sections from intelligence cache
    const parts: string[] = []

    // Cache uses 'company'/'industry' (current) or 'companyIntelligence'/'industryAnalysis' (legacy)
    const companyText = intel.company ?? intel.companyIntelligence
    if (companyText) {
      parts.push(typeof companyText === 'string'
        ? companyText.slice(0, 5000)
        : JSON.stringify(companyText).slice(0, 5000))
    }

    const industryText = intel.industry ?? intel.industryAnalysis
    if (industryText) {
      parts.push(typeof industryText === 'string'
        ? industryText.slice(0, 3000)
        : JSON.stringify(industryText).slice(0, 3000))
    }

    return parts.join('\n\n')
  } catch {
    return ''
  }
}

// ── Recent Interactions Context Builder (#426) ──────────────────────────────

/**
 * Synthesize recent interactions from:
 * 1. ALL prep history for the customer (not just recurring series)
 * 2. Drive docs context (passed in as string)
 * 3. Recurring carry-forward (if applicable — prepended as first bullet)
 *
 * Returns structured text for injection into Gemini prompt.
 */
export function buildRecentInteractionsContext(
  slug: string,
  carryForwardContext: string,
  driveDocsContext: string,
): string {
  const history = readHistory(slug)
  const parts: string[] = []

  // 1. Carry-forward from recurring meetings — becomes first bullet
  if (carryForwardContext) {
    parts.push(carryForwardContext)
  }

  // 2. Past prep history — ALL meetings for this customer, last 5
  if (history.length > 0) {
    const recentHistory = history.slice(0, 5)
    const historyLines = recentHistory.map(h => {
      const date = new Date(h.meetingStart).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      const actions = (h.actionItems ?? []).slice(0, 3)
      const actionSummary = actions.length > 0
        ? ` — Key items: ${actions.join('; ')}`
        : ''
      return `- ${date}: "${h.meetingTitle}"${actionSummary}${h.docUrl ? ` [doc](${h.docUrl})` : ''}`
    })
    parts.push(`## Past Meeting Prep History (last ${recentHistory.length})\n${historyLines.join('\n')}`)
  }

  // 3. Drive docs context
  if (driveDocsContext) {
    parts.push(driveDocsContext)
  }

  return parts.join('\n\n')
}

// ── Fallback Attendee Table ───────────────────────────────────────────────────

export function buildFallbackAttendeeTable(
  attendees: string[],
  prepData: any,
  meeting?: { attendeeDetails?: Array<{ email: string; displayName?: string; linkedinUrl?: string }> }
): string {
  if (attendees.length === 0) return 'No attendees listed'

  const rows = attendees.map(attendee => {
    const name = meeting ? getAttendeeDisplayName(meeting as any, attendee) : attendee
    const company = deriveCompanyFromDomain(attendee)
    const ctx = prepData?.attendeeContext?.find(
      (ac: any) => ac.name === attendee
    )
    const lastInteraction = ctx?.lastInteraction ?? 'Unknown'

    return `| ${name} | ${company} | Last interaction: ${lastInteraction} | — |`
  })

  return `| Name & Title | Company | Background | Engagement Angle |\n|------|------|-----------|------------------|\n${rows.join('\n')}`
}

// ── Meeting Prep Assembly (from calendar data) ────────────────────────────────

export async function assembleMeetingPrepForMeeting(
  customer: Customer,
  meeting: { meetingTitle: string; meetingStart: string; attendees: string[] }
) {
  // Import needed types
  const { readEmailCache, readSheetCache } = await import('./cache-layer.ts')
  const slug = toSlug(customer.name)

  // Read cached data
  const emails = readEmailCache(slug) ?? []
  const cases = await fetchCases({ includeAll: false }).catch(() => [])
  const customerCases = cases.filter((sc: SupportCase) =>
    (customer.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
  )

  // Read subscription cache (ProductSubscription from sheet cache)
  let subscriptions: CustomerSubscription[] = []
  try {
    const subCache = readSheetCache(customer.name)
    if (subCache?.rows) {
      // Map ProductSubscription to CustomerSubscription shape
      subscriptions = subCache.rows.map((r: any) => {
        const endDate = r.endDate ?? ''
        const daysLeft = endDate
          ? Math.ceil((new Date(endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : NaN
        return {
          subscriptionNumber: r.sku ?? '',
          productName: r.productDescription ?? '',
          quantity: r.quantity ?? 0,
          endDate,
          daysLeft,
          status: r.status ?? 'Active',
        } satisfies CustomerSubscription
      })
    }
  } catch { /* no subscriptions cached */ }

  // Build a synthetic CalendarEvent array with just this meeting
  const syntheticMeetings: CalendarEvent[] = [{
    title: meeting.meetingTitle,
    start: meeting.meetingStart,
    end: meeting.meetingStart, // Not critical for prep assembly
    attendees: meeting.attendees,
    needsPrep: true,
    customers: [customer.name],
  }]

  const preps = assembleMeetingPrep(syntheticMeetings, emails, customerCases, subscriptions)
  return preps[0] ?? null
}

// ── Recommended Play Extraction (#646) ──────────────────────────────────────

/**
 * Extract recommended plays from generated prep content for carry-forward tracking.
 * Looks for play/tactic headers in the Gemini output. When evidence blocks (#643) are
 * available, this function will receive them directly instead of parsing content.
 */
function extractRecommendedPlays(
  prepContent: string,
  recurringEventId?: string,
  customerSlug?: string,
): Array<{ playName: string; compositeScore: number; firstRecommendedAt?: string }> {
  const plays: Array<{ playName: string; compositeScore: number; firstRecommendedAt?: string }> = []

  // Extract play names from "### Play N: PlayName (confidence: 0.XX)" headers
  const playHeaderRegex = /###\s+Play\s+\d+:\s+(.+?)\s*\(confidence:\s*([\d.]+)\)/g
  let match
  while ((match = playHeaderRegex.exec(prepContent)) !== null) {
    plays.push({
      playName: match[1].trim(),
      compositeScore: parseFloat(match[2]) || 0,
    })
  }

  // Also try "### N. PlayName" pattern (7-section format Value Play references)
  if (plays.length === 0) {
    const altRegex = /###\s+\d+\.\s+(?:Value Play|Recommended Plays?):\s*(.+)/g
    while ((match = altRegex.exec(prepContent)) !== null) {
      plays.push({
        playName: match[1].trim(),
        compositeScore: 0.5, // default score for non-evidence-block format
      })
    }
  }

  // Resolve firstRecommendedAt from history if this is a recurring meeting
  if (recurringEventId && customerSlug) {
    const history = readHistory(customerSlug)
    for (const play of plays) {
      // Find the earliest history entry in this series that recommended this play
      const seriesEntries = history.filter(h => h.recurringEventId === recurringEventId)
      for (let i = seriesEntries.length - 1; i >= 0; i--) {
        const entry = seriesEntries[i]
        const prevPlay = (entry.recommendedPlays ?? []).find(p => p.playName === play.playName)
        if (prevPlay) {
          play.firstRecommendedAt = prevPlay.firstRecommendedAt ?? entry.generatedAt
          break
        }
      }
      // If no previous match, this is the first time — set to now
      if (!play.firstRecommendedAt) {
        play.firstRecommendedAt = new Date().toISOString()
      }
    }
  }

  return plays
}

// ── Core Generation Logic ─────────────────────────────────────────────────────

export async function generateMeetingPrep(
  customer: Customer,
  meeting: MeetingPrepRequest
): Promise<MeetingPrepResult> {
  const slug = toSlug(customer.name)
  const meetingDate = new Date(meeting.meetingStart)
  const dateStr = meetingDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  console.log(`[meeting-prep] Generating prep for ${customer.name} — "${meeting.meetingTitle}" on ${dateStr}`)

  // ── Step 0: Pre-flight signal refresh (#285) ──────────────────────────
  await FeatureModuleRegistry.refreshStaleSignals(slug).catch(() => {})

  // ── Step 1: Gather all context in parallel ──────────────────────────────

  const [
    meetingPrepData,
    signalData,
    casesData,
  ] = await Promise.all([
    // assembleMeetingPrep for attendee context + health signals
    assembleMeetingPrepForMeeting(customer, meeting),
    // Customer signals (intelligence, product intel, etc.)
    loadCustomerSignals(slug, customer.name, { ensureFresh: true }).catch((e) => {
      console.warn(`[meeting-prep] Signal loading failed:`, e.message)
      return { signals: {}, registrySignals: [], loaded: [], missing: [] }
    }),
    // Support cases
    fetchCases({ includeAll: false }).catch(() => [] as SupportCase[]),
  ])

  // Account team
  const accountTeam = getAccountTeam(customer)
  const teamContext = toPromptContext(accountTeam)

  // Account plan from signal loader (existing cached data from Drive)
  const accountPlanContext = (signalData.signals as any)?.accountPlan
    ? (typeof (signalData.signals as any).accountPlan === 'string'
        ? (signalData.signals as any).accountPlan.slice(0, 4000)
        : '')
    : ''

  // Intelligence cache — generate on-the-fly if missing, then poll until complete
  let intelligenceContext = buildIntelligenceContext(slug)
  if (!intelligenceContext) {
    console.log(`[meeting-prep] Intelligence missing for ${customer.name} — generating on the fly...`)
    try {
      runIntelligencePipeline(customer.name, true)
      // Poll for completion (pipeline is fire-and-forget internally)
      const maxWaitMs = 120_000
      const pollIntervalMs = 3_000
      const startTime = Date.now()
      while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs))
        const job = getJobStatus(customer.name)
        if (job?.status === 'complete' || job?.status === 'complete_no_drive_folder' || job?.status === 'error') break
      }
      intelligenceContext = buildIntelligenceContext(slug)
      console.log(`[meeting-prep] Intelligence generated for ${customer.name} (${intelligenceContext.length} chars)`)
    } catch (e: any) {
      console.warn(`[meeting-prep] Intelligence generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // ── Step 1a: Load intelligence graph and score tactics (#642) ─────────
  const graphScoring = loadAndScoreTactics(slug)
  if (graphScoring.graphLoaded) {
    console.log(`[meeting-prep] Intelligence graph loaded for ${customer.name} — ${graphScoring.scoredTactics.length} tactics scored`)
  } else {
    console.log(`[meeting-prep] No intelligence graph for ${customer.name} — falling back to enrichment context`)
  }

  // ── Step 1b: Recurring meeting carry-forward (#269) ────────────────────
  let carryForwardContext = ''
  const isRecurring = !!meeting.recurringEventId
  if (isRecurring) {
    console.log(`[meeting-prep] Recurring meeting detected (series: ${meeting.recurringEventId})`)
    const history = readHistory(slug) as PrepHistoryWithSeries[]
    const previousPrep = findPreviousPrepForSeries(
      meeting.recurringEventId!,
      meeting.meetingStart,
      history
    )

    if (previousPrep) {
      // Try to read the cached content for action item extraction
      const contentPath = resolve(CACHE_DIR, 'meeting-prep', `${slug}-latest.json`)
      let actionItems: string[] = previousPrep.actionItems ?? []

      if (actionItems.length === 0 && existsSync(contentPath)) {
        try {
          const cached = JSON.parse(readFileSync(contentPath, 'utf-8'))
          if (cached.content) {
            actionItems = extractActionItems(cached.content)
          }
        } catch { /* no cached content */ }
      }

      carryForwardContext = buildCarryForwardContext(actionItems, previousPrep.meetingStart)
      if (carryForwardContext) {
        console.log(`[meeting-prep] Carry-forward: ${actionItems.length} action items from ${previousPrep.meetingStart}`)
      }
    }
  }

  // ── Step 1a-1: Carry-forward escalation (#646) ────────────────────────
  // Computed after generation, injected into the Gemini prompt as escalation context.
  // Escalation will be applied in the prompt injection below after evidence blocks are available.
  let escalationContext = ''

  // ── Step 1a-2: Scan customer Drive folder for recent docs (#269) ──────
  let driveDocsContext = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    // Find docs modified since last prep (or last 14 days)
    const lastPrepHistory = readHistory(slug)
    const lastPrepDate = lastPrepHistory[0]?.generatedAt
    const sinceDate = lastPrepDate
      ? new Date(lastPrepDate)
      : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    const recentDocs = await drive.files.list({
      q: `'${customerFolderId}' in parents and mimeType = 'application/vnd.google-apps.document' and modifiedTime > '${sinceDate.toISOString()}' and trashed = false`,
      fields: 'files(id,name,modifiedTime,webViewLink)',
      pageSize: 10,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const docs = recentDocs.data.files ?? []
    if (docs.length > 0) {
      // Extract text from recent docs (capped)
      const docTexts: string[] = []
      for (const doc of docs.slice(0, 5)) {
        try {
          const exported = await drive.files.export({
            fileId: doc.id!,
            mimeType: 'text/plain',
          })
          const text = typeof exported.data === 'string'
            ? exported.data.slice(0, 2000)
            : ''
          if (text) {
            docTexts.push(`### ${doc.name} (modified ${new Date(doc.modifiedTime!).toLocaleDateString()})\n${text}`)
          }
        } catch { /* skip unreadable docs */ }
      }
      if (docTexts.length > 0) {
        driveDocsContext = `## Account Notes & Recent Documents\nThe following documents were found in the customer's Drive folder, modified since the last prep:\n\n${docTexts.join('\n\n')}`
        console.log(`[meeting-prep] Drive scan: ${docTexts.length} recent docs found for ${customer.name}`)
      }
    }
  } catch (e: any) {
    console.warn(`[meeting-prep] Drive folder scan failed for ${customer.name}:`, e.message)
  }

  // ── Step 1b: Load additional data sources ──────────────────────────────

  // Determine product focus: explicit context > subscription data > inferred from objective
  let productSlugs = meeting.context?.productFocus?.length
    ? meeting.context.productFocus
    : getCustomerProductSlugs(customer)

  // ALWAYS check meeting context for additional product mentions (#446)
  // Even when subscriptions provide slugs, the meeting may be about a product not yet subscribed
  {
    const contextText = [meeting.meetingTitle, meeting.context?.objective, meeting.context?.notes].filter(Boolean).join(' ').toLowerCase()
    const keywordToSlug: Record<string, string> = {
      'openshift': 'ocp', 'ocp': 'ocp', 'kubernetes': 'ocp', 'k8s': 'ocp', 'container': 'ocp',
      'ansible': 'aap', 'aap': 'aap', 'automation': 'aap', 'playbook': 'aap', 'lightspeed': 'aap',
      'rhel': 'rhel', 'enterprise linux': 'rhel', 'linux': 'rhel',
      'satellite': 'satellite', 'quay': 'quay',
      'openshift ai': 'rhoai', 'rhoai': 'rhoai', 'ai platform': 'rhoai',
      'virtualization': 'ocp-virt', 'virt': 'ocp-virt', 'vmware': 'ocp-virt',
      'acs': 'acs', 'advanced cluster security': 'acs',
      'acm': 'acm', 'advanced cluster management': 'acm',
    }
    const added: string[] = []
    for (const [keyword, slug] of Object.entries(keywordToSlug)) {
      if (contextText.includes(keyword) && !productSlugs.includes(slug)) {
        productSlugs.push(slug)
        added.push(slug)
      }
    }
    if (added.length > 0) {
      console.log(`[meeting-prep] Added products from meeting context: ${added.join(', ')} (total: ${productSlugs.join(', ')})`)
    }
  }

  const lifecycleCache = readProductLifecycleCache()
  const productSummaries = getAllProductSummaries()
  const rssItems = loadRSSFeedItems()

  // Internal roadmap data (manually maintained release dates)
  const roadmapData = loadProductRoadmap()

  // Filter RSS to relevant products
  const relevantRSS = rssItems
    .filter(item => productSlugs.length === 0 || (item.productTags ?? []).some(tag => productSlugs.includes(tag.toLowerCase())))
    .slice(0, 10)

  // ── Step 2: Resolve attendees via profile cache (#645) ───────────────────

  const attendeeEmails = meeting.attendees.filter(e => !e.endsWith('@redhat.com'))
  const { partnerDomains, customerDomains } = detectPartnerDomains(meeting.attendees, customer)

  // Load partner config and match detected domains
  const partnerConfigs = loadPartnerConfig()
  const detectedPartners: PartnerConfig[] = []
  for (const pd of partnerDomains) {
    const match = findPartner(pd, partnerConfigs)
    if (match) detectedPartners.push(match)
  }

  let attendeeResearch = ''
  let partnerResearch = ''
  let otherPartnersTable = ''
  let resolvedProfiles: AttendeeProfile[] = []

  // Build calendar display name map from meeting data
  const calendarDisplayNames = new Map<string, string>()
  for (const email of attendeeEmails) {
    const displayName = getAttendeeDisplayName(meeting, email)
    if (displayName && displayName !== email) {
      calendarDisplayNames.set(email, displayName)
    }
  }

  // Load meeting history for cross-reference
  const meetingHistory = readHistory(slug)

  // Resolve ALL attendees (customer + partner) via profile cache (#645)
  // AC-4: Partner attendees get full research — no skip
  try {
    resolvedProfiles = await resolveAttendees(
      attendeeEmails,
      customer.name,
      {
        calendarDisplayNames,
        meetingHistory,
        customerName: customer.name,
      }
    )

    // Get AE name for unresolved attendee messages
    const team = getAccountTeam(customer)
    const aeEntry = team.find(m => m.role === 'ae')
    const aeName = aeEntry?.name ?? 'your AE'

    // Format resolved profiles into attendee research output
    const profileLines = resolvedProfiles.map(profile => {
      if (profile.resolved) {
        const titlePart = profile.title ? `, ${profile.title}` : ''
        const linkedinPart = profile.linkedinUrl ? ` — [LinkedIn](${profile.linkedinUrl})` : ''
        return `- **${profile.name}**${titlePart} at ${profile.company}${linkedinPart}`
      } else {
        return `- **${profile.name}** at ${profile.company} — Profile not found — ask ${aeName} for context`
      }
    })

    attendeeResearch = profileLines.join('\n')
    console.log(`[meeting-prep] Resolved ${resolvedProfiles.filter(p => p.resolved).length}/${resolvedProfiles.length} attendee profiles for ${customer.name}`)
  } catch (e: any) {
    console.warn(`[meeting-prep] Attendee profile resolution failed:`, e.message)
    attendeeResearch = buildFallbackAttendeeTable(attendeeEmails, meetingPrepData, meeting)
  }

  // ── Step 2b: Partner context from config or grounding ────────────────────

  if (partnerDomains.length > 0) {
    if (detectedPartners.length > 0) {
      // Use config data — no Gemini call needed
      partnerResearch = detectedPartners.map(p =>
        `**${p.name}**\n- Partnership Level: ${p.partnershipLevel}\n- Specializations: ${p.specializations.join(', ')}\n- Geo: ${p.country}\n- Catalog: ${p.catalogUrl ?? 'N/A'}`
      ).join('\n\n')

      // Also find recommended partners for the product focus
      const specToProduct: Record<string, string[]> = {
        'Mission Critical Automation': ['aap'],
        'Container Mgmt': ['ocp'],
        'Application Platform': ['ocp', 'rhdh'],
        'Virtualization': ['ocp'],
        'Server Cloud': ['rhel'],
        'Server Cloud OS': ['rhel'],
      }
      const relevantPartners = partnerConfigs.filter(p =>
        !detectedPartners.includes(p) &&
        p.specializations.some(s => (specToProduct[s] ?? []).some(ps => productSlugs.includes(ps)))
      )
      if (relevantPartners.length > 0) {
        const partnerRows = relevantPartners.slice(0, 8).map(p => {
          const link = p.catalogUrl ? `[Catalog](${p.catalogUrl})` : (p.sourceUrl ? `[Profile](${p.sourceUrl})` : '—')
          return `| ${p.name} | ${p.specializations.join(', ')} | ${p.country || p.geo || '—'} | ${link} |`
        }).join('\n')
        otherPartnersTable = `\n\n**Other Certified Partners for These Products:**\n| Partner | Specializations | Region | Link |\n|---|---|---|---|\n${partnerRows}`
      }
    } else {
      // Unknown partner — single Gemini grounding search for the company
      try {
        const partnerResult = await callGemini(
          'You are a B2B sales intelligence researcher. Research this company and describe their business and any Red Hat partnership status. Be concise — 3-4 lines max.',
          `Research: ${partnerDomains.join(', ')} — what do they do? Are they a Red Hat partner?`,
          { callType: 'meeting-prep-partner-research', customerName: customer.name, grounding: true, timeoutMs: 30_000 }
        )
        partnerResearch = partnerResult.text
      } catch { partnerResearch = `Partner domains identified: ${partnerDomains.join(', ')}` }
    }
  }

  // ── Step 2c: Audience detection & filtering (#644) ────────────────────
  const audienceType: AudienceType = meeting.audience ?? detectAudienceType(meeting.attendees, customer)
  console.log(`[meeting-prep] Audience type: ${audienceType}${meeting.audience ? ' (manual override)' : ' (auto-detected)'}`)

  // For partner meetings, cross-reference partner specializations against all customers
  let partnerCrossRefContext = ''
  if (audienceType === 'partner' && partnerDomains.length > 0) {
    try {
      const { customers: allCustomers } = await import('./server-state.ts')
      const crossRefMatches = crossReferencePartnerCustomers(
        partnerDomains[0].split('.')[0], // use first partner domain slug
        allCustomers,
        (s) => {
          try {
            const { loadCustomerSignalsSync } = require('./lib/signal-loader.ts')
            return loadCustomerSignalsSync?.(s) ?? []
          } catch { return [] }
        }
      )
      if (crossRefMatches.length > 0) {
        partnerCrossRefContext = `## Partner Cross-Reference — Joint Opportunities\nCustomers aligned with this partner's specializations:\n${crossRefMatches.map(m =>
          `- **${m.customerName}**: ${m.matchedProducts.join(', ')}${m.pipelineSize ? ` (pipeline: $${m.pipelineSize.toLocaleString()})` : ''}\n  ${m.opportunityContext}`
        ).join('\n')}`
        console.log(`[meeting-prep] Partner cross-reference: ${crossRefMatches.length} customer matches`)
      }
    } catch (e: any) {
      console.warn(`[meeting-prep] Partner cross-reference failed:`, e?.message ?? e)
    }
  }

  // ── Step 2d: Build templateAll() context (PRINCIPLES.md Layer 3) ──────
  const meetingSignals = enrichMeetingSignals({
    customer,
    meeting: {
      meetingTitle: meeting.meetingTitle,
      meetingStart: meeting.meetingStart,
      attendees: meeting.attendees,
      attendeeDetails: meeting.attendeeDetails,
      recurringEventId: meeting.recurringEventId,
      objective: meeting.context?.objective,
      productFocus: meeting.context?.productFocus,
      notes: meeting.context?.notes,
    },
    attendeeResearch,
    partnerContext: partnerResearch,
    otherPartnersTable,
    detectedPartnerNames: detectedPartners.map(p => p.name),
    carryForwardContext,
    driveDocsContext,
  })

  // Merge meeting-specific signals with registry signals
  const rawSignals = [...(signalData.registrySignals ?? []), ...meetingSignals]

  // Audience filter (#644) is applied later to evidence blocks, not raw signals.
  // Raw signals pass through to templateAll() for deterministic sections.
  const allSignals = rawSignals

  // Call templateAll — PRINCIPLES.md Layer 3 compliance
  const templateResult = await templateAll(allSignals, accountTeam, {
    format: 'meeting-prep',
    productFilter: productSlugs.length > 0 ? productSlugs : undefined,
    customerSlug: slug,
  })

  // ── Step 2d: Build evidence blocks from scored tactics + signals (#643) ──
  const evidenceBlocks = graphScoring.graphLoaded
    ? buildEvidenceBlocks(graphScoring.scoredTactics, allSignals, accountTeam)
    : []
  // Apply audience filter (#644) to evidence blocks before Gemini
  const filteredEvidenceBlocks = filterForAudience(evidenceBlocks, audienceType)
  if (filteredEvidenceBlocks.length > 0) {
    console.log(`[meeting-prep] Built ${filteredEvidenceBlocks.length} evidence blocks (audience: ${audienceType}): ${filteredEvidenceBlocks.map(b => `${b.playName} (${b.compositeScore.toFixed(2)})`).join(', ')}`)
  }

  // ── Step 3: Filter cases to this customer ──────────────────────────────

  const customerCases = casesData.filter((sc) =>
    (customer.accountNumbers ?? []).map(String).includes(String(sc.accountNumber))
  )
  const caseSummary = customerCases.length > 0
    ? customerCases.map(sc => `- ${sc.summary} (Sev${sc.severity}, ${sc.status})`).join('\n')
    : 'No open support cases'

  // ── Step 3b: Compute carry-forward escalation (#646) ────────────────────
  if (isRecurring && meeting.recurringEventId) {
    const fullHistory = readHistory(slug)
    // Use real evidence blocks for escalation tracking (#647)
    const currentPlays = filteredEvidenceBlocks
    const escalations = computeEscalation(currentPlays, fullHistory, meeting.recurringEventId)
    escalationContext = formatEscalationForPrompt(escalations)
    if (escalationContext) {
      console.log(`[meeting-prep] Carry-forward escalation: ${escalations.size} plays escalated`)
    }
  }

  // ── Step 4: Check for existing playbook (ADR-026 derived view) ──────────
  const playbook = readPlaybook(slug)
  let prepContent: string
  let qualityScorecard: QualityScorecard | undefined

  if (playbook) {
    console.log(`[meeting-prep] Found playbook for ${customer.name} — generating derived meeting prep`)

    // Build attendee filter: match against key relationships and team members
    // Use enriched names with titles from resolved profiles (#648)
    const attendeeNames = meeting.attendees
      .filter(e => !e.endsWith('@redhat.com'))
      .map(email => getEnrichedAttendeeName(email, meeting, resolvedProfiles))

    // Extract relevant playbook sections
    const strategicPosition = playbook.sections.strategicPosition.content
    const currentPriorities = playbook.sections.currentPriorities.content
    const expansionOpps = playbook.sections.expansionOpportunities.content
    const renewalsRisk = playbook.sections.renewalsAndRisk.content

    // Filter key relationships by attendees in this meeting
    const keyRelationships = playbook.sections.keyRelationships.content
      .split('\n')
      .filter(line => {
        const lowerLine = line.toLowerCase()
        return attendeeNames.some(name => lowerLine.includes(name.toLowerCase()))
      })
      .join('\n')

    // Filter product alignment to products in focus
    const relevantProducts = playbook.sections.productAlignment.products
      .filter(p => productSlugs.length === 0 || productSlugs.includes(p.productSlug))
      .map(p => `**${p.displayName}**\n- Use Case: ${p.useCase}\n- Proof Points: ${p.proofPoints}\n- What's New: ${p.whatsNew}\n- Lifecycle: ${p.lifecycle}\n${p.featureTalkingPoints ? `- Feature Highlights: ${p.featureTalkingPoints}` : ''}`)
      .join('\n\n')

    // Get recent engagement history (last 5 entries)
    const recentEngagement = playbook.sections.engagementHistory.entries
      .slice(0, 5)
      .map(e => `- ${e.date}: ${e.summary}${e.attendees.length ? ` (${e.attendees.join(', ')})` : ''}`)
      .join('\n')

    // Filter open action items to those relevant for this meeting
    const openActions = playbook.sections.openActionItems.items
      .filter(item => item.status === 'open')
      .map(item => `- ${item.text} (Owner: ${item.owner})`)
      .join('\n')

    // ── Build enrichment context for prompt injection (#426, #642) ────
    // When intelligence graph is available, use scored tactics instead of raw enrichment
    const scoredTacticsBlock = formatScoredTacticsForPrompt(graphScoring.scoredTactics)
    const graphDiffBlock = formatGraphDiffForPrompt(graphScoring.graphDiff)
    const enrichmentContext = graphScoring.graphLoaded && scoredTacticsBlock
      ? scoredTacticsBlock
      : buildEnrichmentPromptContext(customer, productSlugs, {
          productSummaries, rssItems: relevantRSS, customerSlug: slug,
          getValueMapFn: getValueMap,
          getIntelFn: getCachedCustomerProductIntel,
          getSheetCacheFn: (name: string) => {
            try { return JSON.parse(readFileSync(resolve(CACHE_DIR, `${toSlug(name)}-sheets.json`), 'utf-8')) } catch { return null }
          },
          lifecycleCache, roadmapData,
        })

    // ── Build recent interactions context (#426) ──────────────────────
    const recentInteractionsContext = buildRecentInteractionsContext(slug, carryForwardContext, driveDocsContext)

    // ── Build evidence blocks context for prompt (#643) ────────────────
    const evidenceBlocksContext = formatEvidenceBlocksForPrompt(filteredEvidenceBlocks)

    // Build shorter, focused Gemini prompt using playbook intelligence
    // When evidence blocks are available, use the assertive 4-section format (#643)
    const derivedSystemPrompt = filteredEvidenceBlocks.length > 0
      ? `You are generating a focused Red Hat sales meeting prep document — 4 sections, scannable in 2 minutes. The intelligence graph has pre-scored and ranked tactical plays with evidence. Your job is to write assertive, actionable recommendations.
${GROUNDING_RULES_BLOCK}
VOICE RULES (CRITICAL):
- Assert recommendations with evidence. NEVER phrase as questions ("Have you considered..." or "It might be worth exploring..."). Instead: "Push X because Y evidence shows Z."
- Name people from account team by name and role in every recommendation.
- Connect every recommendation to financial impact — pipeline amounts, renewal dates, deal sizes, subscription counts.
- End each play with a concrete proposed ask — something specific to request in the meeting.
- Use ONLY data provided in the evidence blocks below — do not invent case numbers, dollar amounts, subscription counts, or person names.
- Render all resource links as clickable markdown links: [Name](URL)

FORMAT RULES:
- EXACTLY 4 sections: Meeting Objective, What Changed, Recommended Plays, Open Items
- NO markdown tables — all sections use bullets and narrative
- Bold assertions, bulleted evidence, clear visual hierarchy for scannability
- Each Recommended Play has: bold assertion, evidence trail bullets, available levers as links, proposed ask`
      : `You are generating a focused Red Hat sales meeting prep document — 7 sections, scannable in 3-5 minutes. The playbook has already synthesized customer context — your job is to craft a meeting-specific narrative that guides the account team through THIS specific meeting.
${GROUNDING_RULES_BLOCK}
FOCUS RULE (CRITICAL):
- The meeting goal/objective is the PRIMARY FILTER for all content. If the meeting is about an Ansible renewal, the Value Play, Discussion Questions, and Action Items must CENTER on Ansible — not spread across every product the customer has. Other products may appear as secondary context ONLY if directly relevant to the meeting topic.
- Include the specific subscription details for the product(s) relevant to the meeting goal: product name, quantity, expiration date, renewal opportunity ID, and current pricing/quote status.

FORMAT RULES:
- EXACTLY 8 numbered sections in this order: Meeting Objective, Who's in the Room, Recent Interactions, Value Play, Discussion Questions, Open Items (conditional), Pipeline Opportunities, Action Items
- NO markdown tables in ANY section — all sections use bullets and narrative
- Commercial data (subscriptions, renewals, pipeline, CCSP) must appear WITHIN discussion questions — no dedicated commercial section
- Value Play is ONE paragraph using Command of the Message style — a teaching point focused on the meeting's stated objective
- Discussion Questions must name specific attendees and include a PURPOSE for each question
- Open Items section: ONLY include if there are active cases or urgent renewals relevant to THIS meeting. If nothing actionable, OMIT the section entirely. Reference renewals by PRODUCT NAME and DOLLAR AMOUNT — never show bare opportunity IDs like "00567293".
- Action Items use bullets with phase markers (Pre-meeting/During/Post-meeting), specific names, and dates`

    // ── User prompt: evidence-block path (4-section) or legacy path (7-section) ──
    const derivedUserPrompt = filteredEvidenceBlocks.length > 0
      ? `Generate an assertive 4-section meeting prep using the evidence blocks below.

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeNames.join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT\n${meeting.context.notes}\n` : ''}

${evidenceBlocksContext}

${graphDiffBlock ? `## What Changed Recently\n${graphDiffBlock}` : ''}

## Customer Context (from playbook)
### Strategic Position
${strategicPosition}

### Current Priorities
${currentPriorities}

### Open Action Items
${openActions || 'No open action items'}

${recentInteractionsContext ? `## Recent Interactions & History\n${recentInteractionsContext}` : ''}

### Open Support Cases
${caseSummary}

${templateResult.deterministic ? `## Signal Intelligence\n${templateResult.deterministic}` : ''}

${serializeVerifiedSolutionPlays(templateResult)}

---

Respond with a JSON object matching the response schema. Populate all fields from the provided context data above. Set nullable fields to null when no data is available — never fabricate.`
      : `Generate a 7-section meeting prep for this specific meeting using the existing customer playbook:

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeNames.join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT\n${meeting.context.notes}\n` : ''}

## From Customer Playbook

### Strategic Position (established intelligence)
${strategicPosition}

### Current Priorities (from playbook)
${currentPriorities}

### Key Relationships (filtered to meeting attendees)
${keyRelationships || 'No key relationships match this meeting\'s attendees'}

### Product Alignment (products in focus for this meeting)
${relevantProducts || 'No product alignment data for meeting focus products'}

### Recent Engagement History
${recentEngagement || 'No recent engagement history'}

### Open Action Items (relevant to this meeting)
${openActions || 'No open action items'}

### Expansion Opportunities (from playbook)
${expansionOpps}

### Solution Plays (from playbook)
${(() => {
  const plays = playbook.deterministic?.solutionPlays ?? []
  return plays.length > 0
    ? plays.map((p: any) =>
        `- **${p.playName}** (${p.tdp}, ${p.confidence}): ${p.triggerTechnologies.join(', ')}${p.talkTrack ? `\n  Talk track: ${p.talkTrack.slice(0, 200)}` : ''}`
      ).join('\n')
    : 'No solution plays identified'
})()}

### Tactical Recommendations (from SalesHub knowledge)
${(() => {
  const plays = playbook.deterministic?.solutionPlays ?? []
  if (plays.length === 0) return 'No tactical recommendations — no solution plays matched'
  const recs: string[] = []
  for (const play of plays) {
    const tdpNode = getTdpByName(play.tdp)
    const salesPlay = getSalesPlayByName(play.playName)

    if (tdpNode?.whatToShow?.length) {
      recs.push(`**Recommended Demos (${play.tdp}):**`)
      for (const demo of tdpNode.whatToShow.slice(0, 3)) {
        recs.push(`- [${demo.name}](${demo.url}) — ${demo.type}`)
      }
    }

    const examples = (play as any).realWorldExamples ?? salesPlay?.realWorldExamples ?? []
    if (examples.length > 0) {
      recs.push(`**Reference Case Studies (${play.playName}):**`)
      for (const ex of examples.slice(0, 3)) {
        recs.push(`- ${ex.customer} — ${ex.outcome}`)
      }
    }

    if (tdpNode?.services?.length) {
      recs.push(`**Services to Propose (${play.tdp}):**`)
      for (const svc of tdpNode.services.slice(0, 3)) {
        recs.push(`- ${svc.name}: ${svc.description}`)
      }
    }
  }
  return recs.length > 0 ? recs.join('\n') : 'No tactical recommendations available for matched plays'
})()}

### Renewals & Risk (from playbook)
${renewalsRisk}

## Additional Context for This Meeting

### Meeting Attendees (full research)
${attendeeResearch || 'No attendee research available'}

### Open Support Cases
${caseSummary}

${templateResult.deterministic ? `### Signal Intelligence (from registry — includes ecosystem catalog, tech stack, cloud marketplace)\n${templateResult.deterministic}` : ''}

${filteredEvidenceBlocks.length === 0 && enrichmentContext ? `### ${graphScoring.graphLoaded && scoredTacticsBlock ? 'Scored Intelligence (pre-ranked by intelligence graph — use these to guide Value Play and Discussion Questions)' : 'Product & Market Intelligence (for contextual use in Discussion Questions and Value Play)'}\n${enrichmentContext}` : ''}

${graphDiffBlock ? `### ${graphDiffBlock}` : ''}

${recentInteractionsContext ? `### Recent Interactions & History\n${recentInteractionsContext}` : ''}

${partnerCrossRefContext ? `### Partner Cross-Reference\n${partnerCrossRefContext}` : ''}

${escalationContext ? `${escalationContext}` : ''}

${serializeVerifiedSolutionPlays(templateResult)}

---

**Audience: ${audienceType.toUpperCase()}**${audienceType === 'customer' ? ' — Do NOT include internal incentives, spiff data, or competitive intelligence.' : audienceType === 'partner' ? ' — Do NOT include internal incentives, spiff data, competitive intelligence, or specific pipeline dollar amounts.' : ''}

${isRecurring ? `This is a RECURRING meeting (series ID: ${meeting.recurringEventId}). Outstanding items from the last meeting are in Recent Interactions above — reference them in discussion questions and check their status.\n\n` : ''}Respond with a JSON object matching the response schema. Populate all fields from the provided context data above. Set nullable fields to null when no data is available — never fabricate.`

    // Shorter Gemini call — playbook is primary context
    // ADR-040: temperature 0.3, responseSchema for structured output, grounding rules in system prompt
    const derivedResponseSchema = filteredEvidenceBlocks.length > 0
      ? MEETING_PREP_RESPONSE_SCHEMA_4S
      : MEETING_PREP_RESPONSE_SCHEMA_7S
    const geminiResult = await callGemini(derivedSystemPrompt, derivedUserPrompt, {
      callType: 'meeting-prep-derived-from-playbook',
      customerName: customer.name,
      timeoutMs: 120_000,
      temperature: 0.3,
      responseSchema: derivedResponseSchema,
    })

    // ADR-040: Parse JSON response and convert to markdown
    const derivedHeader = `# Meeting Prep: ${customer.name} — ${meeting.meetingTitle}\n**${dateStr}** | Prepared for: ${accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team'}`
    let derivedMarkdown: string
    try {
      const parsed = JSON.parse(geminiResult.text)
      derivedMarkdown = filteredEvidenceBlocks.length > 0
        ? convertMeetingPrep4SToMarkdown(parsed, derivedHeader)
        : convertMeetingPrep7SToMarkdown(parsed, derivedHeader, isRecurring)
    } catch {
      console.warn('[meeting-prep] Failed to parse structured response from playbook path, using raw text')
      derivedMarkdown = geminiResult.text
    }

    // Quality gate (ADR-024) — validate and retry if below threshold
    const gateResult = await validateAndRetry(
      derivedMarkdown,
      { validator: meetingPrepValidator },
      async (failures) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await callGemini(
          derivedSystemPrompt,
          derivedUserPrompt + '\n\n' + feedback,
          {
            callType: 'meeting-prep-derived-from-playbook',
            customerName: customer.name,
            timeoutMs: 120_000,
            temperature: 0.3,
            responseSchema: derivedResponseSchema,
          }
        )
        // ADR-040: Parse retry JSON response
        try {
          const retryParsed = JSON.parse(retryResult.text)
          return filteredEvidenceBlocks.length > 0
            ? convertMeetingPrep4SToMarkdown(retryParsed, derivedHeader)
            : convertMeetingPrep7SToMarkdown(retryParsed, derivedHeader, isRecurring)
        } catch {
          return retryResult.text
        }
      }
    )
    prepContent = gateResult.output
    qualityScorecard = gateResult.scorecard
  } else {
    // ── No playbook: standard generation flow ──────────────────────────────
    console.log(`[meeting-prep] No playbook for ${customer.name} — using standard generation flow`)

    // ── Build enrichment context for prompt injection (#426, #642) ────
    // When intelligence graph is available, use scored tactics instead of raw enrichment
    const scoredTacticsBlock = formatScoredTacticsForPrompt(graphScoring.scoredTactics)
    const graphDiffBlock = formatGraphDiffForPrompt(graphScoring.graphDiff)
    const enrichmentContext = graphScoring.graphLoaded && scoredTacticsBlock
      ? scoredTacticsBlock
      : buildEnrichmentPromptContext(customer, productSlugs, {
          productSummaries, rssItems: relevantRSS, customerSlug: slug,
          getValueMapFn: getValueMap,
          getIntelFn: getCachedCustomerProductIntel,
          getSheetCacheFn: (name: string) => {
            try { return JSON.parse(readFileSync(resolve(CACHE_DIR, `${toSlug(name)}-sheets.json`), 'utf-8')) } catch { return null }
          },
          lifecycleCache, roadmapData,
        })

    // ── Build recent interactions context (#426) ──────────────────────
    const recentInteractionsContext = buildRecentInteractionsContext(slug, carryForwardContext, driveDocsContext)

    // ── Build evidence blocks context for standard path (#643) ────────
    const evidenceBlocksContextStd = formatEvidenceBlocksForPrompt(filteredEvidenceBlocks)

    const systemPrompt = filteredEvidenceBlocks.length > 0
      ? `You are generating a focused Red Hat sales meeting prep document — 4 sections, scannable in 2 minutes. The intelligence graph has pre-scored and ranked tactical plays with evidence. Your job is to write assertive, actionable recommendations.
${GROUNDING_RULES_BLOCK}
VOICE RULES (CRITICAL):
- Assert recommendations with evidence. NEVER phrase as questions ("Have you considered..." or "It might be worth exploring..."). Instead: "Push X because Y evidence shows Z."
- Name people from account team by name and role in every recommendation.
- Connect every recommendation to financial impact — pipeline amounts, renewal dates, deal sizes, subscription counts.
- End each play with a concrete proposed ask — something specific to request in the meeting.
- Use ONLY data provided in the evidence blocks below — do not invent case numbers, dollar amounts, subscription counts, or person names.
- Render all resource links as clickable markdown links: [Name](URL)

FORMAT RULES:
- EXACTLY 4 sections: Meeting Objective, What Changed, Recommended Plays, Open Items
- NO markdown tables — all sections use bullets and narrative
- Bold assertions, bulleted evidence, clear visual hierarchy for scannability
- Each Recommended Play has: bold assertion, evidence trail bullets, available levers as links, proposed ask`
      : `You are generating a Red Hat sales meeting prep document — 7 sections, scannable in 3-5 minutes. Every line must help the account team sell.
${GROUNDING_RULES_BLOCK}
FOCUS RULE (CRITICAL):
- The meeting goal/objective is the PRIMARY FILTER for all content. If the meeting is about an Ansible renewal, the Value Play, Discussion Questions, and Action Items must CENTER on Ansible — not spread across every product the customer has. Other products may appear as secondary context ONLY if directly relevant to the meeting topic.
- Include the specific subscription details for the product(s) relevant to the meeting goal: product name, quantity, expiration date, renewal opportunity ID, and current pricing/quote status.

FORMAT RULES:
- EXACTLY 8 numbered sections in this order: Meeting Objective, Who's in the Room, Recent Interactions, Value Play, Discussion Questions, Open Items (conditional), Pipeline Opportunities, Action Items
- NO markdown tables in ANY section — all sections use bullets and narrative
- Commercial data (subscriptions, renewals, pipeline, CCSP) must appear WITHIN discussion questions — no dedicated commercial section
- Value Play is ONE paragraph using Command of the Message style — a teaching point focused on the meeting's stated objective
- Discussion Questions must name specific attendees and include a PURPOSE for each question
- Open Items section: ONLY include if there are active cases or urgent renewals relevant to THIS meeting. If nothing actionable, OMIT the section entirely. Reference renewals by PRODUCT NAME and DOLLAR AMOUNT — never show bare opportunity IDs like "00567293".
- Action Items use bullets with phase markers (Pre-meeting/During/Post-meeting), specific names, and dates
- Every claim MUST cite specific customer data (goals, infrastructure, case numbers, renewal dates, subscription quantities)
- NO generic value statements. "Improves efficiency" is forbidden. Be specific.
- Only include products the customer subscribes to in the Value Play.`

    const userPrompt = filteredEvidenceBlocks.length > 0
      ? `Generate an assertive 4-section meeting prep using the evidence blocks below.

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeEmails.map(e => getEnrichedAttendeeName(e, meeting, resolvedProfiles)).join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT\n${meeting.context.notes}\n` : ''}

${evidenceBlocksContextStd}

${graphDiffBlock ? `## What Changed Recently\n${graphDiffBlock}` : ''}

## Deterministic Customer Intelligence (from signal registry)
${templateResult.deterministic || 'No signal data available'}

## Strategic Context (top signals for narrative synthesis)
${templateResult.narrativeContext || 'No signals available'}

## Open Support Cases
${caseSummary}

${recentInteractionsContext ? `## Recent Interactions & History\n${recentInteractionsContext}` : ''}

${serializeVerifiedSolutionPlays(templateResult)}

---

Respond with a JSON object matching the response schema. Populate all fields from the provided context data above. Set nullable fields to null when no data is available — never fabricate.`
      : `Generate a 7-section meeting prep for:

## Meeting Details
- Customer: ${customer.name}
- Meeting: ${meeting.meetingTitle}
- Date: ${dateStr}
- Attendees: ${attendeeEmails.map(e => getEnrichedAttendeeName(e, meeting, resolvedProfiles)).join(', ') || 'Not specified'}
${teamContext ? `\n${teamContext}` : ''}
${meeting.context?.objective ? `\n## MEETING OBJECTIVE (from account team — THIS IS THE #1 PRIORITY)\n${meeting.context.objective}\n` : ''}
${meeting.context?.notes ? `\n## ADDITIONAL CONTEXT (from account team)\n${meeting.context.notes}\n` : ''}
${meeting.context?.productFocus?.length ? `\n## PRODUCT FOCUS (account team specified)\nFocus ALL content on these products: ${meeting.context.productFocus.join(', ')}.\n` : ''}

## Deterministic Customer Intelligence (from signal registry)
${templateResult.deterministic || 'No signal data available'}

## Strategic Context (top signals for narrative synthesis)
${templateResult.narrativeContext || 'No signals available'}

${accountPlanContext ? `## Account Plan & Notes\n${accountPlanContext}` : ''}

## Attendee Research
${attendeeResearch || 'No attendee research available'}

## Open Support Cases
${caseSummary}

${filteredEvidenceBlocks.length === 0 && enrichmentContext ? `## ${graphScoring.graphLoaded && scoredTacticsBlock ? 'Scored Intelligence (pre-ranked by intelligence graph — use these to guide Value Play and Discussion Questions)' : 'Product & Market Intelligence (use contextually in Discussion Questions and Value Play)'}\n${enrichmentContext}` : ''}

${graphDiffBlock ? `## ${graphDiffBlock}` : ''}

${recentInteractionsContext ? `## Recent Interactions & History (synthesize into Section 3)\n${recentInteractionsContext}` : ''}

${escalationContext ? `${escalationContext}` : ''}

${partnerResearch ? `## Partner Context\n${partnerResearch}` : ''}

${partnerCrossRefContext}

${serializeVerifiedSolutionPlays(templateResult)}

---

**Audience: ${audienceType.toUpperCase()}**${audienceType === 'customer' ? ' — Do NOT include internal incentives, spiff data, or competitive intelligence.' : audienceType === 'partner' ? ' — Do NOT include internal incentives, spiff data, competitive intelligence, or specific pipeline dollar amounts.' : ''}

${isRecurring ? `This is a RECURRING meeting (series ID: ${meeting.recurringEventId}). Outstanding items are in Recent Interactions above — reference them in discussion questions and check their status.\n\n` : ''}Respond with a JSON object matching the response schema. Populate all fields from the provided context data above. Set nullable fields to null when no data is available — never fabricate.`

    // ADR-040: temperature 0.3, responseSchema for structured output, grounding rules in system prompt
    const standardResponseSchema = filteredEvidenceBlocks.length > 0
      ? MEETING_PREP_RESPONSE_SCHEMA_4S
      : MEETING_PREP_RESPONSE_SCHEMA_7S
    const geminiResult = await callGemini(systemPrompt, userPrompt, {
      callType: 'meeting-prep-synthesis',
      customerName: customer.name,
      timeoutMs: 120_000,
      temperature: 0.3,
      responseSchema: standardResponseSchema,
    })

    // ADR-040: Parse JSON response and convert to markdown
    const standardHeader = `# Meeting Prep: ${customer.name} — ${meeting.meetingTitle}\n**${dateStr}** | Prepared for: ${accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team'}`
    let standardMarkdown: string
    try {
      const parsed = JSON.parse(geminiResult.text)
      standardMarkdown = filteredEvidenceBlocks.length > 0
        ? convertMeetingPrep4SToMarkdown(parsed, standardHeader)
        : convertMeetingPrep7SToMarkdown(parsed, standardHeader, isRecurring)
    } catch {
      console.warn('[meeting-prep] Failed to parse structured response from standard path, using raw text')
      standardMarkdown = geminiResult.text
    }

    // Quality gate (ADR-024) — validate and retry if below threshold
    const gateResult = await validateAndRetry(
      standardMarkdown,
      { validator: meetingPrepValidator },
      async (failures) => {
        const feedback = formatFailureFeedback(failures)
        const retryResult = await callGemini(
          systemPrompt,
          userPrompt + '\n\n' + feedback,
          {
            callType: 'meeting-prep-synthesis',
            customerName: customer.name,
            timeoutMs: 120_000,
            temperature: 0.3,
            responseSchema: standardResponseSchema,
          }
        )
        // ADR-040: Parse retry JSON response
        try {
          const retryParsed = JSON.parse(retryResult.text)
          return filteredEvidenceBlocks.length > 0
            ? convertMeetingPrep4SToMarkdown(retryParsed, standardHeader)
            : convertMeetingPrep7SToMarkdown(retryParsed, standardHeader, isRecurring)
        } catch {
          return retryResult.text
        }
      }
    )
    prepContent = gateResult.output
    qualityScorecard = gateResult.scorecard
  }

  // ── Step 4b: Inject deterministic Sales Alignment block (#445) ─────────
  const salesAlignmentBlock = buildSalesAlignmentBlock(productSlugs, slug)
  if (salesAlignmentBlock) {
    // Insert after "### 4. Value Play" section, before "### 5. Discussion Questions"
    const section5Marker = '### 5.'
    const idx = prepContent.indexOf(section5Marker)
    if (idx !== -1) {
      prepContent = prepContent.slice(0, idx) + '\n' + salesAlignmentBlock + '\n\n' + prepContent.slice(idx)
      console.log(`[meeting-prep] Sales alignment block injected for ${customer.name}`)
    } else {
      // Fallback: append after the Value Play section by finding ### 5 pattern
      const altMarker = '### 5 '
      const altIdx = prepContent.indexOf(altMarker)
      if (altIdx !== -1) {
        prepContent = prepContent.slice(0, altIdx) + '\n' + salesAlignmentBlock + '\n\n' + prepContent.slice(altIdx)
        console.log(`[meeting-prep] Sales alignment block injected (alt marker) for ${customer.name}`)
      } else {
        // Last resort: append to end
        prepContent += '\n\n' + salesAlignmentBlock
        console.log(`[meeting-prep] Sales alignment block appended for ${customer.name} (no section 5 marker found)`)
      }
    }
  }

  // ── Steps 4c/4d/4f: Deterministic overrides (#657) ─────────────────────
  // Pipeline section, attendee list, and post-generation validation
  // extracted to src/lib/deterministic-overrides.ts
  const overrideResult = applyDeterministicOverrides({
    prepContent, signalData, meeting, accountTeam,
    resolvedProfiles, filteredEvidenceBlocks, templateResult,
    getAttendeeDisplayName, getEnrichedAttendeeName,
    customerName: customer.name,
  })
  prepContent = overrideResult.content

  // ── Step 5: Save to Google Drive as HTML-imported Google Doc ────────────

  let docUrl = ''
  let docId: string | undefined
  const docTitle = `Meeting Prep — ${meeting.meetingTitle} — ${meetingDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`

  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const prepFolderId = await driveClient.ensureChildFolder(customerFolderId, 'Meeting Prep')

    // Generate styled HTML from Gemini's markdown output
    const htmlContent = generateMeetingPrepHTML(prepContent, {
      customerName: customer.name,
      meetingTitle: meeting.meetingTitle,
      dateStr,
      preparedFor: accountTeam.find(m => m.role === 'ae')?.name || accountTeam[0]?.name || 'Account Team',
    })

    // #641: Update-in-place — preserve doc ID/URL across regenerations
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const DOC_MIME = 'application/vnd.google-apps.document'

    // Look up existing doc ID: first from history (reliable), then title match (fallback)
    const history = readHistory(slug)
    const historyMatch = history.find(h => h.docId && h.title === docTitle)
    let existingDocId = historyMatch?.docId ?? null

    if (!existingDocId) {
      // Fallback: search Drive by title in the prep folder
      const existing = await drive.files.list({
        q: `'${prepFolderId}' in parents and name = '${docTitle.replace(/'/g, "\\'")}' and mimeType = '${DOC_MIME}' and trashed = false`,
        fields: 'files(id)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      })
      existingDocId = existing.data.files?.[0]?.id ?? null
    }

    if (existingDocId) {
      // Update existing doc content in-place — same ID, same URL, same sharing
      await drive.files.update({
        fileId: existingDocId,
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      } as any)
      docId = existingDocId
      docUrl = historyMatch?.docUrl ?? `https://docs.google.com/document/d/${existingDocId}/edit`
      console.log(`[meeting-prep] Doc updated in-place: ${docUrl}`)
    } else {
      // First generation — create new doc
      const docResponse = await drive.files.create({
        requestBody: {
          name: docTitle,
          mimeType: DOC_MIME,
          parents: [prepFolderId],
        },
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      })
      docId = docResponse.data.id ?? undefined
      docUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${docId}/edit`
      console.log(`[meeting-prep] Doc created: ${docUrl}`)
    }
  } catch (e: any) {
    console.warn(`[meeting-prep] Drive doc save failed:`, e.message)
    // Continue without Drive doc — still return the generated content
    docUrl = ''
  }

  // ── Step 6: Cache the result ──────────────────────────────────────────────

  const generatedAt = new Date().toISOString()
  const generatedActionItems = extractActionItems(prepContent)

  // #646: Save recommended plays to history for carry-forward escalation
  // #650: Attach evidence snapshots for future delta diffing
  // #656: Use evidence blocks directly when available; fall back to regex extraction
  const recommendedPlays = (filteredEvidenceBlocks.length > 0
    ? filteredEvidenceBlocks.map(b => ({
        playName: b.playName,
        compositeScore: b.compositeScore,
        firstRecommendedAt: new Date().toISOString(),
      }))
    : extractRecommendedPlays(prepContent, meeting.recurringEventId, slug)
  ).map(play => {
      const block = filteredEvidenceBlocks.find(b => b.playName === play.playName)
      return {
        ...play,
        evidenceSnapshot: block?.evidenceTrail.map(e => e.fact),
      }
    })

  const entry: PrepHistoryEntry = {
    meetingTitle: meeting.meetingTitle,
    meetingStart: meeting.meetingStart,
    docUrl,
    title: docTitle,
    generatedAt,
    customerName: customer.name,
    recurringEventId: meeting.recurringEventId,
    actionItems: generatedActionItems.length > 0 ? generatedActionItems : undefined,
    docId,
    attendeeEmails: (meeting.attendees ?? []).filter(Boolean).length > 0 ? (meeting.attendees ?? []).filter(Boolean) : undefined, // #655: for cross-ref resolution
    recommendedPlays: recommendedPlays.length > 0 ? recommendedPlays : undefined,
  }

  appendHistory(slug, entry)

  // Also cache the full content for offline access
  const contentCacheDir = resolve(CACHE_DIR, 'meeting-prep')
  if (!existsSync(contentCacheDir)) mkdirSync(contentCacheDir, { recursive: true })
  const contentPath = resolve(contentCacheDir, `${slug}-latest.json`)
  writeJsonAtomic(contentPath, {
    ...entry,
    content: prepContent,
    qualityScorecard,
  })

  return { docUrl, title: docTitle, generatedAt }
}
