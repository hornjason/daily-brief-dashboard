/**
 * Campaign Service — Domain Logic for Campaign Generation
 *
 * Pure business logic extracted from campaigns-routes.ts.
 * All Gemini prompts, signal processing, intelligence gathering,
 * material extraction, and campaign orchestration live here.
 *
 * Routes file (campaigns-routes.ts) is now a thin HTTP adapter.
 */

// @consumer-contract v1.0
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { Readable } from 'stream'
import { callGemini } from './gemini-call.ts'
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { campaignValidator, validateCampaignSelection } from './quality-validators/campaign-validator.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { toSlug } from './cache-layer.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer } from './types.ts'
import { extractMaterial, deleteMaterialCache } from './material-extraction.ts'
import { extractFromEmail } from './lib/email-extractor.ts'
import { getVoiceProfile, detectVoiceProfile } from './ae-voice.ts'
import { runIntelligencePipeline } from './account-intelligence.ts'
import { generateAccountPlan } from './account-plan.ts'
import type { VoiceProfile } from './ae-voice.ts'
import { generateCampaignFromStructured, cleanCampaignTitle, isRealPersonName, isInternalUrl, isHomepageUrl, type BVTalkingPoint } from './campaign-html-template.ts'
import { extractPeerProofsFromMaterial } from './lib/source-material-parser.ts'
import { loadCustomerSignals, SIGNAL_TIERS, getSignalTier } from './lib/signal-loader.ts'
import type { CustomerSignals, SignalLoadResult } from './lib/signal-loader.ts'
import { FeatureModuleRegistry, type Signal } from './feature-module-registry.ts'
import { getAccountTeam } from './account-team.ts'
import { getFeatureKeys, getFeatureUrlMap } from './lib/feature-url-registry.ts'
import { CACHE_DIR, CONFIG_DIR } from './lib/paths.ts'
import { getSalesPlayByName } from './lib/saleshub-knowledge-loader.ts'
import { buildConsumerContext } from './lib/context-orchestrator.ts'
import { resolveExecutivesByRole, type ResolvedExecutive } from './lib/executive-resolver.ts'
import { preMatchObjectives, preMatchPeerProofs, type PreMatchedMetric, type PreMatchedPeerProof } from './lib/persona-classifier.ts'
import { selectPersonas, formatBriefsForPrompt, type Pass0Result, type PersonaBrief } from './lib/persona-selector.ts'
import { extractObjectiveProfile, type CustomerObjectiveProfile } from './modules/intelligence-module.ts'

// ── Threat/solution derivation (ADR-044 Phase 2) ───────────────────────────

const THREAT_PATTERNS: Array<{ pattern: RegExp; threat: string }> = [
  { pattern: /saas tax|sb 122|sales tax/, threat: 'the SaaS tax' },
  { pattern: /security breach|data breach|cyber attack/, threat: 'security breach exposure' },
  { pattern: /vendor lock-in|vmware|broadcom/, threat: 'vendor lock-in and rising licensing costs' },
  { pattern: /cloud cost|cloud spend|cloud migration/, threat: 'uncontrolled cloud costs' },
  { pattern: /compliance|regulation|audit/, threat: 'compliance requirements' },
  { pattern: /technical debt|legacy|moderniz/, threat: 'technical debt' },
]

const SOLUTION_PATTERNS: Array<{ pattern: RegExp; solution: string }> = [
  { pattern: /ansible|automation/, solution: 'self-managed automation' },
  { pattern: /openshift|container|kubernetes/, solution: 'a unified container platform' },
  { pattern: /rhel|enterprise linux/, solution: 'a standardized enterprise Linux foundation' },
  { pattern: /security|acs|stackrox/, solution: 'integrated security across the stack' },
  { pattern: /ai|ml|model/, solution: 'an enterprise AI platform' },
]

export function deriveThreatSolution(materialTitle: string, materialContent: string): { threat: string; solution: string } {
  const lower = (materialTitle + ' ' + materialContent).toLowerCase()
  const matched = THREAT_PATTERNS.find(tp => tp.pattern.test(lower))
  const threat = matched?.threat || 'rising infrastructure costs'
  const solMatched = SOLUTION_PATTERNS.find(sp => sp.pattern.test(lower))
  const solution = solMatched?.solution || 'consolidated infrastructure'
  return { threat, solution }
}

const SPECULATION_PATTERN = /\b(likely|suggests|indicates|probably|appears|implies|may include|current use|operational reliance|technical requirements|infrastructure strategy)\b|existing\s.*(?:portfolio|tools|automation)|e\.g\.,/i

/** Returns true when text looks like Gemini speculation rather than real product names */
export function isSpeculativeInstalledBase(text: string, customerName?: string): boolean {
  if (customerName) {
    if (text.includes(customerName)) return true
    const firstName = customerName.split(/\s+/)[0]
    if (firstName.length > 2 && text.startsWith(firstName + ' ')) return true
  }
  if (text.length > 40 && SPECULATION_PATTERN.test(text)) return true
  if (text.length > 120 && !text.includes(',')) return true
  return false
}

export function deriveFootprint(
  pass0Briefs: PersonaBrief[],
  subSignals: Signal[],
  registrySignals: Signal[],
  customerName?: string,
): { current: string; expansion: string } | undefined {
  // Subscription signals are authoritative — use them first
  const rawSubProducts = subSignals.map(s => s.metadata?.product as string ?? s.headline).filter(Boolean)
  if (rawSubProducts.length > 0) {
    // AC-2: Deduplicate product names and strip subscription count text (#1124)
    const subProducts = [...new Set(rawSubProducts.map(p => p.replace(/\s*\d+\s*subscriptions?\s*total\s*/gi, '').trim()))]
    // AC-1: Filter out pipeline source signals from expansion (#1124)
    const intelSignals = registrySignals.filter(s => s.source === 'intelligence')
    return {
      current: subProducts.join(', '),
      expansion: intelSignals.slice(0, 3).map(s => s.headline).join(', ') || 'Expansion opportunities under evaluation',
    }
  }

  // Fall back to Pass 0 installedBase for prospects without subscription data
  if (pass0Briefs.length > 0) {
    const installedBases = pass0Briefs.map(b => b.installedBase).filter(Boolean)
      .filter(b => !isSpeculativeInstalledBase(b, customerName))
    const uniqueBases = [...new Set(installedBases)]
    const expansions = pass0Briefs.map(b => b.valueProposition).filter(Boolean)
    const competitive = pass0Briefs
      .map(b => b.competitiveContext)
      .filter((c): c is string => c !== null && c.length > 0)

    if (uniqueBases.length > 0) {
      return {
        current: uniqueBases.join(' · '),
        expansion: competitive.length > 0
          ? `${expansions[0] || 'Expansion under evaluation'} (Competitive: ${competitive[0]})`
          : expansions[0] || 'Expansion opportunities under evaluation',
      }
    }
  }

  return undefined
}


// ── Signal enrichment (loads intelligence + account plan from cache) ────────

async function enrichSignalsFromCache(
  signals: CustomerSignals,
  slug: string,
  subSignals: Signal[],
  registrySignals: Signal[],
): Promise<CustomerSignals> {
  const enriched: any = { ...signals }
  try {
    const { existsSync, readFileSync } = await import('fs')
    const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
    if (existsSync(intelPath)) enriched.intelligence = JSON.parse(readFileSync(intelPath, 'utf-8'))
    const planPath = resolve(CACHE_DIR, 'intelligence', `${slug}-account-plan.md`)
    if (existsSync(planPath)) enriched.accountPlan = readFileSync(planPath, 'utf-8')
  } catch { /* silent */ }
  if (subSignals.length > 0) {
    enriched.subscriptions = subSignals.map(s => ({
      productName: s.metadata?.product ?? s.headline,
      quantity: s.metadata?.quantity ?? 1,
      status: 'Active',
    }))
  }
  const caseSignals = registrySignals.filter(s => s.source === 'cases')
  if (caseSignals.length > 0) enriched.cases = caseSignals
  return enriched
}

// ── URL extraction from plain text ──────────────────────────────────────────
function extractUrlsFromPlainText(text: string): Array<{ url: string; title: string }> {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
  const matches = text.match(urlRegex) ?? []
  const seen = new Set<string>()
  const results: Array<{ url: string; title: string }> = []
  for (const url of matches) {
    const cleaned = url.replace(/[.,;:!?)]+$/, '')
    if (!seen.has(cleaned)) {
      seen.add(cleaned)
      results.push({ url: cleaned, title: cleaned })
    }
  }
  return results
}

// ── Structured HTML quality scoring (parallel validation) ───────────────────
export function scoreStructuredOutput(html: string): { sections: number; emails: number; words: number } {
  const sections = (html.match(/<h[23][^>]*>/g) || []).length
  const emails = (html.match(/📧/g) || []).length
  const words = html.replace(/<[^>]*>/g, '').split(/\s+/).filter(w => w.length > 0).length
  return { sections, emails, words }
}

// ── Structured output schema (ADR-040) ───────────────────────────────────────

const CAMPAIGN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    campaignSummary: {
      type: 'STRING',
      description: 'Campaign strategy summary. Include total pipeline value from the provided pipeline data. If no pipeline data exists, state the strategic rationale without fabricating dollar figures.',
    },
    customerContext: {
      type: 'STRING',
      description: 'What is happening NOW with this customer. Reference specific dates, active evaluations, recent emails, or pipeline opportunities from the provided context. Do not use generic strategic descriptions.',
    },
    positioning: {
      type: 'STRING',
      description: 'How Red Hat value props map to customer needs. Must include one Challenger Insight that teaches the customer something about their own business they may not know.',
    },
    emails: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          persona: { type: 'STRING', description: 'Target role (e.g., CIO, VP Infrastructure, Director of IT)' },
          tier: { type: 'STRING', description: 'executive or manager' },
          subject: { type: 'STRING', description: 'Email subject line. No product names, no company names per Rule 9.' },
          body: { type: 'STRING', description: 'Email body following the tier structure rules. Must include relationship context referencing existing Red Hat product usage.' },
          peerProof: {
            type: 'STRING',
            nullable: true,
            description: 'Cite a SPECIFIC customer win from the VERIFIED SOLUTION PLAYS section in the prompt. Use the EXACT company name and metric. If no matching customer win exists in the provided data, set to null. NEVER fabricate a peer reference.',
          },
          actionStep: {
            type: 'STRING',
            description: 'Concrete next step: "[AE name from account team] should [specific action] by [timeframe]." Reference specific pipeline opportunities or customer situations.',
          },
        },
        required: ['persona', 'tier', 'subject', 'body', 'actionStep'],
      },
    },
  },
  required: ['campaignSummary', 'customerContext', 'positioning', 'emails'],
}

// ── Data selection schema (ADR-043 two-pass) ────────────────────────────────

const CAMPAIGN_SELECTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    campaignSummary: { type: 'STRING', description: 'Campaign strategy overview grounded in loaded signals.' },
    customerContext: { type: 'STRING', description: 'What is happening NOW with this customer.' },
    positioning: { type: 'STRING', description: 'Red Hat value prop mapping. Include one Challenger Insight.' },
    emails: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          recipientName: { type: 'STRING', description: 'MUST match exactly one resolved contact name.' },
          tier: { type: 'STRING', enum: ['executive', 'manager'] },
          intent: { type: 'STRING', enum: ['nurture', 'expand', 're-engage'] },
          subject: { type: 'STRING', description: '2-4 word observation, no product/company names.' },
          signalIndex: { type: 'INTEGER', description: 'Zero-based index into signals array.' },
          featureKeys: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Exactly 3 keys from URL registry.' },
          peerProof: { type: 'OBJECT', nullable: true, properties: { playName: { type: 'STRING' }, exampleIndex: { type: 'INTEGER' } } },
          challengerDataPoint: { type: 'STRING', description: 'Observation from signals that teaches the customer something.' },
          customOpener: {
            type: 'STRING',
            description: 'One sentence observation about THIS recipient\'s specific situation — what is happening in their world that connects to the campaign theme. Must reference a concrete fact from the loaded signals (a recent event, initiative, or business change). NOT a generic opener. Example: "SB 122 takes effect January 1 — every SaaS automation tool your San Jose engineering teams rely on picks up an 8-10% tax overhead." NOT: "Infrastructure modernization is shaping how your teams operate."',
          },
          featureApplications: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Exactly 3 sentences, one per featureKey (same order). Each explains why THIS specific feature matters for THIS customer\'s specific situation. Must reference customer context, not generic capability. Example for A10+SaaS tax: "self-managed in your VPC, zero SaaS tax exposure on automation workloads" NOT: "unifies automation across hybrid environments". Keep to 1 sentence each, 8-12 words. Reference the campaign theme directly. For a SaaS tax campaign: "self-managed in your VPC, zero SaaS tax exposure". NOT generic: "unifies automation across hybrid environments".',
          },
          signalBridge: {
            type: 'STRING',
            description: 'One sentence connecting the selected signal to the customer\'s business and the primary Red Hat product. When mentioning a Red Hat product by name, use a markdown link to its product page from the feature URL registry. Example: "For a company shipping products built on [Red Hat Enterprise Linux](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux), the fix is straightforward." Must be specific to this customer.',
          },
          referenceLine: {
            type: 'STRING',
            nullable: true,
            description: 'One sentence pointing the recipient to relevant source documents. Use markdown links for each document name: [Document Title](url). Example: "For background on the law: [Holland & Knight\'s analysis of SB 122](https://example.com/hk) covers the definitions and exemptions, and [Numeral\'s state-by-state breakdown](https://example.com/numeral) shows where California fits." URLs must come from the provided material content or reference data. Set to null if no reference docs apply.',
          },
        },
        required: ['recipientName', 'tier', 'intent', 'subject', 'signalIndex', 'featureKeys', 'challengerDataPoint', 'customOpener', 'featureApplications', 'signalBridge', 'referenceLine'],
      },
    },
    referenceMaterials: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          resource: { type: 'STRING', description: 'Name of the reference document or source.' },
          url: { type: 'STRING', nullable: true, description: 'URL if from redhat.com, otherwise null.' },
          keyTakeaway: { type: 'STRING', description: 'One-sentence summary of what this source covers.' },
        },
        required: ['resource', 'keyTakeaway'],
      },
      description: 'Extract reference materials/sources from the campaign material. Each entry has resource name, optional URL, and key takeaway. These are external documents cited in the material (legal analyses, reports, sales plays).',
    },
    eligibilityTable: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          offering: { type: 'STRING', description: 'Product or offering name.' },
          deployment: { type: 'STRING', description: 'Deployment model (e.g., Customer VPC, Red Hat Hosted).' },
          status: { type: 'STRING', description: 'Eligibility status (e.g., ELIGIBLE FOR EXEMPTION, TAXABLE).' },
        },
        required: ['offering', 'deployment', 'status'],
      },
      description: 'Extract product deployment eligibility information from the material. Each row has offering name, deployment model, and status. Only include if the material discusses deployment-specific eligibility/compliance.',
    },
    bvTalkingPoints: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          objective: { type: 'STRING', description: 'Business objective category (e.g., Cost Efficiency, Risk Mitigation, Revenue Growth).' },
          talkingPoints: { type: 'STRING', description: '1-2 key talking points for this objective.' },
          keyMetrics: { type: 'STRING', description: 'Specific peer proof metrics from the solution plays.' },
        },
        required: ['objective', 'talkingPoints', 'keyMetrics'],
      },
      description: 'Extract 3-4 business value talking points organized by objective category. Each has: objective (category name), talkingPoints (1-2 key messages), keyMetrics (specific peer proof metrics). These are for internal call prep, not email content.',
    },
    sourceAttributions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Source document title.' },
          description: { type: 'STRING', description: 'Brief description of what this source covers.' },
        },
        required: ['name', 'description'],
      },
      description: 'Extract source document titles and brief descriptions from the material content.',
    },
  },
  required: ['campaignSummary', 'customerContext', 'positioning', 'emails', 'referenceMaterials', 'eligibilityTable', 'bvTalkingPoints', 'sourceAttributions'],
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignRequest {
  materialUrl: string
  supplementalUrls?: string[]
  emailSubject?: string
  personas?: Array<{ role: string; enabled: boolean; relevantVPs?: string[]; linkedinUrl?: string; name?: string }>
  style?: string
  valueProps?: Array<{ id: string; claim: string; detail: string }>
  campaignDirective?: string
  forceGenerate?: boolean
}

export interface CampaignResult {
  ok: true
  campaignId: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
  signalsLoaded?: string[]
  signalsMissing?: string[]
  signalCompleteness?: number
}

// ── Signal Quality Gate (#1120) ──────────────────────────────────────────────

export interface SignalQualityAssessment {
  disposition: 'PROCEED' | 'DEGRADED' | 'BLOCKED'
  signalCompleteness: number
  missing: string[]
  stale: string[]
  reasons: Record<string, string>
}

export class CampaignQualityGateError extends Error {
  constructor(
    public assessment: SignalQualityAssessment,
    public customerName: string,
  ) {
    const missingList = assessment.missing.map(s => `  - ${s}: ${assessment.reasons[s] || 'not available'}`).join('\n')
    super(`Campaign generation blocked for ${customerName} — missing critical signals:\n${missingList}\n\nTo override: add forceGenerate: true to request. Warning banner will be injected into output.`)
    this.name = 'CampaignQualityGateError'
  }
}

export function assessSignalQuality(
  loaded: string[],
  missing: string[],
): SignalQualityAssessment {
  const loadedSet = new Set(loaded)
  const missingSet = new Set(missing)
  const reasons: Record<string, string> = {}
  const stale: string[] = []

  const criticalMissing: string[] = []
  for (const source of SIGNAL_TIERS.CRITICAL) {
    if (missingSet.has(source) || !loadedSet.has(source)) {
      criticalMissing.push(source)
      reasons[source] = 'not loaded — no data available for this customer'
    }
  }

  const contextMissing: string[] = []
  for (const source of SIGNAL_TIERS.CONTEXT) {
    if (missingSet.has(source) || !loadedSet.has(source)) {
      contextMissing.push(source)
      reasons[source] = 'not loaded'
    }
  }

  const criticalScore = ((SIGNAL_TIERS.CRITICAL.length - criticalMissing.length) / SIGNAL_TIERS.CRITICAL.length) * 60
  const contextScore = ((SIGNAL_TIERS.CONTEXT.length - contextMissing.length) / SIGNAL_TIERS.CONTEXT.length) * 30
  const enrichmentTotal = SIGNAL_TIERS.ENRICHMENT.length
  const enrichmentLoaded = SIGNAL_TIERS.ENRICHMENT.filter(s => loadedSet.has(s)).length
  const enrichmentScore = (enrichmentLoaded / enrichmentTotal) * 10
  const signalCompleteness = Math.round(criticalScore + contextScore + enrichmentScore)

  let disposition: 'PROCEED' | 'DEGRADED' | 'BLOCKED'
  if (criticalMissing.length > 0) {
    disposition = 'BLOCKED'
  } else if (contextMissing.length > 0) {
    disposition = 'DEGRADED'
  } else {
    disposition = 'PROCEED'
  }

  return {
    disposition,
    signalCompleteness,
    missing: [...criticalMissing, ...contextMissing],
    stale,
    reasons,
  }
}

export interface CampaignListItem {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
}

interface CampaignCacheEntry {
  id: string
  materialTitle: string
  materialUrl: string
  customerName: string
  markdown: string
  htmlContent: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
  driveFileId?: string
  driveHtmlFileId?: string
  signalsLoaded?: string[]
  signalsMissing?: string[]
  signalCompleteness?: number
  qualityScorecard?: QualityScorecard
  campaignDirective?: string
}

// ── Material extraction ──────────────────────────────────────────────────────
// Moved to src/lib/google-content-extractor.ts — imported for local use, re-exported for consumers
import { extractFileId, extractMaterialContent } from './lib/google-content-extractor.ts'
export { extractFileId, extractMaterialContent }

// ── Gemini campaign generation ───────────────────────────────────────────────

const CAMPAIGN_SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect creating deeply personalized email campaigns.

## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. Every claim, metric, dollar amount, date, and name MUST come from the provided context data.
2. If the context does not contain a specific data point for a field, set that field to null.
3. Never extrapolate, estimate, or generate plausible-sounding data that is not in the context.
4. When citing a customer win or peer metric, it MUST come from the VERIFIED SOLUTION PLAYS section. Use the EXACT company name and metric.
5. Generic peer references ("industry peers", "companies like yours", "similar organizations") are PROHIBITED. Either cite a named company from the solution plays data or set peerProof to null.
6. Pipeline dollar figures MUST match the amounts in the provided pipeline data. Do not round, estimate, or fabricate financial figures.

## Email Design Rules (Council-Validated, Mandatory)

Every generated email MUST pass ALL of these rules:

1. **Word limits:** Executive tier = 120 words max; Manager tier = 200-250 words
WORD COUNT IS NON-NEGOTIABLE: Executive emails that exceed 120 words will be rejected. Manager emails below 200 words will be rejected. Count your words.
2. **Technical observations only** — no firmographic facts ("You're a $2B company")
3. **Statements, not questions** — "curious whether" is template smell. No questions anywhere including CTA.
4. **Per-bullet links** — MANDATORY: each bullet MUST be a markdown link [Feature Name](url) linking to the specific Red Hat product page. Use these URLs:
   - Ansible Automation Platform: https://www.redhat.com/en/technologies/management/ansible
   - Event-Driven Ansible: https://www.redhat.com/en/technologies/management/ansible/event-driven-ansible
   - Ansible Lightspeed / Automation Coding Assistant: https://www.redhat.com/en/technologies/management/ansible/automation-coding-assistant
   - AI Infrastructure Automation: https://www.redhat.com/en/technologies/management/ansible (link to main Ansible page)
   - AIOps: https://www.redhat.com/en/topics/ai/what-is-aiops
   - Event-Driven Automation (concept): https://www.redhat.com/en/topics/automation/what-is-event-driven-automation
   - OpenShift: https://www.redhat.com/en/technologies/cloud-computing/openshift
   - OpenShift AI: https://www.redhat.com/en/products/ai/openshift-ai
   - OpenShift Virtualization: https://www.redhat.com/en/technologies/cloud-computing/openshift/virtualization
   - RHEL: https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux
   - RHEL AI: https://www.redhat.com/en/products/ai/enterprise-linux-ai
   CRITICAL URL RULE: Each of the 3 bullets in each email MUST link to a DIFFERENT, SPECIFIC URL from this list. The generic Ansible page (redhat.com/en/technologies/management/ansible) may be used AT MOST ONCE across all 6 emails. If a bullet mentions AIOps, link to the AIOps URL. If it mentions Event-Driven Ansible, link to the Event-Driven URL. If it mentions Lightspeed, link to the Lightspeed URL. NEVER default all bullets to the generic page.
   Across all 6 emails, you must use AT LEAST 6 different URLs from this registry.
   Format each bullet as: * [Feature Name](url): description sentence
5. **Name the peer company with a concrete metric** — "Mutua Madrileña cut service tickets 50%" not "a major insurer improved"
6. **Forward-worthy test** — exec emails: VP forwards to eng lead; manager emails: manager forwards to VP
7. **Competitor-swap test** — if replacing the product name still works, the email is a brochure. Rewrite with feature-specific language.
8. **Creepy line** — NEVER reference support tickets, POC status, internal data, usage telemetry, subscription counts, node counts, subscription expiry/renewal status, or anything the recipient would be surprised the AE knows
9. **Subject = observation about their world** — no product names, no company names, no "Red Hat" or "Ansible"
10. **No filler** — no "let me know," no PS, no calendar links, no "no pressure," no "hope this finds you well"
11. **Relationship context** — every email must include ONE sentence noting the customer already uses Red Hat products (by product name, never subscription counts). This is NOT the opener — it comes after the observation/pain context.

## Two Email Tiers (6 personas total)

### Executive Tier (3 personas, 120 words max each)
Purpose: Competitive urgency, strategic. Designed to be forwarded DOWN with "thoughts?"
Structure: Competitive observation (1 sentence) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 1 sentence) → Peer proof (1 sentence) → ACTION STEP: "[AE name] should [specific ask] by [timeframe]." (1 sentence, MANDATORY — email is incomplete without this)

### Manager Tier (3 personas, 200-250 words each)
Purpose: Technical depth, daily pain. Designed to be forwarded UP with "we should look at this"
Structure: Pain context (2-3 sentences describing their daily operational reality) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 2-3 sentences explaining HOW) → Peer proof with before/after (1-2 sentences) → ACTION STEP: "[AE name] should [specific ask] by [timeframe]." (1 sentence, MANDATORY)

### Relationship Context Line (Mandatory in ALL emails)
Reference Red Hat PRODUCTS by name — NEVER subscription counts, node counts, or SKUs.
ONE sentence, placed AFTER the competitive observation (exec) or pain context (manager), BEFORE the bullets.

{voiceInstruction}

## CRITICAL: Vary Feature Bullets Per Persona
Each of the 6 emails MUST highlight DIFFERENT features relevant to THAT persona's role:
- A VP of Security cares about threat detection, compliance, and risk reduction
- An ML Engineer cares about model deployment, GPU infrastructure, and MLOps tooling
- A Head of Operations cares about uptime, automated remediation, and incident response
- An IT Director cares about cost, consistency, audit trails, and vendor consolidation
DO NOT repeat the same 3 bullets across all emails. Each persona should discover features they haven't seen in the other emails. Pull from the full breadth of the material's value propositions.

## CRITICAL: Vary Peer Proof Across Emails
Each email's peerProof field MUST cite a DIFFERENT customer win from the VERIFIED SOLUTION PLAYS data when multiple wins are available. If there is only one customer win, use it in ONE email and set peerProof to null for the others — never repeat the same proof in all 6 emails. If multiple wins exist, distribute them across personas by relevance (e.g., security win → VP Security, operations win → Head of Ops).

## MISSION ALIGNMENT — Money Connection (MA-4, MANDATORY)
Every campaign MUST connect to the customer's financial reality. In the Campaign Summary or Customer Context section, include:
- Pipeline value, renewal amount, or expansion opportunity from the loaded signals
- If specific dollar figures exist in the intelligence data, cite them
- If no specific figures exist, frame as "industry benchmarks suggest $X-Y range" — NEVER omit the money connection entirely
Each email's CTA should imply financial impact ("accelerate your $X initiative" or "protect your upcoming renewal").

## MISSION ALIGNMENT — Context Anchor (MA-1, MANDATORY)
The Customer Context section MUST open with what is happening NOW — a recent case, upcoming renewal, recent meeting, new buying signal, or active campaign. Reference specific dates and events from the loaded signals. Generic strategic descriptions ("they are strategically moving towards...") are NOT sufficient. Anchor to a specific, recent, observable event.

## MISSION ALIGNMENT — Actionable Steps (MA-3, MANDATORY)
Each email MUST end with a concrete action step following WHO/WHAT/BY WHEN format:
"[AE Name or Role] should [specific action] by [timeframe]."
Example: "The AE should schedule a 30-minute demo of Event-Driven Ansible with their Head of Ops by end of month."
Do NOT use generic CTAs like "let's discuss" or "reach out to learn more."

## MISSION ALIGNMENT — Challenger Insight (MA-6, MANDATORY)
The Campaign Summary MUST include ONE insight the customer likely doesn't know about their own industry or competitive position. This is NOT a product pitch — it's a business insight that reframes their priorities. Use industry benchmarks, competitive intelligence, or technology trends specific to their vertical. Generic cloud/AI observations are NOT sufficient.

## Output Format
Generate clean markdown with these REQUIRED SECTIONS:
1. **Campaign Summary** — 1-2 sentences including the deal potential: pipeline value, renewal amount, or expansion opportunity from the loaded signals. If no specific dollar figure is in the data, estimate a range based on their subscription size and industry benchmarks.
2. **Customer Context** — what is happening NOW (recent case, upcoming renewal, new signal, active campaign). Must reference a specific recent event with a date or timeframe. Generic strategic descriptions are NOT sufficient.
3. **Positioning** — how value props map to customer needs. Include ONE Challenger insight: something the customer doesn't know about their own competitive position, tech stack gaps, or industry benchmarks specific to their vertical. Public knowledge (like their own press releases) is NOT a Challenger insight.
4. **Email Templates** — 6 emails (3 exec + 3 manager), each with:
   ## {Persona} — {Tier}
   Subject: [observation about their world — no product names]
   [email body following the structure above]
`

export async function callGeminiForCampaign(opts: {
  materialTitle: string
  materialContent: string
  customerName: string
  customerSignals: CustomerSignals
  registrySignals: Signal[]
  deterministicContext?: string
  voiceInstruction?: string
  personas?: Array<{ role: string; enabled: boolean; relevantVPs?: string[]; linkedinUrl?: string; name?: string }>
  emailTemplateContext?: string
  structuredPlays?: Array<{ name: string; parentTdp: string; customerWins?: string[]; realWorldExamples?: Array<{ customer: string; outcome: string }>; extractedMetrics?: Array<{ value: string; context: string }>; talkTrack?: string }>
  campaignDirective?: string
}): Promise<string> {
  // Assemble user prompt with material + signals
  const intelligenceSummary = opts.customerSignals.intelligence?.company
    ? opts.customerSignals.intelligence.company.substring(0, 4000)
    : 'No intelligence data available.'

  const subscriptionsSummary = opts.customerSignals.subscriptions
    ? JSON.stringify(opts.customerSignals.subscriptions, null, 2).substring(0, 2000)
    : 'No subscription data available.'

  // Build registry signals section (news, product lifecycle, RSS, etc.)
  const registrySignalsSummary = opts.registrySignals.length > 0
    ? opts.registrySignals
        .slice(0, 20) // Top 20 signals to avoid token overflow
        .map(s => `[${s.type}] ${s.headline}${s.detail ? ' — ' + s.detail.substring(0, 200) : ''}`)
        .join('\n')
    : 'No registry signals available.'

  // Build persona list (filter to enabled only)
  const enabledPersonas = opts.personas?.filter(p => p.enabled) ?? [
    { role: 'CIO', enabled: true },
    { role: 'VP Infrastructure', enabled: true },
    { role: 'VP Operations', enabled: true },
    { role: 'Director of IT', enabled: true },
    { role: 'Sr. Manager, Cloud Operations', enabled: true },
    { role: 'Director of Platform Engineering', enabled: true },
  ]

  // Build persona instructions — use LinkedIn URL for targeted individuals, generic role otherwise
  const personaLines = enabledPersonas.map(persona => {
    if (persona.linkedinUrl) {
      const label = persona.name ?? persona.role
      return `- ${label}: Research this LinkedIn profile: ${persona.linkedinUrl} — personalize the email for this specific individual`
    }
    return `- ${persona.role}`
  })
  const personasStr = personaLines.join('\n')

  // Serialize verified solution plays for peer proof grounding (ADR-040)
  let solutionPlaysContext = '\n## VERIFIED SOLUTION PLAYS (Source: SalesHub — cite these for peer proof, do not fabricate alternatives)\n\n'

  // Source material customer wins go FIRST
  const materialPeerProofs = extractPeerProofsFromMaterial(opts.materialContent)
  if (materialPeerProofs.length > 0) {
    solutionPlaysContext += `### Play: "Source Material Customer Wins" ⭐ USE THESE FIRST\n`
    solutionPlaysContext += `- TDP: Campaign Source Material\n`
    solutionPlaysContext += `- Real-World Examples:\n`
    materialPeerProofs.forEach((proof, i) => {
      solutionPlaysContext += `  [${i}] ${proof.customer}: ${proof.outcome}\n`
    })
    solutionPlaysContext += '\n'
  }

  if (opts.structuredPlays && opts.structuredPlays.length > 0) {
    for (const play of opts.structuredPlays) {
      solutionPlaysContext += `### Play: "${play.name}"\n`
      solutionPlaysContext += `- TDP: ${play.parentTdp}\n`
      if (play.customerWins?.length) solutionPlaysContext += `- Customer Wins: ${JSON.stringify(play.customerWins)}\n`
      if (play.realWorldExamples?.length) solutionPlaysContext += `- Real-World Examples: ${JSON.stringify(play.realWorldExamples)}\n`
      if (play.extractedMetrics?.length) solutionPlaysContext += `- Verified Metrics: ${JSON.stringify(play.extractedMetrics)}\n`
      if (play.talkTrack) solutionPlaysContext += `- Talk Track: ${play.talkTrack.slice(0, 300)}\n`
      solutionPlaysContext += '\n'
    }
  }

  const userPrompt = `## Material: ${opts.materialTitle}

### Material Content (first 8000 chars):
${opts.materialContent.substring(0, 8000)}

## Customer: ${opts.customerName}

### Company Intelligence:
${intelligenceSummary}

${opts.deterministicContext ? `### Customer Intelligence (Deterministic):\n${opts.deterministicContext}\n` : ''}

### Current Subscriptions:
${subscriptionsSummary}

### Additional Intelligence Signals:
${registrySignalsSummary}
${solutionPlaysContext}
${opts.campaignDirective ? `\n## Campaign Directive (User-Provided Context):\n${opts.campaignDirective}\n\nUse this directive to shape the campaign angle, messaging focus, and email tone.\n` : ''}
${opts.voiceInstruction ? `\n## Voice Instruction:\n${opts.voiceInstruction}\n` : ''}
${opts.emailTemplateContext ?? ''}
---
Now generate a complete campaign for ${opts.customerName} with positioning and email templates.

Generate email templates for these personas (C-level + director-level tiers for each):
${personasStr}`

  const result = await callGemini(CAMPAIGN_SYSTEM_PROMPT, userPrompt, {
    callType: 'campaign-generation',
    customerName: opts.customerName,
    temperature: 0.1,
    responseSchema: CAMPAIGN_RESPONSE_SCHEMA,
    // No deltaKey — campaigns are customer-specific and material may change
  })

  if (!result.text) throw new Error('Gemini returned empty response')

  // Parse structured JSON response (ADR-040)
  let parsedCampaign: any
  try {
    parsedCampaign = JSON.parse(result.text)
  } catch {
    console.warn('[campaigns] Failed to parse structured response, falling back to raw text')
    return result.text // fallback to raw markdown
  }

  // Convert parsed JSON to markdown for downstream pipeline (HTML generation, Drive upload, cache)
  const markdownParts: string[] = []
  markdownParts.push(`## Campaign Summary\n\n${parsedCampaign.campaignSummary}\n`)
  markdownParts.push(`## Customer Context\n\n${parsedCampaign.customerContext}\n`)
  markdownParts.push(`## Positioning\n\n${parsedCampaign.positioning}\n`)
  markdownParts.push('---\n## Email Templates\n')

  for (const email of parsedCampaign.emails ?? []) {
    markdownParts.push(`\n## ${email.persona} — ${email.tier === 'executive' ? 'Executive' : 'Manager'}\n`)
    markdownParts.push(`\nSubject: ${email.subject}\n`)
    markdownParts.push(`\n${email.body}\n`)
    if (email.peerProof) {
      markdownParts.push(`\n${email.peerProof}\n`)
    }
    markdownParts.push(`\n${email.actionStep}\n`)
  }

  return markdownParts.join('\n')
}

// ── Campaign selection (ADR-043 two-pass: Pass 1) ────────────────────────────

const CAMPAIGN_SELECTION_SYSTEM_PROMPT = `You are selecting data points for personalized B2B email campaigns. You are NOT writing emails — you are choosing which data points the template engine should use.

For each resolved contact, select:
1. The most relevant signal (by index) from the loaded signals
2. Exactly 3 feature keys from the URL registry enum — each key must be different and relevant to the recipient's role. CRITICAL DIVERSITY RULE: Do NOT reuse the same feature key in the same position (1st, 2nd, or 3rd) across more than 2 emails. Each email's 3 features should be a unique combination. Distribute ansible-automation-platform across different slots — it should NOT be the 2nd key in every email. Aim for at least 8 distinct feature keys across all 6 emails.
3. A peer proof reference (play name + example index) if one exists in the VERIFIED SOLUTION PLAYS data, otherwise null
4. A challenger data point: one observation from the loaded signals that teaches the customer something about their own business
5. A custom opener: one sentence specific to THIS recipient's situation — reference a concrete fact from the signals. This replaces generic template openers. Write as if opening a colleague's email, not a marketing template.
6. Three feature application sentences (one per feature key, same order): explain why each feature matters for THIS customer's specific situation. Keep each to 8-12 words. Reference the campaign theme directly, not generic capability descriptions.
7. A signal bridge: one sentence connecting the selected signal to the customer's business and the primary Red Hat product. Must be specific to this customer, not a generic industry statement.
8. A reference line: one sentence pointing the recipient to relevant source documents. Use markdown links [Document Title](url) for ALL URLs found in the source material content — including external legal analyses and third-party reports. Do NOT invent URLs that aren't in the material. Example: "For background on the law: [Holland & Knight's analysis of SB 122](https://www.hklaw.com/...) covers the definitions, and [Numeral's state-by-state breakdown](https://www.numeral.com/...) shows where California fits."
9. Reference materials: Extract ALL source documents, legal analyses, reports, and sales plays cited in the material content. Each gets resource name, URL if present in the material, and a one-sentence key takeaway. You MUST extract at least the primary source documents.
10. Eligibility table: If the material discusses deployment-specific compliance, eligibility, or tax status by deployment model, extract every row with offering name, deployment model, and status (e.g., 'ELIGIBLE FOR EXEMPTION', 'TAXABLE').
11. BV Talking Points: Extract 3-4 business value talking points organized by business objective category (e.g., 'Cost Efficiency', 'Risk Mitigation', 'Revenue Growth'). Each has talking points and key metrics from the material or verified solution plays.
12. Source attributions: Extract every source document title referenced in the material with a one-line description. Include the primary campaign material, any legal analyses, tax guides, and supplemental sources.

When the source material uses specific terminology (e.g., 'remotely accessed software', 'self-managed in your VPC', '8-10% tax overhead'), REUSE those exact phrases in customOpener, signalBridge, and featureApplications. Do not paraphrase established terminology from the campaign material.

CRITICAL: customOpener, featureApplications, and signalBridge are the PRIMARY quality differentiator. Generic text in these fields defeats the purpose of the entire system. Every sentence must contain a fact that could ONLY apply to THIS customer.

GROUNDING RULES:
- recipientName MUST exactly match one of the resolved contact names provided
- featureKeys MUST be selected from the provided feature key enum — no invented keys
- signalIndex MUST be a valid zero-based index into the signals array
- challengerDataPoint MUST reference actual data from the loaded signals — never fabricate
- peerProof.playName MUST match a play from VERIFIED SOLUTION PLAYS — never invent
- Do NOT write email body text, CTAs, or prose — the template engine handles all prose generation
- NEVER include signal index references like "(Signal 6)" or "(Signal 29)" in customOpener, featureApplications, signalBridge, or challengerDataPoint — these are internal identifiers that must not appear in customer-facing text

CRITICAL: You MUST generate one email entry for EVERY resolved contact provided. Do NOT skip any contacts. If 6 contacts are listed, produce exactly 6 email entries.

TIER DISTRIBUTION: Assign exactly 3 contacts as 'executive' tier and 3 as 'manager' tier. C-level officers (CEO, CFO, CTO, CIO) and VPs are executive tier. Directors, Heads, and Sr. Managers are manager tier.


`

export interface CampaignSelectionResult {
  campaignSummary: string
  customerContext: string
  positioning: string
  emails: Array<{
    recipientName: string
    tier: 'executive' | 'manager'
    intent: 'nurture' | 'expand' | 're-engage'
    subject: string
    signalIndex: number
    featureKeys: string[]
    peerProof: { playName: string; exampleIndex: number } | null
    challengerDataPoint: string
    customOpener: string
    featureApplications: string[]
    signalBridge: string
    referenceLine?: string
  }>
  referenceMaterials?: Array<{ resource: string; url?: string; keyTakeaway: string }>
  eligibilityTable?: Array<{ offering: string; deployment: string; status: string }>
  bvTalkingPoints?: Array<{ objective: string; talkingPoints: string; keyMetrics: string }>
  sourceAttributions?: Array<{ name: string; description: string }>
}

export async function callGeminiForCampaignSelection(opts: {
  materialTitle: string
  materialContent: string
  customerName: string
  customerSignals: CustomerSignals
  registrySignals: Signal[]
  deterministicContext?: string
  resolvedContacts: Array<{ name: string; title: string; role: string }>
  structuredPlays?: Array<{ name: string; parentTdp: string; customerWins?: string[]; realWorldExamples?: Array<{ customer: string; outcome: string }>; extractedMetrics?: Array<{ value: string; context: string }>; talkTrack?: string }>
  campaignDirective?: string
  temperature?: number
  objectiveProfile?: CustomerObjectiveProfile
  preMatchedMetrics?: PreMatchedMetric[]
  preMatchedPeerProofs?: PreMatchedPeerProof[]
  pass0Briefs?: PersonaBrief[]
}): Promise<CampaignSelectionResult> {
  const featureKeys = getFeatureKeys()

  const signalsSummary = opts.registrySignals.length > 0
    ? opts.registrySignals
        .slice(0, 30)
        .map((s, i) => `[${i}] [${s.type}] ${s.headline}${s.detail ? ' — ' + s.detail.substring(0, 200) : ''}`)
        .join('\n')
    : 'No signals available.'

  const contactLines = opts.resolvedContacts.map(c => `- ${c.name}, ${c.title} (role: ${c.role})`).join('\n')

  let solutionPlaysContext = '\n## VERIFIED SOLUTION PLAYS (cite by playName + exampleIndex)\n\n'

  // Source material customer wins go FIRST — these are directly relevant to the campaign topic
  const materialPeerProofs = extractPeerProofsFromMaterial(opts.materialContent)
  if (materialPeerProofs.length > 0) {
    console.log(`[campaigns] Extracted ${materialPeerProofs.length} peer proofs from source material: ${materialPeerProofs.map(p => p.customer).join(', ')}`)
    solutionPlaysContext += `### Play: "Source Material Customer Wins" ⭐ USE THESE FIRST\n`
    solutionPlaysContext += `- TDP: Campaign Source Material\n`
    solutionPlaysContext += `- Real-World Examples:\n`
    materialPeerProofs.forEach((proof, i) => {
      solutionPlaysContext += `  [${i}] ${proof.customer}: ${proof.outcome}\n`
    })
    solutionPlaysContext += '\n'
  } else {
    console.log(`[campaigns] No peer proofs found in source material (${opts.materialContent.length} chars)`)
  }

  if (opts.structuredPlays && opts.structuredPlays.length > 0) {
    for (const play of opts.structuredPlays) {
      solutionPlaysContext += `### Play: "${play.name}"\n`
      solutionPlaysContext += `- TDP: ${play.parentTdp}\n`
      if (play.realWorldExamples?.length) {
        solutionPlaysContext += `- Real-World Examples:\n`
        play.realWorldExamples.forEach((ex, i) => {
          solutionPlaysContext += `  [${i}] ${ex.customer}: ${ex.outcome}\n`
        })
      }
      if (play.extractedMetrics?.length) solutionPlaysContext += `- Verified Metrics: ${JSON.stringify(play.extractedMetrics)}\n`
      solutionPlaysContext += '\n'
    }
  }

  const featureUrlMap = getFeatureUrlMap()

  let preMatchContext = ''
  if (opts.preMatchedMetrics && opts.preMatchedMetrics.length > 0) {
    preMatchContext = '\n## PRE-MATCHED BUSINESS METRICS (use these data points in the emails — DO NOT select different ones)\n\n'
    for (const pm of opts.preMatchedMetrics) {
      preMatchContext += `- ${pm.recipientName} (${pm.recipientTitle}): USE THIS DATA POINT: "${pm.entry.objective}" [${pm.category}]\n`
    }
    preMatchContext += '\nWeave each recipient\'s pre-matched data point into their email\'s signalBridge or customOpener. The data point should appear naturally in the email body.\n'
  }

  let peerProofContext = ''
  if (opts.preMatchedPeerProofs && opts.preMatchedPeerProofs.length > 0) {
    peerProofContext = '\n## PRE-MATCHED PEER PROOFS (use these — DO NOT select different ones)\n\n'
    for (const pp of opts.preMatchedPeerProofs) {
      peerProofContext += `- ${pp.recipientName}: ${pp.proof.customer} → ${pp.proof.outcome}\n`
    }
    peerProofContext += '\nSet each recipient\'s peerProof to playName: "Source Material Customer Wins" with the matching exampleIndex.\n'
  }

  const pass0BriefContext = opts.pass0Briefs ? formatBriefsForPrompt(opts.pass0Briefs) : ''

  const userPrompt = `## Material: ${opts.materialTitle}\n\n### Material Content (first 8000 chars):\n${opts.materialContent.substring(0, 8000)}\n\n## Customer: ${opts.customerName}\n\n${opts.deterministicContext ? `### Customer Intelligence (Deterministic):\n${opts.deterministicContext}\n` : ''}${preMatchContext}${peerProofContext}${pass0BriefContext}\n### Loaded Signals (reference by index number):\n${signalsSummary}\n${solutionPlaysContext}${opts.campaignDirective ? `\n## Campaign Directive:\n${opts.campaignDirective}\n` : ''}\n## RESOLVED CONTACTS — select data for EXACTLY these people (use EXACT names):\n${contactLines}\n\n## AVAILABLE FEATURE KEYS — select exactly 3 per email from this list ONLY:\n${featureKeys.join(', ')}\n\n## VERIFIED URLS — use ONLY these URLs for reference lines (referenceLine field):\n${featureUrlMap}\n\n---\nFor EACH of the ${opts.resolvedContacts.length} resolved contacts below, select the most relevant signal, 3 feature keys, peer proof (if available), and a challenger data point. Return exactly ${opts.resolvedContacts.length} email entries — one per resolved contact. Do NOT skip any contacts. Return structured selections — do NOT write email prose.`

  const result = await callGemini(CAMPAIGN_SELECTION_SYSTEM_PROMPT, userPrompt, {
    callType: 'campaign-selection',
    customerName: opts.customerName,
    temperature: opts.temperature ?? 0.1,
    responseSchema: CAMPAIGN_SELECTION_SCHEMA,
  })

  if (!result.text) throw new Error('Gemini returned empty response for campaign selection')

  const parsed: CampaignSelectionResult = JSON.parse(result.text)
  return parsed
}

// ── Drive persistence ────────────────────────────────────────────────────────

async function ensureCampaignsSubfolder(customerFolderId: string): Promise<string> {
  return driveClient.ensureChildFolder(customerFolderId, 'Campaigns')
}

function findExistingDriveFileIds(
  customerSlug: string,
  materialUrl: string,
): { driveFileId?: string; driveHtmlFileId?: string } | null {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  if (!existsSync(campaignsDir)) return null

  const files = readdirSync(campaignsDir).filter(f => f.startsWith(`${customerSlug}-`) && f.endsWith('.json'))
  let latest: CampaignCacheEntry | null = null

  for (const file of files) {
    try {
      const entry: CampaignCacheEntry = JSON.parse(readFileSync(resolve(campaignsDir, file), 'utf-8'))
      if (entry.materialUrl === materialUrl && (entry.driveFileId || entry.driveHtmlFileId)) {
        if (!latest || new Date(entry.generatedAt) > new Date(latest.generatedAt)) {
          latest = entry
        }
      }
    } catch { /* skip corrupt entries */ }
  }

  return latest ? { driveFileId: latest.driveFileId, driveHtmlFileId: latest.driveHtmlFileId } : null
}

async function uploadCampaignToDrive(
  customerFolderId: string,
  customer: Customer,
  materialTitle: string,
  materialUrl: string,
  markdown: string,
  aeName: string,
  signals: CustomerSignals,
  accountTeamOverride?: import('./types.ts').AccountTeamMember[],
  existingFileIds?: { driveFileId?: string; driveHtmlFileId?: string },
  campaignDirective?: string,
  prebuiltHtml?: string,
): Promise<{ driveUrl: string; htmlUrl: string; driveFileId: string; driveHtmlFileId: string }> {
  const campaignsFolderId = await ensureCampaignsSubfolder(customerFolderId)
  // Use campaign directive for doc name when available, fall back to material title
  const campaignLabel = campaignDirective
    ? campaignDirective.split(/[.!?\n]/)[0].trim().substring(0, 60)
    : materialTitle
  const docName = `${campaignLabel} - ${customer.name}`

  const accountTeam = accountTeamOverride ?? getAccountTeam(customer)
  const htmlContent = prebuiltHtml ?? ''

  // Google Doc: upload HTML (not markdown) so all template sections render (#1054)
  // HTML-to-Google-Doc conversion preserves formatting, tables, and styling
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  let driveFileId = ''
  let driveUrl = ''

  if (existingFileIds?.driveFileId) {
    try {
      await drive.files.update({
        fileId: existingFileIds.driveFileId,
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        supportsAllDrives: true,
      })
      driveFileId = existingFileIds.driveFileId
      driveUrl = `https://docs.google.com/document/d/${driveFileId}/edit`
      console.log(`[campaigns] Updated Google Doc in-place (PATCH): ${driveUrl}`)
    } catch (e: any) {
      if (e?.code === 404 || e?.status === 404) {
        console.warn(`[campaigns] Cached doc ${existingFileIds.driveFileId} not found — creating new`)
      } else {
        console.warn(`[campaigns] Doc update failed — creating new:`, e?.message)
      }
    }
  }

  if (!driveFileId) {
    const docResponse = await drive.files.create({
      requestBody: {
        name: docName,
        mimeType: 'application/vnd.google-apps.document',
        parents: [campaignsFolderId],
      },
      media: {
        mimeType: 'text/html',
        body: Readable.from(Buffer.from(htmlContent)),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    })
    driveFileId = docResponse.data.id ?? ''
    driveUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${driveFileId}/edit`
    console.log(`[campaigns] Created Google Doc from HTML: ${docName} → ${driveUrl}`)
  }

  let htmlFileId = ''
  let htmlUrl = ''

  if (existingFileIds?.driveHtmlFileId) {
    try {
      const updateResponse = await drive.files.update({
        fileId: existingFileIds.driveHtmlFileId,
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      })
      htmlFileId = updateResponse.data.id ?? existingFileIds.driveHtmlFileId
      htmlUrl = updateResponse.data.webViewLink ?? `https://drive.google.com/file/d/${htmlFileId}/view`
      console.log(`[campaigns] Updated HTML file in-place (PATCH): ${htmlFileId}`)
    } catch (e: any) {
      if (e?.code === 404 || e?.status === 404) {
        console.warn(`[campaigns] Cached HTML file ${existingFileIds.driveHtmlFileId} not found (404) — creating new`)
      } else {
        console.warn(`[campaigns] HTML update failed — creating new:`, e?.message)
      }
    }
  }

  if (!htmlFileId) {
    const htmlResponse = await drive.files.create({
      requestBody: {
        name: `${docName}.html`,
        parents: [campaignsFolderId],
      },
      media: {
        mimeType: 'text/html',
        body: Readable.from(Buffer.from(htmlContent)),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    })
    htmlFileId = htmlResponse.data.id ?? ''
    htmlUrl = htmlResponse.data.webViewLink ?? `https://drive.google.com/file/d/${htmlFileId}/view`
    console.log(`[campaigns] Created HTML file: ${docName}.html → ${htmlUrl}`)
  }

  return { driveUrl, htmlUrl, driveFileId, driveHtmlFileId: htmlFileId }
}

// ── Cache persistence ────────────────────────────────────────────────────────

export function saveCampaignToCache(
  customerSlug: string,
  entry: CampaignCacheEntry,
): void {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  mkdirSync(campaignsDir, { recursive: true })

  const campaignPath = resolve(campaignsDir, `${customerSlug}-${entry.id}.json`)
  writeFileSync(campaignPath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  console.log(`[campaigns] Saved to cache: ${campaignPath}`)
}

export function loadCampaignsFromCache(customerSlug: string): CampaignListItem[] {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  if (!existsSync(campaignsDir)) return []

  const files = readdirSync(campaignsDir).filter(f => f.startsWith(`${customerSlug}-`) && f.endsWith('.json'))
  const campaigns: CampaignListItem[] = []

  for (const file of files) {
    try {
      const entry: CampaignCacheEntry = JSON.parse(readFileSync(resolve(campaignsDir, file), 'utf-8'))
      campaigns.push({
        id: entry.id,
        materialTitle: entry.materialTitle,
        generatedAt: entry.generatedAt,
        driveUrl: entry.driveUrl,
        htmlUrl: entry.htmlUrl,
      })
    } catch (e: any) {
      console.warn(`[campaigns] Failed to read ${file}:`, e.message)
    }
  }

  // Sort by generatedAt desc
  campaigns.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  return campaigns
}

export function loadCampaignFromCache(customerSlug: string, campaignId: string): CampaignCacheEntry | null {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  const campaignPath = resolve(campaignsDir, `${customerSlug}-${campaignId}.json`)

  if (!existsSync(campaignPath)) return null

  try {
    return JSON.parse(readFileSync(campaignPath, 'utf-8'))
  } catch (e: any) {
    console.error(`[campaigns] Failed to read campaign ${campaignId}:`, e.message)
    return null
  }
}

export function deleteCampaignFromCache(customerSlug: string, campaignId: string): boolean {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  const campaignPath = resolve(campaignsDir, `${customerSlug}-${campaignId}.json`)

  if (!existsSync(campaignPath)) return false

  try {
    unlinkSync(campaignPath)
    console.log(`[campaigns] Deleted from cache: ${campaignPath}`)
    return true
  } catch (e: any) {
    console.error(`[campaigns] Failed to delete campaign ${campaignId}:`, e.message)
    return false
  }
}

// ── Core generation logic ────────────────────────────────────────────────────

export async function generateCampaign(
  customer: Customer,
  materialUrl: string,
  config?: CampaignRequest,
): Promise<CampaignResult> {
  const slug = toSlug(customer.name)

  let materialTitle: string
  let materialContent: string
  let referenceMaterialData: Array<{ url: string; title: string; excerpt: string }> = []

  if (config?.emailSubject && !materialUrl) {
    console.log(`[campaigns] Generating campaign for ${customer.name} from email: "${config.emailSubject}"`)
    const emailResult = await extractFromEmail(config.emailSubject)
    materialTitle = cleanCampaignTitle(emailResult.title)
    materialContent = emailResult.content
    referenceMaterialData = emailResult.sourceLinks
    materialUrl = `email:${config.emailSubject}`
    if (referenceMaterialData.length > 0) {
      const refSection = referenceMaterialData
        .filter(l => !l.excerpt.startsWith('['))
        .filter(l => !isHomepageUrl(l.url))
        .map(l => `### ${l.title}\n${l.url}\n${l.excerpt}`)
        .join('\n\n')
      if (refSection) {
        materialContent += `\n\n## Referenced Content\n\n${refSection}`
      }
    }
    console.log(`[campaigns] Extracted email: "${materialTitle}" (${materialContent.length} chars, ${referenceMaterialData.length} links)`)
  } else if (config?.campaignDirective && !materialUrl) {
    const text = config.campaignDirective
    console.log(`[campaigns] Generating campaign for ${customer.name} from directive (freeform)`)
    materialTitle = cleanCampaignTitle(text.split(/[.!?\n]/)[0].trim().substring(0, 100))
    materialContent = text
    materialUrl = `directive:${materialTitle}`
  } else {
    console.log(`[campaigns] Generating campaign for ${customer.name} from ${materialUrl}`)
    const fileId = extractFileId(materialUrl)
    if (!fileId) {
      throw new Error('Invalid materialUrl — expected a Google Docs or Slides link')
    }
    const extracted = await extractMaterialContent(fileId)
    materialTitle = extracted.title
    materialContent = extracted.content

    // Extract URLs from the document content
    const contentUrls = extractUrlsFromPlainText(materialContent)

    // Add the source document itself as primary reference
    referenceMaterialData = [
      {
        url: materialUrl,
        title: materialTitle,
        excerpt: materialContent.substring(0, 500).replace(/\s+/g, ' ').trim()
      }
    ]

    // Add any URLs discovered within the document
    for (const link of contentUrls) {
      if (!referenceMaterialData.some(r => r.url === link.url)) {
        referenceMaterialData.push({
          url: link.url,
          title: link.title,
          excerpt: ''
        })
      }
    }

    console.log(`[campaigns] Extracted material: "${materialTitle}" (${materialContent.length} chars, ${referenceMaterialData.length} URLs discovered)`)
  }

  if (config?.supplementalUrls?.length) {
    for (const url of config.supplementalUrls) {
      try {
        const fileId = extractFileId(url)
        if (!fileId) continue
        const supplemental = await extractMaterialContent(fileId)
        materialContent += `\n\n## Supplemental Source: ${supplemental.title}\n\n${supplemental.content}`
        console.log(`[campaigns] Appended supplemental: "${supplemental.title}" (${supplemental.content.length} chars)`)
      } catch (e: any) {
        console.warn(`[campaigns] Supplemental URL extraction failed (non-fatal): ${url} — ${e?.message}`)
      }
    }
  }

  // 2. Pre-flight: ensure all intelligence exists and is fresh before loading signals
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  const planPath = resolve(CACHE_DIR, 'intelligence', `${slug}-account-plan.md`)
  const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  // Check intelligence brief — generate if missing or stale (>7 days)
  let needsIntelRefresh = !existsSync(intelPath)
  if (!needsIntelRefresh && existsSync(intelPath)) {
    try {
      const intelData = JSON.parse(readFileSync(intelPath, 'utf-8'))
      const cachedAt = intelData.cachedAt ? new Date(intelData.cachedAt).getTime() : 0
      if (Date.now() - cachedAt > STALE_THRESHOLD_MS) {
        needsIntelRefresh = true
        console.log(`[campaigns] Intelligence brief stale for ${customer.name} (cached ${intelData.cachedAt})`)
      }
    } catch { needsIntelRefresh = true }
  }

  if (needsIntelRefresh) {
    console.log(`[campaigns] Intelligence brief ${existsSync(intelPath) ? 'stale' : 'missing'} for ${customer.name} — generating...`)
    try {
      await runIntelligencePipeline(customer.name, true)
      console.log(`[campaigns] Intelligence brief generated for ${customer.name}`)
    } catch (e: any) {
      console.warn(`[campaigns] Intelligence generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // Check account plan — generate if missing
  if (!existsSync(planPath)) {
    console.log(`[campaigns] Account plan missing for ${customer.name} — generating...`)
    try {
      await generateAccountPlan(customer, CACHE_DIR, CONFIG_DIR)
      console.log(`[campaigns] Account plan generated for ${customer.name}`)
    } catch (e: any) {
      console.warn(`[campaigns] Account plan generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // Pre-flight signal refresh (#285) — ensure fresh data before generation
  await FeatureModuleRegistry.refreshStaleSignals(slug).catch(() => {})

  // 3. Load all customer signals (legacy cache + registry signals)
  const { signals, registrySignals, loaded, missing } = await loadCustomerSignals(slug, customer.name, { ensureFresh: true })
  console.log(`[campaigns] Signals for ${customer.name}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}] registry=${registrySignals.length}`)

  // Signal quality gate (#1118/#1120)
  const signalQuality = assessSignalQuality(loaded, missing)
  console.log(`[campaigns] Signal quality for ${customer.name}: ${signalQuality.disposition} (${signalQuality.signalCompleteness}%) — missing: [${signalQuality.missing.join(', ')}]`)

  if (signalQuality.disposition === 'BLOCKED' && !config?.forceGenerate) {
    throw new CampaignQualityGateError(signalQuality, customer.name)
  }

  // 3-obj. Load objective profile from intelligence cache (ADR-044 Phase 2)
  let objectiveProfile: CustomerObjectiveProfile | undefined
  try {
    const profilePath = resolve(CACHE_DIR, 'intelligence', `${slug}-objectives.json`)
    if (existsSync(profilePath)) {
      objectiveProfile = JSON.parse(readFileSync(profilePath, 'utf-8'))
      console.log(`[campaigns] Loaded objective profile for ${customer.name}`)
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load objective profile: ${e?.message}`)
  }
  if (!objectiveProfile && signals.intelligence) {
    const companyText = typeof signals.intelligence === 'string' ? signals.intelligence : (signals.intelligence.company || '')
    if (companyText) {
      objectiveProfile = extractObjectiveProfile(companyText)
      console.log(`[campaigns] Extracted objective profile from intelligence text (${objectiveProfile.financial.length} financial entries)`)
    }
  }

  // 3a. Build deterministic intelligence context from signals (PRINCIPLES.md Layer 2)
  // #668: Filter account team to AE + product-relevant SSP/SSA only
  const productFilter = config?.valueProps
    ?.map(vp => vp.id) // valueProps id may be product slug
    .filter((id): id is string => typeof id === 'string')
  const accountTeam = productFilter && productFilter.length > 0
    ? getAccountTeam(customer, { products: productFilter })
    : getAccountTeam(customer)
  // templateAll is now called internally by the context orchestrator (#1033)
  const ctx = await buildConsumerContext({
    customer,
    consumerType: 'campaign',
    options: {
      signals: registrySignals,
      productFilter: productFilter && productFilter.length > 0 ? productFilter : undefined,
    },
  })
  const templateResult = ctx.templateResult

  // 3b. Load voice profile if not provided in config
  let voiceInstruction = config?.style || ''
  let voiceProfile: VoiceProfile | null = null
  if (!voiceInstruction && customer.ae) {
    voiceProfile = await getVoiceProfile(customer.ae)
    if (voiceProfile) {
      voiceInstruction = `## Voice: ${voiceProfile.aeName}\n${voiceProfile.promptInstruction}`
      console.log(`[campaigns] Using voice profile for ${voiceProfile.aeName}`)
    }
  }

  // 3c-pre. Build structuredPlays early so Pass 0 can reference them
  const structuredPlays = (templateResult.structured?.solutionPlays ?? []).map(sp => {
    const salesHubPlay = getSalesPlayByName(sp.playName)
    return {
      name: sp.playName,
      parentTdp: sp.tdp,
      customerWins: sp.customerWins,
      realWorldExamples: sp.realWorldExamples ?? salesHubPlay?.realWorldExamples,
      extractedMetrics: sp.extractedMetrics,
      talkTrack: sp.talkTrack ?? salesHubPlay?.description,
    }
  })

  // 3c. AI-powered persona selection via Pass 0 (#1097)
  let pass0Result: Pass0Result | null = null
  let pass0Briefs: PersonaBrief[] = []

  // User-provided personas take priority — skip Pass 0 entirely
  const userPersonas = config?.personas?.filter(p => p.enabled)
  if (!userPersonas?.length && (materialContent || config?.campaignDirective)) {
    try {
      const intelligenceText = typeof signals.intelligence === 'string'
        ? signals.intelligence
        : (signals.intelligence?.company || '')
      const accountPlanText = typeof signals.accountPlan === 'string'
        ? signals.accountPlan
        : ''
      const featureKeysList = getFeatureKeys()
      pass0Result = await selectPersonas({
        materialTitle,
        materialContent,
        campaignDirective: config?.campaignDirective,
        intelligenceText: intelligenceText || undefined,
        accountPlanText: accountPlanText || undefined,
        objectiveProfile: objectiveProfile || undefined,
        subscriptionSignals: registrySignals.filter(s => s.source === 'subscriptions'),
        structuredPlays: structuredPlays.map(sp => ({ name: sp.name, parentTdp: sp.parentTdp })),
        customerName: customer.name,
        featureKeys: featureKeysList,
      })
      if (pass0Result) {
        pass0Briefs = pass0Result.briefs
        console.log(`[campaigns] Pass 0 selected ${pass0Result.selectedRoles.length} roles: ${pass0Result.selectedRoles.join(', ')}`)
      } else if (!config?.forceGenerate) {
        throw new Error(`Pass 0 persona selection returned no results for ${customer.name}. Use forceGenerate to bypass.`)
      } else {
        console.warn(`[campaigns] Pass 0 returned null — forceGenerate active, continuing with fallback personas`)
      }
    } catch (e: any) {
      if (e.message?.includes('Pass 0 persona selection returned no results')) throw e
      if (!config?.forceGenerate) {
        throw new Error(`Pass 0 persona selection failed for ${customer.name}: ${e?.message}. Use forceGenerate to bypass.`)
      }
      console.warn(`[campaigns] Pass 0 failed — forceGenerate active, continuing with fallback: ${e?.message}`)
    }
  }

  // Persona cascade: user-provided → Pass 0 → directiveRoleMap → defaults
  const directiveRoleMap: Record<string, string[]> = {
    'tax': ['CEO', 'CFO', 'VP Engineering', 'Director of Finance', 'Sr. Director, Enterprise Info Mgmt', 'Head of IT'],
    'cost': ['Director of Finance', 'VP Finance', 'Head of Procurement'],
    'saas': ['CEO', 'CFO', 'VP Engineering', 'Director of Finance', 'Sr. Director, Enterprise Info Mgmt', 'Head of IT'],
    'security': ['CISO', 'Head of Information Security', 'VP Security'],
    'compliance': ['Director of Finance', 'Head of Compliance', 'General Counsel'],
  }
  let directiveRoles: string[] = []
  if (!pass0Result && !userPersonas?.length && config?.campaignDirective) {
    const directiveLower = config.campaignDirective.toLowerCase()
    for (const [keyword, roles] of Object.entries(directiveRoleMap)) {
      if (directiveLower.includes(keyword)) directiveRoles.push(...roles)
    }
    directiveRoles = [...new Set(directiveRoles)]
  }

  let enabledPersonas: Array<{ role: string; enabled: boolean; linkedinUrl?: string; name?: string }>
  if (userPersonas?.length) {
    enabledPersonas = userPersonas
  } else if (pass0Result) {
    enabledPersonas = pass0Result.briefs.map(b => ({ role: b.suggestedTitle, enabled: true }))
  } else if (directiveRoles.length > 0) {
    enabledPersonas = directiveRoles.slice(0, 6).map(r => ({ role: r, enabled: true }))
  } else {
    enabledPersonas = [
      { role: 'CIO', enabled: true },
      { role: 'VP Infrastructure', enabled: true },
      { role: 'VP Operations', enabled: true },
      { role: 'Director of IT', enabled: true },
      { role: 'Sr. Manager, Cloud Operations', enabled: true },
      { role: 'Director of Platform Engineering', enabled: true },
    ]
  }
  let resolvedContactsContext = ''
  let resolvedExecs: ResolvedExecutive[] = []
  try {
    const namedPersonas = enabledPersonas.filter(p => p.name)
    for (const p of namedPersonas) {
      resolvedExecs.push({ name: p.name!, title: p.role, role: p.role, resolvedAt: new Date().toISOString(), ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}) })
    }
    const rolesToResolve = enabledPersonas
      .filter(p => !p.linkedinUrl && !p.name)
      .map(p => p.role)
    if (rolesToResolve.length > 0) {
      const resolved = await resolveExecutivesByRole(rolesToResolve, customer.name, customer.domain)
      resolvedExecs.push(...resolved)
    }
    if (resolvedExecs.length < 6) {
      const resolvedRoles = new Set(resolvedExecs.map(r => r.role.toLowerCase()))
      const paddingRoles = enabledPersonas
        .map(p => p.role)
        .filter(r => !resolvedRoles.has(r.toLowerCase()))
      for (const role of paddingRoles) {
        if (resolvedExecs.length >= 6) break
        resolvedExecs.push({ name: `${role} at ${customer.name}`, title: role, role, resolvedAt: new Date().toISOString() })
      }
      if (resolvedExecs.length < 6) {
        const fallbackPad = ['VP Engineering', 'Director of Security', 'Head of Cloud Operations', 'CTO', 'Sr. Director IT', 'VP Digital Transformation']
        for (const role of fallbackPad) {
          if (resolvedExecs.length >= 6) break
          if (!resolvedRoles.has(role.toLowerCase())) {
            resolvedExecs.push({ name: `${role} at ${customer.name}`, title: role, role, resolvedAt: new Date().toISOString() })
          }
        }
      }
      console.log(`[campaigns] Padded contacts to ${resolvedExecs.length} for ${customer.name}`)
    }
    const prePadCount = resolvedExecs.length
    resolvedExecs = resolvedExecs.filter(e => isRealPersonName(e.name))
    if (resolvedExecs.length < prePadCount) {
      console.log(`[campaigns] Filtered ${prePadCount - resolvedExecs.length} placeholder contacts for ${customer.name}`)
    }

    // AC-1: Re-pad with Tier 2 contacts if filter dropped count below 6
    if (resolvedExecs.length < 6) {
      const needed = 6 - resolvedExecs.length
      console.log(`[campaigns] Contact count ${resolvedExecs.length}/6 after filter — attempting to re-resolve ${needed} additional contacts via Tier 2`)
      try {
        // Use fallback roles from executive-resolver.ts
        const fallbackRoles = [
          'IT Operations Manager',
          'Cloud Architect',
          'Head of Engineering',
          'VP Engineering',
          'Director of Infrastructure',
          'Engineering Manager',
        ]
        const existingNames = new Set(resolvedExecs.map(e => e.name.toLowerCase()))
        const additionalContacts = await resolveExecutivesByRole(fallbackRoles, customer.name, customer.domain)

        // Filter out duplicates and add up to needed count
        let added = 0
        for (const contact of additionalContacts) {
          if (added >= needed) break
          if (!existingNames.has(contact.name.toLowerCase())) {
            resolvedExecs.push(contact)
            existingNames.add(contact.name.toLowerCase())
            added++
          }
        }
        if (added > 0) {
          console.log(`[campaigns] Re-padded with ${added} Tier 2 contacts for ${customer.name}`)
        } else {
          console.log(`[campaigns] No additional Tier 2 contacts found — proceeding with ${resolvedExecs.length} contacts`)
        }
      } catch (e: any) {
        console.warn(`[campaigns] Tier 2 re-resolution failed (non-fatal):`, e?.message ?? e)
      }
    }

    // #1137: Tier split enforcement — ensure 3+ executive and 3+ manager tier contacts
    if (resolvedExecs.length > 0) {
      // Classify contacts by email tier (executive vs manager)
      const classifyEmailTier = (title: string): 'executive' | 'manager' => {
        const titleLower = title.toLowerCase()
        // Executive tier: C-level and VPs
        if (/\b(ceo|cfo|cto|cio|ciso|chief|c-level)\b/i.test(titleLower)) return 'executive'
        if (/\bvp\b|vice president/i.test(titleLower)) return 'executive'
        // Manager tier: Directors, Heads, Sr. Managers
        return 'manager'
      }

      const execTierContacts = resolvedExecs.filter(e => classifyEmailTier(e.title) === 'executive')
      const managerTierContacts = resolvedExecs.filter(e => classifyEmailTier(e.title) === 'manager')

      console.log(`[campaigns] Tier split before enforcement: ${execTierContacts.length} executive, ${managerTierContacts.length} manager`)

      // If all contacts are executive-level, force-include manager-level roles
      if (managerTierContacts.length < 3 && resolvedExecs.length >= 3) {
        const needed = 3 - managerTierContacts.length
        console.log(`[campaigns] Insufficient manager tier contacts (${managerTierContacts.length}/3) — adding ${needed} manager-level roles`)

        const managerRoles = [
          'Director of IT',
          'Director of Infrastructure',
          'Director of Platform Engineering',
          'Sr. Manager, Cloud Operations',
          'Head of DevOps',
          'Director of Security',
        ]

        const existingTitles = new Set(resolvedExecs.map(e => e.title.toLowerCase()))
        let added = 0

        for (const role of managerRoles) {
          if (added >= needed) break
          if (!existingTitles.has(role.toLowerCase())) {
            try {
              const additionalManager = await resolveExecutivesByRole([role], customer.name, customer.domain)
              if (additionalManager.length > 0) {
                resolvedExecs.push(additionalManager[0])
                existingTitles.add(role.toLowerCase())
                added++
              } else {
                // Fallback: create placeholder contact if resolution fails
                resolvedExecs.push({
                  name: `${role} at ${customer.name}`,
                  title: role,
                  role,
                  resolvedAt: new Date().toISOString(),
                })
                existingTitles.add(role.toLowerCase())
                added++
              }
            } catch (e: any) {
              console.warn(`[campaigns] Failed to resolve ${role} (non-fatal):`, e?.message)
              // Fallback: create placeholder contact
              resolvedExecs.push({
                name: `${role} at ${customer.name}`,
                title: role,
                role,
                resolvedAt: new Date().toISOString(),
              })
              existingTitles.add(role.toLowerCase())
              added++
            }
          }
        }

        console.log(`[campaigns] Added ${added} manager-level contacts — new split: ${execTierContacts.length} executive, ${resolvedExecs.filter(e => classifyEmailTier(e.title) === 'manager').length} manager`)
      }

      // If we have too few executive contacts (and enough manager contacts), add executive roles
      const currentExecCount = resolvedExecs.filter(e => classifyEmailTier(e.title) === 'executive').length
      if (currentExecCount < 3 && resolvedExecs.length >= 3) {
        const needed = 3 - currentExecCount
        console.log(`[campaigns] Insufficient executive tier contacts (${currentExecCount}/3) — adding ${needed} executive-level roles`)

        const executiveRoles = [
          'CIO',
          'CTO',
          'VP Engineering',
          'VP Operations',
          'Chief Information Officer',
          'VP Infrastructure',
        ]

        const existingTitles = new Set(resolvedExecs.map(e => e.title.toLowerCase()))
        let added = 0

        for (const role of executiveRoles) {
          if (added >= needed) break
          if (!existingTitles.has(role.toLowerCase())) {
            try {
              const additionalExec = await resolveExecutivesByRole([role], customer.name, customer.domain)
              if (additionalExec.length > 0) {
                resolvedExecs.push(additionalExec[0])
                existingTitles.add(role.toLowerCase())
                added++
              } else {
                resolvedExecs.push({
                  name: `${role} at ${customer.name}`,
                  title: role,
                  role,
                  resolvedAt: new Date().toISOString(),
                })
                existingTitles.add(role.toLowerCase())
                added++
              }
            } catch (e: any) {
              console.warn(`[campaigns] Failed to resolve ${role} (non-fatal):`, e?.message)
              resolvedExecs.push({
                name: `${role} at ${customer.name}`,
                title: role,
                role,
                resolvedAt: new Date().toISOString(),
              })
              existingTitles.add(role.toLowerCase())
              added++
            }
          }
        }

        console.log(`[campaigns] Added ${added} executive-level contacts — new split: ${resolvedExecs.filter(e => classifyEmailTier(e.title) === 'executive').length} executive, ${managerTierContacts.length} manager`)
      }

      // AC-2: Log final tier breakdown
      const finalExecCount = resolvedExecs.filter(e => classifyEmailTier(e.title) === 'executive').length
      const finalManagerCount = resolvedExecs.filter(e => classifyEmailTier(e.title) === 'manager').length
      const tier1Count = resolvedExecs.filter(e => e.leadershipContext).length
      const tier2Count = resolvedExecs.length - tier1Count
      console.log(`[campaigns] Final contact distribution: ${resolvedExecs.length} total (${tier1Count} Tier 1 intel, ${tier2Count} Tier 2 Gemini) — Email tiers: ${finalExecCount} executive, ${finalManagerCount} manager`)

      const contactLines = resolvedExecs.map(r =>
        `- ${r.name}, ${r.title}${r.email ? ` (${r.email})` : ''}${r.linkedinUrl ? ` | LinkedIn: ${r.linkedinUrl}` : ''}`
      )
      resolvedContactsContext = `\n## RESOLVED TARGET CONTACTS — MANDATORY\nGenerate EXACTLY one email per person below. Use their EXACT name.\n${contactLines.join('\n')}\n`
    }
  } catch (e: any) {
    console.warn(`[campaigns] Executive resolution failed (non-fatal):`, e?.message ?? e)
  }

  // Backfill inferred emails for any contacts missing them
  // customer.domain may be undefined at runtime despite being in config — read fresh
  let emailDomain = customer.domain
  if (!emailDomain) {
    try {
      const cfg = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'customers.json'), 'utf-8'))
      const lowerName = customer.name.toLowerCase()
      const cfgCustomer = (cfg.customers ?? []).find((c: any) => c.name?.toLowerCase() === lowerName || c.name?.toLowerCase().includes(lowerName) || lowerName.includes(c.name?.toLowerCase()))
      emailDomain = cfgCustomer?.domain
    } catch (e: any) { console.warn(`[campaigns] Domain lookup failed: ${e?.message}`) }
  }
  console.log(`[campaigns] Email domain: ${emailDomain ?? 'NONE'}, contacts: ${resolvedExecs.length}, missing email: ${resolvedExecs.filter(e => !e.email).length}`)
  if (emailDomain) {
    let backfilled = 0
    for (const exec of resolvedExecs) {
      if (exec.email) continue
      const realName = exec.name.replace(/ at .+$/, '').trim()
      const nameParts = realName.split(/\s+/)
      const isRoleName = /^(VP|Director|Head|Sr\.|Chief|Manager|CIO|CFO|CEO|CTO|CISO)\b/i.test(nameParts[0])
      if (nameParts.length >= 2 && !isRoleName && /^[A-Za-z]/.test(nameParts[0]) && /^[A-Za-z]/.test(nameParts[nameParts.length - 1])) {
        const firstInitial = nameParts[0][0].toLowerCase()
        const lastName = nameParts[nameParts.length - 1].toLowerCase()
        exec.email = `${firstInitial}${lastName}@${emailDomain}`
        backfilled++
      }
    }
    console.log(`[campaigns] Email backfill: ${backfilled} new, ${resolvedExecs.filter(e => e.email).length}/${resolvedExecs.length} have email for ${customer.name}`)
  }

  // 4a. Check for SalesHub email template base (#372, #439 — signal-based lookup)
  // Uses solution-intelligence signals from loadCustomerSignals() instead of
  // direct module import (PRINCIPLES.md Layer 3 compliance).
  let emailTemplateContext = ''
  try {
    const solutionSignals = registrySignals.filter(s => s.source === 'solution-intelligence' && s.metadata?.solutionPlayName)
    for (const sig of solutionSignals) {
      const playName = sig.metadata!.solutionPlayName as string
      const salesPlay = getSalesPlayByName(playName)
      if (salesPlay?.emailTemplateUrl) {
        try {
          const resp = await fetch(salesPlay.emailTemplateUrl, { signal: AbortSignal.timeout(10000) })
          if (resp.ok) {
            const templateText = await resp.text()
            const cleanTemplate = templateText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000)
            emailTemplateContext = `\n## SalesHub Email Template Base (${playName})\nUse this template as the base structure and language. Personalize with customer signals but preserve the template's positioning language:\n\n${cleanTemplate}\n`
            console.log(`[campaigns] Using SalesHub email template from ${playName}`)
          }
        } catch { /* skip on template fetch failure */ }
        break // Use first template found
      }
    }
  } catch {
    // Solution signals unavailable — proceed without template
  }

  // 4a. Inject source material peer proofs into structuredPlays so buildPeerPattern() can resolve them
  const augmentedMaterial = materialContent + resolvedContactsContext
  const materialPeerProofs = extractPeerProofsFromMaterial(augmentedMaterial)
  if (materialPeerProofs.length > 0) {
    structuredPlays.unshift({
      name: 'Source Material Customer Wins',
      parentTdp: 'Campaign Source Material',
      customerWins: undefined,
      realWorldExamples: materialPeerProofs.map(p => ({ customer: p.customer, outcome: p.outcome })),
      extractedMetrics: undefined,
      talkTrack: undefined,
    })
    console.log(`[campaigns] Injected ${materialPeerProofs.length} source material peer proofs into structuredPlays: ${materialPeerProofs.map(p => p.customer).join(', ')}`)
  }

  // 4b. Generate campaign — branched by feature flag (ADR-043)
  const generatedAt = new Date().toISOString()
  const campaignId = Date.now().toString()
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  let markdown = ''
  let htmlContent = ''
  let qualityScorecard: QualityScorecard | undefined
  let driveUrl = ''
  let htmlUrl = ''
  let driveFileId = ''
  let driveHtmlFileId = ''

  // Build subscription signals for template data
  const subSignals = registrySignals.filter(s => s.source === 'subscriptions')

  // ── Structured two-pass path (ADR-043) ──────────────────────────────────
  console.log(`[campaigns] Using STRUCTURED generation path for ${customer.name}`)

    // Pre-match objectives deterministically (ADR-045 Phase 4)
    const preMatchedMetrics = objectiveProfile
      ? preMatchObjectives(
          resolvedExecs.map(e => ({ name: e.name, title: e.title, leadershipContext: e.leadershipContext })),
          objectiveProfile,
        )
      : []
    if (preMatchedMetrics.length > 0) {
      console.log(`[campaigns] Pre-matched ${preMatchedMetrics.length} objectives for ${customer.name}`)
    }

    // Pre-match peer proofs deterministically (council fix 2)
    const preMatchedPeerProofs = preMatchPeerProofs(
      resolvedExecs.map(e => ({ name: e.name, title: e.title })),
      materialPeerProofs,
    )
    if (preMatchedPeerProofs.length > 0) {
      console.log(`[campaigns] Pre-matched ${preMatchedPeerProofs.length} peer proofs for ${customer.name}`)
    }

    // Pass 1: Gemini data selection
    const selection = await callGeminiForCampaignSelection({
      materialTitle,
      materialContent: augmentedMaterial,
      customerName: customer.name,
      customerSignals: signals,
      registrySignals,
      deterministicContext: templateResult.deterministic,
      resolvedContacts: resolvedExecs.map(e => ({ name: e.name, title: e.title, role: e.role })),
      structuredPlays,
      campaignDirective: config?.campaignDirective,
      objectiveProfile,
      preMatchedMetrics,
      preMatchedPeerProofs,
      pass0Briefs,
    })

    // Validate selection
    const validationResult = validateCampaignSelection(
      selection,
      resolvedExecs.map(e => e.name),
      getFeatureKeys(),
      registrySignals.length,
    )
    if (!validationResult.valid) {
      console.warn(`[campaigns] Selection validation warnings:`, validationResult.reasons)
    } else {
      console.log(`[campaigns] Selection validation passed for ${customer.name}`)
    }

    // ── Deterministic fallback: extract URLs from materialContent for backfill ──
    const materialUrlMap = new Map<string, string>()
    for (const match of augmentedMaterial.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
      materialUrlMap.set(match[1], match[2])
    }
    for (const match of augmentedMaterial.matchAll(/([\w\s&']+(?:analysis|guide|breakdown|report|study))\s*(?::|—|-)?\s*(https?:\/\/[^\s)"<>]+)/gi)) {
      materialUrlMap.set(match[1].trim(), match[2])
    }
    // Extract from "### Title\nURL" or "### Title\nexcerpt" patterns (email sourceLinks format)
    for (const match of augmentedMaterial.matchAll(/###\s+(.+)\n(https?:\/\/[^\s]+)/g)) {
      materialUrlMap.set(match[1].trim(), match[2].trim())
    }
    // Filter internal URLs and homepage/generic URLs from materialUrlMap
    for (const [name, url] of materialUrlMap.entries()) {
      if (isInternalUrl(url) || isHomepageUrl(url)) materialUrlMap.delete(name)
    }
    for (const email of selection.emails) {
      if (materialUrlMap.size > 0) {
        if (!email.referenceLine) {
          const externalRefs = [...materialUrlMap.entries()]
            .slice(0, 2)
          if (externalRefs.length > 0) {
            email.referenceLine = `For additional context: ${externalRefs.map(([name, url]) => `[${name}](${url})`).join(' and ')}.`
          }
        } else if (email.referenceLine && !email.referenceLine.includes('](http')) {
          const externalUrls = [...materialUrlMap.entries()]
          if (externalUrls.length >= 2) {
            email.referenceLine = `For background on the law: [${externalUrls[0][0]}](${externalUrls[0][1]}) covers the definitions, and [${externalUrls[1][0]}](${externalUrls[1][1]}) provides the broader landscape.`
          } else if (externalUrls.length === 1) {
            email.referenceLine = `For background: [${externalUrls[0][0]}](${externalUrls[0][1]}).`
          }
        }
      }
    }

    if (!selection.referenceMaterials || selection.referenceMaterials.length === 0) {
      const refs: Array<{ resource: string; url?: string; keyTakeaway: string }> = []
      for (const [name, url] of materialUrlMap.entries()) {
        refs.push({ resource: name, url, keyTakeaway: 'Source document referenced in campaign material.' })
      }
      if (refs.length > 0) selection.referenceMaterials = refs
    }

    // Fuzzy URL backfill removed — we now use referenceMaterialData directly (see line 1725)

    if (!selection.sourceAttributions || selection.sourceAttributions.length < 2) {
      const attrs: Array<{ name: string; description: string }> = []
      if (materialTitle) attrs.push({ name: materialTitle, description: 'Primary campaign source material.' })
      for (const [name] of materialUrlMap.entries()) {
        if (name !== materialTitle) attrs.push({ name, description: 'Referenced source document.' })
      }
      if (attrs.length > (selection.sourceAttributions?.length ?? 0)) {
        selection.sourceAttributions = attrs
      }
    }

    // ── Gold-standard validation gate ──
    const goldGaps: string[] = []
    if (resolvedExecs.length === 0) goldGaps.push('resolvedExecs: 0 contacts')
    if (!selection.referenceMaterials?.length) goldGaps.push('referenceMaterials')
    if (!selection.eligibilityTable?.length) goldGaps.push('eligibilityTable')
    if (!selection.bvTalkingPoints?.length) goldGaps.push('bvTalkingPoints')
    if (!selection.sourceAttributions?.length) goldGaps.push('sourceAttributions')
    if (selection.emails.length !== resolvedExecs.length) goldGaps.push(`emails: ${selection.emails.length}/${resolvedExecs.length}`)
    const nullRefLines = selection.emails.filter(e => !e.referenceLine).length
    if (nullRefLines > 0) goldGaps.push(`${nullRefLines} null referenceLines`)

    if (goldGaps.length > 0) {
      console.warn(`[campaigns] Gold standard gaps after fallbacks: ${goldGaps.join(', ')}`)
    }

    if (selection.emails.length < resolvedExecs.length && selection.emails.length < 6) {
      console.warn(`[campaigns] Email count ${selection.emails.length}/${resolvedExecs.length} — retrying at temperature 0.05`)
      try {
        const retrySelection = await callGeminiForCampaignSelection({
          materialTitle,
          materialContent: augmentedMaterial,
          customerName: customer.name,
          customerSignals: signals,
          registrySignals,
          deterministicContext: templateResult.deterministic,
          resolvedContacts: resolvedExecs.map(e => ({ name: e.name, title: e.title, role: e.role })),
          structuredPlays,
          campaignDirective: config?.campaignDirective,
          temperature: 0.05,
        })
        if (retrySelection.emails.length > selection.emails.length) {
          selection.emails = retrySelection.emails
          console.log(`[campaigns] Retry produced ${retrySelection.emails.length} emails — using retry`)
        }
      } catch (e: any) {
        console.warn(`[campaigns] Retry failed (using original): ${e?.message}`)
      }
    }

    // Derive BV Talking Points — Pass 0 briefs first, then Gemini, then plays
    let bvTalkingPoints: BVTalkingPoint[] = []
    if (pass0Briefs.length > 0) {
      for (const brief of pass0Briefs) {
        const proofText = brief.peerProofCandidates.length > 0
          ? brief.peerProofCandidates.map(p => `${p.company}: ${p.outcome}`).join('; ')
          : ''
        bvTalkingPoints.push({
          objective: brief.suggestedTitle || brief.role,
          talkingPoints: brief.valueProposition,
          keyMetrics: proofText,
        })
      }
    } else if (selection.bvTalkingPoints && selection.bvTalkingPoints.length > 0) {
      bvTalkingPoints = selection.bvTalkingPoints.map(bp => ({
        objective: bp.objective,
        talkingPoints: bp.talkingPoints,
        keyMetrics: bp.keyMetrics,
      }))
    } else if (structuredPlays && structuredPlays.length > 0) {
      for (const play of structuredPlays.slice(0, 4)) {
        bvTalkingPoints.push({
          objective: play.name,
          talkingPoints: play.talkTrack || play.realWorldExamples?.[0]?.outcome || '',
          keyMetrics: play.extractedMetrics?.[0] ? `${play.extractedMetrics[0].value} — ${play.extractedMetrics[0].context}` : '',
        })
      }
    } else if (selection.campaignSummary) {
      bvTalkingPoints.push({
        objective: 'Campaign Theme',
        talkingPoints: selection.campaignSummary,
        keyMetrics: selection.positioning || '',
      })
    }

    const footprint = deriveFootprint(pass0Briefs, subSignals, registrySignals, customer.name)
    const enrichedSignals = await enrichSignalsFromCache(signals, slug, subSignals, registrySignals)

    // Derive AE email from name (flast@redhat.com), use voice profile for phone/email
    const aeTeam = accountTeam.find(m => m.role === 'ae')
    let aeEmail: string | undefined
    let aePhone: string | undefined
    if (aeTeam) {
      const parts = aeTeam.name.trim().split(/\s+/)
      if (parts.length >= 2) {
        aeEmail = `${parts[0][0].toLowerCase()}${parts[parts.length - 1].toLowerCase()}@redhat.com`
      }
    }
    aePhone = voiceProfile?.phone
    if (voiceProfile?.email) aeEmail = voiceProfile.email

    // Derive threat/solution from campaign material (ADR-044 Phase 2)
    const { threat, solution } = deriveThreatSolution(materialTitle, materialContent)

    // Pass 2: Template assembly (deterministic, no LLM)
    htmlContent = generateCampaignFromStructured(selection, {
      resolvedExecs: resolvedExecs.map(e => ({
        name: e.name,
        title: e.title,
        email: e.email,
        linkedIn: e.linkedinUrl,
      })),
      signals: registrySignals,
      voiceProfile,
      accountTeam,
      subscriptions: subSignals.map(s => ({
        product: s.metadata?.product as string ?? s.headline,
        quantity: s.metadata?.quantity as number ?? 1,
        status: 'Active',
      })),
      structuredPlays,
      customerName: customer.name,
      materialTitle,
      materialUrl,
      generatedDate: timestamp,
      rawSignals: enrichedSignals,
      bvTalkingPoints: bvTalkingPoints.length > 0 ? bvTalkingPoints : undefined,
      referenceMaterials: referenceMaterialData.length > 0
        ? (() => {
            const seen = new Set<string>()
            return referenceMaterialData
              .filter(rm => rm.url && rm.title)
              .filter(rm => !isHomepageUrl(rm.url))
              .filter(rm => {
                if (seen.has(rm.url)) return false
                seen.add(rm.url)
                return true
              })
              .map(rm => ({
                resource: rm.title,
                url: rm.url,
                keyTakeaway: rm.excerpt ? (rm.excerpt.length > 200 ? rm.excerpt.slice(0, 200) + '...' : rm.excerpt) : '',
              }))
          })()
        : selection.referenceMaterials?.map(rm => ({
            resource: rm.resource,
            url: rm.url,
            keyTakeaway: rm.keyTakeaway,
          })),
      referenceMaterialsHeading: 'SB 122 Reference Material',
      eligibilityTable: selection.eligibilityTable?.map(et => ({
        offering: et.offering,
        deployment: et.deployment,
        status: et.status,
      })),
      eligibilityHeading: 'SB 122 Eligibility by AAP Deployment Type',
      footprint,
      sourceAttributions: selection.sourceAttributions,
      aeEmail,
      aePhone,
      sourceUrls: (materialContent.match(/https?:\/\/[^\s)"<>]+/g) || []).filter((u: string) => !u.includes('redhat.com')),
      campaignThreat: threat,
      campaignSolution: solution,
      objectiveProfile,
      preMatchedMetrics,
      preMatchedPeerProofs,
      pass0Briefs: pass0Briefs.length > 0 ? pass0Briefs : undefined,
      signalQuality: signalQuality.disposition !== 'PROCEED' || config?.forceGenerate ? signalQuality : undefined,
    })

    // Store selection JSON as markdown equivalent for cache compatibility
    markdown = JSON.stringify(selection, null, 2)
    console.log(`[campaigns] Structured campaign generated (${htmlContent.length} chars HTML, ${selection.emails.length} emails)`)

    // Upload to Drive with pre-built HTML
    const cachedFileIds = findExistingDriveFileIds(slug, materialUrl)
    try {
      const customerFolderId = await findCustomerDriveFolder(customer)
      const driveResult = await uploadCampaignToDrive(
        customerFolderId,
        customer,
        materialTitle,
        materialUrl,
        markdown,
        customer.ae ?? 'Unknown AE',
        signals,
        accountTeam,
        cachedFileIds ?? undefined,
        config?.campaignDirective,
        htmlContent,
      )
      driveUrl = driveResult.driveUrl
      htmlUrl = driveResult.htmlUrl
      driveFileId = driveResult.driveFileId
      driveHtmlFileId = driveResult.driveHtmlFileId
      console.log(`[campaigns] Uploaded structured campaign to Drive: ${driveUrl}`)
    } catch (e: any) {
      console.error(`[campaigns] Drive upload failed (non-fatal):`, e.message)
    }

  // 7. Save to cache (with HTML content for preview + signal metadata + quality scorecard + file IDs)
  saveCampaignToCache(slug, {
    id: campaignId,
    materialTitle,
    materialUrl,
    customerName: customer.name,
    markdown,
    htmlContent,
    generatedAt,
    driveUrl,
    htmlUrl,
    driveFileId: driveFileId || undefined,
    driveHtmlFileId: driveHtmlFileId || undefined,
    signalsLoaded: loaded,
    signalsMissing: missing,
    signalCompleteness: signalQuality.signalCompleteness,
    qualityScorecard,
    campaignDirective: config?.campaignDirective,
  })

  return {
    ok: true,
    campaignId,
    generatedAt,
    driveUrl,
    htmlUrl,
    signalsLoaded: loaded,
    signalsMissing: missing,
    signalCompleteness: signalQuality.signalCompleteness,
  }
}

// ── Play-based campaign generation (#663) ────────────────────────────────────

export interface PlayContextRequest {
  playName: string
  products: string[]
  valueProps: string[]
  evidence: string[]
}

/**
 * Generate a campaign from play context instead of a material URL.
 * Uses valueProps + evidence as the content source instead of Google Doc extraction.
 */
export async function generateCampaignFromPlay(
  customer: Customer,
  playContext: PlayContextRequest,
  config?: Partial<CampaignRequest>,
): Promise<CampaignResult> {
  const slug = toSlug(customer.name)
  console.log(`[campaigns] Generating campaign from play "${playContext.playName}" for ${customer.name}`)

  // Build synthetic material content from play context
  const materialTitle = `${playContext.playName} — Recommended Play`
  const materialContent = [
    `# ${playContext.playName}`,
    '',
    '## Value Propositions',
    ...playContext.valueProps.map(vp => `- ${vp}`),
    '',
    '## Customer Evidence',
    ...playContext.evidence.map(e => `- ${e}`),
    '',
    '## Products',
    ...playContext.products.map(p => `- ${p}`),
  ].join('\n')

  // Pre-flight: ensure intelligence is fresh
  const intelPath = resolve(CACHE_DIR, 'intelligence', `${slug}.json`)
  const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

  let needsIntelRefresh = !existsSync(intelPath)
  if (!needsIntelRefresh && existsSync(intelPath)) {
    try {
      const intelData = JSON.parse(readFileSync(intelPath, 'utf-8'))
      const cachedAt = intelData.cachedAt ? new Date(intelData.cachedAt).getTime() : 0
      if (Date.now() - cachedAt > STALE_THRESHOLD_MS) needsIntelRefresh = true
    } catch { needsIntelRefresh = true }
  }

  if (needsIntelRefresh) {
    try {
      await runIntelligencePipeline(customer.name, true)
    } catch (e: any) {
      console.warn(`[campaigns] Intelligence generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // Pre-flight signal refresh
  await FeatureModuleRegistry.refreshStaleSignals(slug).catch(() => {})

  // Load customer signals
  const { signals, registrySignals, loaded, missing } = await loadCustomerSignals(slug, customer.name, { ensureFresh: true })

  // Build deterministic context
  // #668: Filter account team to AE + product-relevant SSP/SSA only
  const accountTeam = playContext.products.length > 0
    ? getAccountTeam(customer, { products: playContext.products })
    : getAccountTeam(customer)
  // templateAll is now called internally by the context orchestrator (#1033)
  const ctx = await buildConsumerContext({
    customer,
    consumerType: 'campaign',
    options: {
      signals: registrySignals,
      productFilter: playContext.products.length > 0 ? playContext.products : undefined,
    },
  })
  const templateResult = ctx.templateResult

  // Load voice profile
  let voiceInstruction = config?.style || ''
  if (!voiceInstruction && customer.ae) {
    const voice = await getVoiceProfile(customer.ae)
    if (voice) {
      voiceInstruction = `## Voice: ${voice.aeName}\n${voice.promptInstruction}`
    }
  }

  // #669: Extract ecosystem/partner resources matching play products
  const ecosystemSignals = registrySignals.filter(s =>
    s.source === 'ecosystem-catalog' &&
    playContext.products.some(p => (s.metadata?.platform as string)?.toLowerCase().includes(p.toLowerCase()))
  )
  const partnerSignals = registrySignals.filter(s =>
    s.source === 'partner-catalog' &&
    (s.metadata?.matchedProducts as string[] | undefined)?.some(mp =>
      playContext.products.some(p => mp.toLowerCase().includes(p.toLowerCase()))
    )
  )

  const resourceLinks = [
    ...ecosystemSignals.flatMap(s => {
      const resources = (s.metadata?.resources ?? []) as Array<{ title?: string; url?: string; type?: string }>
      const solutionName = (s.metadata?.solutionName as string) ?? s.headline
      const partnerName = (s.metadata?.partnerName as string) ?? ''
      // If no individual resources, link the solution itself
      if (resources.length === 0 && s.url) {
        return [`- [${solutionName} — ${partnerName}](${s.url})`]
      }
      return resources
        .filter(r => r.url)
        .map(r => `- [${r.title ?? solutionName}](${r.url}) (${r.type ?? 'solution'})`)
    }),
    ...partnerSignals
      .filter(s => s.metadata?.catalogUrl)
      .map(s => {
        const partnerName = (s.metadata?.partnerName as string) ?? s.headline
        const specs = (s.metadata?.specializations as string[]) ?? []
        return `- [${partnerName} — ${specs.join(', ')}](${s.metadata!.catalogUrl as string})`
      }),
  ].join('\n')

  // Build partner/ecosystem context for the prompt
  const partnerEcosystemContext = resourceLinks
    ? `\n## Available Partner & Ecosystem Resources\n${resourceLinks}\n\nInclude 1-2 of these partner/ecosystem links in each email where relevant to the persona's concerns.\n`
    : ''

  // #670: Resolve real executives for campaign personas
  const enabledPersonas = config?.personas?.filter(p => p.enabled) ?? [
    { role: 'CIO', enabled: true },
    { role: 'VP Infrastructure', enabled: true },
    { role: 'VP Operations', enabled: true },
    { role: 'Director of IT', enabled: true },
    { role: 'Sr. Manager, Cloud Operations', enabled: true },
    { role: 'Director of Platform Engineering', enabled: true },
  ]
  let resolvedContactsContext = ''
  try {
    const rolesToResolve = enabledPersonas
      .filter(p => !p.linkedinUrl && !p.name)  // Only resolve generic personas
      .map(p => p.role)
    if (rolesToResolve.length > 0) {
      const resolved = await resolveExecutivesByRole(rolesToResolve, customer.name)
      if (resolved.length > 0) {
        const contactLines = resolved.map(r =>
          `- ${r.role}: ${r.name}, ${r.title}${r.linkedinUrl ? ` (${r.linkedinUrl})` : ''}`
        )
        resolvedContactsContext = `\n## Target Contacts (resolved)\nThese are real executives at ${customer.name}. Personalize emails for them by name and title:\n${contactLines.join('\n')}\n`
        console.log(`[campaigns] Resolved ${resolved.length} executives for ${customer.name}`)
      }
    }
  } catch (e: any) {
    console.warn(`[campaigns] Executive resolution failed (non-fatal):`, e?.message ?? e)
  }

  // Augment material content with partner resources + resolved contacts
  const augmentedContent = materialContent + partnerEcosystemContext + resolvedContactsContext

  // Generate via Gemini
  const rawMarkdown = await callGeminiForCampaign({
    materialTitle,
    materialContent: augmentedContent,
    customerName: customer.name,
    customerSignals: signals,
    registrySignals,
    deterministicContext: templateResult.deterministic,
    voiceInstruction,
    personas: config?.personas as any,
    campaignDirective: config?.campaignDirective,
  })

  const gateResult = await validateAndRetry(
    rawMarkdown,
    { validator: campaignValidator },
    async (failures) => {
      const feedback = formatFailureFeedback(failures)
      return callGeminiForCampaign({
        materialTitle,
        materialContent: augmentedContent + '\n\n' + feedback,
        customerName: customer.name,
        customerSignals: signals,
        registrySignals,
        deterministicContext: templateResult.deterministic,
        voiceInstruction,
        personas: config?.personas as any,
        campaignDirective: config?.campaignDirective,
      })
    }
  )
  const markdown = gateResult.output

  const generatedAt = new Date().toISOString()
  const campaignId = Date.now().toString()

  // TODO: Migrate to generateCampaignFromStructured (#1135)
  throw new Error('generateCampaignFromPlay must be migrated to the structured path — see #1135')

  const htmlContent = '' // unreachable — placeholder for cache entry type

  // Upload to Drive — PATCH existing on re-runs (#1059)
  let driveUrl = ''
  let htmlUrl = ''
  let driveFileId = ''
  let driveHtmlFileId = ''
  const playMaterialKey = `play:${playContext.playName}`
  const cachedFileIds = findExistingDriveFileIds(slug, playMaterialKey)
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const driveResult = await uploadCampaignToDrive(
      customerFolderId, customer, materialTitle, playMaterialKey,
      markdown, customer.ae ?? 'Unknown AE', signals,
      accountTeam,
      cachedFileIds ?? undefined,
      config?.campaignDirective,
    )
    driveUrl = driveResult.driveUrl
    htmlUrl = driveResult.htmlUrl
    driveFileId = driveResult.driveFileId
    driveHtmlFileId = driveResult.driveHtmlFileId
  } catch (e: any) {
    console.error(`[campaigns] Drive upload failed (non-fatal):`, e.message)
  }

  // Cache
  saveCampaignToCache(slug, {
    id: campaignId,
    materialTitle,
    materialUrl: playMaterialKey,
    customerName: customer.name,
    markdown,
    htmlContent,
    generatedAt,
    driveUrl,
    htmlUrl,
    driveFileId: driveFileId || undefined,
    driveHtmlFileId: driveHtmlFileId || undefined,
    signalsLoaded: loaded,
    signalsMissing: missing,
    qualityScorecard: gateResult.scorecard,
    campaignDirective: config?.campaignDirective,
  })

  return {
    ok: true,
    campaignId,
    generatedAt,
    driveUrl,
    htmlUrl,
    signalsLoaded: loaded,
    signalsMissing: missing,
  }
}

// ── AE Voice Profile Service ────────────────────────────────────────────────

export { getVoiceProfile, detectVoiceProfile }

// ── Material extraction re-exports ──────────────────────────────────────────

export { extractMaterial, deleteMaterialCache }
export { extractFromEmail } from './lib/email-extractor.ts'
