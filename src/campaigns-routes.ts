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
  signalsLoaded?: string[]
  signalsMissing?: string[]
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

interface SignalStack {
  productIntel: any | null
  intelligence: any | null
  customerDocs: any | null
  dailyBrief: any | null
  subscriptions: any | null
  emails: any | null
  cases: any | null
}

interface SignalLoadResult {
  signals: SignalStack
  loaded: string[]
  missing: string[]
}

/**
 * Load all 7 signal sources from cache with graceful degradation.
 * Follows ContentCampaign/SKILL.md Step 4 priority order.
 *
 * @param customerName - Full customer name (for cases matching)
 * @param customerSlug - Slug for file path construction
 * @param productSlugs - Optional product slugs from material extraction
 */
function loadSignalStack(
  customerName: string,
  customerSlug: string,
  productSlugs?: string[]
): SignalLoadResult {
  const signals: SignalStack = {
    productIntel: null,
    intelligence: null,
    customerDocs: null,
    dailyBrief: null,
    subscriptions: null,
    emails: null,
    cases: null,
  }
  const loaded: string[] = []
  const missing: string[] = []

  // 1. Product Intel (only if productSlugs provided)
  if (productSlugs && productSlugs.length > 0) {
    for (const productSlug of productSlugs) {
      try {
        const path = resolve(CACHE_DIR, 'product-intel', `${productSlug}-customer-intel`, `${customerSlug}.json`)
        if (existsSync(path)) {
          signals.productIntel = JSON.parse(readFileSync(path, 'utf-8'))
          loaded.push('productIntel')
          break // Only need one match
        }
      } catch (e: any) {
        console.warn(`[campaigns] Failed to load product intel ${productSlug}:`, e.message)
      }
    }
    if (!signals.productIntel) missing.push('productIntel')
  }

  // 2. Intelligence Brief
  try {
    const path = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (existsSync(path)) {
      signals.intelligence = JSON.parse(readFileSync(path, 'utf-8'))
      loaded.push('intelligence')
    } else {
      missing.push('intelligence')
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load intelligence:`, e.message)
    missing.push('intelligence')
  }

  // 3. Customer Docs
  try {
    const path = resolve(CACHE_DIR, 'product-intel', 'customer-docs', `${customerSlug}.json`)
    if (existsSync(path)) {
      signals.customerDocs = JSON.parse(readFileSync(path, 'utf-8'))
      loaded.push('customerDocs')
    } else {
      missing.push('customerDocs')
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load customer docs:`, e.message)
    missing.push('customerDocs')
  }

  // 4. Daily Brief (today's date, fall back to most recent)
  try {
    const today = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD
    const todayPath = resolve(CACHE_DIR, `${customerSlug}-${today}.json`)

    if (existsSync(todayPath)) {
      signals.dailyBrief = JSON.parse(readFileSync(todayPath, 'utf-8'))
      loaded.push('dailyBrief')
    } else {
      // Scan for most recent brief
      const files = readdirSync(CACHE_DIR).filter(f =>
        f.startsWith(`${customerSlug}-`) &&
        f.endsWith('.json') &&
        /\d{4}-\d{2}-\d{2}\.json$/.test(f)
      )

      if (files.length > 0) {
        files.sort().reverse() // Most recent first
        const mostRecentPath = resolve(CACHE_DIR, files[0])
        signals.dailyBrief = JSON.parse(readFileSync(mostRecentPath, 'utf-8'))
        loaded.push('dailyBrief')
      } else {
        missing.push('dailyBrief')
      }
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load daily brief:`, e.message)
    missing.push('dailyBrief')
  }

  // 5. Subscriptions
  try {
    const path = resolve(CACHE_DIR, `${customerSlug}-sheets.json`)
    if (existsSync(path)) {
      signals.subscriptions = JSON.parse(readFileSync(path, 'utf-8'))
      loaded.push('subscriptions')
    } else {
      missing.push('subscriptions')
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load subscriptions:`, e.message)
    missing.push('subscriptions')
  }

  // 6. Emails
  try {
    const path = resolve(CACHE_DIR, `${customerSlug}-emails.json`)
    if (existsSync(path)) {
      signals.emails = JSON.parse(readFileSync(path, 'utf-8'))
      loaded.push('emails')
    } else {
      missing.push('emails')
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load emails:`, e.message)
    missing.push('emails')
  }

  // 7. Cases (filter by customer name)
  try {
    const path = resolve(CACHE_DIR, 'cases.json')
    if (existsSync(path)) {
      const allCases = JSON.parse(readFileSync(path, 'utf-8'))
      // Filter cases matching this customer
      signals.cases = Array.isArray(allCases)
        ? allCases.filter((c: any) =>
            c.accountName?.toLowerCase().includes(customerName.toLowerCase())
          )
        : []

      if (signals.cases.length > 0) {
        loaded.push('cases')
      } else {
        missing.push('cases')
      }
    } else {
      missing.push('cases')
    }
  } catch (e: any) {
    console.warn(`[campaigns] Failed to load cases:`, e.message)
    missing.push('cases')
  }

  return { signals, loaded, missing }
}

// ── Gemini campaign generation ───────────────────────────────────────────────

const CAMPAIGN_SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect creating deeply personalized email campaigns.

## Email Design Rules (Council-Validated, Mandatory)

Every generated email MUST pass ALL of these rules:

1. **Word limits:** Executive tier = 90 words max; Manager tier = 200-250 words
2. **Technical observations only** — no firmographic facts ("You're a $2B company")
3. **Statements, not questions** — "curious whether" is template smell. No questions anywhere including CTA.
4. **Per-bullet links** — each bullet links to the specific Red Hat product page for that feature (no single generic CTA link)
5. **Name the peer company with a concrete metric** — "Mutua Madrileña cut service tickets 50%" not "a major insurer improved"
6. **Forward-worthy test** — exec emails: VP forwards to eng lead; manager emails: manager forwards to VP
7. **Competitor-swap test** — if replacing the product name still works, the email is a brochure. Rewrite with feature-specific language.
8. **Creepy line** — NEVER reference support tickets, POC status, internal data, usage telemetry, subscription counts, node counts, or anything the recipient would be surprised the AE knows
9. **Subject = observation about their world** — no product names, no company names, no "Red Hat" or "Ansible"
10. **No filler** — no "let me know," no PS, no calendar links, no "no pressure," no "hope this finds you well"
11. **Relationship context** — every email must include ONE sentence noting the customer already uses Red Hat products (by product name, never subscription counts). This is NOT the opener — it comes after the observation/pain context.

## Two Email Tiers (6 personas total)

### Executive Tier (3 personas, 90 words max each)
Purpose: Competitive urgency, strategic. Designed to be forwarded DOWN with "thoughts?"

**Structure:** Competitive observation (1 sentence) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 1 sentence) → Peer proof (1 sentence)

Competitive observation: Create urgency by referencing a SPECIFIC competitor. Pattern: "While [competitor] is [doing X], [customer]'s [initiative] needs [capability] to stay ahead."

### Manager Tier (3 personas, 200-250 words each)
Purpose: Technical depth, daily pain. Designed to be forwarded UP with "we should look at this"

**Structure:** Pain context (2-3 sentences describing their daily operational reality) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 2-3 sentences explaining HOW) → Peer proof with before/after (1-2 sentences)

Pain context: What their Monday morning looks like, what manual process burns them out. Show you understand their queue.

### Relationship Context Line (Mandatory in ALL emails)
- Reference Red Hat PRODUCTS by name (e.g., "Red Hat Enterprise Linux") — NEVER subscription counts, node counts, or SKUs
- ONE sentence, placed AFTER the competitive observation (exec) or pain context (manager), BEFORE the bullets
- Pattern: "Your organization already runs [product] — [new product] is a natural extension of that foundation."

## Persona Elevation
Map extracted personas to executive/manager tiers:
- IT Operations Manager → VP of IT Operations (exec tier)
- AI/ML Engineer → Director of AI/ML Engineering (exec tier)
- Automation Architect → VP of Platform Engineering (exec tier)
- Sr. DevOps Engineer → Sr. Manager, DevOps (manager tier)
- Infrastructure Lead → Sr. Manager, Infrastructure (manager tier)
- Security Analyst → Sr. Manager, Security Operations (manager tier)

{voiceInstruction}

## Output Format
Generate clean markdown with these REQUIRED SECTIONS:
1. **Campaign Summary** — 1-2 sentences: what this campaign is about
2. **Customer Context** — what we know that's relevant (from signals)
3. **Positioning** — how value props map to customer needs
4. **Email Templates** — 6 emails (3 exec + 3 manager), each with:
   ## {Persona} — {Tier}
   **Subject:** [observation about their world]
   **Body:** [following the structure above]
`

async function callGeminiForCampaign(opts: {
  materialTitle: string
  materialContent: string
  customerName: string
  signals: SignalStack
  voiceInstruction?: string
}): Promise<string> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model = getGeminiModel()
  if (!project) throw new Error('GOOGLE_CLOUD_PROJECT not set — required for Gemini via Vertex AI')

  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  // Assemble user prompt with material + all available signals
  const sections: string[] = []

  // Material
  sections.push(`## Material: ${opts.materialTitle}\n\n### Material Content (first 8000 chars):\n${opts.materialContent.substring(0, 8000)}`)

  // Customer header
  sections.push(`## Customer: ${opts.customerName}`)

  // Signal #1: Product Intel
  if (opts.signals.productIntel) {
    sections.push(`### Product-Specific Intelligence:\n${JSON.stringify(opts.signals.productIntel, null, 2).substring(0, 2000)}`)
  }

  // Signal #2: Intelligence Brief
  if (opts.signals.intelligence?.company) {
    sections.push(`### Company Intelligence:\n${opts.signals.intelligence.company.substring(0, 4000)}`)
  }

  // Signal #3: Customer Docs
  if (opts.signals.customerDocs) {
    sections.push(`### Account Documentation:\n${JSON.stringify(opts.signals.customerDocs, null, 2).substring(0, 2000)}`)
  }

  // Signal #4: Daily Brief
  if (opts.signals.dailyBrief) {
    sections.push(`### Recent Daily Brief:\n${JSON.stringify(opts.signals.dailyBrief, null, 2).substring(0, 2000)}`)
  }

  // Signal #5: Subscriptions
  if (opts.signals.subscriptions) {
    sections.push(`### Current Subscriptions:\n${JSON.stringify(opts.signals.subscriptions, null, 2).substring(0, 2000)}`)
  }

  // Signal #6: Emails
  if (opts.signals.emails) {
    sections.push(`### Recent Email Threads:\n${JSON.stringify(opts.signals.emails, null, 2).substring(0, 2000)}`)
  }

  // Signal #7: Cases
  if (opts.signals.cases && Array.isArray(opts.signals.cases) && opts.signals.cases.length > 0) {
    sections.push(`### Support Cases:\n${JSON.stringify(opts.signals.cases, null, 2).substring(0, 2000)}`)
  }

  // Fallback if no signals loaded
  if (sections.length === 2) { // Only material + customer header
    sections.push('### Available Signals:\nNo cached signal data available for this customer.')
  }

  const userPrompt = sections.join('\n\n') + `\n\n---\nNow generate a complete campaign for ${opts.customerName} with positioning and email templates.`

  // Default voice instruction if not provided
  const voiceInstruction = opts.voiceInstruction ?? `## Voice\nWrite in a professional, confident tone. Knowledgeable but deferential — peer-level, not salesy.`

  // Inject voice instruction into system prompt
  const systemPrompt = CAMPAIGN_SYSTEM_PROMPT.replace('{voiceInstruction}', voiceInstruction)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180_000), // 3 min
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
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
  signalsLoaded?: string[]
  signalsMissing?: string[]
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

  // 2. Load all 7 signal sources
  const { signals, loaded, missing } = loadSignalStack(customer.name, slug)
  console.log(`[campaigns] Signal stack for ${customer.name}:`, {
    loaded: loaded.join(', ') || 'none',
    missing: missing.join(', ') || 'none',
  })

  // 3. Generate campaign via Gemini
  const markdown = await callGeminiForCampaign({
    materialTitle,
    materialContent,
    customerName: customer.name,
    signals,
    // Default voice — per-AE voice profiles to be loaded in future enhancement
    voiceInstruction: `## Voice\nWrite in a professional, confident tone. Knowledgeable but deferential — peer-level, not salesy.`,
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
    signalsLoaded: loaded,
    signalsMissing: missing,
  })

  return {
    ok: true,
    campaignId,
    generatedAt,
    driveUrl,
    signalsLoaded: loaded,
    signalsMissing: missing,
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
