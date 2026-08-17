import { callGemini } from '../gemini-call.ts'
import { parseSections } from '../modules/intelligence-module.ts'
import type { CustomerObjectiveProfile } from '../modules/intelligence-module.ts'
import type { Signal } from '../feature-module-registry.ts'

// ── Types ────────────────────────────────────────────────────────────────────

const VALID_ROLES = [
  'executive-sponsor',
  'technical-evaluator',
  'champion',
  'financial-gatekeeper',
  'practitioner',
] as const

export type BuyingCommitteeRole = typeof VALID_ROLES[number]

const VALID_ROLES_SET = new Set<string>(VALID_ROLES)

export interface PersonaBrief {
  role: BuyingCommitteeRole
  suggestedTitle: string
  why: string
  objectiveMatch: string
  peerProofCandidates: Array<{ company: string; outcome: string; relevance: string }>
  timingTrigger: string
  valueProposition: string
  featureKeys: string[]
  competitiveContext: string | null
  relationshipPath: string
  installedBase: string
  suppressTriggers: string[]
  confidence: { overall: 'HIGH' | 'MEDIUM' | 'LOW' }
}

export interface Pass0Result {
  selectedRoles: BuyingCommitteeRole[]
  briefs: PersonaBrief[]
  reasoning: string
  campaignTheme: string
}

export interface Pass0PromptInput {
  materialTitle: string
  materialContent: string
  campaignDirective?: string
  intelligenceText?: string
  accountPlanText?: string
  objectiveProfile?: CustomerObjectiveProfile
  subscriptionSignals?: Signal[]
  structuredPlays?: Array<{ name: string; parentTdp: string }>
  customerName: string
  featureKeys: string[]
}

// ── Gemini Schema ────────────────────────────────────────────────────────────

export const PASS0_PERSONA_SELECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    selectedRoles: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Selected buying committee roles',
    },
    briefs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          role: { type: 'STRING', description: 'Buying committee role enum value' },
          suggestedTitle: { type: 'STRING', description: 'Suggested job title (e.g. CIO, CFO)' },
          why: { type: 'STRING', description: 'Why this role is relevant to the campaign' },
          objectiveMatch: { type: 'STRING', description: 'How campaign aligns with this role objectives' },
          peerProofCandidates: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                company: { type: 'STRING' },
                outcome: { type: 'STRING' },
                relevance: { type: 'STRING' },
              },
              required: ['company', 'outcome', 'relevance'],
            },
          },
          timingTrigger: { type: 'STRING', description: 'Why now — timing context' },
          valueProposition: { type: 'STRING', description: 'Core value prop for this role' },
          featureKeys: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: '3 pre-selected feature keys from registry',
          },
          competitiveContext: {
            type: 'STRING',
            nullable: true,
            description: 'Competitive positioning context or null',
          },
          relationshipPath: { type: 'STRING', description: 'Path to engage this persona' },
          installedBase: { type: 'STRING', description: 'Existing products/deployments relevant' },
          suppressTriggers: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Reasons NOT to reach out',
          },
          confidence: {
            type: 'OBJECT',
            properties: {
              overall: { type: 'STRING', description: 'HIGH, MEDIUM, or LOW' },
            },
            required: ['overall'],
          },
        },
        required: [
          'role', 'suggestedTitle', 'why', 'objectiveMatch',
          'peerProofCandidates', 'timingTrigger', 'valueProposition',
          'featureKeys', 'competitiveContext', 'relationshipPath',
          'installedBase', 'suppressTriggers', 'confidence',
        ],
      },
    },
    reasoning: { type: 'STRING', description: 'Overall reasoning for role selection' },
    campaignTheme: { type: 'STRING', description: 'Derived campaign theme' },
  },
  required: ['selectedRoles', 'briefs', 'reasoning', 'campaignTheme'],
}

// ── System Prompt ────────────────────────────────────────────────────────────

const PASS0_SYSTEM_PROMPT = `You are a B2B buying committee analyst specializing in enterprise technology sales.

Your task: Given campaign material and customer intelligence, select 3-4 buying committee roles most relevant to this campaign and build a strategic brief for each.

## Buying Committee Roles

1. **Executive Sponsor** (executive-sponsor): CIO, CTO, VP Engineering, CEO — owns budget, sets strategic direction
2. **Technical Evaluator** (technical-evaluator): Solutions Architect, DevSecOps Lead, Platform Engineer — evaluates technical fit, runs POCs
3. **Champion** (champion): Director of IT, IT Manager, Director of Platform Eng — internal advocate, drives adoption
4. **Financial Gatekeeper** (financial-gatekeeper): CFO, VP Finance, Head of Procurement — controls budget approval
5. **Practitioner** (practitioner): DevOps Engineer, SRE, Developer — daily user, influences bottom-up adoption

## Selection Rules

- Select 3-4 roles. Omit a role ONLY when the campaign theme has zero relevance to that role's concerns.
- For each selected role, build ALL 12 brief fields.
- Feature keys MUST come from the provided feature registry list — do not invent keys.
- Suppress triggers: reasons NOT to reach out (active competitor RFP, recent escalation, departed executive).
- Confidence levels: HIGH = data from intelligence + subscriptions, MEDIUM = inferred from signals, LOW = generic/assumed.
- Peer proof candidates: suggest companies/outcomes from intelligence that could serve as social proof for this role.

Return structured JSON matching the schema exactly.`

// ── Prompt Builder ───────────────────────────────────────────────────────────

const INTELLIGENCE_SECTIONS = ['Executive Summary', 'Leadership', 'Strategic Initiatives', 'Financial']
const ACCOUNT_PLAN_SECTIONS = ['Key Stakeholders', 'Initiatives', 'Whitespace', 'Scorecard']

function extractRelevantSections(text: string, targetSections: string[], heading: string): string {
  const sections = parseSections(text)
  const entries = Object.entries(sections)
  const relevant = targetSections
    .map(s => entries.find(([k]) => k.toLowerCase().includes(s.toLowerCase())))
    .filter((m): m is [string, string] => m !== undefined)
    .map(([name, content]) => `### ${name}\n${content.trim().substring(0, 500)}`)
  return relevant.length > 0 ? `\n## ${heading}\n${relevant.join('\n\n')}` : ''
}

export function formatBriefsForPrompt(briefs: PersonaBrief[]): string {
  if (briefs.length === 0) return ''
  const briefSection = briefs.map(b =>
    `### ${b.role} (${b.suggestedTitle})\n` +
    `Why: ${b.why}\n` +
    `Value prop: ${b.valueProposition}\n` +
    `Objective: ${b.objectiveMatch}\n` +
    `Feature keys: ${b.featureKeys.join(', ')}\n` +
    (b.timingTrigger ? `Timing: ${b.timingTrigger}\n` : '') +
    (b.peerProofCandidates.length > 0 ? `Proof candidates: ${b.peerProofCandidates.map(p => `${p.company}: ${p.outcome}`).join('; ')}\n` : ''),
  ).join('\n')
  return `\n## PERSONA BRIEFS (constraints)\nUse these pre-selected personas. Select peer proofs from candidates. Use pre-selected feature keys.\n${briefSection}\n`
}

export function buildPass0Prompt(opts: Pass0PromptInput): string {
  const parts: string[] = []

  // Campaign Topic
  parts.push(`## Campaign Topic: ${opts.materialTitle}`)
  parts.push(opts.materialContent.substring(0, 2000))

  // Campaign Directive
  if (opts.campaignDirective) {
    parts.push(`\n## Campaign Directive\n${opts.campaignDirective}`)
  }

  // Customer Intelligence
  if (opts.intelligenceText) {
    const section = extractRelevantSections(opts.intelligenceText, INTELLIGENCE_SECTIONS, 'Customer Intelligence')
    if (section) parts.push(section)
  }

  // Account Plan
  if (opts.accountPlanText) {
    const section = extractRelevantSections(opts.accountPlanText, ACCOUNT_PLAN_SECTIONS, 'Account Plan')
    if (section) parts.push(section)
  }

  // Objective Profile
  if (opts.objectiveProfile) {
    const categories = Object.entries(opts.objectiveProfile)
      .filter(([k, v]) => k !== 'productFit' && Array.isArray(v) && v.length > 0)
      .map(([cat, entries]) =>
        `- ${cat}: ${(entries as Array<{ objective: string }>).map(e => e.objective).join('; ')}`,
      )
    if (categories.length > 0) {
      parts.push(`\n## Customer Objectives\n${categories.join('\n')}`)
    }
  }

  // Subscription Summary
  if (opts.subscriptionSignals && opts.subscriptionSignals.length > 0) {
    const subs = opts.subscriptionSignals
      .filter(s => s.metadata?.quantity && !s.headline?.toLowerCase().includes('eval'))
      .map(s => `- ${s.headline}${s.metadata?.quantity ? ` (qty: ${s.metadata.quantity})` : ''}`)
    if (subs.length > 0) {
      parts.push(`\n## Subscription Summary\n${subs.join('\n')}`)
    }
  }

  // Solution Plays
  if (opts.structuredPlays && opts.structuredPlays.length > 0) {
    const plays = opts.structuredPlays.map(sp => `- ${sp.name} (TDP: ${sp.parentTdp})`).join('\n')
    parts.push(`\n## Solution Plays\n${plays}`)
  }

  // Customer Name
  parts.push(`\n## Customer: ${opts.customerName}`)

  // Available Feature Keys
  parts.push(`\n## Available Feature Keys\nSelect exactly 3 per role from this list ONLY:\n${opts.featureKeys.join(', ')}`)

  return parts.join('\n')
}

// ── Gemini Call ──────────────────────────────────────────────────────────────

async function callGeminiForPass0(opts: Pass0PromptInput): Promise<Pass0Result | null> {
  const userPrompt = buildPass0Prompt(opts)

  const result = await callGemini(PASS0_SYSTEM_PROMPT, userPrompt, {
    callType: 'pass0-persona',
    customerName: opts.customerName,
    temperature: 0.15,
    responseSchema: PASS0_PERSONA_SELECTION_SCHEMA,
  })

  if (!result.text) return null

  const parsed: Pass0Result = JSON.parse(result.text)
  return validatePass0Result(parsed)
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validatePass0Result(result: Pass0Result): Pass0Result | null {
  if (!result.briefs || result.briefs.length < 3 || result.briefs.length > 5) {
    console.warn(`[pass0] Invalid brief count: ${result.briefs?.length ?? 0} (expected 3-5)`)
    return null
  }

  const roles = result.briefs.map(b => b.role)
  const uniqueRoles = new Set(roles)
  if (uniqueRoles.size !== roles.length) {
    console.warn(`[pass0] Duplicate roles detected: ${roles.join(', ')}`)
    return null
  }

  for (const role of roles) {
    if (!role || !VALID_ROLES_SET.has(role)) {
      console.warn(`[pass0] Invalid role: "${role}"`)
      return null
    }
  }

  for (const brief of result.briefs) {
    if (!brief.role || !brief.why || !brief.suggestedTitle || !brief.valueProposition) {
      console.warn(`[pass0] Missing required field in brief for ${brief.role || 'unknown'}`)
      return null
    }
  }

  return result
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function selectPersonas(opts: Pass0PromptInput): Promise<Pass0Result | null> {
  try {
    const result = await callGeminiForPass0(opts)
    return result
  } catch (e: any) {
    console.warn(`[pass0] Persona selection failed: ${e?.message}`)
    return null
  }
}
