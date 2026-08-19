import { callGemini } from '../gemini-call.ts'
import { parseSections } from '../modules/intelligence-module.ts'
import type { CustomerObjectiveProfile } from '../modules/intelligence-module.ts'
import type { Signal } from '../feature-module-registry.ts'
import { getFeatureKeys } from './feature-url-registry.ts'
import { extractPeerProofsFromMaterial } from './source-material-parser.ts'

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
    timeoutMs: 90_000,
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

// ── Unified Selection Types (Phase 4a — ADR-046 §2 Change 1) ───────────────

export interface UnifiedPersona {
  // PersonaBrief fields (role-level)
  role: BuyingCommitteeRole
  suggestedTitle: string
  why: string
  objectiveMatch: string
  peerProofCandidates: Array<{ company: string; outcome: string; relevance: string }>
  timingTrigger: string
  valueProposition: string
  competitiveContext: string | null
  relationshipPath: string
  installedBase: string
  suppressTriggers: string[]
  confidence: { overall: 'HIGH' | 'MEDIUM' | 'LOW' }
  // CampaignSelection email fields (contact-level)
  recipientName: string
  tier: 'executive' | 'manager'
  intent: 'nurture' | 'expand' | 're-engage'
  subject: string
  signalIndex: number
  featureKeys: string[]
  peerProof: { playName: string; exampleIndex: number } | null
}

export interface UnifiedSelectionResult {
  campaignTheme: string
  campaignSummary: string
  customerContext: string
  positioning: string
  reasoning: string
  selectedRoles: BuyingCommitteeRole[]
  personas: UnifiedPersona[]
}

export interface UnifiedSelectionInput {
  materialTitle: string
  materialContent: string
  customerName: string
  campaignDirective?: string
  intelligenceText?: string
  accountPlanText?: string
  objectiveProfile?: CustomerObjectiveProfile
  subscriptionSignals?: Signal[]
  structuredPlays?: Array<{ name: string; parentTdp: string; customerWins?: string[]; realWorldExamples?: Array<{ customer: string; outcome: string }>; extractedMetrics?: Array<{ value: string; context: string }>; talkTrack?: string }>
  featureKeys: string[]
  registrySignals: Signal[]
  deterministicContext?: string
  resolvedContacts: Array<{ name: string; title: string; role: string }>
  preMatchedMetrics?: Array<{ recipientName: string; recipientTitle: string; entry: { objective: string }; category: string }>
  preMatchedPeerProofs?: Array<{ recipientName: string; proof: { customer: string; outcome: string } }>
}

// ── Unified Gemini Schema ───────────────────────────────────────────────────

export const UNIFIED_SELECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    campaignTheme: { type: 'STRING', description: 'Derived campaign theme from material analysis' },
    campaignSummary: { type: 'STRING', description: 'Campaign strategy overview grounded in loaded signals' },
    customerContext: { type: 'STRING', description: 'What is happening NOW with this customer' },
    positioning: { type: 'STRING', description: 'Red Hat value prop mapping with one Challenger Insight' },
    reasoning: { type: 'STRING', description: 'Overall reasoning for role selection and data choices' },
    selectedRoles: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Selected buying committee roles (3-5)',
    },
    personas: {
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
          recipientName: { type: 'STRING', description: 'MUST match exactly one resolved contact name' },
          tier: { type: 'STRING', enum: ['executive', 'manager'] },
          intent: { type: 'STRING', enum: ['nurture', 'expand', 're-engage'] },
          subject: { type: 'STRING', description: '2-4 word observation, no product/company names' },
          signalIndex: { type: 'INTEGER', description: 'Zero-based index into signals array' },
          featureKeys: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Exactly 3 keys from feature registry',
          },
          peerProof: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              playName: { type: 'STRING' },
              exampleIndex: { type: 'INTEGER' },
            },
          },
        },
        required: [
          'role', 'suggestedTitle', 'why', 'objectiveMatch',
          'peerProofCandidates', 'timingTrigger', 'valueProposition',
          'competitiveContext', 'relationshipPath', 'installedBase',
          'suppressTriggers', 'confidence',
          'recipientName', 'tier', 'intent', 'subject', 'signalIndex', 'featureKeys',
        ],
      },
    },
  },
  required: ['campaignTheme', 'campaignSummary', 'customerContext', 'positioning', 'reasoning', 'selectedRoles', 'personas'],
}

// ── Unified System Prompt ───────────────────────────────────────────────────

const UNIFIED_SELECTION_SYSTEM_PROMPT = `You are a B2B buying committee analyst AND data selector for enterprise technology email campaigns.

Your task has TWO parts in ONE response:
1. ANALYZE the campaign material and customer intelligence to select 3-5 buying committee roles
2. For EACH resolved contact, SELECT the data points (signal, features, peer proof) the template engine should use

## Buying Committee Roles

1. **Executive Sponsor** (executive-sponsor): CIO, CTO, VP Engineering, CEO — owns budget, sets strategic direction
2. **Technical Evaluator** (technical-evaluator): Solutions Architect, DevSecOps Lead, Platform Engineer — evaluates technical fit, runs POCs
3. **Champion** (champion): Director of IT, IT Manager, Director of Platform Eng — internal advocate, drives adoption
4. **Financial Gatekeeper** (financial-gatekeeper): CFO, VP Finance, Head of Procurement — controls budget approval
5. **Practitioner** (practitioner): DevOps Engineer, SRE, Developer — daily user, influences bottom-up adoption

## Part 1: Persona Analysis Rules

- Select 3-5 roles. For each, build ALL brief fields (why, objectiveMatch, peerProofCandidates, timingTrigger, valueProposition, etc.)
- Feature keys MUST come from the provided feature registry — do not invent keys
- Suppress triggers: reasons NOT to reach out (active competitor RFP, recent escalation, departed executive)
- Confidence levels: HIGH = data from intelligence + subscriptions, MEDIUM = inferred, LOW = generic/assumed
- Peer proof candidates: suggest companies/outcomes from intelligence for social proof

## Part 2: Data Selection Rules

For each resolved contact, select:
1. The most relevant signal (by index) from the loaded signals
2. Exactly 3 feature keys from the feature registry — each key must be different and relevant to the recipient's role
3. A peer proof reference (play name + example index) if available, otherwise null

GROUNDING RULES:
- recipientName MUST exactly match one resolved contact name
- featureKeys MUST be selected from the provided feature key list — no invented keys
- signalIndex MUST be a valid zero-based index into the signals array
- peerProof.playName MUST match a play from VERIFIED SOLUTION PLAYS — never invent
- You MUST generate one persona entry for EVERY resolved contact. Do NOT skip contacts.
- TIER DISTRIBUTION: C-level officers (CEO, CFO, CTO, CIO) and VPs are executive tier. Directors, Heads, and Sr. Managers are manager tier.

## Campaign-Level Fields

- campaignTheme: derived theme from material analysis
- campaignSummary: strategy overview grounded in loaded signals
- customerContext: what is happening NOW (recent case, renewal, meeting, signal)
- positioning: Red Hat value prop mapping with one Challenger Insight
- reasoning: overall reasoning for role selection

Return structured JSON matching the schema exactly.`

// ── Unified Prompt Builder ──────────────────────────────────────────────────

export function buildUnifiedSelectionPrompt(opts: UnifiedSelectionInput): string {
  const parts: string[] = []

  parts.push(`## Campaign Topic: ${opts.materialTitle}`)
  parts.push(opts.materialContent.substring(0, 8000))

  if (opts.campaignDirective) {
    parts.push(`\n## Campaign Directive\n${opts.campaignDirective}`)
  }

  if (opts.intelligenceText) {
    const section = extractRelevantSections(opts.intelligenceText, INTELLIGENCE_SECTIONS, 'Customer Intelligence')
    if (section) parts.push(section)
  }

  if (opts.accountPlanText) {
    const section = extractRelevantSections(opts.accountPlanText, ACCOUNT_PLAN_SECTIONS, 'Account Plan')
    if (section) parts.push(section)
  }

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

  if (opts.subscriptionSignals && opts.subscriptionSignals.length > 0) {
    const subs = opts.subscriptionSignals
      .filter(s => s.metadata?.quantity && !s.headline?.toLowerCase().includes('eval'))
      .map(s => `- ${s.headline}${s.metadata?.quantity ? ` (qty: ${s.metadata.quantity})` : ''}`)
    if (subs.length > 0) {
      parts.push(`\n## Subscription Summary\n${subs.join('\n')}`)
    }
  }

  if (opts.structuredPlays && opts.structuredPlays.length > 0) {
    let playsContext = '\n## VERIFIED SOLUTION PLAYS (cite by playName + exampleIndex)\n\n'
    const materialPeerProofs = extractPeerProofsFromMaterial(opts.materialContent)
    if (materialPeerProofs.length > 0) {
      playsContext += `### Play: "Source Material Customer Wins"\n`
      materialPeerProofs.forEach((proof, i) => {
        playsContext += `  [${i}] ${proof.customer}: ${proof.outcome}\n`
      })
      playsContext += '\n'
    }
    for (const play of opts.structuredPlays) {
      playsContext += `### Play: "${play.name}"\n- TDP: ${play.parentTdp}\n`
      if (play.realWorldExamples?.length) {
        playsContext += `- Real-World Examples:\n`
        play.realWorldExamples.forEach((ex, i) => {
          playsContext += `  [${i}] ${ex.customer}: ${ex.outcome}\n`
        })
      }
      if (play.extractedMetrics?.length) playsContext += `- Verified Metrics: ${JSON.stringify(play.extractedMetrics)}\n`
      playsContext += '\n'
    }
    parts.push(playsContext)
  }

  parts.push(`\n## Customer: ${opts.customerName}`)

  if (opts.deterministicContext) {
    parts.push(`\n### Customer Intelligence (Deterministic):\n${opts.deterministicContext}`)
  }

  if (opts.preMatchedMetrics && opts.preMatchedMetrics.length > 0) {
    let preMatchContext = '\n## PRE-MATCHED BUSINESS METRICS\n\n'
    for (const pm of opts.preMatchedMetrics) {
      preMatchContext += `- ${pm.recipientName} (${pm.recipientTitle}): "${pm.entry.objective}" [${pm.category}]\n`
    }
    parts.push(preMatchContext)
  }

  if (opts.preMatchedPeerProofs && opts.preMatchedPeerProofs.length > 0) {
    let ppContext = '\n## PRE-MATCHED PEER PROOFS\n\n'
    for (const pp of opts.preMatchedPeerProofs) {
      ppContext += `- ${pp.recipientName}: ${pp.proof.customer} → ${pp.proof.outcome}\n`
    }
    parts.push(ppContext)
  }

  const signalsSummary = opts.registrySignals.length > 0
    ? opts.registrySignals
        .slice(0, 30)
        .map((s, i) => `[${i}] [${s.type}] ${s.headline}${s.detail ? ' — ' + s.detail.substring(0, 200) : ''}`)
        .join('\n')
    : 'No signals available.'
  parts.push(`\n### Loaded Signals (reference by index number):\n${signalsSummary}`)

  const contactLines = opts.resolvedContacts.map(c => `- ${c.name}, ${c.title} (role: ${c.role})`).join('\n')
  parts.push(`\n## RESOLVED CONTACTS — generate one persona entry per contact:\n${contactLines}`)

  parts.push(`\n## Available Feature Keys\nSelect exactly 3 per persona from this list ONLY:\n${opts.featureKeys.join(', ')}`)

  return parts.join('\n')
}

// ── Unified Validation ──────────────────────────────────────────────────────

export function validateUnifiedResult(result: UnifiedSelectionResult): UnifiedSelectionResult | null {
  if (!result.personas || result.personas.length < 3) {
    console.warn(`[unified] Invalid persona count: ${result.personas?.length ?? 0} (expected ≥3)`)
    return null
  }

  if (!result.campaignTheme || !result.campaignSummary || !result.positioning) {
    console.warn('[unified] Missing required campaign-level field')
    return null
  }

  const roles = result.personas.map(p => p.role)
  for (const role of roles) {
    if (!role || !VALID_ROLES_SET.has(role)) {
      console.warn(`[unified] Invalid role: "${role}"`)
      return null
    }
  }

  for (const persona of result.personas) {
    if (!persona.suggestedTitle || persona.suggestedTitle.trim().length === 0) {
      console.warn(`[unified] Missing suggestedTitle for ${persona.role}`)
      return null
    }

    if (!persona.why || persona.why.trim().length === 0) {
      console.warn(`[unified] Missing why for ${persona.role}`)
      return null
    }

    if (!persona.valueProposition || persona.valueProposition.trim().length === 0) {
      console.warn(`[unified] Missing valueProposition for ${persona.role}`)
      return null
    }

    if (!persona.recipientName || persona.recipientName.trim().length === 0) {
      console.warn(`[unified] Missing recipientName for ${persona.role}`)
      return null
    }

    if (!persona.subject || persona.subject.trim().length === 0) {
      console.warn(`[unified] Missing subject for ${persona.role}`)
      return null
    }

    if (typeof persona.signalIndex !== 'number' || persona.signalIndex < 0) {
      console.warn(`[unified] Invalid signalIndex ${persona.signalIndex} for ${persona.recipientName}`)
      return null
    }

    if (!Array.isArray(persona.featureKeys) || persona.featureKeys.length !== 3) {
      console.warn(`[unified] featureKeys must have exactly 3 entries for ${persona.recipientName}, got ${persona.featureKeys?.length ?? 0}`)
      return null
    }

    if (!persona.tier || !['executive', 'manager'].includes(persona.tier)) {
      console.warn(`[unified] Invalid tier "${persona.tier}" for ${persona.recipientName}`)
      return null
    }

    if (!persona.intent || !['nurture', 'expand', 're-engage'].includes(persona.intent)) {
      console.warn(`[unified] Invalid intent "${persona.intent}" for ${persona.recipientName}`)
      return null
    }
  }

  return result
}

// ── Unified Gemini Call ─────────────────────────────────────────────────────

export async function callGeminiForUnifiedSelection(opts: UnifiedSelectionInput): Promise<UnifiedSelectionResult | null> {
  try {
    const userPrompt = buildUnifiedSelectionPrompt(opts)

    const result = await callGemini(UNIFIED_SELECTION_SYSTEM_PROMPT, userPrompt, {
      callType: 'unified-selection',
      customerName: opts.customerName,
      temperature: 0.15,
      responseSchema: UNIFIED_SELECTION_SCHEMA,
      timeoutMs: 120_000,
    })

    if (!result.text) return null

    const parsed: UnifiedSelectionResult = JSON.parse(result.text)
    return validateUnifiedResult(parsed)
  } catch (e: any) {
    console.warn(`[unified] Unified selection failed: ${e?.message}`)
    return null
  }
}
