// src/modules/cloud-marketplace-module.ts
// GitHub Issue #306 — Cloud Marketplace Offers feature module
// Extracts Red Hat Cloud Marketplace newsletter content from Gmail,
// parses linked Drive files (presentations/docs), and generates signals
// cross-referenced with customer CCSP cloud spend data.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { toSlug, readCCSPCache } from '../cache-layer.ts'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { callGemini } from '../gemini-call.ts'
import { sanitizeErr } from '../utils.ts'

// ── Paths ──────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CLOUD_MARKETPLACE_CACHE_DIR = resolve(CACHE_DIR, 'cloud-marketplace')
const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN ?? resolve(process.env.CONFIG_DIR ?? 'config', '.gmail-token.json')

// Ensure cache directory exists
if (!existsSync(CLOUD_MARKETPLACE_CACHE_DIR)) {
  mkdirSync(CLOUD_MARKETPLACE_CACHE_DIR, { recursive: true })
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface CloudOffering {
  name: string
  description: string
  dates?: string
}

interface CloudProgram {
  name: string
  description: string
  eligibility?: string
}

interface CloudIncentive {
  name: string
  description: string
  value?: string
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
}

// ── Gmail newsletter extraction ────────────────────────────────────────────────

const DEFAULT_SEARCH_QUERY = 'subject:"Cloud Marketplaces and Private Offers Newsletter"'

/**
 * Extract HTML body from Gmail message parts (handles multipart MIME)
 */
function extractHtmlBody(payload: any): string | null {
  // Direct body data
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  // Multipart — walk parts tree to find text/html
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      }
      // Recursive for nested multipart
      if (part.parts) {
        const nested = extractHtmlBody(part)
        if (nested) return nested
      }
    }
  }

  return null
}

/**
 * Extract Google Drive file IDs from HTML body
 * Matches: docs.google.com/presentation/d/{fileId}, document/d/{fileId}, file/d/{fileId}
 */
function extractDriveFileIds(html: string): string[] {
  const regex = /(?:docs|drive)\.google\.com\/(?:presentation|document|file)\/d\/([a-zA-Z0-9_-]+)/g
  const ids = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1])
  }

  return Array.from(ids)
}

/**
 * Fetch latest Cloud Marketplace newsletter from Gmail and extract linked Drive files
 */
async function fetchNewsletterContent(searchQuery: string): Promise<{ newsletterDate: string; fileIds: string[]; slideText: string }> {
  const auth = makeAuth(GMAIL_TOKEN_PATH)
  const gmail = google.gmail({ version: 'v1', auth })
  const drive = google.drive({ version: 'v3', auth })

  // Search for recent newsletters
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: searchQuery,
    maxResults: 5,
  })

  const messages = listRes.data.messages ?? []
  if (messages.length === 0) {
    throw new Error('No Cloud Marketplace newsletters found in Gmail')
  }

  // Get the latest message (first in list)
  const latestId = messages[0].id!
  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: latestId,
    format: 'full',
  })

  // Extract date from headers
  const headers = msgRes.data.payload?.headers ?? []
  const dateHeader = headers.find(h => h.name === 'Date')?.value ?? ''
  const newsletterDate = dateHeader ? new Date(dateHeader).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)

  // Extract HTML body
  const htmlBody = extractHtmlBody(msgRes.data.payload)
  if (!htmlBody) {
    throw new Error('Could not extract HTML body from newsletter email')
  }

  // Extract Drive file IDs
  const fileIds = extractDriveFileIds(htmlBody)
  if (fileIds.length === 0) {
    console.warn('[cloud-marketplace] No Drive file IDs found in newsletter HTML')
  }

  // Export each file as plain text
  const textParts: string[] = []
  for (const fileId of fileIds) {
    try {
      const exportRes = await drive.files.export(
        { fileId, mimeType: 'text/plain' },
        { responseType: 'text' }
      )
      const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)
      textParts.push(content)
    } catch (e: any) {
      console.warn(`[cloud-marketplace] Failed to export file ${fileId}: ${sanitizeErr(e.message)}`)
    }
  }

  const slideText = textParts.join('\n\n---\n\n')

  return { newsletterDate, fileIds, slideText }
}

// ── Gemini extraction ──────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing content from Red Hat's Cloud Marketplaces and Private Offers newsletter slide decks.

Extract structured data per cloud provider (AWS, Google/GCP, Microsoft/Azure, Oracle/OCI).

For each cloud provider, extract:
- offerings: new product listings, versions, images (name + description + dates if mentioned)
- programs: marketplace programs, partnership programs (name + description + eligibility if mentioned)
- incentives: financial incentives, free trials, credits (name + description + value if mentioned)
- newCountries: newly enabled countries/regions
- partnerships: partnership announcements

Return a JSON object matching this structure:
{
  "newsletterDate": "YYYY-MM",
  "clouds": [
    {
      "provider": "AWS" | "Google" | "Microsoft" | "Oracle",
      "offerings": [{"name": "...", "description": "...", "dates": "..."}],
      "programs": [{"name": "...", "description": "...", "eligibility": "..."}],
      "incentives": [{"name": "...", "description": "...", "value": "..."}],
      "newCountries": ["India", "Japan"],
      "partnerships": ["..."]
    }
  ]
}

Only include clouds that have actual content. If a cloud has no offerings/programs/incentives/countries/partnerships, omit it entirely.`

async function extractCloudData(slideText: string, newsletterDate: string): Promise<CloudSection[]> {
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

  const userPrompt = `Newsletter content:\n\n${slideText.slice(0, 40000)}\n\nExtract cloud marketplace data as JSON.`

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

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'cloud-marketplace',
  displayName: 'Cloud Marketplace',
  refreshEndpoint: '/api/refresh/cloud-marketplace',
  scope: 'customer',  // signals are per-customer (CCSP cross-ref)
  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: () => ['data/cache/cloud-marketplace/latest.json'],

  async fetch(): Promise<void> {
    // This module fetches portfolio-level data (newsletter), not per-customer
    // Actual fetching happens in syncNow()
  },

  async cleanup(): Promise<void> {
    // Portfolio-level cache — cleanup not customer-specific
  },

  async syncNow(): Promise<void> {
    console.log('[cloud-marketplace] fetching latest newsletter...')

    try {
      // 1. Fetch newsletter content from Gmail
      const { newsletterDate, fileIds, slideText } = await fetchNewsletterContent(DEFAULT_SEARCH_QUERY)

      if (!slideText || slideText.trim().length < 100) {
        console.warn('[cloud-marketplace] insufficient slide text extracted')
        FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: 'no slide content' })
        return
      }

      // 2. Extract cloud data via Gemini
      const clouds = await extractCloudData(slideText, newsletterDate)

      // 3. Write cache
      const cache: CloudMarketplaceCache = {
        newsletterDate,
        searchQuery: DEFAULT_SEARCH_QUERY,
        sourceFileIds: fileIds,
        clouds,
        cachedAt: new Date().toISOString(),
      }

      writeCloudMarketplaceCache(cache)
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

    const ccspCache = readCCSPCache()
    if (!ccspCache?.records?.length) return []

    // Find customer's CCSP records
    const customerRecords = ccspCache.records.filter(r =>
      toSlug(r.accountName ?? '') === customerSlug
    )
    if (customerRecords.length === 0) return []

    // Map newsletter providers to CCSP cloudPartner values
    const providerMap: Record<string, string> = {
      'Google': 'Google',
      'Microsoft': 'Microsoft',
      'AWS': 'AWS',
      'Oracle': 'Other',
    }

    // Get customer's cloud partners
    const customerClouds = new Set(
      customerRecords.map(r => r.cloudPartner).filter(Boolean)
    )

    const signals: Signal[] = []

    // For each cloud in newsletter, generate signals
    for (const cloud of marketplaceCache.clouds) {
      const ccspPartner = providerMap[cloud.provider]
      const hasCloud = ccspPartner && customerClouds.has(ccspPartner)

      // Calculate total ACV for this cloud
      const cloudACV = hasCloud
        ? customerRecords
            .filter(r => r.cloudPartner === ccspPartner)
            .reduce((sum, r) => sum + (r.acvPlus || 0), 0)
        : 0

      // Generate signals for offerings — limit to top 2 per cloud to leave room for programs/incentives
      for (const offering of cloud.offerings.slice(0, 2)) {
        const headline = hasCloud
          ? `${cloud.provider}: ${offering.name} — customer has $${Math.round(cloudACV).toLocaleString()} ${ccspPartner} spend`
          : `${cloud.provider}: ${offering.name} — expansion opportunity`

        // ADR-027: rawRelevance for offerings
        const rawRelevance = 0.7  // Offerings are high-value content

        signals.push({
          source: 'cloud-marketplace',
          type: 'product-release',
          headline,
          detail: `${offering.description}${offering.dates ? ` Available: ${offering.dates}` : ''}`,
          rawRelevance,
          timestamp: marketplaceCache.cachedAt,
          metadata: {
            customerSlug: hasCloud ? customerSlug : undefined,  // ADR-027: Only customer-specific if they have cloud spend
            provider: cloud.provider,
            offeringType: 'product',
            hasCloudSpend: hasCloud,
            acvPlus: cloudACV,
            cloudPartner: ccspPartner,
          },
        })
      }

      // Generate signals for programs
      for (const program of cloud.programs.slice(0, 2)) {  // Limit to top 2 per cloud
        const headline = hasCloud
          ? `${cloud.provider} program: ${program.name} — leverage existing $${Math.round(cloudACV).toLocaleString()} spend`
          : `${cloud.provider} program: ${program.name}`

        // ADR-027: rawRelevance for programs — higher than offerings because programs
        // (EDP, CPPO, MACC) are directly actionable in customer conversations
        const rawRelevance = 0.8

        signals.push({
          source: 'cloud-marketplace',
          type: 'product-intel',
          headline,
          detail: `${program.description}${program.eligibility ? ` Eligibility: ${program.eligibility}` : ''}`,
          rawRelevance,
          timestamp: marketplaceCache.cachedAt,
          metadata: {
            customerSlug: hasCloud ? customerSlug : undefined,  // ADR-027: Only customer-specific if they have cloud spend
            provider: cloud.provider,
            offeringType: 'program',
            hasCloudSpend: hasCloud,
            cloudPartner: ccspPartner,
          },
        })
      }

      // Generate signals for incentives
      for (const incentive of cloud.incentives.slice(0, 2)) {  // Limit to top 2 per cloud
        const headline = hasCloud
          ? `${cloud.provider} incentive: ${incentive.name} — applicable to customer's ${ccspPartner} workloads`
          : `${cloud.provider} incentive: ${incentive.name}`

        // ADR-027: rawRelevance for incentives — high because incentives
        // (SPIFFs, sales boosts) are directly revenue-relevant
        const rawRelevance = 0.75

        signals.push({
          source: 'cloud-marketplace',
          type: 'product-intel',
          headline,
          detail: `${incentive.description}${incentive.value ? ` Value: ${incentive.value}` : ''}`,
          rawRelevance,
          timestamp: marketplaceCache.cachedAt,
          metadata: {
            customerSlug: hasCloud ? customerSlug : undefined,  // ADR-027: Only customer-specific if they have cloud spend
            provider: cloud.provider,
            offeringType: 'incentive',
            hasCloudSpend: hasCloud,
            cloudPartner: ccspPartner,
          },
        })
      }
    }

    return signals
  },
})
