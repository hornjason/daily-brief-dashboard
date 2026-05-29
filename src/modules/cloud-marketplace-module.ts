// src/modules/cloud-marketplace-module.ts
// GitHub Issue #306, #451 — Cloud Marketplace Offers feature module
// Extracts Red Hat Cloud Marketplace newsletter content from Gmail,
// parses linked Drive files (presentations/docs), and generates signals
// cross-referenced with customer CCSP cloud spend and tech-stack intelligence.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { toSlug, readCCSPCache } from '../cache-layer.ts'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { callGemini } from '../gemini-call.ts'
import { sanitizeErr } from '../utils.ts'
import { extractNewsletterEvents } from '../newsletter-events.ts'
import { CONFIG_DIR } from '../lib/paths.ts'

// ── Paths ──────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CLOUD_MARKETPLACE_CACHE_DIR = resolve(CACHE_DIR, 'cloud-marketplace')
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN ?? resolve(process.env.CONFIG_DIR ?? 'config', '.gmail-token.json')
const CLOUD_MARKETPLACE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// Ensure cache directory exists
if (!existsSync(CLOUD_MARKETPLACE_CACHE_DIR)) {
  mkdirSync(CLOUD_MARKETPLACE_CACHE_DIR, { recursive: true })
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface CloudOffering {
  name: string
  description: string
  dates?: string
  url?: string
  pricing?: string
  availability?: string
}

interface CloudProgram {
  name: string
  description: string
  eligibility?: string
  url?: string
}

interface CloudIncentive {
  name: string
  description: string
  value?: string
  url?: string
}

interface CloudSection {
  provider: string  // 'AWS' | 'Google' | 'Microsoft' | 'Oracle'
  offerings: CloudOffering[]
  programs: CloudProgram[]
  incentives: CloudIncentive[]
  newCountries: string[]
  partnerships: string[]
}

interface CloudMarketplaceCache {
  newsletterDate: string
  searchQuery: string
  sourceFileIds: string[]
  clouds: CloudSection[]
  cachedAt: string
  newsletterHtml?: string
  rawSlideContent?: string
}

// ── Gmail newsletter extraction ────────────────────────────────────────────────

const DEFAULT_SEARCH_QUERY = 'subject:"Cloud Marketplaces and Private Offers Newsletter"'

function extractHtmlBody(payload: any): string | null {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      }
      if (part.parts) {
        const nested = extractHtmlBody(part)
        if (nested) return nested
      }
    }
  }
  return null
}

/**
 * Extract Google Docs Editor file IDs from HTML body.
 * Only matches docs.google.com links (presentations, documents).
 * Skips drive.google.com/file/d/ links — those are uploaded binaries
 * that can't be exported via the Docs export API.
 */
function extractDriveFileIds(html: string): string[] {
  const regex = /docs\.google\.com\/(?:presentation|document)\/d\/([a-zA-Z0-9_-]+)/g
  const ids = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1])
  }
  return Array.from(ids)
}

async function fetchNewsletterContent(searchQuery: string): Promise<{ newsletterDate: string; fileIds: string[]; slideText: string; htmlBody: string }> {
  const auth = makeAuth(GMAIL_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })
  const drive = google.drive({ version: 'v3', auth })

  const listRes = await gmail.users.messages.list({ userId: 'me', q: searchQuery, maxResults: 5 })
  const messages = listRes.data.messages ?? []
  if (messages.length === 0) throw new Error('No Cloud Marketplace newsletters found in Gmail')

  const latestId = messages[0].id!
  const msgRes = await gmail.users.messages.get({ userId: 'me', id: latestId, format: 'full' })

  const headers = msgRes.data.payload?.headers ?? []
  const dateHeader = headers.find(h => h.name === 'Date')?.value ?? ''
  const newsletterDate = dateHeader ? new Date(dateHeader).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)

  const htmlBody = extractHtmlBody(msgRes.data.payload)
  if (!htmlBody) throw new Error('Could not extract HTML body from newsletter email')

  const fileIds = extractDriveFileIds(htmlBody)
  if (fileIds.length === 0) console.warn('[cloud-marketplace] No Drive file IDs found in newsletter HTML')

  // Export each file using the right format based on its MIME type
  const textParts: string[] = []
  for (const fileId of fileIds) {
    try {
      const fileMeta = await drive.files.get({ fileId, fields: 'id,name,mimeType', supportsAllDrives: true })
      const mime = fileMeta.data.mimeType ?? ''
      const fname = fileMeta.data.name ?? fileId

      let exportMime: string
      if (mime === 'application/vnd.google-apps.document') {
        exportMime = 'text/html'
      } else if (mime === 'application/vnd.google-apps.presentation') {
        exportMime = 'text/plain'
      } else if (mime.startsWith('application/vnd.google-apps.')) {
        exportMime = 'text/plain'
      } else {
        console.log(`[cloud-marketplace] ${fname}: non-native file (${mime}) — downloading raw`)
        try {
          const dlRes = await drive.files.get(
            { fileId, alt: 'media', supportsAllDrives: true } as any,
            { responseType: 'text' },
          )
          const raw = typeof dlRes.data === 'string' ? dlRes.data : String(dlRes.data)
          if (raw.length > 100) textParts.push(raw)
        } catch (dlErr: any) {
          console.warn(`[cloud-marketplace] ${fname}: raw download failed: ${sanitizeErr(dlErr.message)}`)
        }
        continue
      }

      console.log(`[cloud-marketplace] ${fname}: exporting as ${exportMime} (${mime})`)
      const exportRes = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'text' })
      const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)
      textParts.push(content)
    } catch (e: any) {
      console.warn(`[cloud-marketplace] Failed to export file ${fileId}: ${sanitizeErr(e.message)}`)
    }
  }

  const slideText = textParts.join('\n\n---\n\n')
  return { newsletterDate, fileIds, slideText, htmlBody }
}

// ── Gemini extraction ──────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing content from Red Hat's Cloud Marketplaces and Private Offers newsletter slide decks.

Extract structured data per cloud provider (AWS, Google/GCP, Microsoft/Azure, Oracle/OCI).

For each cloud provider, extract:
- offerings: new product listings, versions, images (name + description + dates if mentioned + url if a link is present + pricing if mentioned + availability regions/dates if mentioned)
- programs: marketplace programs, partnership programs (name + description + eligibility if mentioned + url if a link is present)
- incentives: financial incentives, free trials, credits (name + description + value if mentioned + url if a link is present)
- newCountries: newly enabled countries/regions
- partnerships: partnership announcements

When extracting from HTML content, preserve any hyperlinks as url fields. Extract pricing details (e.g. "Free tier available", "$0.10/hr") and availability info (e.g. "GA in us-east-1", "Preview in all regions").

Return a JSON object matching this structure:
{
  "newsletterDate": "YYYY-MM",
  "clouds": [
    {
      "provider": "AWS" | "Google" | "Microsoft" | "Oracle",
      "offerings": [{"name": "...", "description": "...", "dates": "...", "url": "...", "pricing": "...", "availability": "..."}],
      "programs": [{"name": "...", "description": "...", "eligibility": "...", "url": "..."}],
      "incentives": [{"name": "...", "description": "...", "value": "...", "url": "..."}],
      "newCountries": ["India", "Japan"],
      "partnerships": ["..."]
    }
  ]
}

Only include clouds that have actual content. If a cloud has no offerings/programs/incentives/countries/partnerships, omit it entirely.`

async function extractCloudData(slideText: string, htmlBody: string, newsletterDate: string): Promise<CloudSection[]> {
  const responseSchema = {
    type: 'object',
    properties: {
      newsletterDate: { type: 'string' },
      clouds: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['AWS', 'Google', 'Microsoft', 'Oracle'] },
            offerings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  dates: { type: 'string' },
                  url: { type: 'string' },
                  pricing: { type: 'string' },
                  availability: { type: 'string' },
                },
                required: ['name', 'description'],
              },
            },
            programs: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  eligibility: { type: 'string' },
                  url: { type: 'string' },
                },
                required: ['name', 'description'],
              },
            },
            incentives: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  value: { type: 'string' },
                  url: { type: 'string' },
                },
                required: ['name', 'description'],
              },
            },
            newCountries: { type: 'array', items: { type: 'string' } },
            partnerships: { type: 'array', items: { type: 'string' } },
          },
          required: ['provider', 'offerings', 'programs', 'incentives', 'newCountries', 'partnerships'],
        },
      },
    },
    required: ['newsletterDate', 'clouds'],
  }

  const userPrompt = `Slide deck content (HTML):\n\n${slideText.slice(0, 30000)}\n\nNewsletter email body (HTML):\n\n${htmlBody.slice(0, 10000)}\n\nExtract cloud marketplace data as JSON. Preserve any URLs found in anchor tags.`

  try {
    const result = await callGemini(EXTRACTION_PROMPT, userPrompt, {
      callType: 'cloud-marketplace-extraction',
      model: 'full',
      responseSchema,
      deltaKey: 'cloud-marketplace-latest',
      timeoutMs: 60_000,
      temperature: 0.2,
    })
    const parsed = JSON.parse(result.text)
    return parsed.clouds ?? []
  } catch (e: any) {
    console.error(`[cloud-marketplace] Gemini extraction failed: ${sanitizeErr(e.message)}`)
    return []
  }
}

// ── Cache management ───────────────────────────────────────────────────────────

function readCloudMarketplaceCache(): CloudMarketplaceCache | null {
  try {
    const cachePath = resolve(CLOUD_MARKETPLACE_CACHE_DIR, 'latest.json')
    if (!existsSync(cachePath)) return null
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch (e: any) {
    console.warn(`[cloud-marketplace] Failed to read cache: ${sanitizeErr(e.message)}`)
    return null
  }
}

function writeCloudMarketplaceCache(data: CloudMarketplaceCache): void {
  const cachePath = resolve(CLOUD_MARKETPLACE_CACHE_DIR, 'latest.json')
  writeFileSync(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function getCloudMarketplaceContent(): {
  rawContent: string | null
  newsletterDate: string | null
  cachedAt: string | null
  clouds: CloudSection[]
} {
  const cache = readCloudMarketplaceCache()
  if (!cache) return { rawContent: null, newsletterDate: null, cachedAt: null, clouds: [] }
  return {
    rawContent: cache.rawSlideContent ?? null,
    newsletterDate: cache.newsletterDate,
    cachedAt: cache.cachedAt,
    clouds: cache.clouds,
  }
}

// ── Drive sync (L3 shared read/write) ─────────────────────────────────────────

const CLOUD_MARKETPLACE_FOLDER_NAME = 'Cloud Marketplace'
const CLOUD_MARKETPLACE_JSON_NAME = 'cloud-marketplace-latest.json'

function getPodBookingsFolderId(): string | null {
  try {
    const settingsPath = resolve(CONFIG_DIR, 'settings.json')
    if (!existsSync(settingsPath)) return null
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const regions = settings.regions ?? []
    for (const r of regions) {
      if (r.podBookingsFolderId) return r.podBookingsFolderId
    }
  } catch {}
  return null
}

async function ensureCloudMarketplaceFolder(parentFolderId: string): Promise<string> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const listRes = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${CLOUD_MARKETPLACE_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true,
    }),
    '[cloud-marketplace] find Cloud Marketplace folder',
  )
  const existingId = listRes.data.files?.[0]?.id
  if (existingId) return existingId
  const createRes = await withQuotaRetry(
    () => drive.files.create({
      requestBody: { name: CLOUD_MARKETPLACE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
      fields: 'id', supportsAllDrives: true,
    }),
    '[cloud-marketplace] create Cloud Marketplace folder',
  )
  return createRes.data.id!
}

async function copySlideDecksToFolder(folderId: string, fileIds: string[]): Promise<void> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const existingRes = await withQuotaRetry(
    () => drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 100,
    }),
    '[cloud-marketplace] list existing files in folder',
  )
  const existingNames = new Set((existingRes.data.files ?? []).map(f => f.name))

  for (const sourceId of fileIds) {
    try {
      const meta = await drive.files.get({ fileId: sourceId, fields: 'id,name,mimeType', supportsAllDrives: true })
      const sourceName = meta.data.name ?? sourceId
      if (existingNames.has(sourceName)) {
        console.log(`[cloud-marketplace] ${sourceName}: already in folder — skipping`)
        continue
      }
      await withQuotaRetry(
        () => drive.files.copy({
          fileId: sourceId,
          requestBody: { name: sourceName, parents: [folderId] },
          fields: 'id,name', supportsAllDrives: true,
        }),
        `[cloud-marketplace] copy ${sourceName}`,
      )
      console.log(`[cloud-marketplace] copied ${sourceName} to Cloud Marketplace folder`)
    } catch (e: any) {
      console.warn(`[cloud-marketplace] Failed to copy file ${sourceId}: ${sanitizeErr(e.message)}`)
    }
  }
}

async function uploadCloudMarketplaceJson(folderId: string, data: CloudMarketplaceCache): Promise<void> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })
  const listRes = await withQuotaRetry(
    () => drive.files.list({
      q: `name = '${CLOUD_MARKETPLACE_JSON_NAME}' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
    }),
    '[cloud-marketplace] find existing JSON',
  )
  const content = JSON.stringify(data, null, 2)
  const existingFileId = listRes.data.files?.[0]?.id
  if (existingFileId) {
    await withQuotaRetry(
      () => drive.files.update({ fileId: existingFileId, media: { mimeType: 'application/json', body: content }, supportsAllDrives: true }),
      '[cloud-marketplace] update JSON on Drive',
    )
  } else {
    await withQuotaRetry(
      () => drive.files.create({
        requestBody: { name: CLOUD_MARKETPLACE_JSON_NAME, parents: [folderId], mimeType: 'application/json' },
        media: { mimeType: 'application/json', body: content }, fields: 'id', supportsAllDrives: true,
      }),
      '[cloud-marketplace] upload JSON to Drive',
    )
  }
}

async function syncFromDrive(): Promise<boolean> {
  const parentFolderId = getPodBookingsFolderId()
  if (!parentFolderId) {
    console.log('[cloud-marketplace] No podBookingsFolderId in settings — skipping Drive sync')
    return false
  }
  try {
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })
    const folderListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${CLOUD_MARKETPLACE_FOLDER_NAME}' and '${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true,
      }),
      '[cloud-marketplace] find Cloud Marketplace folder for read',
    )
    const cmFolderId = folderListRes.data.files?.[0]?.id
    if (!cmFolderId) { console.log('[cloud-marketplace] No Cloud Marketplace folder found on Drive'); return false }

    const fileListRes = await withQuotaRetry(
      () => drive.files.list({
        q: `name = '${CLOUD_MARKETPLACE_JSON_NAME}' and '${cmFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, modifiedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true,
      }),
      '[cloud-marketplace] find cloud-marketplace-latest.json',
    )
    const jsonFileId = fileListRes.data.files?.[0]?.id
    if (!jsonFileId) { console.log('[cloud-marketplace] No cloud-marketplace-latest.json found on Drive'); return false }

    const contentRes = await withQuotaRetry(
      () => drive.files.get(
        { fileId: jsonFileId, alt: 'media', supportsAllDrives: true } as any,
        { responseType: 'text' },
      ),
      '[cloud-marketplace] download cloud-marketplace-latest.json',
    )
    const jsonData = typeof contentRes.data === 'string' ? contentRes.data : JSON.stringify(contentRes.data)
    JSON.parse(jsonData) // validate
    writeFileSync(resolve(CLOUD_MARKETPLACE_CACHE_DIR, 'latest.json'), jsonData, { mode: 0o600 })
    console.log('[cloud-marketplace] synced from Drive successfully')
    return true
  } catch (e: any) {
    console.warn(`[cloud-marketplace] Drive sync failed: ${sanitizeErr(e.message)}`)
    return false
  }
}

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'cloud-marketplace',
  displayName: 'Cloud Marketplace',
  refreshEndpoint: '/api/refresh/cloud-marketplace',
  scope: 'customer',
  refreshInterval: 7 * 24 * 60 * 60 * 1000,

  cachePaths: () => ['data/cache/cloud-marketplace/latest.json'],
  cacheTtlMs: CLOUD_MARKETPLACE_TTL_MS,

  async ensureFresh(_customerSlug: string): Promise<void> {
    const cachePath = resolve(CLOUD_MARKETPLACE_CACHE_DIR, 'latest.json')
    try {
      const stat = statSync(cachePath)
      if (Date.now() - stat.mtimeMs < CLOUD_MARKETPLACE_TTL_MS) return
    } catch { /* file doesn't exist */ }

    // Try L3 Drive read first (hero install path)
    const driveOk = await syncFromDrive()
    if (driveOk) {
      try {
        const stat = statSync(cachePath)
        if (Date.now() - stat.mtimeMs < CLOUD_MARKETPLACE_TTL_MS) return
      } catch { /* fall through to Gmail */ }
    }
    await this.syncNow('')
  },

  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {
    console.log('[cloud-marketplace] fetching latest newsletter...')
    try {
      const { newsletterDate, fileIds, slideText, htmlBody } = await fetchNewsletterContent(DEFAULT_SEARCH_QUERY)
      if (!slideText || slideText.trim().length < 100) {
        console.warn('[cloud-marketplace] insufficient slide text extracted')
        FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: 'no slide content' })
        return
      }

      const clouds = await extractCloudData(slideText, htmlBody, newsletterDate)

      const cache: CloudMarketplaceCache = {
        newsletterDate,
        searchQuery: DEFAULT_SEARCH_QUERY,
        sourceFileIds: fileIds,
        clouds,
        cachedAt: new Date().toISOString(),
        newsletterHtml: htmlBody.slice(0, 50_000),
        rawSlideContent: slideText.slice(0, 100_000),
      }

      writeCloudMarketplaceCache(cache)

      // Write to Drive for L3 sharing (non-fatal)
      try {
        const parentId = getPodBookingsFolderId()
        if (parentId) {
          const cmFolder = await ensureCloudMarketplaceFolder(parentId)
          await copySlideDecksToFolder(cmFolder, fileIds)
          await uploadCloudMarketplaceJson(cmFolder, cache)
          console.log('[cloud-marketplace] synced to Drive successfully')
        }
      } catch (driveErr: any) {
        console.warn(`[cloud-marketplace] Drive write failed (non-fatal): ${sanitizeErr(driveErr.message)}`)
      }

      FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: true, recordCount: clouds.length })
      console.log(`[cloud-marketplace] cached ${clouds.length} cloud sections for ${newsletterDate}`)
    } catch (e: any) {
      console.error(`[cloud-marketplace] sync failed: ${sanitizeErr(e.message)}`)
      FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: e.message })
      throw e
    }
  },

  async signals(customerSlug: string): Promise<Signal[]> {
    const marketplaceCache = readCloudMarketplaceCache()
    if (!marketplaceCache || !marketplaceCache.clouds?.length) return []

    // CCSP spend data — optional, enriches signals when present
    const ccspCache = readCCSPCache()
    const customerRecords = (ccspCache?.records ?? []).filter(r =>
      toSlug(r.accountName ?? '') === customerSlug
    )

    const providerMap: Record<string, string> = {
      'Google': 'Google', 'Microsoft': 'Microsoft', 'AWS': 'AWS', 'Oracle': 'Other',
    }

    const ccspClouds = new Set(customerRecords.map(r => r.cloudPartner).filter(Boolean))

    // Detect cloud usage from tech-stack intelligence
    const techStackClouds = new Set<string>()
    let hasGenericCloudIntel = false
    try {
      const techPath = resolve(CACHE_DIR, 'tech-stack', `${customerSlug}.json`)
      if (existsSync(techPath)) {
        const techData = JSON.parse(readFileSync(techPath, 'utf-8'))
        for (const tech of techData.technologies ?? []) {
          for (const infra of tech.infrastructure ?? []) {
            const lower = infra.toLowerCase()
            if (lower.includes('aws') || lower.includes('amazon')) techStackClouds.add('AWS')
            if (lower.includes('azure') || lower.includes('microsoft')) techStackClouds.add('Microsoft')
            if (lower.includes('google cloud') || lower.includes('gcp')) techStackClouds.add('Google')
            if (lower.includes('oracle cloud') || lower.includes('oci')) techStackClouds.add('Oracle')
            if (lower.includes('cloud') || lower.includes('kubernetes') || lower.includes('containers')) hasGenericCloudIntel = true
          }
        }
      }
    } catch { /* tech-stack cache missing */ }
    if (hasGenericCloudIntel) {
      for (const p of ['AWS', 'Microsoft', 'Google', 'Oracle']) techStackClouds.add(p)
    }

    const signals: Signal[] = []

    for (const cloud of marketplaceCache.clouds) {
      const ccspPartner = providerMap[cloud.provider]
      const hasSpend = ccspPartner && ccspClouds.has(ccspPartner)
      const hasCloudIntel = techStackClouds.has(cloud.provider)

      // Skip providers the customer has no relationship with
      if (!hasSpend && !hasCloudIntel) continue

      const cloudACV = hasSpend
        ? customerRecords.filter(r => r.cloudPartner === ccspPartner).reduce((sum, r) => sum + (r.acvPlus || 0), 0)
        : 0

      let headline: string
      if (hasSpend) {
        headline = `${cloud.provider} Marketplace: ${cloud.offerings.length} offerings, ${cloud.programs.length} programs — customer has $${Math.round(cloudACV).toLocaleString()} ${ccspPartner} spend`
      } else {
        headline = `${cloud.provider} Marketplace: ${cloud.offerings.length} offerings, ${cloud.programs.length} programs — customer uses ${cloud.provider}, position Red Hat solutions`
      }

      const detailParts: string[] = []
      for (const o of cloud.offerings) {
        let line = o.name
        if (o.availability) line += ` (${o.availability})`
        if (o.pricing) line += ` — ${o.pricing}`
        detailParts.push(line)
      }
      for (const p of cloud.programs) {
        let line = `PROGRAM: ${p.name}`
        if (p.eligibility) line += ` — Eligibility: ${p.eligibility}`
        detailParts.push(line)
      }
      for (const inc of cloud.incentives) {
        let line = `INCENTIVE: ${inc.name}`
        if (inc.value) line += ` — Value: ${inc.value}`
        detailParts.push(line)
      }
      if (cloud.newCountries.length) detailParts.push(`NEW COUNTRIES: ${cloud.newCountries.join(', ')}`)
      if (cloud.partnerships.length) detailParts.push(`PARTNERSHIPS: ${cloud.partnerships.join('; ')}`)

      const rawRelevance = hasSpend ? 0.8 : hasCloudIntel ? 0.65 : 0.4

      signals.push({
        source: 'cloud-marketplace',
        type: 'product-intel',
        headline,
        detail: detailParts.join('\n'),
        rawRelevance,
        timestamp: marketplaceCache.cachedAt,
        metadata: {
          customerSlug: (hasSpend || hasCloudIntel) ? customerSlug : undefined,
          provider: cloud.provider,
          offeringType: 'summary',
          hasCloudSpend: hasSpend,
          hasCloudIntel: hasCloudIntel,
          acvPlus: cloudACV,
          cloudPartner: ccspPartner,
          offerings: cloud.offerings.map(o => ({ name: o.name, availability: o.availability, pricing: o.pricing, url: o.url })),
          programs: cloud.programs.map(p => ({ name: p.name, eligibility: p.eligibility, url: p.url, description: p.description })),
          incentives: cloud.incentives.map(i => ({ name: i.name, value: i.value, url: i.url, description: i.description })),
          newCountries: cloud.newCountries,
          partnerships: cloud.partnerships,
        },
      })
    }

    // #316: Newsletter events (office hours, recordings, announcements)
    if (marketplaceCache.newsletterHtml) {
      const newsletterEvents = extractNewsletterEvents(marketplaceCache.newsletterHtml)
      for (const ne of newsletterEvents) {
        signals.push({
          source: 'cloud-marketplace',
          type: 'event',
          headline: ne.title,
          detail: ne.detail ?? ne.title,
          rawRelevance: ne.eventType === 'office-hours' ? 0.7 : 0.5,
          timestamp: marketplaceCache.cachedAt,
          url: ne.url,
          metadata: { eventType: ne.eventType, newsletterSource: true, date: ne.date },
        })
      }
    }

    return signals
  },
})
