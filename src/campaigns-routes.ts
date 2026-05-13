/**
 * Campaign Generation API — GitHub Issue #151
 *
 * Two endpoints:
 * - POST /api/customer/:name/campaigns/generate — trigger campaign generation
 * - GET /api/customer/:name/campaigns — retrieve campaign history
 *
 * Follows account-plan.ts pattern: generation function, cache read/write,
 * Drive doc creation, in-flight guard.
 */

import { Hono } from 'hono'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { getGeminiToken } from './gemini-auth.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { getGeminiModel } from './ai-config.ts'
import { customers } from './server-state.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer } from './types.ts'
import { extractMaterial, deleteMaterialCache } from './material-extraction.ts'

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../cache')

// ── In-flight guard ──────────────────────────────────────────────────────────

const _campaignsInFlight = new Set<string>()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignRequest {
  materialUrl: string
}

export interface CampaignResult {
  ok: true
  campaignId: string
  generatedAt: string
  driveUrl: string
}

export interface CampaignListItem {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
}

// ── Material extraction ──────────────────────────────────────────────────────

/**
 * Extract Google Doc/Slides file ID from URL.
 * Accepts: https://docs.google.com/presentation/d/{fileId}/...
 *          https://docs.google.com/document/d/{fileId}/...
 */
function extractFileId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

/**
 * Export material as plain text via Google Drive API.
 * Returns { title, content }
 */
async function extractMaterialContent(fileId: string): Promise<{ title: string; content: string }> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // Get file metadata (title + mimeType)
  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  })

  const title = meta.data.name ?? 'Untitled'

  // Export as plain text
  const exportRes = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' },
  )

  const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)

  return { title, content }
}

// ── Customer intelligence loading ────────────────────────────────────────────

interface CustomerSignals {
  intelligence?: any
  emails?: any
  subscriptions?: any
}

/**
 * Load customer signal stack from cache (simplified Phase 3 version).
 * Loads:
 * - intelligence brief (data/cache/intelligence/{slug}.json)
 * - emails (data/cache/{slug}-emails.json)
 * - subscriptions (data/cache/{slug}-sheets.json)
 */
function loadCustomerSignals(customerSlug: string): CustomerSignals {
  const signals: CustomerSignals = {}

  // Intelligence brief
  try {
    const intelPath = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (existsSync(intelPath)) {
      signals.intelligence = JSON.parse(readFileSync(intelPath, 'utf-8'))
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load intelligence for ${customerSlug}:`, e.message)
  }

  // Emails
  try {
    const emailsPath = resolve(CACHE_DIR, `${customerSlug}-emails.json`)
    if (existsSync(emailsPath)) {
      signals.emails = JSON.parse(readFileSync(emailsPath, 'utf-8'))
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load emails for ${customerSlug}:`, e.message)
  }

  // Subscriptions
  try {
    const subsPath = resolve(CACHE_DIR, `${customerSlug}-sheets.json`)
    if (existsSync(subsPath)) {
      signals.subscriptions = JSON.parse(readFileSync(subsPath, 'utf-8'))
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load subscriptions for ${customerSlug}:`, e.message)
  }

  return signals
}

// ── Gemini campaign generation ───────────────────────────────────────────────

const CAMPAIGN_SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect creating personalized email campaigns.

Your job:
1. Extract value propositions from the provided product material
2. Match them against the customer's specific business context and signals
3. Generate positioning summary and role-specific email templates

Rules:
- Be specific: use customer names, product names, current subscriptions
- Write as Jason Horn (Red Hat ASA)
- Keep emails under 90 words (council rule: observation→peer→link)
- No internal Red Hat data in emails
- Output clean markdown with clear sections

REQUIRED SECTIONS:
1. Campaign Summary (1-2 sentences: what this campaign is about)
2. Customer Context (what we know about this customer that's relevant)
3. Positioning (how the material's value props map to customer needs)
4. Email Templates (6 personas, 2 tiers each):
   - VP Infrastructure / Platform Engineering (C-level + director-level)
   - VP Operations / SRE Lead (C-level + director-level)
   - CIO / IT Director (C-level + director-level)
   Format: ## {Persona} — {Tier}
           Subject: ...
           Body: ...
`

async function callGeminiForCampaign(opts: {
  materialTitle: string
  materialContent: string
  customerName: string
  customerSignals: CustomerSignals
}): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model = getGeminiModel()
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  // Assemble user prompt with material + signals
  const intelligenceSummary = opts.customerSignals.intelligence?.company
    ? opts.customerSignals.intelligence.company.substring(0, 4000)
    : 'No intelligence data available.'

  const subscriptionsSummary = opts.customerSignals.subscriptions
    ? JSON.stringify(opts.customerSignals.subscriptions, null, 2).substring(0, 2000)
    : 'No subscription data available.'

  const userPrompt = `## Material: ${opts.materialTitle}

### Material Content (first 8000 chars):
${opts.materialContent.substring(0, 8000)}

## Customer: ${opts.customerName}

### Company Intelligence:
${intelligenceSummary}

### Current Subscriptions:
${subscriptionsSummary}

---
Now generate a complete campaign for ${opts.customerName} with positioning and email templates.`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000), // 3 min
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CAMPAIGN_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 300)}`)
  }

  const json = await res.json() as any
  const usage = json.usageMetadata
  if (usage) {
    recordGeminiUsage({
      timestamp: new Date().toISOString(),
      callType: 'campaign-generation',
      customerName: opts.customerName,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      model,
    })
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  if (!text) throw new Error('Gemini returned empty response')
  return text
}

// ── Drive persistence ────────────────────────────────────────────────────────

async function ensureCampaignsSubfolder(customerFolderId: string): Promise<string> {
  return driveClient.ensureChildFolder(customerFolderId, 'Campaigns')
}

async function uploadCampaignToDrive(
  customerFolderId: string,
  customerName: string,
  materialTitle: string,
  markdown: string,
): Promise<string> {
  const campaignsFolderId = await ensureCampaignsSubfolder(customerFolderId)
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const docName = `${materialTitle} - Campaign for ${customerName}`
  const fullContent = `Generated: ${timestamp}\n\n${markdown}`
  return driveClient.upsertDoc(campaignsFolderId, docName, fullContent, { onConflict: 'rewrite' })
}

// ── Cache persistence ────────────────────────────────────────────────────────

interface CampaignCacheEntry {
  id: string
  materialTitle: string
  materialUrl: string
  customerName: string
  markdown: string
  generatedAt: string
  driveUrl: string
}

function saveCampaignToCache(
  customerSlug: string,
  entry: CampaignCacheEntry,
): void {
  const campaignsDir = resolve(CACHE_DIR, 'campaigns')
  mkdirSync(campaignsDir, { recursive: true })

  const campaignPath = resolve(campaignsDir, `${customerSlug}-${entry.id}.json`)
  writeFileSync(campaignPath, JSON.stringify(entry, null, 2), { mode: 0o600 })
  console.log(`[campaigns] Saved to cache: ${campaignPath}`)
}

function loadCampaignsFromCache(customerSlug: string): CampaignListItem[] {
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
      })
    } catch (e: any) {
      console.warn(`[campaigns] Failed to read ${file}:`, e.message)
    }
  }

  // Sort by generatedAt desc
  campaigns.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  return campaigns
}

// ── Core generation logic ────────────────────────────────────────────────────

export async function generateCampaign(
  customer: Customer,
  materialUrl: string,
): Promise<CampaignResult> {
  const slug = toSlug(customer.name)
  console.log(`[campaigns] Generating campaign for ${customer.name} from ${materialUrl}`)

  // 1. Validate and extract material
  const fileId = extractFileId(materialUrl)
  if (!fileId) {
    throw new Error('Invalid materialUrl — expected a Google Docs or Slides link')
  }

  const { title: materialTitle, content: materialContent } = await extractMaterialContent(fileId)
  console.log(`[campaigns] Extracted material: "${materialTitle}" (${materialContent.length} chars)`)

  // 2. Load customer signals
  const signals = loadCustomerSignals(slug)
  console.log(`[campaigns] Loaded signals for ${customer.name}:`, {
    hasIntelligence: !!signals.intelligence,
    hasEmails: !!signals.emails,
    hasSubscriptions: !!signals.subscriptions,
  })

  // 3. Generate campaign via Gemini
  const markdown = await callGeminiForCampaign({
    materialTitle,
    materialContent,
    customerName: customer.name,
    customerSignals: signals,
  })
  console.log(`[campaigns] Generated campaign markdown (${markdown.length} chars)`)

  const generatedAt = new Date().toISOString()
  const campaignId = Date.now().toString()

  // 4. Upload to Drive
  let driveUrl = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    driveUrl = await uploadCampaignToDrive(customerFolderId, customer.name, materialTitle, markdown)
    console.log(`[campaigns] Uploaded to Drive: ${driveUrl}`)
  } catch (e: any) {
    console.error(`[campaigns] Drive upload failed (non-fatal):`, e.message)
    // Non-fatal — cached markdown is still available
  }

  // 5. Save to cache
  saveCampaignToCache(slug, {
    id: campaignId,
    materialTitle,
    materialUrl,
    customerName: customer.name,
    markdown,
    generatedAt,
    driveUrl,
  })

  return {
    ok: true,
    campaignId,
    generatedAt,
    driveUrl,
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createCampaignsRouter(): Hono {
  const router = new Hono()

  // POST /api/customer/:name/campaigns/generate
  router.post('/api/customer/:name/campaigns/generate', async (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    let body: CampaignRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.materialUrl || typeof body.materialUrl !== 'string') {
      return c.json({ error: 'materialUrl is required' }, 400)
    }

    const slug = toSlug(customer.name)
    if (_campaignsInFlight.has(slug)) {
      return c.json({ error: 'Generation already in progress for this customer' }, 409)
    }

    _campaignsInFlight.add(slug)
    try {
      const result = await generateCampaign(customer, body.materialUrl)
      return c.json(result)
    } catch (e: any) {
      console.error(`[campaigns] Generation failed for ${customer.name}:`, e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    } finally {
      _campaignsInFlight.delete(slug)
    }
  })

  // GET /api/customer/:name/campaigns
  router.get('/api/customer/:name/campaigns', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaigns = loadCampaignsFromCache(slug)

    return c.json({ campaigns })
  })

  // POST /api/campaigns/extract-material — Extract and decompose material via Gemini
  router.post('/api/campaigns/extract-material', async (c) => {
    let body: { materialUrl: string; forceRefresh?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!body.materialUrl || typeof body.materialUrl !== 'string') {
      return c.json({ error: 'materialUrl is required' }, 400)
    }

    try {
      const extraction = await extractMaterial(body.materialUrl, body.forceRefresh ?? false)
      return c.json({ ...extraction, cached: !body.forceRefresh })
    } catch (e: any) {
      console.error('[campaigns] Material extraction failed:', e.message)
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // DELETE /api/campaigns/extract-material?url={encodedUrl} — Invalidate cache
  router.delete('/api/campaigns/extract-material', (c) => {
    const materialUrl = c.req.query('url')
    if (!materialUrl || typeof materialUrl !== 'string') {
      return c.json({ error: 'url query parameter is required' }, 400)
    }

    const deleted = deleteMaterialCache(decodeURIComponent(materialUrl))
    return c.json({ ok: true, deleted })
  })

  return router
}
