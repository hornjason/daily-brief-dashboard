/**
 * Account Plan Generation — AI-powered account plan creation
 *
 * Assembles customer intelligence, a sample plan template, playbook guidance,
 * and a questions reference (PDF) to generate a structured account plan via Gemini.
 * Uploads the result to a dedicated "Account Plans" subfolder in the customer's
 * Google Drive folder (separate from Account Intelligence to avoid feedback loops).
 *
 * Uses Gemini multimodal (inlineData for the questions PDF image) and the same
 * Vertex AI auth pattern as account-intelligence.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
// @consumer-contract v1.0
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { accountPlanValidator } from './quality-validators/account-plan-validator.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import type { Customer } from './types.ts'
import { getOperatorProfile, getAccountTeam } from './account-team.ts'
import { CONFIG_DIR } from './lib/paths.ts'
import { callGemini } from './gemini-call.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { templateAll } from './lib/signal-templates.ts'
import { resolveTemplatePath } from './template-sync.ts'

// ── Config paths ──────────────────────────────────────────────────────────────

const CONFIG_DIR_PATH  = CONFIG_DIR

// ── In-app config path (inside container: /app/config/account-plan/) ─────────
const APP_CONFIG_DIR = resolve(import.meta.dir, '../config/account-plan')

// ── ADR-040: Structured response schema for account plan generation ─────────

const ACCOUNT_PLAN_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    executiveSummary: {
      type: 'STRING',
      nullable: true,
      description: 'Scorecard overview summarizing account health, ACV, growth trajectory, and strategic priorities. Use ONLY data from the provided context. If a metric is not in the context, omit it rather than fabricating. Include customer fiscal year month if known from context, and note continuous planning cadence (CY27 CAPI requirement).',
    },
    teamMembers: {
      type: 'STRING',
      nullable: true,
      description: 'AE and ASA names and roles from the provided Account Team data. Do not fabricate team member names.',
    },
    scorecard: {
      type: 'STRING',
      nullable: true,
      description: 'Category scores (% per category) derived from the provided intelligence data. Only include scores for categories where data exists in the context.',
    },
    customerView: {
      type: 'STRING',
      nullable: true,
      description: 'All numbered questions answered: ACV ambition, ACV goal, growth %, why Red Hat, etc. Use ONLY figures from the provided pipeline and intelligence data.',
    },
    accountIntelligence: {
      type: 'OBJECT',
      nullable: true,
      description: 'Structured account intelligence with executive summary, business objectives, and market/competition analysis. Every claim MUST come from the provided intelligence context.',
      properties: {
        executiveSummary: { type: 'STRING', description: 'Executive summary: customer objectives, challenges, environment' },
        businessObjectives: { type: 'STRING', description: 'Customer business objectives, challenges, key initiatives with IT funding analysis' },
        marketCompetition: { type: 'STRING', description: 'Customer market, competitors, industry dynamics' },
        innovationPersona: { type: 'STRING', nullable: true, description: 'Rogers Diffusion persona: Innovator, Early Adopter, Early Majority, Late Majority, Laggard' },
      },
      required: ['executiveSummary', 'businessObjectives', 'marketCompetition'],
    },
    customerEcosystem: {
      type: 'OBJECT',
      nullable: true,
      description: 'Structured customer ecosystem with partner strategy, cloud providers, and committed spend. Only cite partners and technologies present in the context.',
      properties: {
        summary: { type: 'STRING', description: 'Executive summary of ecosystem strategy' },
        partnerGrowthStrategy: { type: 'STRING', description: 'CY27 Q#4: How to leverage Services Partners, VARs, Distributors for growth' },
        cloudProviders: { type: 'STRING', description: 'Cloud providers in use with Red Hat marketplace spend' },
        committedSpend: { type: 'STRING', nullable: true, description: 'Committed spend agreements (EDP, cloud commits)' },
        cloudAdoptionLevel: { type: 'STRING', nullable: true, description: 'Cloud adoption level' },
        specializedPartners: { type: 'STRING', nullable: true, description: 'Key SIs, MSPs, ISVs, OEM partners in the account' },
      },
      required: ['summary', 'partnerGrowthStrategy', 'cloudProviders'],
    },
    keyStakeholders: {
      type: 'STRING',
      nullable: true,
      description: 'Names, titles, engagement status from the provided stakeholder data. Never fabricate stakeholder names or titles. Must identify the Economic Buyer if stakeholder data exists — distinct from Champion. Include their P&L authority, decision influence, and relationship to the deal (CY27 requirement).',
    },
    technicalLandscape: {
      type: 'OBJECT',
      nullable: true,
      description: 'Structured technical landscape with per-TDP assessments, security/sovereignty analysis, and optional key applications and hardware context.',
      properties: {
        summary: { type: 'STRING', description: 'Executive summary of technical landscape and competition' },
        tdpAssessments: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              tdpName: { type: 'STRING', description: 'TDP name: Server/Cloud OS, Virtualization, Container Management, Application Platform, Mission Critical Automation, or Red Hat AI' },
              analysis: { type: 'STRING', description: 'Customer usage, competition, and Red Hat fit for this TDP' },
              maturity: { type: 'STRING', description: 'Adoption maturity: 1=Initial/Ad-Hoc, 2=Basic/Developing, 3=Repeatable, 4=Managed, 5=Optimized' },
            },
            required: ['tdpName', 'analysis', 'maturity'],
          },
        },
        securitySovereignty: { type: 'STRING', description: 'CY27 Q#16: Security, Compliance, Sovereignty & Accessibility — connection to Sovereignty and Lightwell motions' },
        keyApplications: { type: 'STRING', nullable: true, description: 'Key customer applications and workloads' },
        hardwareStorage: { type: 'STRING', nullable: true, description: 'Hardware and storage landscape' },
      },
      required: ['summary', 'tdpAssessments', 'securitySovereignty'],
    },
    customerSuccess: {
      type: 'STRING',
      nullable: true,
      description: 'Health assessment, open cases, risk factors from the provided case and health data. Case counts and details MUST match the provided data.',
    },
    whitespaceMap: {
      type: 'STRING',
      nullable: true,
      description: 'A markdown table mapping Business Units/Functions (rows) against Red Hat products (columns: RHEL, Ansible Automation, OpenShift, OpenShift Virt, RHEL AI / OpenShift AI) with opportunity level indicators. Base opportunity levels on evidence from the provided context.',
    },
    initiatives: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        properties: {
          customerObjective: {
            type: 'STRING',
            description: 'Customer objective addressed — must reference a real objective from the provided intelligence.',
          },
          redHatSolution: {
            type: 'STRING',
            description: 'Red Hat solution that maps to this objective.',
          },
          estimatedDealSize: {
            type: 'STRING',
            nullable: true,
            description: 'Estimated deal size from pipeline data. If no pipeline data exists for this initiative, set to null. NEVER fabricate dollar figures.',
          },
          timeline: {
            type: 'STRING',
            nullable: true,
            description: 'Timeline based on available context. Set to null if no timeline data exists.',
          },
          nextSteps: {
            type: 'STRING',
            description: 'Concrete next steps referencing specific people and actions from the context.',
          },
          taggedOpportunity: {
            type: 'STRING',
            nullable: true,
            description: 'Tagged potential opportunity from pipeline data. Set to null if no matching opportunity exists.',
          },
        },
        required: ['customerObjective', 'redHatSolution', 'nextSteps'],
      },
    },
    actionsNextSteps: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        properties: {
          action: { type: 'STRING', description: 'Specific action item. Include quarterly review milestones and continuous planning cadence items per CY27 CAPI.' },
          owner: { type: 'STRING', description: 'Owner — use AE or ASA name from the provided account team data.' },
          targetDate: { type: 'STRING', nullable: true, description: 'Target date if known. Set to null if not determinable from context.' },
          status: { type: 'STRING', description: 'Current status (e.g., Not Started, In Progress).' },
        },
        required: ['action', 'owner', 'status'],
      },
    },
    solutionPlaysReferenced: {
      type: 'ARRAY',
      nullable: true,
      description: 'Solution plays cited in this plan. Each entry MUST come from the VERIFIED SOLUTION PLAYS section. Never fabricate play references.',
      items: {
        type: 'OBJECT',
        properties: {
          playName: { type: 'STRING', description: 'Exact play name from the VERIFIED SOLUTION PLAYS section.' },
          customerWin: { type: 'STRING', nullable: true, description: 'Exact customer win cited. Set to null if no win exists for this play.' },
        },
        required: ['playName'],
      },
    },
  },
  required: [
    'executiveSummary', 'teamMembers', 'customerView',
    'accountIntelligence', 'whitespaceMap', 'initiatives', 'actionsNextSteps',
  ],
}

// ── System prompt (validated in generate-test.ts proof-of-concept) ────────────

const SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect assistant. Your job is to produce a complete, structured Account Plan for a customer — modeled after the sample plan provided.

## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. Every claim, metric, dollar amount, date, and name MUST come from the provided context data.
2. If the context does not contain a specific data point for a field, set that field to null.
3. Never extrapolate, estimate, or generate plausible-sounding data that is not in the context.
4. When citing a customer win or peer metric, it MUST come from the VERIFIED SOLUTION PLAYS section. Use the EXACT company name and metric.
5. Generic peer references ("industry peers", "companies like yours", "similar organizations") are PROHIBITED. Either cite a named company from the solution plays data or set peerProof to null.
6. Pipeline dollar figures MUST match the amounts in the provided pipeline data. Do not round, estimate, or fabricate financial figures.

Rules:
- Answer EVERY question and section shown in the questions reference (the image)
- Use the sample account plan as your structural template — match its sections, depth, and style
- Use the customer intelligence data as your primary source for specific facts, numbers, and insights
- Be specific: use customer names, product names, dollar amounts, dates where available
- Write as if the Account Solution Architect is the author
- Output clean markdown with ## section headers matching the sample plan structure
- Do NOT include placeholder text — if data is missing, set the field to null

REQUIRED SECTIONS — every plan MUST include all of these:
1. Executive Summary (scorecard overview)
2. Team Members (AE + ASA names and roles)
3. Scorecard (with % scores per category)
4. Customer View (all numbered questions: ACV ambition, ACV goal, growth %, why Red Hat, etc.)
5. Account Intelligence — structured with subsections: (1) Executive Summary of customer objectives/challenges/environment, (2) Business Objectives, Challenges & Key Initiatives with IT funding analysis, (3) Market & Competition analysis, plus Innovation Adopter Persona (Rogers Diffusion)
6. Customer Ecosystem — structured with subsections: Executive Summary, Partner Growth Strategy (CY27 Q#4: how to leverage Services Partners, VARs, Distributors), Cloud Providers with marketplace spend, Committed Spend Agreements, Cloud Adoption Level, Specialized Partners (SIs, MSPs, ISVs, OEMs)
7. Key Stakeholders (names, titles, engagement status, Economic Buyer identification)
8. Technical Landscape — structured per-TDP with: executive summary, then per-TDP assessment for each of (Server/Cloud OS, Virtualization, Container Management, Application Platform, Mission Critical Automation, Red Hat AI) with analysis + maturity rating (1=Initial/Ad-Hoc through 5=Optimized), plus Q#16 Security/Compliance/Sovereignty & Accessibility, Key Customer Applications & Workloads, Hardware & Storage
9. Customer Success (health, open cases, risk)
10. Whitespace Map — REQUIRED: a markdown table mapping customer Business Units/Functions (rows) against Red Hat products (columns: RHEL, Ansible Automation, OpenShift, OpenShift Virt, RHEL AI / OpenShift AI) with opportunity level (🟢 High / 🟡 Medium / ⚪ Low) and Opportunity Status
11. Initiatives — REQUIRED: 3-5 customer-centric initiatives, each with: Customer Objective Addressed, Red Hat Solution, Estimated Deal Size, Timeline, Next Steps, Tagged Potential Opportunity
12. Actions & Next Steps — REQUIRED: a numbered markdown table with columns: #, Action, Owner (use AE or ASA name), Target Date, Status`

// ── Drive: ensure Account Plans subfolder ────────────────────────────────────

/**
 * Find or create "Account Plans" subfolder inside the customer's Drive folder.
 * This is a SEPARATE folder from "Account Intelligence" to avoid feedback loops
 * into the brief pipeline.
 */
export async function ensureAccountPlansSubfolder(customerFolderId: string): Promise<string> {
  // ADR-0016: drive-client supplies supportsAllDrives unconditionally.
  return driveClient.ensureChildFolder(customerFolderId, 'Account Plans')
}

// ── Upload markdown to Drive as a Google Doc ─────────────────────────────────

// Thin wrapper: delegates to driveClient.upsertDoc with rewrite semantics (BKL-ARCH-07c).
// rewrite preserves the docId / Drive URL on updates — account plan callers depend on a stable URL.
async function upsertAccountPlanDoc(
  folderId: string,
  docName: string,
  markdownContent: string,
): Promise<string> {
  return driveClient.upsertDoc(folderId, docName, markdownContent, { onConflict: 'rewrite' })
}

// ── Gemini multimodal call via callGemini() gateway ─────────────────────────

async function callGeminiForAccountPlan(opts: {
  systemPrompt: string
  userPrompt: string
  pdfParts?: { inlineData: { mimeType: string; data: string } }[]
  temperature?: number
  customerName?: string
  responseSchema?: object
}): Promise<string> {
  const result = await callGemini(opts.systemPrompt, opts.userPrompt, {
    callType: 'account-plan-generation',
    customerName: opts.customerName,
    inlineDataParts: opts.pdfParts?.map(p => ({ mimeType: p.inlineData.mimeType, data: p.inlineData.data })),
    timeoutMs: 300_000,
    temperature: opts.temperature ?? 0.3,
    responseSchema: opts.responseSchema,
  })
  if (!result.text) throw new Error('Gemini returned empty response')
  return result.text
}

// ── ADR-040: Convert structured JSON response back to markdown ──────────────

function formatGeminiString(s: string): string {
  return s
    .replace(/(?<!\n)(\d+)\.\s+/g, '\n$1. ')
    .replace(/(?<!\n)\*\s+/g, '\n* ')
    .replace(/^\n/, '')
}

function convertAccountPlanJsonToMarkdown(rawText: string): string {
  let parsed: any
  try {
    parsed = JSON.parse(rawText)
  } catch {
    console.warn('[acct-plan] Failed to parse structured JSON response, using raw text')
    return rawText
  }

  const parts: string[] = []

  if (parsed.executiveSummary) {
    parts.push(`## Executive Summary\n\n${formatGeminiString(parsed.executiveSummary)}`)
  }
  if (parsed.teamMembers) {
    const formatted = parsed.teamMembers
      .replace(/\.\s+(?=[A-Z])/g, '.\n- ')
      .replace(/^(?!-)/, '- ')
    parts.push(`## Team Members\n\n${formatted}`)
  }
  if (parsed.scorecard) {
    parts.push(`## Scorecard\n\n${formatGeminiString(parsed.scorecard)}`)
  }
  if (parsed.customerView) {
    parts.push(`## Customer View\n\n${formatGeminiString(parsed.customerView)}`)
  }
  if (parsed.accountIntelligence) {
    if (typeof parsed.accountIntelligence === 'string') {
      parts.push(`## Account Intelligence\n\n${parsed.accountIntelligence}`)
    } else {
      const ai = parsed.accountIntelligence
      const aiParts: string[] = ['## Account Intelligence']
      if (ai.executiveSummary) aiParts.push(`### 1. Executive Summary\n\n${ai.executiveSummary}`)
      if (ai.businessObjectives) aiParts.push(`### 2. Customer Business Objectives, Challenges & Key Initiatives\n\n${ai.businessObjectives}`)
      if (ai.marketCompetition) aiParts.push(`### 3. Customer's Market & Competition\n\n${ai.marketCompetition}`)
      if (ai.innovationPersona) aiParts.push(`### Innovation Adopter Persona\n\n${ai.innovationPersona}`)
      parts.push(aiParts.join('\n\n'))
    }
  }
  if (parsed.customerEcosystem) {
    if (typeof parsed.customerEcosystem === 'string') {
      parts.push(`## Customer Ecosystem\n\n${parsed.customerEcosystem}`)
    } else {
      const ce = parsed.customerEcosystem
      const ceParts: string[] = ['## Customer Ecosystem']
      if (ce.summary) ceParts.push(`### Executive Summary\n\n${ce.summary}`)
      if (ce.partnerGrowthStrategy) ceParts.push(`### Partner Growth Strategy (CY27 Q#4)\n\n${ce.partnerGrowthStrategy}`)
      if (ce.cloudProviders) ceParts.push(`### Cloud Providers\n\n${ce.cloudProviders}`)
      if (ce.committedSpend) ceParts.push(`### Committed Spend Agreements\n\n${ce.committedSpend}`)
      if (ce.cloudAdoptionLevel) ceParts.push(`### Cloud Adoption Level\n\n${ce.cloudAdoptionLevel}`)
      if (ce.specializedPartners) ceParts.push(`### Specialized Partners\n\n${ce.specializedPartners}`)
      parts.push(ceParts.join('\n\n'))
    }
  }
  if (parsed.keyStakeholders) {
    parts.push(`## Key Stakeholders\n\n${formatGeminiString(parsed.keyStakeholders)}`)
  }
  if (parsed.technicalLandscape) {
    if (typeof parsed.technicalLandscape === 'string') {
      parts.push(`## Technical Landscape\n\n${parsed.technicalLandscape}`)
    } else {
      const tl = parsed.technicalLandscape
      const tlParts: string[] = ['## Technical Landscape']
      if (tl.summary) tlParts.push(tl.summary)
      if (tl.tdpAssessments && Array.isArray(tl.tdpAssessments)) {
        for (const tdp of tl.tdpAssessments) {
          tlParts.push(`### ${tdp.tdpName}\n\n${tdp.analysis}\n\n**Adoption Maturity:** ${tdp.maturity}`)
        }
      }
      if (tl.securitySovereignty) tlParts.push(`### Security, Compliance, Sovereignty & Accessibility\n\n${tl.securitySovereignty}`)
      if (tl.keyApplications) tlParts.push(`### Key Customer Applications & Workloads\n\n${tl.keyApplications}`)
      if (tl.hardwareStorage) tlParts.push(`### Hardware & Storage\n\n${tl.hardwareStorage}`)
      parts.push(tlParts.join('\n\n'))
    }
  }
  if (parsed.customerSuccess) {
    parts.push(`## Customer Success\n\n${formatGeminiString(parsed.customerSuccess)}`)
  }
  if (parsed.whitespaceMap) {
    parts.push(`## Whitespace Map\n\n${parsed.whitespaceMap}`)
  }

  // Initiatives — convert structured array to markdown
  if (parsed.initiatives && Array.isArray(parsed.initiatives) && parsed.initiatives.length > 0) {
    const initLines = parsed.initiatives.map((init: any, i: number) => {
      const lines = [`### Initiative ${i + 1}: ${init.customerObjective}`]
      lines.push(`- **Red Hat Solution:** ${init.redHatSolution}`)
      if (init.estimatedDealSize) lines.push(`- **Estimated Deal Size:** ${init.estimatedDealSize}`)
      if (init.timeline) lines.push(`- **Timeline:** ${init.timeline}`)
      lines.push(`- **Next Steps:** ${init.nextSteps}`)
      if (init.taggedOpportunity) lines.push(`- **Tagged Opportunity:** ${init.taggedOpportunity}`)
      return lines.join('\n')
    })
    parts.push(`## Initiatives\n\n${initLines.join('\n\n')}`)
  }

  // Actions & Next Steps — convert structured array to markdown table
  if (parsed.actionsNextSteps && Array.isArray(parsed.actionsNextSteps) && parsed.actionsNextSteps.length > 0) {
    const tableHeader = '| # | Action | Owner | Target Date | Status |\n|---|--------|-------|-------------|--------|'
    const tableRows = parsed.actionsNextSteps.map((a: any, i: number) =>
      `| ${i + 1} | ${a.action} | ${a.owner} | ${a.targetDate ?? 'TBD'} | ${a.status} |`
    )
    parts.push(`## Actions & Next Steps\n\n${tableHeader}\n${tableRows.join('\n')}`)
  }

  // Solution plays referenced — informational section
  if (parsed.solutionPlaysReferenced && Array.isArray(parsed.solutionPlaysReferenced) && parsed.solutionPlaysReferenced.length > 0) {
    const playLines = parsed.solutionPlaysReferenced.map((p: any) => {
      const win = p.customerWin ? ` — Customer Win: ${p.customerWin}` : ''
      return `- ${p.playName}${win}`
    })
    parts.push(`## Solution Plays Referenced\n\n${playLines.join('\n')}`)
  }

  let result = parts.join('\n\n')
  // Strip lines where Gemini wrote "null" as a value — looks broken to users
  result = result.replace(/^.*?:\s*null\s*$/gm, '')
  result = result.replace(/\n{3,}/g, '\n\n')
  return result
}

// ── Core generation logic ────────────────────────────────────────────────────

export interface AccountPlanResult {
  markdown: string
  generatedAt: string
  driveUrl: string
}

// ── #978: CY27 Midyear Update — focused 5-section output ───────────────────

export interface MidyearUpdateResult {
  sections: {
    initiatives: string
    economicBuyer: string
    ecosystemStrategy: string
    securitySovereignty: string
    timeframeGuidance: string
  }
  generatedAt: string
}

const MIDYEAR_UPDATE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    initiatives: {
      type: 'STRING',
      description: '2 detailed customer initiatives for 2027 — new topics or extension of existing. Written in the customer\'s terms with success metrics, target value, and timeline. Format as initiative cards ready to paste into RHSC.',
    },
    economicBuyer: {
      type: 'STRING',
      description: 'Identify the Economic Buyer from stakeholder/intelligence data. Include: name (if in data), title, P&L authority, veto power, strategic focus. Format as account map entry ready for RHSC.',
    },
    ecosystemStrategy: {
      type: 'STRING',
      description: 'Answer to new scorecard Q#4: "How do you plan to leverage Services Partners, VARs, and Distributors to drive growth in this account?" Based on partner/channel data.',
    },
    securitySovereignty: {
      type: 'STRING',
      description: 'Answer to updated scorecard Q#16: Security, Compliance, Sovereignty & Accessibility insights in relation to Red Hat\'s value. Based on technical landscape data.',
    },
    timeframeGuidance: {
      type: 'STRING',
      description: 'Recommendation on whether to create a Follow-up plan (clone) or extend current plan timeframe to 2027. Based on whether existing plan exists and its status.',
    },
  },
  required: ['initiatives', 'economicBuyer', 'ecosystemStrategy', 'securitySovereignty', 'timeframeGuidance'],
}

const MIDYEAR_SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect assistant. Your job is to produce a CY27 Midyear Update — 5 paste-ready sections for the RHSC (Red Hat Sales Center) account plan scorecard.

## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. Every claim, metric, dollar amount, date, and name MUST come from the provided context data.
2. If the context does not contain a specific data point, say so explicitly rather than fabricating.
3. Never extrapolate, estimate, or generate plausible-sounding data that is not in the context.
4. Pipeline dollar figures MUST match the amounts in the provided data.

## OUTPUT REQUIREMENTS
Produce ONLY these 5 sections — no preamble, no executive summary, no extra commentary:

1. **2027 Initiatives** — 2 detailed customer initiatives for 2027. Each should include: initiative name, description in customer terms, success metrics, target value, timeline, and relevant Red Hat solution. Format as initiative cards ready to paste into RHSC.

2. **Economic Buyer** — Identify from stakeholder data: name (if available), title, P&L authority, veto power, strategic focus. If no clear Economic Buyer is identifiable from the data, state that explicitly with a recommendation. Format as an account map entry.

3. **Ecosystem Strategy** — Answer scorecard Q#4: "How do you plan to leverage Services Partners, VARs, and Distributors to drive growth in this account?" Ground in partner/channel data from the intelligence.

4. **Security & Sovereignty** — Answer updated scorecard Q#16: Security, Compliance, Sovereignty & Accessibility insights. Connect to Red Hat's Sovereignty and Lightwell motions where relevant.

5. **Timeframe Guidance** — Recommend whether to create a Follow-up plan (clone) or extend the current plan timeframe to 2027. Base on existing plan status and customer fiscal cycle.`

/**
 * Generate a full account plan for a customer.
 *
 * Sources:
 * 1. Sample plan markdown (structural template)
 * 2. Questions PDF as base64 (image-based reference)
 * 3. Playbook markdown (guidance, first 8000 chars)
 * 4. Customer intelligence from cache (company + product fields)
 */
export async function generateAccountPlan(
  customer: Customer,
  cacheDir: string,
  configDir: string,
  opts?: { playbookOverride?: string; cachePrefix?: string; label?: string },
): Promise<AccountPlanResult> {
  const slug = toSlug(customer.name)
  const label = opts?.label ?? 'acct-plan'
  const cachePrefix = opts?.cachePrefix ?? 'account-plan'
  console.log(`[${label}] Generating account plan for ${customer.name} (${slug})`)

  // Get operator profile
  const operatorProfile = getOperatorProfile()
  const operatorName = operatorProfile?.name ?? 'the Account Solution Architect'
  const operatorTitle = operatorProfile?.title ?? 'Account Solution Architect'

  // 1. Load sample plan markdown (cache-first, baked-in fallback)
  const samplePlanPath = resolveTemplatePath('sample.md') ?? resolve(APP_CONFIG_DIR, 'sample.md')
  const samplePlan = readFileSync(samplePlanPath, 'utf-8')

  // 2. Load questions PDF as base64 for vision (cache-first, baked-in fallback)
  const questionsPdfPath = resolveTemplatePath('questions.pdf') ?? resolve(APP_CONFIG_DIR, 'questions.pdf')
  const questionsB64 = readFileSync(questionsPdfPath).toString('base64')

  // 3. Load playbook/planning deck (override or default)
  const playbookFile = opts?.playbookOverride ?? 'playbook.md'
  const playbookPath = resolveTemplatePath(playbookFile) ?? resolve(APP_CONFIG_DIR, playbookFile)
  const playbookMaxChars = opts?.playbookOverride ? 15000 : 8000
  const playbook = readFileSync(playbookPath, 'utf-8').substring(0, playbookMaxChars)

  // 4. Load customer intelligence from cache
  const intelPath = resolve(cacheDir, 'intelligence', `${slug}.json`)
  let companyIntel = ''
  let productIntel = ''
  let customerDisplayName = customer.name
  try {
    const intel = JSON.parse(readFileSync(intelPath, 'utf-8'))
    companyIntel = intel.company ?? ''
    productIntel = intel.products ? JSON.stringify(intel.products, null, 2) : ''
    customerDisplayName = intel.customerName ?? customer.name
  } catch {
    console.warn(`[acct-plan] No intelligence cache for ${slug} — generating with limited data`)
  }

  // Look up AE name from customers.json
  const aeName = customer.ae ?? 'Account Executive'
  console.log(`[acct-plan] AE for ${customerDisplayName}: ${aeName}`)

  // #786: Load templateAll deterministic sections for signal context enrichment
  let signalContext = ''
  let solutionPlaysContext = ''
  try {
    const teamMembers = getAccountTeam(customer)
    const { registrySignals } = await loadCustomerSignals(slug, customer.name, { ensureFresh: true })
    const templateResult = await templateAll(registrySignals, teamMembers, { format: 'playbook' })
    signalContext = templateResult.deterministic || ''

    // ADR-040: Serialize solutionPlays into VERIFIED SOLUTION PLAYS section for grounding
    const structuredPlays = templateResult.structured?.solutionPlays ?? []
    if (structuredPlays.length > 0) {
      solutionPlaysContext = '\n## VERIFIED SOLUTION PLAYS (Source: SalesHub — cite these for peer proof, do not fabricate alternatives)\n\n'
      for (const play of structuredPlays) {
        solutionPlaysContext += `### Play: "${play.playName}"\n`
        solutionPlaysContext += `- TDP: ${play.tdp}\n`
        if (play.customerWins?.length) solutionPlaysContext += `- Customer Wins: ${JSON.stringify(play.customerWins)}\n`
        if (play.realWorldExamples?.length) solutionPlaysContext += `- Real-World Examples: ${JSON.stringify(play.realWorldExamples)}\n`
        if (play.extractedMetrics?.length) solutionPlaysContext += `- Verified Metrics: ${JSON.stringify(play.extractedMetrics)}\n`
        if (play.talkTrack) solutionPlaysContext += `- Talk Track: ${play.talkTrack.slice(0, 300)}\n`
        solutionPlaysContext += '\n'
      }
    }
  } catch (e: any) {
    console.warn(`[acct-plan] templateAll enrichment failed (non-fatal): ${e.message}`)
  }

  // Assemble user prompt (same structure as validated in generate-test.ts)
  const signalSection = signalContext ? `\n\n### Signal Context\n${signalContext}` : ''
  const userPrompt = `## Sample Account Plan (use as structural template)
${samplePlan.substring(0, 15000)}

## Customer: ${customerDisplayName}
## Account Team
- Account Executive (AE): ${aeName}
- ${operatorTitle} (ASA): ${operatorName}

### Company Intelligence
${companyIntel.substring(0, 8000)}

### Product Intelligence
${productIntel.substring(0, 5000)}${signalSection}
${solutionPlaysContext}
## Account Planning Playbook (Guidance)
${playbook}

---
Now generate a complete Account Plan for ${customerDisplayName} following the sample structure above and answering all questions from the reference image. Include ${aeName} as the AE and ${operatorName} as the ASA in the team members section.`

  // Call Gemini with multimodal (text + PDF image) via callGemini() gateway
  // ADR-040: temperature 0.3, structured responseSchema
  const rawResponse = await callGeminiForAccountPlan({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    pdfParts: [{ inlineData: { mimeType: 'application/pdf', data: questionsB64 } }],
    temperature: 0.3,
    customerName: customer.name,
    responseSchema: ACCOUNT_PLAN_RESPONSE_SCHEMA,
  })

  // ADR-040: Parse structured JSON response and convert to markdown
  const rawMarkdown = convertAccountPlanJsonToMarkdown(rawResponse)

  // Quality gate (ADR-024) — validate and retry if below threshold
  const gateResult = await validateAndRetry(
    rawMarkdown,
    { validator: accountPlanValidator },
    async (failures) => {
      const feedback = formatFailureFeedback(failures)
      const retryResponse = await callGeminiForAccountPlan({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPrompt + '\n\n' + feedback,
        pdfParts: [{ inlineData: { mimeType: 'application/pdf', data: questionsB64 } }],
        temperature: 0.3,
        customerName: customer.name,
        responseSchema: ACCOUNT_PLAN_RESPONSE_SCHEMA,
      })
      return convertAccountPlanJsonToMarkdown(retryResponse)
    }
  )
  const markdown = gateResult.output

  const generatedAt = new Date().toISOString()

  // Write to cache
  const intelDir = resolve(cacheDir, 'intelligence')
  mkdirSync(intelDir, { recursive: true })
  const outputPath = resolve(intelDir, `${slug}-${cachePrefix}.md`)
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const fullContent = `<!-- Generated: ${generatedAt} -->\n\n${markdown}`
  writeFileSync(outputPath, fullContent, { mode: 0o600 })
  console.log(`[${label}] Written to ${outputPath} (${markdown.length} chars, quality: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`)

  // Write quality scorecard meta alongside the plan
  const metaPath = resolve(intelDir, `${slug}-${cachePrefix}-meta.json`)
  writeJsonAtomic(metaPath, {
    customerName: customer.name,
    generatedAt,
    markdownLength: markdown.length,
    qualityScorecard: gateResult.scorecard,
  })

  // Upload to Drive
  let driveUrl = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const plansFolderId = await ensureAccountPlansSubfolder(customerFolderId)
    const docSuffix = cachePrefix === 'account-plan' ? '' : ` ${cachePrefix.replace('account-plan-', '').toUpperCase()}`
    const docName = `${customer.name} - Account Plan${docSuffix}`
    driveUrl = await upsertAccountPlanDoc(plansFolderId, docName, `Generated: ${timestamp}\n\n${markdown}`)
    console.log(`[${label}] Uploaded to Drive: ${driveUrl}`)
  } catch (e: any) {
    console.error(`[${label}] Drive upload failed (non-fatal): ${e.message}`)
    // Non-fatal — the cached markdown is still available
  }

  return { markdown, generatedAt, driveUrl }
}

// ── Read cached account plan ─────────────────────────────────────────────────

export interface CachedAccountPlan {
  markdown: string
  generatedAt: string
  driveUrl: string
}

export function readAccountPlan(
  customerSlug: string,
  cacheDir: string,
): CachedAccountPlan | null {
  const planPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan.md`)
  try {
    if (!existsSync(planPath)) return null
    const content = readFileSync(planPath, 'utf-8')
    if (!content || content.length < 50) return null

    // Extract generatedAt from the HTML comment header
    const timestampMatch = content.match(/<!-- Generated: (.+?) -->/)
    const generatedAt = timestampMatch?.[1] ?? statSync(planPath).mtime.toISOString()

    // Strip the comment header for display
    const markdown = content.replace(/<!-- Generated: .+? -->\n\n/, '')

    // Try to read drive URL from a sidecar file
    let driveUrl = ''
    const metaPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan-meta.json`)
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      driveUrl = meta.driveUrl ?? ''
    } catch { /* no meta file yet */ }

    return { markdown, generatedAt, driveUrl }
  } catch {
    return null
  }
}

/**
 * Save drive URL metadata alongside the cached plan.
 */
function savePlanMeta(cacheDir: string, customerSlug: string, driveUrl: string, generatedAt: string): void {
  const metaPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan-meta.json`)
  writeFileSync(metaPath, JSON.stringify({ driveUrl, generatedAt }, null, 2), { mode: 0o600 })
}

// ── Enhanced generate that also persists drive URL ───────────────────────────

export async function generateAndSaveAccountPlan(
  customer: Customer,
  cacheDir: string,
  configDir: string,
): Promise<AccountPlanResult> {
  const result = await generateAccountPlan(customer, cacheDir, configDir)
  const slug = toSlug(customer.name)
  savePlanMeta(cacheDir, slug, result.driveUrl, result.generatedAt)
  return result
}

// ── #978: CY27 Midyear Update generation ────────────────────────────────────

function formatInitiativesSection(raw: string): string {
  if (!raw) return ''
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return raw
    return arr.map((item: any) => {
      const name = item.initiativeName ?? item.name ?? 'Untitled Initiative'
      const desc = item.description ?? ''
      const lines = [`### Initiative: ${name}`, desc]
      if (item.successMetrics) lines.push(`- **Success Metrics:** ${item.successMetrics}`)
      if (item.targetValue) lines.push(`- **Target Value:** ${item.targetValue}`)
      if (item.timeline) lines.push(`- **Timeline:** ${item.timeline}`)
      if (item.relevantSolution) lines.push(`- **Red Hat Solution:** ${item.relevantSolution}`)
      return lines.join('\n')
    }).join('\n\n')
  } catch {
    return raw
  }
}

function formatEconomicBuyerSection(raw: string): string {
  if (!raw) return ''
  try {
    const obj = JSON.parse(raw)
    if (typeof obj !== 'object' || obj === null || !obj.name) return raw
    const lines = [`**${obj.name}**${obj.title ? `, ${obj.title}` : ''}`]
    if (obj.pnlAuthority) lines.push(`- **P&L Authority:** ${obj.pnlAuthority}`)
    if (obj.vetoPower) lines.push(`- **Veto Power:** ${obj.vetoPower}`)
    if (obj.strategicFocus) lines.push(`- **Strategic Focus:** ${obj.strategicFocus}`)
    return lines.join('\n')
  } catch {
    return raw
  }
}

export async function generateMidyearUpdate(
  customer: Customer,
  cacheDir: string,
  configDir: string,
): Promise<MidyearUpdateResult> {
  const slug = toSlug(customer.name)
  console.log(`[midyear] Generating CY27 midyear update for ${customer.name} (${slug})`)

  const operatorProfile = getOperatorProfile()
  const operatorName = operatorProfile?.name ?? 'the Account Solution Architect'
  const operatorTitle = operatorProfile?.title ?? 'Account Solution Architect'

  const playbookPath = resolveTemplatePath('playbook.md') ?? resolve(APP_CONFIG_DIR, 'playbook.md')
  const playbook = readFileSync(playbookPath, 'utf-8').substring(0, 8000)

  const intelPath = resolve(cacheDir, 'intelligence', `${slug}.json`)
  let companyIntel = ''
  let productIntel = ''
  let customerDisplayName = customer.name
  try {
    const intel = JSON.parse(readFileSync(intelPath, 'utf-8'))
    companyIntel = intel.company ?? ''
    productIntel = intel.products ? JSON.stringify(intel.products, null, 2) : ''
    customerDisplayName = intel.customerName ?? customer.name
  } catch {
    console.warn(`[midyear] No intelligence cache for ${slug} — generating with limited data`)
  }

  const aeName = customer.ae ?? 'Account Executive'

  let signalContext = ''
  try {
    const teamMembers = getAccountTeam(customer)
    const { registrySignals } = await loadCustomerSignals(slug, customer.name, { ensureFresh: true })
    const templateResult = await templateAll(registrySignals, teamMembers, { format: 'playbook' })
    signalContext = templateResult.deterministic || ''
  } catch (e: any) {
    console.warn(`[midyear] templateAll enrichment failed (non-fatal): ${e.message}`)
  }

  const existingPlan = readAccountPlan(slug, cacheDir)
  const existingPlanSection = existingPlan
    ? `\n\n### Existing Account Plan (generated ${existingPlan.generatedAt})\nA full account plan already exists. Consider whether to clone or extend.\n`
    : '\n\n### Existing Account Plan\nNo existing account plan found for this customer.\n'

  const signalSection = signalContext ? `\n\n### Signal Context\n${signalContext}` : ''
  const userPrompt = `## Customer: ${customerDisplayName}
## Account Team
- Account Executive (AE): ${aeName}
- ${operatorTitle} (ASA): ${operatorName}

### Company Intelligence
${companyIntel.substring(0, 8000)}

### Product Intelligence
${productIntel.substring(0, 5000)}${signalSection}${existingPlanSection}
## CY27 Account Planning Playbook
${playbook}

---
Generate a CY27 Midyear Update for ${customerDisplayName} with the 5 required sections. Use the playbook guidance for CY27 requirements.`

  const rawResponse = await callGeminiForAccountPlan({
    systemPrompt: MIDYEAR_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.3,
    customerName: customer.name,
    responseSchema: MIDYEAR_UPDATE_RESPONSE_SCHEMA,
  })

  let sections: MidyearUpdateResult['sections']
  try {
    const parsed = JSON.parse(rawResponse)
    sections = {
      initiatives: formatInitiativesSection(parsed.initiatives ?? ''),
      economicBuyer: formatEconomicBuyerSection(parsed.economicBuyer ?? ''),
      ecosystemStrategy: parsed.ecosystemStrategy ?? '',
      securitySovereignty: parsed.securitySovereignty ?? '',
      timeframeGuidance: parsed.timeframeGuidance ?? '',
    }
  } catch {
    sections = {
      initiatives: rawResponse,
      economicBuyer: '',
      ecosystemStrategy: '',
      securitySovereignty: '',
      timeframeGuidance: '',
    }
  }

  const generatedAt = new Date().toISOString()

  const intelDir = resolve(cacheDir, 'intelligence')
  mkdirSync(intelDir, { recursive: true })

  const mdContent = `<!-- Generated: ${generatedAt} -->\n\n# CY27 Midyear Update — ${customerDisplayName}\n\n## 2027 Initiatives\n${sections.initiatives}\n\n## Economic Buyer\n${sections.economicBuyer}\n\n## Ecosystem Strategy\n${sections.ecosystemStrategy}\n\n## Security & Sovereignty\n${sections.securitySovereignty}\n\n## Timeframe Guidance\n${sections.timeframeGuidance}`
  const outputPath = resolve(intelDir, `${slug}-midyear-update.md`)
  writeFileSync(outputPath, mdContent, { mode: 0o600 })
  console.log(`[midyear] Written to ${outputPath}`)

  const metaPath = resolve(intelDir, `${slug}-midyear-update-meta.json`)
  writeJsonAtomic(metaPath, { customerName: customer.name, generatedAt })

  return { sections, generatedAt }
}

export function readMidyearUpdate(
  customerSlug: string,
  cacheDir: string,
): MidyearUpdateResult | null {
  const filePath = resolve(cacheDir, 'intelligence', `${customerSlug}-midyear-update.md`)
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf-8')
    if (!content || content.length < 50) return null

    const timestampMatch = content.match(/<!-- Generated: (.+?) -->/)
    const generatedAt = timestampMatch?.[1] ?? statSync(filePath).mtime.toISOString()

    const extractSection = (heading: string): string => {
      const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`)
      const m = content.match(re)
      return m?.[1]?.trim() ?? ''
    }

    return {
      sections: {
        initiatives: extractSection('2027 Initiatives'),
        economicBuyer: extractSection('Economic Buyer'),
        ecosystemStrategy: extractSection('Ecosystem Strategy'),
        securitySovereignty: extractSection('Security & Sovereignty'),
        timeframeGuidance: extractSection('Timeframe Guidance'),
      },
      generatedAt,
    }
  } catch {
    return null
  }
}

// ── #1017: CY27 Account Plan — thin wrappers over generateAccountPlan ──────

export async function generateAccountPlanCY27(
  customer: Customer,
  cacheDir: string,
  configDir: string,
): Promise<AccountPlanResult> {
  return generateAccountPlan(customer, cacheDir, configDir, {
    playbookOverride: 'cy27-planning-deck.txt',
    cachePrefix: 'account-plan-cy27',
    label: 'acct-plan-cy27',
  })
}

export function readAccountPlanCY27(
  customerSlug: string,
  cacheDir: string,
): CachedAccountPlan | null {
  const planPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan-cy27.md`)
  try {
    if (!existsSync(planPath)) return null
    const content = readFileSync(planPath, 'utf-8')
    if (!content || content.length < 50) return null

    const timestampMatch = content.match(/<!-- Generated: (.+?) -->/)
    const generatedAt = timestampMatch?.[1] ?? statSync(planPath).mtime.toISOString()
    const markdown = content.replace(/<!-- Generated: .+? -->\n\n/, '')

    let driveUrl = ''
    const metaPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan-cy27-meta.json`)
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      driveUrl = meta.driveUrl ?? ''
    } catch { /* no meta file yet */ }

    return { markdown, generatedAt, driveUrl }
  } catch {
    return null
  }
}
