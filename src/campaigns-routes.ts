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
import { Readable } from 'stream'
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
import { getVoiceProfile, detectVoiceProfile } from './ae-voice.ts'
import type { VoiceProfile } from './ae-voice.ts'
import { generateCampaignHTML } from './campaign-html-template.ts'

// ── Config ────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? resolve(import.meta.dir, '../cache')

// ── In-flight guard ──────────────────────────────────────────────────────────

const _campaignsInFlight = new Set<string>()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignRequest {
  materialUrl: string
  personas?: Array<{ role: string; enabled: boolean; relevantVPs?: string[] }>
  style?: string
  valueProps?: Array<{ id: string; claim: string; detail: string }>
}

export interface CampaignResult {
  ok: true
  campaignId: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
  signalsLoaded?: string[]
  signalsMissing?: string[]
}

export interface CampaignListItem {
  id: string
  materialTitle: string
  generatedAt: string
  driveUrl: string
  htmlUrl: string
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
  productIntel?: any
  intelligence?: any
  customerDocs?: any
  dailyBrief?: any
  subscriptions?: any
  emails?: any
  cases?: any
}

interface SignalLoadResult {
  signals: CustomerSignals
  loaded: string[]
  missing: string[]
}

/**
 * Load all 7 customer signal sources from cache with graceful degradation.
 * Missing sources are logged but don't block generation.
 */
function loadCustomerSignals(customerSlug: string, customerName?: string): SignalLoadResult {
  const signals: CustomerSignals = {}
  const loaded: string[] = []
  const missing: string[] = []

  const tryLoad = (name: string, path: string, postProcess?: (data: any) => any) => {
    try {
      if (existsSync(path)) {
        let data = JSON.parse(readFileSync(path, 'utf-8'))
        if (postProcess) data = postProcess(data)
        ;(signals as any)[name] = data
        loaded.push(name)
      } else {
        missing.push(name)
      }
    } catch (e: any) {
      console.warn(`[campaigns] Failed to load ${name} for ${customerSlug}:`, e.message)
      missing.push(name)
    }
  }

  // 1. Intelligence brief
  tryLoad('intelligence', resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`))

  // 2. Customer docs
  tryLoad('customerDocs', resolve(CACHE_DIR, 'product-intel', 'customer-docs', `${customerSlug}.json`))

  // 3. Daily brief (try today first, then most recent)
  const today = new Date().toISOString().slice(0, 10)
  const briefPath = resolve(CACHE_DIR, `${customerSlug}-${today}.json`)
  if (existsSync(briefPath)) {
    tryLoad('dailyBrief', briefPath)
  } else {
    // Scan for most recent brief
    try {
      const files = readdirSync(CACHE_DIR).filter(f => f.startsWith(`${customerSlug}-`) && f.match(/\d{4}-\d{2}-\d{2}\.json$/))
      if (files.length > 0) {
        files.sort().reverse()
        tryLoad('dailyBrief', resolve(CACHE_DIR, files[0]))
      } else {
        missing.push('dailyBrief')
      }
    } catch { missing.push('dailyBrief') }
  }

  // 4. Subscriptions
  tryLoad('subscriptions', resolve(CACHE_DIR, `${customerSlug}-sheets.json`))

  // 5. Emails
  tryLoad('emails', resolve(CACHE_DIR, `${customerSlug}-emails.json`))

  // 6. Cases (filter by customer name from global cases file)
  tryLoad('cases', resolve(CACHE_DIR, 'cases.json'), (data) => {
    if (!customerName || !Array.isArray(data)) return data
    return data.filter((c: any) => c.customer?.toLowerCase() === customerName.toLowerCase() || c.accountName?.toLowerCase() === customerName.toLowerCase())
  })

  // 7. Product intel (scan for any customer-specific product intel)
  try {
    const productIntelDir = resolve(CACHE_DIR, 'product-intel')
    if (existsSync(productIntelDir)) {
      const dirs = readdirSync(productIntelDir).filter(d => d.endsWith('-customer-intel'))
      const allIntel: any[] = []
      for (const dir of dirs) {
        const filePath = resolve(productIntelDir, dir, `${customerSlug}.json`)
        if (existsSync(filePath)) {
          allIntel.push(JSON.parse(readFileSync(filePath, 'utf-8')))
        }
      }
      if (allIntel.length > 0) {
        signals.productIntel = allIntel
        loaded.push('productIntel')
      } else {
        missing.push('productIntel')
      }
    } else {
      missing.push('productIntel')
    }
  } catch { missing.push('productIntel') }

  console.log(`[campaigns] Signal stack for ${customerSlug}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}]`)
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
Structure: Competitive observation (1 sentence) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 1 sentence) → Peer proof (1 sentence)

### Manager Tier (3 personas, 200-250 words each)
Purpose: Technical depth, daily pain. Designed to be forwarded UP with "we should look at this"
Structure: Pain context (2-3 sentences describing their daily operational reality) → Relationship context (1 sentence) → 3 feature bullets (each = linked feature name + 2-3 sentences explaining HOW) → Peer proof with before/after (1-2 sentences)

### Relationship Context Line (Mandatory in ALL emails)
Reference Red Hat PRODUCTS by name — NEVER subscription counts, node counts, or SKUs.
ONE sentence, placed AFTER the competitive observation (exec) or pain context (manager), BEFORE the bullets.

{voiceInstruction}

## Output Format
Generate clean markdown with these REQUIRED SECTIONS:
1. **Campaign Summary** — 1-2 sentences
2. **Customer Context** — what we know that's relevant
3. **Positioning** — how value props map to customer needs
4. **Email Templates** — 6 emails (3 exec + 3 manager), each with:
   ## {Persona} — {Tier}
   Subject: [observation about their world — no product names]
   [email body following the structure above]
`

async function callGeminiForCampaign(opts: {
  materialTitle: string
  materialContent: string
  customerName: string
  customerSignals: CustomerSignals
  voiceInstruction?: string
  personas?: Array<{ role: string; enabled: boolean; relevantVPs?: string[] }>
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

  // Build persona list (filter to enabled only)
  const enabledPersonas = opts.personas?.filter(p => p.enabled).map(p => p.role) ?? [
    'VP Infrastructure',
    'VP Operations',
    'CIO',
  ]
  const personasStr = enabledPersonas.join(', ')

  const userPrompt = `## Material: ${opts.materialTitle}

### Material Content (first 8000 chars):
${opts.materialContent.substring(0, 8000)}

## Customer: ${opts.customerName}

### Company Intelligence:
${intelligenceSummary}

### Current Subscriptions:
${subscriptionsSummary}

${opts.voiceInstruction ? `\n## Voice Instruction:\n${opts.voiceInstruction}\n` : ''}

---
Now generate a complete campaign for ${opts.customerName} with positioning and email templates.

Generate email templates for these personas (C-level + director-level tiers for each):
${personasStr}`

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
  materialUrl: string,
  markdown: string,
  aeName: string,
  signals: CustomerSignals,
): Promise<{ driveUrl: string; htmlUrl: string }> {
  const campaignsFolderId = await ensureCampaignsSubfolder(customerFolderId)
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const docName = `${materialTitle} - Campaign for ${customerName}`

  // Generate rich HTML output
  const htmlContent = generateCampaignHTML({
    materialTitle,
    materialUrl,
    customerName,
    aeName,
    generatedDate: timestamp,
    signals,
    markdown,
  })

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  // File 1: Google Doc (formatted, editable) — HTML imported and converted
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

  const driveUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${docResponse.data.id}/edit`
  console.log(`[campaigns] Created Google Doc: ${docName} → ${driveUrl}`)

  // File 2: HTML file (raw, for browser preview in Drive)
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

  const htmlUrl = htmlResponse.data.webViewLink ?? `https://drive.google.com/file/d/${htmlResponse.data.id}/view`
  console.log(`[campaigns] Created HTML file: ${docName}.html → ${htmlUrl}`)

  return { driveUrl, htmlUrl }
}

// ── Cache persistence ────────────────────────────────────────────────────────

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

// ── Core generation logic ────────────────────────────────────────────────────

export async function generateCampaign(
  customer: Customer,
  materialUrl: string,
  config?: CampaignRequest,
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

  // 2. Load all 7 customer signals
  const { signals, loaded, missing } = loadCustomerSignals(slug, customer.name)
  console.log(`[campaigns] Signals for ${customer.name}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}]`)

  // 3. Load voice profile if not provided in config
  let voiceInstruction = config?.style || ''
  if (!voiceInstruction && customer.ae) {
    const voice = await getVoiceProfile(customer.ae)
    if (voice) {
      voiceInstruction = `## Voice: ${voice.aeName}\n${voice.promptInstruction}`
      console.log(`[campaigns] Using voice profile for ${voice.aeName}`)
    }
  }

  // 4. Generate campaign via Gemini
  const markdown = await callGeminiForCampaign({
    materialTitle,
    materialContent,
    customerName: customer.name,
    customerSignals: signals,
    voiceInstruction,
    personas: config?.personas,
  })
  console.log(`[campaigns] Generated campaign markdown (${markdown.length} chars)`)

  const generatedAt = new Date().toISOString()
  const campaignId = Date.now().toString()

  // 5. Generate HTML content (for Drive AND cache)
  const timestamp = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const htmlContent = generateCampaignHTML({
    materialTitle,
    materialUrl,
    customerName: customer.name,
    aeName: customer.ae ?? 'Unknown AE',
    generatedDate: timestamp,
    signals,
    markdown,
  })

  // 6. Upload to Drive (Google Doc + HTML file)
  let driveUrl = ''
  let htmlUrl = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const driveResult = await uploadCampaignToDrive(
      customerFolderId,
      customer.name,
      materialTitle,
      materialUrl,
      markdown,
      customer.ae ?? 'Unknown AE',
      signals
    )
    driveUrl = driveResult.driveUrl
    htmlUrl = driveResult.htmlUrl
    console.log(`[campaigns] Uploaded to Drive: ${driveUrl}`)
  } catch (e: any) {
    console.error(`[campaigns] Drive upload failed (non-fatal):`, e.message)
    // Non-fatal — cached markdown is still available
  }

  // 7. Save to cache (with HTML content for preview + signal metadata)
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
    signalsLoaded: loaded,
    signalsMissing: missing,
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
      const result = await generateCampaign(customer, body.materialUrl, body)
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

  // GET /api/customer/:name/campaigns/:id/preview — Preview campaign HTML
  router.get('/api/customer/:name/campaigns/:id/preview', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const campaignId = c.req.param('id')

    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)

    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaignsDir = resolve(CACHE_DIR, 'campaigns')
    const campaignPath = resolve(campaignsDir, `${slug}-${campaignId}.json`)

    if (!existsSync(campaignPath)) {
      return c.json({ error: 'Campaign not found' }, 404)
    }

    try {
      const entry: CampaignCacheEntry = JSON.parse(readFileSync(campaignPath, 'utf-8'))
      c.header('Content-Type', 'text/html')
      return c.body(entry.htmlContent)
    } catch (e: any) {
      console.error(`[campaigns] Failed to read campaign ${campaignId}:`, e.message)
      return c.json({ error: 'Failed to load campaign' }, 500)
    }
  })

  // DELETE /api/customer/:name/campaigns/:id — remove a campaign from cache
  router.delete('/api/customer/:name/campaigns/:id', (c) => {
    const rawName = decodeURIComponent(c.req.param('name'))
    const campaignId = c.req.param('id')
    const customer = customers.find((cu) => cu.name.toLowerCase() === rawName.toLowerCase())
      || customers.find((cu) => toSlug(cu.name) === rawName)
    if (!customer) return c.json({ error: 'Customer not found' }, 404)

    const slug = toSlug(customer.name)
    const campaignPath = resolve(CACHE_DIR, 'campaigns', `${slug}-${campaignId}.json`)

    if (!existsSync(campaignPath)) {
      return c.json({ error: 'Campaign not found' }, 404)
    }

    try {
      const { unlinkSync } = require('fs')
      unlinkSync(campaignPath)
      console.log(`[campaigns] Deleted campaign ${campaignId} for ${customer.name}`)
      return c.json({ ok: true, deleted: campaignId })
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  // ── AE Voice Profile routes (#183) ──────────────────────────────────────────

  router.get('/api/ae/:name/style-guide', async (c) => {
    const aeName = decodeURIComponent(c.req.param('name'))
    try {
      const profile = await getVoiceProfile(aeName)
      if (!profile) return c.json({ error: 'No voice profile found' }, 404)
      return c.json(profile)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  router.post('/api/ae/:name/style-guide/detect', async (c) => {
    const aeName = decodeURIComponent(c.req.param('name'))
    try {
      const profile = await detectVoiceProfile(aeName)
      return c.json(profile)
    } catch (e: any) {
      return c.json({ error: sanitizeErr(e) }, 500)
    }
  })

  return router
}
