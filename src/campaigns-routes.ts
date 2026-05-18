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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { google } from 'googleapis'
import { Readable } from 'stream'
import { callGemini } from './gemini-call.ts'
import { driveClient } from './lib/drive-client.ts'
import { findCustomerDriveFolder } from './lib/customer-folder.ts'
import { customers } from './server-state.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from './google.ts'
import type { Customer } from './types.ts'
import { extractMaterial, deleteMaterialCache } from './material-extraction.ts'
import { getVoiceProfile, detectVoiceProfile } from './ae-voice.ts'
import { runIntelligencePipeline } from './account-intelligence.ts'
import { generateAccountPlan } from './account-plan.ts'
import type { VoiceProfile } from './ae-voice.ts'
import { generateCampaignHTML } from './campaign-html-template.ts'
import { loadCustomerSignals } from './lib/signal-loader.ts'
import type { CustomerSignals, SignalLoadResult } from './lib/signal-loader.ts'
import { FeatureModuleRegistry, type Signal } from './feature-module-registry.ts'
import { getAccountTeam } from './account-team.ts'

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

// ── Gemini campaign generation ───────────────────────────────────────────────

const CAMPAIGN_SYSTEM_PROMPT = `You are a Red Hat Account Solution Architect creating deeply personalized email campaigns.

## Email Design Rules (Council-Validated, Mandatory)

Every generated email MUST pass ALL of these rules:

1. **Word limits:** Executive tier = 90 words max; Manager tier = 200-250 words
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
   IMPORTANT: Each bullet MUST use the most specific URL that matches the feature being described. Do NOT use the generic Ansible page for specific features like AIOps or Event-Driven Ansible.
   Format each bullet as: * [Feature Name](url): description sentence
5. **Name the peer company with a concrete metric** — "Mutua Madrileña cut service tickets 50%" not "a major insurer improved"
6. **Forward-worthy test** — exec emails: VP forwards to eng lead; manager emails: manager forwards to VP
7. **Competitor-swap test** — if replacing the product name still works, the email is a brochure. Rewrite with feature-specific language.
8. **Creepy line** — NEVER reference support tickets, POC status, internal data, usage telemetry, subscription counts, node counts, subscription expiry/renewal status, or anything the recipient would be surprised the AE knows
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

## CRITICAL: Vary Feature Bullets Per Persona
Each of the 6 emails MUST highlight DIFFERENT features relevant to THAT persona's role:
- A VP of Security cares about threat detection, compliance, and risk reduction
- An ML Engineer cares about model deployment, GPU infrastructure, and MLOps tooling
- A Head of Operations cares about uptime, automated remediation, and incident response
- An IT Director cares about cost, consistency, audit trails, and vendor consolidation
DO NOT repeat the same 3 bullets across all emails. Each persona should discover features they haven't seen in the other emails. Pull from the full breadth of the material's value propositions.

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
  registrySignals: Signal[]
  voiceInstruction?: string
  personas?: Array<{ role: string; enabled: boolean; relevantVPs?: string[] }>
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

### Additional Intelligence Signals:
${registrySignalsSummary}

${opts.voiceInstruction ? `\n## Voice Instruction:\n${opts.voiceInstruction}\n` : ''}

---
Now generate a complete campaign for ${opts.customerName} with positioning and email templates.

Generate email templates for these personas (C-level + director-level tiers for each):
${personasStr}`

  const result = await callGemini(CAMPAIGN_SYSTEM_PROMPT, userPrompt, {
    callType: 'campaign-generation',
    customerName: opts.customerName,
    model: 'pro',  // Pro for campaigns — better instruction following for council rules
    temperature: 0.7,
    // No deltaKey — campaigns are customer-specific and material may change
  })

  if (!result.text) throw new Error('Gemini returned empty response')
  return result.text
}

// ── Drive persistence ────────────────────────────────────────────────────────

async function ensureCampaignsSubfolder(customerFolderId: string): Promise<string> {
  return driveClient.ensureChildFolder(customerFolderId, 'Campaigns')
}

async function uploadCampaignToDrive(
  customerFolderId: string,
  customer: Customer,
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
  const docName = `${materialTitle} - Campaign for ${customer.name}`

  // Get account team
  const accountTeam = getAccountTeam(customer)

  // Generate rich HTML output
  const htmlContent = generateCampaignHTML({
    materialTitle,
    materialUrl,
    customerName: customer.name,
    aeName,
    generatedDate: timestamp,
    accountTeam,
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
      const configDir = process.env.CONFIG_DIR ?? resolve(import.meta.dir, '../config')
      await generateAccountPlan(customer, CACHE_DIR, configDir)
      console.log(`[campaigns] Account plan generated for ${customer.name}`)
    } catch (e: any) {
      console.warn(`[campaigns] Account plan generation failed for ${customer.name}:`, e?.message ?? e)
    }
  }

  // Pre-flight signal refresh (#285) — ensure fresh data before generation
  await FeatureModuleRegistry.refreshStaleSignals(slug).catch(() => {})

  // 3. Load all customer signals (legacy cache + registry signals)
  const { signals, registrySignals, loaded, missing } = await loadCustomerSignals(slug, customer.name)
  console.log(`[campaigns] Signals for ${customer.name}: loaded=[${loaded.join(',')}] missing=[${missing.join(',')}] registry=${registrySignals.length}`)

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
    registrySignals,
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

  // Get account team
  const accountTeam = getAccountTeam(customer)

  // Reconstruct template signals from cache + registry (legacy signals object is empty since #276)
  const templateSignals: any = { ...signals }
  try {
    const { existsSync: fsExists, readFileSync: fsRead } = await import('fs')
    const { resolve: pathResolve } = await import('path')
    const cacheDir = process.env.CACHE_DIR ?? 'data/cache'
    const intelPath = pathResolve(cacheDir, 'intelligence', `${slug}.json`)
    if (fsExists(intelPath)) {
      templateSignals.intelligence = JSON.parse(fsRead(intelPath, 'utf-8'))
    }
  } catch { /* silent — template will show dashes */ }
  const subSignals = registrySignals.filter(s => s.source === 'subscriptions')
  if (subSignals.length > 0) {
    templateSignals.subscriptions = subSignals.map(s => ({
      productName: s.metadata?.product ?? s.headline,
      quantity: s.metadata?.quantity ?? 1,
      status: 'Active',
    }))
  }
  const caseSignals = registrySignals.filter(s => s.source === 'cases')
  if (caseSignals.length > 0) templateSignals.cases = caseSignals
  const pipelineSignals = registrySignals.filter(s => s.source === 'pipeline')
  if (pipelineSignals.length > 0) templateSignals.pipeline = pipelineSignals

  const htmlContent = generateCampaignHTML({
    materialTitle,
    materialUrl,
    customerName: customer.name,
    aeName: customer.ae ?? 'Unknown AE',
    generatedDate: timestamp,
    accountTeam,
    signals: templateSignals,
    markdown,
  })

  // 6. Upload to Drive (Google Doc + HTML file)
  let driveUrl = ''
  let htmlUrl = ''
  try {
    const customerFolderId = await findCustomerDriveFolder(customer)
    const driveResult = await uploadCampaignToDrive(
      customerFolderId,
      customer,
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
  router.delete('/api/customer/:name/campaigns/:id', async (c) => {
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
      const campaign = JSON.parse(readFileSync(campaignPath, 'utf-8'))

      // Delete Google Drive files (doc + HTML)
      try {
        const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
        const driveApi = google.drive({ version: 'v3', auth })
        for (const url of [campaign.driveUrl, campaign.htmlUrl].filter(Boolean)) {
          const docIdMatch = (url as string).match(/\/d\/([a-zA-Z0-9_-]+)/)
          if (docIdMatch?.[1]) {
            await driveApi.files.delete({ fileId: docIdMatch[1], supportsAllDrives: true } as any)
            console.log(`[campaigns] Deleted Drive file: ${docIdMatch[1]}`)
          }
        }
      } catch (e: any) {
        console.warn(`[campaigns] Drive delete failed (continuing):`, e?.message ?? e)
      }

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
