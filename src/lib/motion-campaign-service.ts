/**
 * src/lib/motion-campaign-service.ts
 * Motion-driven campaign generation — GitHub Issue #518
 *
 * Takes a StrategicMotion and generates campaign emails per phase,
 * each targeting matched personas with appropriate template tiers.
 *
 * Uses the 10 council-validated email rules from campaign-service.ts
 * and generates via callGemini().
 *
 * Dependencies:
 *   - motion-builder.ts — StrategicMotion, MotionPhase types
 *   - gemini-call.ts — callGemini()
 *   - campaign-service.ts — CAMPAIGN_SYSTEM_PROMPT pattern (rules replicated here
 *     for motion-specific context; the 10 rules are identical)
 */

import { callGemini } from '../gemini-call.ts'
import { driveClient } from './drive-client.ts'
import { findCustomerDriveFolder } from './customer-folder.ts'
import { customers } from '../server-state.ts'
import { toSlug } from '../cache-layer.ts'
import type { StrategicMotion, MotionPhase } from './motion-builder.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MotionCampaignRequest {
  motion: StrategicMotion
  customerSlug: string
  customerName: string
  phases?: string[]          // phase IDs to generate for (default: all)
}

export interface MotionCampaignEmail {
  phaseId: string
  phaseName: string
  personaRole: string
  contactName?: string       // from enrichment, if found
  contactEmail?: string
  templateTier: 'executive' | 'manager'
  subject: string
  body: string               // generated email text
}

export interface MotionCampaignResult {
  motionTitle: string
  emails: MotionCampaignEmail[]
  generatedAt: string
  driveUrl?: string          // Link to saved Google Doc (best-effort)
}

// ── Tier classification ──────────────────────────────────────────────────────

const EXECUTIVE_PATTERNS = [
  /\bvp\b/i,
  /\bsvp\b/i,
  /\bevp\b/i,
  /\bcxo\b/i,
  /\bceo\b/i,
  /\bcto\b/i,
  /\bcio\b/i,
  /\bcfo\b/i,
  /\bciso\b/i,
  /\bcoo\b/i,
  /\bchief\b/i,
]

export function classifyTemplateTier(personaRole: string): 'executive' | 'manager' {
  for (const pattern of EXECUTIVE_PATTERNS) {
    if (pattern.test(personaRole)) return 'executive'
  }
  return 'manager'
}

// ── System prompt (10 council-validated rules, adapted for motion context) ──

function buildSystemPrompt(tier: 'executive' | 'manager'): string {
  const wordLimit = tier === 'executive'
    ? 'This is an EXECUTIVE tier email. Maximum 90 words.'
    : 'This is a MANAGER tier email. 200-250 words.'

  return `You are a Red Hat Account Solution Architect creating a deeply personalized email as part of a strategic motion campaign.

## Email Design Rules (Council-Validated, Mandatory)

Every generated email MUST pass ALL of these rules:

1. **Word limit:** ${wordLimit}
2. **Technical observations only** — no firmographic facts ("You're a $2B company")
3. **Statements, not questions** — "curious whether" is template smell. No questions anywhere including CTA.
4. **Per-bullet links** — MANDATORY: each bullet MUST be a markdown link [Feature Name](url) linking to the specific Red Hat product page.
5. **Name the peer company with a concrete metric** — "Mutua Madrileña cut service tickets 50%" not "a major insurer improved"
6. **Forward-worthy test** — exec emails: VP forwards to eng lead; manager emails: manager forwards to VP
7. **Competitor-swap test** — if replacing the product name still works, the email is a brochure. Rewrite with feature-specific language.
8. **Creepy line** — NEVER reference support tickets, POC status, internal data, usage telemetry, subscription counts, node counts, subscription expiry/renewal status, or anything the recipient would be surprised the AE knows
9. **Subject = observation about their world** — no product names, no company names, no "Red Hat" or "Ansible"
10. **No filler** — no "let me know," no PS, no calendar links, no "no pressure," no "hope this finds you well"

## Structure

${tier === 'executive'
    ? 'Competitive observation (1 sentence) → 3 feature bullets (each = linked feature name + 1 sentence) → Peer proof (1 sentence)'
    : 'Pain context (2-3 sentences describing their daily operational reality) → 3 feature bullets (each = linked feature name + 2-3 sentences explaining HOW) → Peer proof with before/after (1-2 sentences)'}

## Output Format

Return ONLY the email content in this exact format:
Subject: [observation about their world — no product names]

[email body]
`
}

// ── User prompt builder ──────────────────────────────────────────────────────

function buildUserPrompt(
  motion: StrategicMotion,
  phase: MotionPhase,
  personaRole: string,
): string {
  const tacticsSection = phase.tactics
    .map((t: MotionPhase['tactics'][number]) => {
      const assetList = t.assets.map((a: { name: string; url: string; type: string }) => `  - [${a.name}](${a.url}) (${a.type})`).join('\n')
      return `- ${t.name} (${t.parentTdp})\n${assetList}`
    })
    .join('\n')

  const evidenceSection = phase.evidence
    .map((e: MotionPhase['evidence'][number]) => `- [${e.module}] ${e.fact}${e.url ? ` (${e.url})` : ''}`)
    .join('\n')

  return `## Strategic Motion Context

This email is part of a multi-phase strategic motion: "${motion.title}"
${motion.salesPlay ? `Sales Play: ${motion.salesPlay}` : ''}
Customer: ${motion.customerName}
Overall confidence: ${motion.confidence}

## Current Phase: ${phase.name}

Category: ${phase.category} | Urgency: ${phase.urgency}

### Available Tactics & Assets
${tacticsSection}

### Customer Evidence
${evidenceSection}

## Target Persona: ${personaRole}

Generate ONE email for this persona within the context of this strategic motion.
The email should reference the broader strategic motion story — this is not a standalone product pitch, it is part of a coordinated account strategy.
Focus on what matters to a ${personaRole} specifically.
`
}

// ── Parse Gemini response ────────────────────────────────────────────────────

function parseEmailResponse(text: string): { subject: string; body: string } {
  const subjectMatch = text.match(/^Subject:\s*(.+)$/m)
  const subject = subjectMatch?.[1]?.trim() ?? 'Strategic opportunity'

  // Body is everything after the Subject line
  const subjectIdx = text.indexOf('Subject:')
  let body: string
  if (subjectIdx >= 0) {
    const afterSubject = text.substring(subjectIdx)
    const firstNewline = afterSubject.indexOf('\n')
    body = firstNewline >= 0 ? afterSubject.substring(firstNewline + 1).trim() : ''
  } else {
    body = text.trim()
  }

  return { subject, body }
}

// ── Drive persistence (best-effort) ─────────────────────────────────────────

function formatEmailsAsMarkdown(
  motionTitle: string,
  emails: MotionCampaignEmail[],
  generatedAt: string,
): string {
  const lines: string[] = [
    `# Motion Campaign: ${motionTitle}`,
    `Generated: ${new Date(generatedAt).toLocaleString()}`,
    '',
  ]

  // Group emails by phase
  const byPhase = new Map<string, MotionCampaignEmail[]>()
  for (const email of emails) {
    const key = email.phaseId
    if (!byPhase.has(key)) byPhase.set(key, [])
    byPhase.get(key)!.push(email)
  }

  for (const [, phaseEmails] of byPhase) {
    const phaseName = phaseEmails[0]?.phaseName ?? 'Unknown Phase'
    lines.push(`## Phase: ${phaseName}`, '')

    for (const email of phaseEmails) {
      const contactLabel = email.contactName ?? `(${email.personaRole})`
      lines.push(
        `### ${contactLabel} — ${email.templateTier}`,
        `**Subject:** ${email.subject}`,
        '',
        email.body,
        '',
        '---',
        '',
      )
    }
  }

  return lines.join('\n')
}

async function saveMotionCampaignToDrive(
  customerSlug: string,
  motionTitle: string,
  emails: MotionCampaignEmail[],
  generatedAt: string,
): Promise<string | undefined> {
  try {
    // Resolve customer from server-state by slug
    const customer = customers.find(c => toSlug(c.name) === customerSlug)
    if (!customer) {
      console.log(`[motion-campaigns] Could not resolve customer "${customerSlug}" for Drive save, skipping`)
      return undefined
    }

    const customerFolderId = await findCustomerDriveFolder(customer)
    const campaignsFolderId = await driveClient.ensureChildFolder(customerFolderId, 'Campaigns')

    const docName = `Motion Campaign - ${motionTitle}`
    const markdown = formatEmailsAsMarkdown(motionTitle, emails, generatedAt)

    const driveUrl = await driveClient.upsertDoc(campaignsFolderId, docName, markdown)
    console.log(`[motion-campaigns] Saved to Drive: ${docName} → ${driveUrl}`)
    return driveUrl
  } catch (e: any) {
    console.error(`[motion-campaigns] Drive save failed (non-fatal):`, e?.message)
    return undefined
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateMotionCampaigns(
  request: MotionCampaignRequest,
): Promise<MotionCampaignResult> {
  const { motion, customerName, customerSlug } = request

  // Filter phases if specific ones requested
  const targetPhases = request.phases
    ? motion.phases.filter((p: MotionPhase) => request.phases!.includes(p.id))
    : motion.phases

  const emails: MotionCampaignEmail[] = []

  for (const phase of targetPhases) {
    for (const personaRole of phase.targetPersonas) {
      const tier = classifyTemplateTier(personaRole)
      const systemPrompt = buildSystemPrompt(tier)
      const userPrompt = buildUserPrompt(motion, phase, personaRole)

      const result = await callGemini(systemPrompt, userPrompt, {
        callType: 'motion-campaign-generation',
        customerName,
        temperature: 0.7,
      })

      const { subject, body } = parseEmailResponse(result.text)

      emails.push({
        phaseId: phase.id,
        phaseName: phase.name,
        personaRole,
        templateTier: tier,
        subject,
        body,
      })
    }
  }

  const generatedAt = new Date().toISOString()

  // Best-effort Drive save
  const driveUrl = await saveMotionCampaignToDrive(
    customerSlug,
    motion.title,
    emails,
    generatedAt,
  )

  return {
    motionTitle: motion.title,
    emails,
    generatedAt,
    driveUrl,
  }
}
