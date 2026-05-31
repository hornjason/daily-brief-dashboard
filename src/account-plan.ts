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
import { validateAndRetry, formatFailureFeedback, type QualityScorecard } from './gemini-quality-gate.ts'
import { accountPlanValidator } from './quality-validators/account-plan-validator.ts'
import { writeJsonAtomic } from './lib/atomic-write.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import type { Customer } from './types.ts'
import { getOperatorProfile } from './account-team.ts'
import { CONFIG_DIR } from './lib/paths.ts'
import { callGemini } from './gemini-call.ts'

// ── Config paths ──────────────────────────────────────────────────────────────

const CONFIG_DIR_PATH  = CONFIG_DIR

// ── In-app config path (inside container: /app/config/account-plan/) ─────────
const APP_CONFIG_DIR = resolve(import.meta.dir, '../config/account-plan')

// ── System prompt (validated in generate-test.ts proof-of-concept) ────────────

const SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect assistant. Your job is to produce a complete, structured Account Plan for a customer — modeled after the sample plan provided.

Rules:
- Answer EVERY question and section shown in the questions reference (the image)
- Use the sample account plan as your structural template — match its sections, depth, and style
- Use the customer intelligence data as your primary source for specific facts, numbers, and insights
- Be specific: use customer names, product names, dollar amounts, dates where available
- Write as if the Account Solution Architect is the author
- Output clean markdown with ## section headers matching the sample plan structure
- Do NOT include placeholder text — if data is missing, write a concise inference based on what is known

REQUIRED SECTIONS — every plan MUST include all of these:
1. Executive Summary (scorecard overview)
2. Team Members (AE + ASA names and roles)
3. Scorecard (with % scores per category)
4. Customer View (all numbered questions: ACV ambition, ACV goal, growth %, why Red Hat, etc.)
5. Account Intelligence (company strategy, financial signals, industry pressures)
6. Customer Ecosystem (partners, technologies, integrations)
7. Key Stakeholders (names, titles, engagement status)
8. Technical Landscape (current tech stack, initiatives)
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
}): Promise<string> {
  const result = await callGemini(opts.systemPrompt, opts.userPrompt, {
    callType: 'account-plan-generation',
    customerName: opts.customerName,
    inlineDataParts: opts.pdfParts?.map(p => ({ mimeType: p.inlineData.mimeType, data: p.inlineData.data })),
    timeoutMs: 300_000,
    temperature: opts.temperature ?? 0.7,
  })
  if (!result.text) throw new Error('Gemini returned empty response')
  return result.text
}

// ── Core generation logic ────────────────────────────────────────────────────

export interface AccountPlanResult {
  markdown: string
  generatedAt: string
  driveUrl: string
}

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
): Promise<AccountPlanResult> {
  const slug = toSlug(customer.name)
  console.log(`[acct-plan] Generating account plan for ${customer.name} (${slug})`)

  // Get operator profile
  const operatorProfile = getOperatorProfile()
  const operatorName = operatorProfile?.name ?? 'the Account Solution Architect'
  const operatorTitle = operatorProfile?.title ?? 'Account Solution Architect'

  // 1. Load sample plan markdown
  const samplePlanPath = resolve(APP_CONFIG_DIR, 'sample.md')
  const samplePlan = readFileSync(samplePlanPath, 'utf-8')

  // 2. Load questions PDF as base64 for vision
  const questionsPdfPath = resolve(APP_CONFIG_DIR, 'questions.pdf')
  const questionsB64 = readFileSync(questionsPdfPath).toString('base64')

  // 3. Load playbook markdown (first 8000 chars)
  const playbookPath = resolve(APP_CONFIG_DIR, 'playbook.md')
  const playbook = readFileSync(playbookPath, 'utf-8').substring(0, 8000)

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

  // Assemble user prompt (same structure as validated in generate-test.ts)
  const userPrompt = `## Sample Account Plan (use as structural template)
${samplePlan.substring(0, 15000)}

## Customer: ${customerDisplayName}
## Account Team
- Account Executive (AE): ${aeName}
- ${operatorTitle} (ASA): ${operatorName}

### Company Intelligence
${companyIntel.substring(0, 8000)}

### Product Intelligence
${productIntel.substring(0, 5000)}

## Account Planning Playbook (Guidance)
${playbook}

---
Now generate a complete Account Plan for ${customerDisplayName} following the sample structure above and answering all questions from the reference image. Include ${aeName} as the AE and ${operatorName} as the ASA in the team members section.`

  // Call Gemini with multimodal (text + PDF image) via callGemini() gateway
  const rawMarkdown = await callGeminiForAccountPlan({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    pdfParts: [{ inlineData: { mimeType: 'application/pdf', data: questionsB64 } }],
    temperature: 0.7,
    customerName: customer.name,
  })

  // Quality gate (ADR-024) — validate and retry if below threshold
  const gateResult = await validateAndRetry(
    rawMarkdown,
    { validator: accountPlanValidator },
    async (failures) => {
      const feedback = formatFailureFeedback(failures)
      return callGeminiForAccountPlan({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPrompt + '\n\n' + feedback,
        pdfParts: [{ inlineData: { mimeType: 'application/pdf', data: questionsB64 } }],
        temperature: 0.7,
        customerName: customer.name,
      })
    }
  )
  const markdown = gateResult.output

  const generatedAt = new Date().toISOString()

  // Write to cache
  const intelDir = resolve(cacheDir, 'intelligence')
  mkdirSync(intelDir, { recursive: true })
  const outputPath = resolve(intelDir, `${slug}-account-plan.md`)
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const fullContent = `<!-- Generated: ${generatedAt} -->\n\n${markdown}`
  writeFileSync(outputPath, fullContent, { mode: 0o600 })
  console.log(`[acct-plan] Written to ${outputPath} (${markdown.length} chars, quality: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold})`)

  // Write quality scorecard meta alongside the plan
  const metaPath = resolve(intelDir, `${slug}-account-plan-meta.json`)
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
    const docName = `${customer.name} - Account Plan`
    driveUrl = await upsertAccountPlanDoc(plansFolderId, docName, `Generated: ${timestamp}\n\n${markdown}`)
    console.log(`[acct-plan] Uploaded to Drive: ${driveUrl}`)
  } catch (e: any) {
    console.error(`[acct-plan] Drive upload failed (non-fatal): ${e.message}`)
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
