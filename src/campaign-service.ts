/**
 * Campaign Service — Domain Logic for Campaign Generation
 * Routes file (campaigns-routes.ts) is the thin HTTP adapter.
 */

// @consumer-contract v1.0
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { callGemini } from './gemini-call.ts'
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { campaignValidator, validateCampaignSelection } from './quality-validators/campaign-validator.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { toSlug } from './cache-layer.ts'
import type { Customer } from './types.ts'
import { extractMaterial, deleteMaterialCache } from './material-extraction.ts'
import { extractFromEmail } from './lib/email-extractor.ts'
import { getVoiceProfile, detectVoiceProfile } from './ae-voice.ts'
import { runIntelligencePipeline } from './account-intelligence.ts'
import { generateAccountPlan } from './account-plan.ts'
import type { VoiceProfile } from './ae-voice.ts'
import { generateCampaignFromStructured, cleanCampaignTitle, type BVTalkingPoint } from './campaign-html-template.ts'
import { isHomepageUrl, LinkRegistry } from './lib/link-registry.ts'
import { extractPeerProofsFromMaterial } from './lib/source-material-parser.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import type { CustomerSignals } from './lib/signal-loader.ts'
import { FeatureModuleRegistry, type Signal } from './feature-module-registry.ts'
import { getAccountTeam } from './account-team.ts'
import { getFeatureKeys } from './lib/feature-url-registry.ts'
import { CACHE_DIR, CONFIG_DIR } from './lib/paths.ts'
import { getSalesPlayByName } from './lib/saleshub-knowledge-loader.ts'
import { buildConsumerContext } from './lib/context-orchestrator.ts'
import { resolveAllContacts } from './lib/exec-resolver.ts'
import { preMatchObjectives, preMatchPeerProofs } from './lib/persona-classifier.ts'
import { callGeminiForUnifiedSelection, type UnifiedSelectionResult, type UnifiedPersona, type PersonaBrief } from './lib/persona-selector.ts'
import { extractObjectiveProfile, type CustomerObjectiveProfile } from './modules/intelligence-module.ts'
import { assertExtractionOutput, assertUnifiedSelectionOutput, assertPass2Output } from './lib/campaign-contracts.ts'
import { validateCampaignOutput } from './lib/campaign-output-validator.ts'
import {
  saveCampaignToCache,
  findExistingDriveFileIds,
  enrichSignalsFromCache,
  isIntelligenceStale,
} from './lib/campaign-cache.ts'
import {
  assessSignalQuality,
  CampaignQualityGateError,
  deriveFootprint,
  deriveThreatSolution,
  type SignalQualityAssessment,
} from './lib/campaign-quality.ts'
import { uploadCampaignToDrive } from './lib/campaign-drive.ts'

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

// ── Material extraction (moved to google-content-extractor.ts) ──────────────
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

1. **Word limits:** Executive tier = 150 words max; Manager tier = 200-250 words
WORD COUNT IS NON-NEGOTIABLE: Executive emails that exceed 150 words will be rejected. Manager emails below 200 words will be rejected. Count your words.
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

### Executive Tier (3 personas, 150 words max each)
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

// ── Campaign selection types (used by Pass 2 template assembly) ──────────────

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
  }>
}

function mapUnifiedToSelection(result: UnifiedSelectionResult): CampaignSelectionResult {
  return {
    campaignSummary: result.campaignSummary,
    customerContext: result.customerContext,
    positioning: result.positioning,
    emails: result.personas.map(p => ({
      recipientName: p.recipientName,
      tier: p.tier,
      intent: p.intent,
      subject: p.subject,
      signalIndex: p.signalIndex,
      featureKeys: p.featureKeys,
      peerProof: p.peerProof,
    })),
  }
}

function extractBriefsFromUnified(personas: UnifiedPersona[]): PersonaBrief[] {
  return personas.map(p => ({
    role: p.role,
    suggestedTitle: p.suggestedTitle,
    why: p.why,
    objectiveMatch: p.objectiveMatch,
    peerProofCandidates: p.peerProofCandidates,
    timingTrigger: p.timingTrigger,
    valueProposition: p.valueProposition,
    featureKeys: p.featureKeys,
    competitiveContext: p.competitiveContext,
    relationshipPath: p.relationshipPath,
    installedBase: p.installedBase,
    suppressTriggers: p.suppressTriggers,
    confidence: p.confidence,
  }))
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

  // ── Contract assertion: Extraction → Pass 0 ──
  try {
    assertExtractionOutput({ materialContent, materialTitle })
  } catch (e: any) {
    if (process.env.NODE_ENV === 'test') throw e
    console.warn(`[campaigns] Extraction contract warning:`, e?.message)
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
  const planPath = resolve(CACHE_DIR, 'intelligence', `${slug}-account-plan.md`)

  if (isIntelligenceStale(slug)) {
    console.log(`[campaigns] Intelligence brief stale/missing for ${customer.name} — generating...`)
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

  // 3c. Executive resolution — resolve contacts for ALL buying committee roles
  // Extracted to exec-resolver.ts (#1162, ADR-046 §4)
  const resolvedExecs = await resolveAllContacts({
    personas: config?.personas,
    customerName: customer.name,
    customerDomain: customer.domain,
  })

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
  const materialPeerProofs = extractPeerProofsFromMaterial(materialContent)
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

  // ── Unified selection path (ADR-046 Phase 4) ──────────────────────────────
  console.log(`[campaigns] Using UNIFIED generation path for ${customer.name}`)

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

    // Unified selection: persona analysis + data selection in one call (ADR-046 Phase 4)
    const intelligenceText = typeof signals.intelligence === 'string'
      ? signals.intelligence
      : (signals.intelligence?.company || '')
    const accountPlanText = typeof signals.accountPlan === 'string'
      ? signals.accountPlan
      : ''
    const featureKeysList = getFeatureKeys()

    let unifiedResult = await callGeminiForUnifiedSelection({
      materialTitle,
      materialContent,
      customerName: customer.name,
      campaignDirective: config?.campaignDirective,
      intelligenceText: intelligenceText || undefined,
      accountPlanText: accountPlanText || undefined,
      objectiveProfile: objectiveProfile || undefined,
      subscriptionSignals: registrySignals.filter(s => s.source === 'subscriptions'),
      structuredPlays,
      featureKeys: featureKeysList,
      registrySignals,
      deterministicContext: templateResult.deterministic,
      resolvedContacts: resolvedExecs.map(e => ({ name: e.name, title: e.title, role: e.role })),
      preMatchedMetrics,
      preMatchedPeerProofs,
    })

    if (!unifiedResult) {
      if (!config?.forceGenerate) {
        throw new Error(`Unified selection returned no results for ${customer.name}. Use forceGenerate to bypass.`)
      }
      console.warn(`[campaigns] Unified selection returned null — forceGenerate active`)
      throw new Error(`Unified selection returned null for ${customer.name} even with forceGenerate`)
    }

    console.log(`[campaigns] Unified selection: ${unifiedResult.personas.length} personas, theme="${unifiedResult.campaignTheme}"`)

    // Map unified result to CampaignSelectionResult for Pass 2 compatibility
    let selection = mapUnifiedToSelection(unifiedResult)

    // Extract PersonaBrief[] from unified personas for downstream consumers
    let pass0Briefs = extractBriefsFromUnified(unifiedResult.personas)

    // Validate selection
    const validationResult = validateCampaignSelection(
      selection,
      resolvedExecs.map(e => e.name),
      featureKeysList,
      registrySignals.length,
    )
    if (!validationResult.valid) {
      console.warn(`[campaigns] Selection validation warnings:`, validationResult.reasons)
    } else {
      console.log(`[campaigns] Selection validation passed for ${customer.name}`)
    }

    // ── Contract assertion: Unified Selection → Pass 2 ──
    try {
      assertUnifiedSelectionOutput(unifiedResult, resolvedExecs.length)
    } catch (e: any) {
      if (process.env.NODE_ENV === 'test') throw e
      console.warn(`[campaigns] Unified selection contract warning:`, e?.message)
    }

    // ── LinkRegistry: single source of truth for link lifecycle ──
    const linkRegistry = new LinkRegistry(referenceMaterialData)
    const excerptMap = new Map(referenceMaterialData.filter(r => r.excerpt).map(r => [r.title, r.excerpt]))
    const deterministicRefMaterials = linkRegistry.getReferenceMaterials(excerptMap)

    // Build deterministic source attributions from registry
    const deterministicSourceAttrs: Array<{ name: string; description: string }> = []
    if (materialTitle) deterministicSourceAttrs.push({ name: materialTitle, description: 'Primary campaign source material.' })
    for (const link of linkRegistry.getExternalLinks()) {
      if (link.anchor !== materialTitle) deterministicSourceAttrs.push({ name: link.anchor, description: 'Referenced source document.' })
    }

    // ── Gold-standard validation gate ──
    const goldGaps: string[] = []
    if (resolvedExecs.length === 0) goldGaps.push('resolvedExecs: 0 contacts')
    if (selection.emails.length !== resolvedExecs.length) goldGaps.push(`emails: ${selection.emails.length}/${resolvedExecs.length}`)

    if (goldGaps.length > 0) {
      console.warn(`[campaigns] Gold standard gaps after fallbacks: ${goldGaps.join(', ')}`)
    }

    if (selection.emails.length < resolvedExecs.length && selection.emails.length < 6) {
      console.warn(`[campaigns] Email count ${selection.emails.length}/${resolvedExecs.length} — retrying unified call`)
      try {
        const retryResult = await callGeminiForUnifiedSelection({
          materialTitle,
          materialContent,
          customerName: customer.name,
          campaignDirective: config?.campaignDirective,
          intelligenceText: intelligenceText || undefined,
          accountPlanText: accountPlanText || undefined,
          objectiveProfile: objectiveProfile || undefined,
          subscriptionSignals: registrySignals.filter(s => s.source === 'subscriptions'),
          structuredPlays,
          featureKeys: featureKeysList,
          registrySignals,
          deterministicContext: templateResult.deterministic,
          resolvedContacts: resolvedExecs.map(e => ({ name: e.name, title: e.title, role: e.role })),
          preMatchedMetrics,
          preMatchedPeerProofs,
        })
        if (retryResult && retryResult.personas.length > selection.emails.length) {
          unifiedResult = retryResult
          selection = mapUnifiedToSelection(retryResult)
          pass0Briefs = extractBriefsFromUnified(retryResult.personas)
          console.log(`[campaigns] Retry produced ${retryResult.personas.length} personas — using retry`)
        }
      } catch (e: any) {
        console.warn(`[campaigns] Retry failed (using original): ${e?.message}`)
      }
    }

    // Derive BV Talking Points deterministically — unified briefs first, then plays
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

    // Derive eligibility table deterministically — static for SB 122 campaigns
    let eligibilityTable: Array<{ offering: string; deployment: string; status: string }> | undefined
    const isSb122 = /sb[\s-]*122|saas[\s-]*tax/i.test(materialTitle) || /sb[\s-]*122|saas[\s-]*tax/i.test(materialContent.slice(0, 2000))
    if (isSb122) {
      eligibilityTable = [
        { offering: 'Ansible Automation Platform', deployment: 'Customer VPC (self-managed)', status: 'ELIGIBLE FOR EXEMPTION' },
        { offering: 'Ansible Automation Platform', deployment: 'Red Hat Hosted', status: 'TAXABLE' },
        { offering: 'OpenShift Container Platform', deployment: 'Customer VPC (self-managed)', status: 'ELIGIBLE FOR EXEMPTION' },
        { offering: 'Red Hat Enterprise Linux', deployment: 'Customer-managed', status: 'ELIGIBLE FOR EXEMPTION' },
      ]
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

    // Parse product fit sections from intel brief (#197 — signals as source of truth)
    const productFitSections: Record<string, string> = {}
    const intelText = typeof enrichedSignals.intelligence === 'string'
      ? enrichedSignals.intelligence
      : (enrichedSignals.intelligence?.company || '')
    for (const [key, label] of [['rhel', 'RHEL Fit'], ['openshift', 'OpenShift Fit'], ['ansible', 'Ansible Fit'], ['ai', 'Red Hat AI Fit']] as const) {
      const match = intelText.match(new RegExp(`##\\s*#?\\s*${label}([\\s\\S]*?)(?=\\n##|$)`, 'i'))
      if (match) productFitSections[key] = match[1].trim().slice(0, 300)
    }
    if (Object.keys(productFitSections).length > 0) {
      console.log(`[campaigns] Parsed ${Object.keys(productFitSections).length} product fit sections from intel brief: ${Object.keys(productFitSections).join(', ')}`)
    }

    // Pass 2: Template assembly (deterministic, no LLM)
    htmlContent = await generateCampaignFromStructured(selection, {
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
      referenceMaterials: deterministicRefMaterials.length > 0 ? deterministicRefMaterials : undefined,
      referenceMaterialsHeading: 'Source Documents & Analyses',
      eligibilityTable,
      eligibilityHeading: 'Deployment Eligibility',
      footprint,
      sourceAttributions: deterministicSourceAttrs.length > 0 ? deterministicSourceAttrs : undefined,
      linkRegistry,
      aeEmail,
      aePhone,
      campaignThreat: threat,
      campaignSolution: solution,
      objectiveProfile,
      preMatchedMetrics,
      preMatchedPeerProofs,
      pass0Briefs: pass0Briefs.length > 0 ? pass0Briefs : undefined,
      productFitSections: Object.keys(productFitSections).length > 0 ? productFitSections : undefined,
      signalQuality: signalQuality.disposition !== 'PROCEED' || config?.forceGenerate ? signalQuality : undefined,
    })

    // Store selection JSON as markdown equivalent for cache compatibility
    markdown = JSON.stringify(selection, null, 2)
    console.log(`[campaigns] Structured campaign generated (${htmlContent.length} chars HTML, ${selection.emails.length} emails)`)

    // ── Contract assertion: Pass 2 → Drive ──
    try {
      assertPass2Output(htmlContent)
    } catch (e: any) {
      if (process.env.NODE_ENV === 'test') throw e
      console.warn(`[campaigns] Pass 2 contract warning:`, e?.message)
    }

    // ── Post-generation quality validation ──
    const outputValidation = validateCampaignOutput(htmlContent)
    if (!outputValidation.pass) {
      console.warn(`[campaigns] Output validation FAILED: ${outputValidation.failures.filter((f: { severity: string }) => f.severity === 'blocker').length} blockers`)
      for (const f of outputValidation.failures) {
        console.warn(`[campaigns]   [${f.severity}] ${f.check}: ${f.detail}`)
      }
    } else if (outputValidation.failures.length > 0) {
      console.log(`[campaigns] Output validation passed with ${outputValidation.failures.length} warnings`)
      for (const f of outputValidation.failures) {
        console.log(`[campaigns]   [warning] ${f.check}: ${f.detail}`)
      }
    }

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
  if (isIntelligenceStale(slug)) {
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

  // #670: Resolve real executives for campaign personas (via exec-resolver #1162)
  let resolvedContactsContext = ''
  try {
    const resolved = await resolveAllContacts({ personas: config?.personas, customerName: customer.name, customerDomain: customer.domain })
    if (resolved.length > 0) {
      const contactLines = resolved.map(r =>
        `- ${r.role}: ${r.name}, ${r.title}${r.linkedinUrl ? ` (${r.linkedinUrl})` : ''}`
      )
      resolvedContactsContext = `\n## Target Contacts (resolved)\nThese are real executives at ${customer.name}. Personalize emails for them by name and title:\n${contactLines.join('\n')}\n`
      console.log(`[campaigns] Resolved ${resolved.length} executives for ${customer.name}`)
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

// ── Re-exports ──────────────────────────────────────────────────────────────
export { getVoiceProfile, detectVoiceProfile }
export { extractMaterial, deleteMaterialCache }
export { extractFromEmail } from './lib/email-extractor.ts'
export {
  assessSignalQuality,
  CampaignQualityGateError,
  deriveFootprint,
  deriveThreatSolution,
  isSpeculativeInstalledBase,
  scoreStructuredOutput,
  type SignalQualityAssessment,
} from './lib/campaign-quality.ts'
export { uploadCampaignToDrive, ensureCampaignsSubfolder } from './lib/campaign-drive.ts'
