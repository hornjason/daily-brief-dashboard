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
import { google } from 'googleapis'
import { getGeminiToken } from './gemini-auth.ts'
import { makeAuth } from './google.ts'
import { driveClient } from './lib/drive-client.ts'
import { getGeminiModel } from './settings-api.ts'
import { aes, customers } from './server-state.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { toSlug } from './cache-layer.ts'
import type { Customer } from './types.ts'

// ── Config paths ──────────────────────────────────────────────────────────────

const CONFIG_DIR_PATH  = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
const GDRIVE_TOKEN_PATH = process.env.GDRIVE_TOKEN ?? resolve(CONFIG_DIR_PATH, '.gdrive-server-credentials.json')

// ── In-app config path (inside container: /app/config/account-plan/) ─────────
const APP_CONFIG_DIR = resolve(import.meta.dir, '../config/account-plan')

// ── System prompt (validated in generate-test.ts proof-of-concept) ────────────

const SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect assistant. Your job is to produce a complete, structured Account Plan for a customer — modeled after the sample plan provided.

Rules:
- Answer EVERY question and section shown in the questions reference (the image)
- Use the sample account plan as your structural template — match its sections, depth, and style
- Use the customer intelligence data as your primary source for specific facts, numbers, and insights
- Be specific: use customer names, product names, dollar amounts, dates where available
- Write as if Jason Horn (Red Hat ASA) is the author
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

// ── Drive folder lookup (reuses same logic as account-intelligence.ts) ───────

async function findCustomerDriveFolder(customer: Customer): Promise<string> {
  if (customer.driveFolderId) return customer.driveFolderId

  const ae = aes.find(a => a.name === customer.ae)
  const aeFolderId = ae?.driveFolderId
  if (!aeFolderId) throw new Error(`No Drive folder found for customer ${customer.name} — no per-customer or AE folder ID`)

  // ADR-0016: drive-client supplies supportsAllDrives + 2-level fuzzy descent unconditionally.
  const matchId = await driveClient.findDescendantFolder(aeFolderId, customer.name, {
    fuzzy: true,
    maxDepth: 2,
  })
  if (matchId) return matchId

  throw new Error(`No Drive folder found for customer ${customer.name} under AE ${customer.ae}`)
}

// ── Upload markdown to Drive as a Google Doc ─────────────────────────────────

async function upsertAccountPlanDoc(
  folderId: string,
  docName: string,
  markdownContent: string,
): Promise<string> {
  const auth = makeAuth(GDRIVE_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const docs = google.docs({ version: 'v1', auth })

  // Check for existing doc
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${docName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
    fields: 'files(id)', pageSize: 1,
  })

  if (existing.data.files?.length && existing.data.files[0].id) {
    const docId = existing.data.files[0].id
    // Clear and rewrite
    const doc = await docs.documents.get({ documentId: docId })
    const contentArr = doc.data.body?.content ?? []
    const endIndex = contentArr.length > 0 ? (contentArr[contentArr.length - 1]?.endIndex ?? 1) : 1
    if (endIndex > 2) {
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }] },
      })
    }
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: markdownContent } }] },
    })
    return `https://docs.google.com/document/d/${docId}/edit`
  }

  // Create new doc
  const created = await drive.files.create({
    requestBody: {
      name: docName,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId],
    },
    fields: 'id',
  })
  if (!created.data.id) throw new Error('Failed to create account plan Google Doc')

  await docs.documents.batchUpdate({
    documentId: created.data.id,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: markdownContent } }] },
  })

  return `https://docs.google.com/document/d/${created.data.id}/edit`
}

// ── Gemini call with multimodal support ──────────────────────────────────────

async function callGeminiMultimodal(opts: {
  systemPrompt: string
  textParts: { text: string }[]
  pdfParts?: { inlineData: { mimeType: string; data: string } }[]
  maxOutputTokens?: number
  temperature?: number
  callType?: string
  customerName?: string
}): Promise<string> {
  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  // Assemble parts: text parts first, then PDF inline data
  const parts: any[] = [
    ...(opts.pdfParts ?? []),
    ...opts.textParts,
  ]

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(300_000),  // 5 min for long generation
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300)}`)
  }

  const json = await res.json() as any
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType: opts.callType ?? 'account-plan',
      customerName: opts.customerName ?? 'unknown',
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  if (!text) throw new Error('Gemini returned empty response')
  return text
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
- Account Solution Architect (ASA): Jason Horn

### Company Intelligence
${companyIntel.substring(0, 8000)}

### Product Intelligence
${productIntel.substring(0, 5000)}

## Account Planning Playbook (Guidance)
${playbook}

---
Now generate a complete Account Plan for ${customerDisplayName} following the sample structure above and answering all questions from the reference image. Include ${aeName} as the AE and Jason Horn as the ASA in the team members section.`

  // Call Gemini with multimodal (text + PDF image)
  const markdown = await callGeminiMultimodal({
    systemPrompt: SYSTEM_PROMPT,
    textParts: [{ text: userPrompt }],
    pdfParts: [{ inlineData: { mimeType: 'application/pdf', data: questionsB64 } }],
    maxOutputTokens: 8192,
    temperature: 0.7,
    callType: 'account-plan-generation',
    customerName: customer.name,
  })

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
  console.log(`[acct-plan] Written to ${outputPath} (${markdown.length} chars)`)

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
