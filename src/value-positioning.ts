/**
 * Value Positioning — Proactive Value Proposition Brief
 * GitHub Issue #264
 *
 * Assembles customer intelligence, account plan, value maps, cases, pipeline,
 * and enrichment signals to generate a proactive value proposition brief
 * via Gemini. Outputs a professional document proposing Red Hat solutions
 * for stalled or quiet accounts.
 *
 * Shares data pipeline with account-plan.ts and expansion-opportunities.ts
 * but with a different trigger (proactive) and output structure (proposal).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { CACHE_DIR } from './lib/paths.ts'
import { callGemini } from './gemini-call.ts'
import { sanitizePromptInput, normalizeForQuery } from './utils.ts'
import { toSlug } from './cache-layer.ts'
import { getOperatorProfile } from './account-team.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import { templateAll } from './lib/signal-templates.ts'
import type { Customer } from './types.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SolutionAlignment {
  solution: string
  alignment: string
  proofPoints: string[]
}

export interface PositioningSections {
  currentState: string
  solutionAlignment: SolutionAlignment[]
  artOfPossible: string
  nextSteps: string[]
}

export interface ValuePositioningResult {
  customerName: string
  sections: PositioningSections
  signalSummary: {
    intelligenceAvailable: boolean
    accountPlanAvailable: boolean
    casesCount: number
    pipelineCount: number
    valueMapProducts: string[]
  }
  generatedAt: string
  driveUrl: string
}

export interface PositioningContext {
  intelligence: { company: string; industry: string; products?: any } | null
  accountPlan: string | null
  cases: { total: number; openSev1: number; openSev2: number }
  pipeline: { totalOpps: number; totalAcv: number; records: any[] }
  valueMapProducts: string[]
}

// ── Cache paths ────────────────────────────────────────────────────────────

function positioningCachePath(customerSlug: string): string {
  return resolve(CACHE_DIR, 'intelligence', `${customerSlug}-value-positioning.json`)
}

// ── Cache read/write ──────────────────────────────────────────────────────

export function readCachedPositioning(customerSlug: string): ValuePositioningResult | null {
  const p = positioningCachePath(customerSlug)
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

export function writePositioningCache(customerSlug: string, data: ValuePositioningResult): void {
  const dir = resolve(CACHE_DIR, 'intelligence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(positioningCachePath(customerSlug), JSON.stringify(data, null, 2), { mode: 0o600 })
}

// ── Signal assembly ───────────────────────────────────────────────────────

export function assemblePositioningContext(customerSlug: string, customerName: string): PositioningContext {
  const cacheDir = process.env.CACHE_DIR ?? CACHE_DIR

  // Intelligence cache
  let intelligence: PositioningContext['intelligence'] = null
  try {
    const intelPath = resolve(cacheDir, 'intelligence', `${customerSlug}.json`)
    if (existsSync(intelPath)) {
      const raw = JSON.parse(readFileSync(intelPath, 'utf-8'))
      intelligence = {
        company: String(raw.company ?? ''),
        industry: String(raw.industry ?? ''),
        products: raw.products,
      }
    }
  } catch { /* no intelligence */ }

  // Account plan
  let accountPlan: string | null = null
  try {
    const planPath = resolve(cacheDir, 'intelligence', `${customerSlug}-account-plan.md`)
    if (existsSync(planPath)) {
      const content = readFileSync(planPath, 'utf-8')
      accountPlan = content.replace(/<!-- Generated: .+? -->\n\n/, '')
    }
  } catch { /* no account plan */ }

  // Cases enrichment
  let cases = { total: 0, openSev1: 0, openSev2: 0 }
  try {
    const casesPath = resolve(cacheDir, 'cases.json')
    if (existsSync(casesPath)) {
      const raw = JSON.parse(readFileSync(casesPath, 'utf-8'))
      const allCases: any[] = raw.cases ?? (Array.isArray(raw) ? raw : [])
      const needle = customerSlug.replace(/-/g, ' ').toLowerCase()
      const customerCases = allCases.filter(c => {
        const name = (c.customerName ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
        return name.includes(needle) || needle.includes(name.replace(/\s+/g, ' ').trim())
      })
      cases = {
        total: customerCases.length,
        openSev1: customerCases.filter(c => c.severity === '1' && c.status !== 'Closed').length,
        openSev2: customerCases.filter(c => c.severity === '2' && c.status !== 'Closed').length,
      }
    }
  } catch { /* no cases */ }

  // Pipeline enrichment
  let pipeline = { totalOpps: 0, totalAcv: 0, records: [] as any[] }
  try {
    const pipePath = resolve(cacheDir, 'pipeline-data.json')
    if (existsSync(pipePath)) {
      const raw = JSON.parse(readFileSync(pipePath, 'utf-8'))
      const records: any[] = raw.records ?? []
      const needle = customerSlug.replace(/-/g, ' ').toLowerCase()
      const customerRecords = records.filter(r => {
        const name = (r.accountName ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
        return name.includes(needle) || needle.includes(name.replace(/\s+/g, ' ').trim())
      })
      const totalAcv = customerRecords.reduce((sum: number, r: any) => sum + (Number(r.acv) || 0), 0)
      pipeline = { totalOpps: customerRecords.length, totalAcv, records: customerRecords }
    }
  } catch { /* no pipeline */ }

  // Value map products (which products have value map content)
  let valueMapProducts: string[] = []
  try {
    const vmPath = resolve(cacheDir, 'value-maps/business-value-maps.txt')
    if (existsSync(vmPath)) {
      const knownSlugs = ['ocp', 'rhel', 'aap', 'acs', 'acm', 'quay', 'rhoai', 'rhdh', 'satellite', 'insights']
      valueMapProducts = knownSlugs
    }
  } catch { /* no value maps */ }

  return { intelligence, accountPlan, cases, pipeline, valueMapProducts }
}

// ── Prompt construction ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect. Your job is to create a compelling Value Proposition Brief for a customer account that has gone quiet or stalled. This document will be used to re-engage the customer with a proactive, intelligence-driven proposal.

Rules:
- Be specific: cite actual data, case numbers, dollar amounts, product names
- Write as the Account Solution Architect addressing the account team
- Focus on what the customer COULD achieve with Red Hat, grounded in what we KNOW about them
- Every solution alignment must include proof points (industry examples, case studies, or direct customer evidence)
- Next steps must be concrete and actionable (not generic "schedule a meeting")
- Output valid JSON matching the schema provided`

export function buildPositioningPrompt(customerName: string, ctx: PositioningContext): string {
  const sections: string[] = [`CUSTOMER: ${customerName}`]

  if (ctx.intelligence) {
    sections.push(`--- Company Intelligence ---\n${sanitizePromptInput(ctx.intelligence.company, 6000)}`)
    if (ctx.intelligence.industry) {
      sections.push(`--- Industry Context ---\n${sanitizePromptInput(ctx.intelligence.industry, 3000)}`)
    }
  }

  if (ctx.accountPlan) {
    sections.push(`--- Account Plan (existing) ---\n${sanitizePromptInput(ctx.accountPlan, 8000)}`)
  }

  if (ctx.cases.total > 0) {
    sections.push(`--- Support Cases ---\nTotal: ${ctx.cases.total}, Open Sev-1: ${ctx.cases.openSev1}, Open Sev-2: ${ctx.cases.openSev2}`)
  }

  if (ctx.pipeline.totalOpps > 0) {
    const pipelineText = ctx.pipeline.records
      .map((r: any) => `- ${sanitizePromptInput(r.oppName ?? '', 200)}: $${(Number(r.acv) || 0).toLocaleString()} ACV, ${sanitizePromptInput(r.forecastCategory ?? '', 50)}`)
      .join('\n')
    sections.push(`--- Pipeline ---\nTotal: ${ctx.pipeline.totalOpps} opps, $${ctx.pipeline.totalAcv.toLocaleString()} ACV\n${pipelineText}`)
  }

  sections.push(`Generate a Value Proposition Brief for ${customerName}. The brief should re-engage this account with specific, intelligence-backed proposals.

OUTPUT SCHEMA (respond with ONLY this JSON, no markdown fences):
{
  "currentState": "2-3 paragraph summary of what we know about the customer's current state, goals, and challenges",
  "solutionAlignment": [
    {
      "solution": "Red Hat product or solution name",
      "alignment": "How this solution addresses a specific customer goal or pain point",
      "proofPoints": ["Evidence point 1", "Evidence point 2"]
    }
  ],
  "artOfPossible": "2-3 paragraphs describing what the customer could achieve with Red Hat that they're not doing today",
  "nextSteps": ["Concrete action item 1", "Concrete action item 2", "Concrete action item 3"]
}`)

  return sections.join('\n\n')
}

// ── Result validation ─────────────────────────────────────────────────────

export function validatePositioningResult(parsed: any): boolean {
  if (!parsed) return false
  if (!parsed.currentState || typeof parsed.currentState !== 'string' || parsed.currentState.length < 10) return false
  if (!Array.isArray(parsed.solutionAlignment) || parsed.solutionAlignment.length === 0) return false
  if (!parsed.artOfPossible || typeof parsed.artOfPossible !== 'string') return false
  if (!Array.isArray(parsed.nextSteps) || parsed.nextSteps.length === 0) return false

  for (const sa of parsed.solutionAlignment) {
    if (!sa.solution || !sa.alignment) return false
  }

  return true
}

// ── Drive upload ──────────────────────────────────────────────────────────

async function uploadPositioningToDrive(customer: Customer, markdown: string): Promise<string> {
  const customerFolderId = await findCustomerDriveFolder(customer)
  const subfolderId = await driveClient.ensureChildFolder(customerFolderId, 'Value Positioning')
  const docName = `${customer.name} - Value Proposition Brief`
  return driveClient.upsertDoc(subfolderId, docName, markdown, { onConflict: 'rewrite' })
}

// ── Markdown rendering ───────────────────────────────────────────────────

function renderPositioningMarkdown(customerName: string, sections: PositioningSections, generatedAt: string): string {
  const timestamp = new Date(generatedAt).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const solutionRows = sections.solutionAlignment
    .map(sa => {
      const proofs = sa.proofPoints.map(p => `  - ${p}`).join('\n')
      return `### ${sa.solution}\n${sa.alignment}\n\n**Proof Points:**\n${proofs}`
    })
    .join('\n\n')

  const nextStepsList = sections.nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')

  return `# Value Proposition Brief — ${customerName}
*Generated: ${timestamp}*

## Current State & Context
${sections.currentState}

## Solution Alignment
${solutionRows}

## The Art of the Possible
${sections.artOfPossible}

## Suggested Next Steps
${nextStepsList}
`
}

// ── Main generation ───────────────────────────────────────────────────────

export async function generateValuePositioning(
  customer: Customer,
): Promise<ValuePositioningResult> {
  const slug = toSlug(customer.name)
  console.log(`[value-positioning] Generating brief for ${customer.name} (${slug})`)

  const ctx = assemblePositioningContext(slug, customer.name)

  // If no intelligence at all, return empty result
  if (!ctx.intelligence && !ctx.accountPlan && ctx.cases.total === 0 && ctx.pipeline.totalOpps === 0) {
    console.warn(`[value-positioning] No data available for ${slug} — returning empty`)
    const empty: ValuePositioningResult = {
      customerName: customer.name,
      sections: { currentState: '', solutionAlignment: [], artOfPossible: '', nextSteps: [] },
      signalSummary: {
        intelligenceAvailable: false,
        accountPlanAvailable: false,
        casesCount: 0,
        pipelineCount: 0,
        valueMapProducts: [],
      },
      generatedAt: new Date().toISOString(),
      driveUrl: '',
    }
    writePositioningCache(slug, empty)
    return empty
  }

  let userPrompt = buildPositioningPrompt(customer.name, ctx)

  // #786: Supplement with templateAll deterministic sections
  try {
    const { registrySignals } = await loadCustomerSignals(slug, customer.name)
    const templateResult = await templateAll(registrySignals, undefined, { format: 'brief' })
    if (templateResult.deterministic) {
      userPrompt += `\n\n--- Signal Context (structured) ---\n${templateResult.deterministic}`
    }
  } catch (e: any) {
    console.warn(`[value-positioning] templateAll enrichment failed (non-fatal): ${e.message}`)
  }

  const geminiResult = await callGemini(SYSTEM_PROMPT, userPrompt, {
    callType: 'value-positioning',
    customerName: customer.name,
    temperature: 0.5,
  })

  const rawText = geminiResult.text
  if (!rawText) throw new Error('Gemini returned empty response')

  // Parse JSON from response
  let parsed: any = null
  const fenceMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/)
  if (fenceMatch) {
    try { parsed = JSON.parse(fenceMatch[1]) } catch { /* fall through */ }
  }
  if (!parsed) {
    const firstBrace = rawText.indexOf('{')
    const lastBrace = rawText.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try { parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1)) } catch { /* fall through */ }
    }
  }

  if (!validatePositioningResult(parsed)) {
    console.warn(`[value-positioning] Gemini returned invalid structure for ${slug}`)
    throw new Error('Generated positioning brief failed validation — missing required sections')
  }

  const sections: PositioningSections = {
    currentState: String(parsed.currentState),
    solutionAlignment: parsed.solutionAlignment.map((sa: any) => ({
      solution: String(sa.solution ?? ''),
      alignment: String(sa.alignment ?? ''),
      proofPoints: Array.isArray(sa.proofPoints) ? sa.proofPoints.map(String) : [],
    })),
    artOfPossible: String(parsed.artOfPossible),
    nextSteps: parsed.nextSteps.map(String),
  }

  const generatedAt = new Date().toISOString()

  // Upload to Drive
  let driveUrl = ''
  try {
    const markdown = renderPositioningMarkdown(customer.name, sections, generatedAt)
    driveUrl = await uploadPositioningToDrive(customer, markdown)
    console.log(`[value-positioning] Uploaded to Drive: ${driveUrl}`)
  } catch (e: any) {
    console.error(`[value-positioning] Drive upload failed (non-fatal): ${e.message}`)
  }

  const result: ValuePositioningResult = {
    customerName: customer.name,
    sections,
    signalSummary: {
      intelligenceAvailable: !!ctx.intelligence,
      accountPlanAvailable: !!ctx.accountPlan,
      casesCount: ctx.cases.total,
      pipelineCount: ctx.pipeline.totalOpps,
      valueMapProducts: ctx.valueMapProducts,
    },
    generatedAt,
    driveUrl,
  }

  writePositioningCache(slug, result)
  console.log(`[value-positioning] Generated brief for ${customer.name}`)
  return result
}
