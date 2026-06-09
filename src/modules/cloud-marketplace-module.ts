// src/modules/cloud-marketplace-module.ts
// GitHub Issue #306, #451 — Cloud Marketplace Offers feature module
// Extracts Red Hat Cloud Marketplace newsletter content from Gmail,
// parses linked Drive files (presentations/docs), and generates signals
// cross-referenced with customer CCSP cloud spend and tech-stack intelligence.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { resolve } from 'path'
import { toSlug, readCCSPCache } from '../cache-layer.ts'
import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH, withQuotaRetry } from '../google.ts'
import { callGemini } from '../gemini-call.ts'
import { sanitizeErr } from '../utils.ts'
import { extractNewsletterEvents } from '../newsletter-events.ts'
import { CONFIG_DIR } from '../lib/paths.ts'
import { validateAndRetry } from '../gemini-quality-gate.ts'
import { cloudMarketplaceValidator } from '../quality-validators/cloud-marketplace-validator.ts'

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
  validThrough?: string
}

interface CloudIncentive {
  name: string
  description: string
  value?: string
  url?: string
  validThrough?: string
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
- programs: marketplace programs, partnership programs (name + description + eligibility if mentioned + url if a link is present + validThrough date if any deadline/expiry is mentioned)
- incentives: financial incentives, free trials, credits, SPIFFs, sales contests (name + description + value if mentioned + url if a link is present + validThrough date if any deadline/expiry is mentioned)
- newCountries: newly enabled countries/regions
- partnerships: partnership announcements

When extracting from HTML content, preserve any hyperlinks as url fields. Extract pricing details (e.g. "Free tier available", "$0.10/hr") and availability info (e.g. "GA in us-east-1", "Preview in all regions").

IMPORTANT: For programs and incentives, extract the validThrough field as a YYYY-MM-DD date when ANY deadline, expiry, or time-bound language is present. Examples: "valid through June 30, 2025" → "2025-06-30", "Q2 (May-June)" → "2026-06-30", "submission deadline Sept 16, 2025" → "2025-09-16", "end of Q1" → "2026-03-31". If no deadline is mentioned, omit validThrough.

Return a JSON object matching this structure:
{
  "newsletterDate": "YYYY-MM",
  "clouds": [
    {
      "provider": "AWS" | "Google" | "Microsoft" | "Oracle",
      "offerings": [{"name": "...", "description": "...", "dates": "...", "url": "...", "pricing": "...", "availability": "..."}],
      "programs": [{"name": "...", "description": "...", "eligibility": "...", "url": "...", "validThrough": "YYYY-MM-DD"}],
      "incentives": [{"name": "...", "description": "...", "value": "...", "url": "...", "validThrough": "YYYY-MM-DD"}],
      "newCountries": ["India", "Japan"],
      "partnerships": ["..."]
    }
  ]
}

Only include clouds that have actual content. If a cloud has no offerings/programs/incentives/countries/partnerships, omit it entirely.`

// ── Provider section splitting ────────────────────────────────────────────────

const PROVIDER_LABELS: { key: string; patterns: RegExp[] }[] = [
  { key: 'AWS', patterns: [/\bAWS\b/i, /\bAmazon Web Services\b/i] },
  { key: 'Google', patterns: [/\bGoogle\s*Cloud\b/i, /\bGCP\b/i, /\bGoogle Cloud Platform\b/i] },
  { key: 'Microsoft', patterns: [/\bMicrosoft\b/i, /\bAzure\b/i] },
  { key: 'Oracle', patterns: [/\bOracle\b/i, /\bOCI\b/i] },
]

// ── Gemini extraction ────────────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
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
                validThrough: { type: 'string' },
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
                validThrough: { type: 'string' },
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
} as const

/**
 * Merge cloud sections from multiple extraction calls.
 * When the same provider appears in multiple chunks, combine their arrays.
 */
function mergeCloudSections(allSections: CloudSection[]): CloudSection[] {
  const byProvider = new Map<string, CloudSection>()
  for (const section of allSections) {
    const existing = byProvider.get(section.provider)
    if (existing) {
      existing.offerings.push(...section.offerings)
      existing.programs.push(...section.programs)
      existing.incentives.push(...section.incentives)
      existing.newCountries.push(...section.newCountries)
      existing.partnerships.push(...section.partnerships)
    } else {
      byProvider.set(section.provider, {
        provider: section.provider,
        offerings: [...section.offerings],
        programs: [...section.programs],
        incentives: [...section.incentives],
        newCountries: [...section.newCountries],
        partnerships: [...section.partnerships],
      })
    }
  }

  // Split compound offerings, then deduplicate within each provider
  for (const section of byProvider.values()) {
    section.offerings = dedupeByName(splitCompoundOfferings(section.offerings as (CloudOffering & { description: string })[]))
    section.programs = dedupeByName(section.programs)
    section.incentives = dedupeByName(section.incentives)
    section.newCountries = [...new Set(section.newCountries)]
    section.partnerships = [...new Set(section.partnerships)]
  }

  return Array.from(byProvider.values())
}

// ── Canonical product name normalization (#704) ──────────────────────────────

/**
 * Maps known product name variants to canonical forms.
 * Order matters: more specific patterns (RHEL SAP, RHEL AI, RHAIE) must be
 * checked before broader ones (RHEL) to avoid false matches.
 */
const CANONICAL_NAME_RULES: { patterns: RegExp[]; canonical: string }[] = [
  // RHAIE — Gemini hallucinated expansions. Must be before RHEL AI.
  {
    patterns: [/^rhaie\b/i],
    canonical: 'Red Hat Enterprise Linux AI (RHEL AI)',
  },
  // RHEL AI variants — must be before base RHEL
  {
    patterns: [
      /^rhel\s+ai\b/i,
      /^red\s+hat\s+enterprise\s+linux\s+ai\b/i,
      /^red\s+hat\s+ai\b/i,
    ],
    canonical: 'Red Hat Enterprise Linux AI (RHEL AI)',
  },
  // RHEL SAP variants — must be before base RHEL
  {
    patterns: [
      /^rhel\s+(?:for\s+)?sap\b/i,
      /^red\s+hat\s+enterprise\s+linux\s+(?:for\s+)?sap\b/i,
    ],
    canonical: 'Red Hat Enterprise Linux for SAP',
  },
  // Base RHEL — after SAP/AI variants
  {
    patterns: [
      /^rhel$/i,
      /^red\s+hat\s+enterprise\s+linux$/i,
    ],
    canonical: 'Red Hat Enterprise Linux (RHEL)',
  },
  // OpenShift / ROSA
  {
    patterns: [
      /^rosa$/i,
      /^openshift$/i,
      /^red\s+hat\s+openshift\b/i,
    ],
    canonical: 'Red Hat OpenShift',
  },
  // Ansible variants
  {
    patterns: [
      /^aap$/i,
      /^ansible\s+as\s+a\s+service$/i,
      /^ansible\s+automation\s+platform\b/i,
      /^red\s+hat\s+ansible\s+automation\s+platform\b/i,
    ],
    canonical: 'Red Hat Ansible Automation Platform',
  },
  // RHACM
  {
    patterns: [
      /^rhacm$/i,
      /^advanced\s+cluster\s+management\b/i,
      /^red\s+hat\s+advanced\s+cluster\s+management\b/i,
    ],
    canonical: 'Red Hat Advanced Cluster Management',
  },
  // RHLS
  {
    patterns: [
      /^rhls$/i,
      /^red\s+hat\s+learning\s+subscription\b/i,
    ],
    canonical: 'Red Hat Learning Subscription',
  },
]

/**
 * Normalize a product name to its canonical form.
 * Returns the original name if no mapping matches.
 */
export function normalizeOfferingName(name: string): string {
  const trimmed = name.trim()
  for (const rule of CANONICAL_NAME_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(trimmed)) {
        return rule.canonical
      }
    }
  }
  return trimmed
}

/**
 * Split compound offerings like "RHEL, RHEL SAP, RHEL Arm" into individual items.
 * Each segment is normalized. The description from the original item is preserved.
 * Only splits when the entry contains comma or semicolon separators.
 */
export function splitCompoundOfferings<T extends { name: string; description: string }>(items: T[]): T[] {
  const result: T[] = []
  for (const item of items) {
    // Only split if the name contains comma or semicolon
    if (/[,;]/.test(item.name)) {
      const segments = item.name.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      if (segments.length > 1) {
        for (const seg of segments) {
          result.push({ ...item, name: normalizeOfferingName(seg) })
        }
        continue
      }
    }
    // Single entry — just normalize
    result.push({ ...item, name: normalizeOfferingName(item.name) })
  }
  return result
}

function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = normalizeOfferingName(item.name).toLowerCase().trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Merge baseline programs from config-templates/cloud-marketplace-baseline.json
 * into extracted sections. Baseline programs provide a deterministic floor
 * regardless of Gemini extraction quality.
 */
function mergeWithBaseline(sections: CloudSection[]): CloudSection[] {
  let baseline: any = null
  try {
    const baselinePath = resolve('config-templates', 'cloud-marketplace-baseline.json')
    if (existsSync(baselinePath)) {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
    }
  } catch {}

  if (!baseline?.providers) return sections

  for (const bp of baseline.providers) {
    const existing = sections.find(s => s.provider === bp.provider)
    if (existing) {
      // Baseline programs override extraction — they have no validThrough (standing programs)
      // This prevents Gemini from adding expired validThrough dates to permanent programs
      for (const prog of (bp.programs ?? [])) {
        const idx = existing.programs.findIndex(p => p.name.toLowerCase() === prog.name.toLowerCase())
        if (idx >= 0) {
          existing.programs[idx] = prog
        } else {
          existing.programs.push(prog)
        }
      }
      // Baseline offerings — add if missing, don't override extraction
      for (const off of (bp.offerings ?? [])) {
        const exists = existing.offerings.some(o => o.name.toLowerCase() === off.name.toLowerCase())
        if (!exists) {
          existing.offerings.push(off)
        }
      }
    } else {
      // Provider not in extraction — add from baseline
      sections.push({
        provider: bp.provider,
        offerings: bp.offerings ?? [],
        programs: bp.programs ?? [],
        incentives: [],
        newCountries: [],
        partnerships: [],
      })
    }
  }

  return sections
}

/**
 * Extract cloud marketplace data from slide text and newsletter HTML.
 *
 * Strategy: Per-provider focused extraction — send full document to Gemini
 * once per provider with a focused prompt. This replaces the previous
 * splitByProvider() approach that gave inconsistent results depending on
 * how the 100K char slide deck content was split.
 *
 * After extraction, merges with baseline programs and validates via quality gate.
 */
function extractProviderLines(text: string, provider: string): string {
  const patterns = PROVIDER_LABELS.find(l => l.key === provider)?.patterns ?? [new RegExp(`\\b${provider}\\b`, 'i')]
  const lines = text.split('\n')
  const relevant: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some(p => p.test(lines[i]))) {
      const start = Math.max(0, i - 3)
      const end = Math.min(lines.length, i + 5)
      for (let j = start; j < end; j++) {
        if (!relevant.includes(lines[j])) relevant.push(lines[j])
      }
    }
  }
  return relevant.join('\n')
}

/**
 * Extract HTML blocks relevant to a specific cloud provider.
 * Unlike extractProviderLines (designed for line-separated slide text),
 * this splits HTML on block-level tags (<p>, <div>, <tr>, <li>, <h1-6>)
 * which avoids the problem of HTML having very few linebreaks — the
 * line-based approach captures the entire HTML body as one "line".
 * GitHub Issue #707
 */
function extractProviderHtmlBlocks(html: string, provider: string, maxChars: number = 15_000): string {
  if (!html || html.length === 0) return ''
  const patterns = PROVIDER_LABELS.find(l => l.key === provider)?.patterns ?? []
  if (patterns.length === 0) return html.slice(0, maxChars)

  const blocks = html.split(/(?=<(?:p|div|tr|li|h[1-6])\b)/i)
  const relevant: string[] = []
  let totalLen = 0

  for (const block of blocks) {
    if (patterns.some(p => p.test(block))) {
      relevant.push(block)
      totalLen += block.length
      if (totalLen >= maxChars) break
    }
  }

  return relevant.length > 0 ? relevant.join('') : html.slice(0, maxChars)
}

async function extractCloudData(slideText: string, htmlBody: string, newsletterDate: string): Promise<CloudSection[]> {
  const providers = ['AWS', 'Google', 'Microsoft']

  // Per-provider focused extraction — sequential to avoid rate limits
  const extractions: CloudSection[][] = []
  for (const provider of providers) {
    const extraction = await (async () => {
      const providerText = extractProviderLines(slideText, provider)
      const providerHtml = extractProviderHtmlBlocks(htmlBody, provider)
      console.log(`[cloud-marketplace] ${provider}: ${providerText.length} chars of relevant slide text, ${providerHtml.length} chars HTML`)

      const focusedPrompt = `${EXTRACTION_PROMPT}\n\nIMPORTANT: Extract content relevant to ${provider}'s marketplace. Include Red Hat products listed on ${provider}'s marketplace even when described alongside other cloud providers. For example, if a paragraph mentions "available on AWS, Azure, and GCP", extract that offering under ${provider}. Also extract programs, incentives, partnerships, and country availability specific to ${provider}.`

      try {
        const result = await callGemini(focusedPrompt, providerText.slice(0, 10_000) + '\n\nHTML CONTEXT:\n' + providerHtml.slice(0, 5_000), {
          callType: `cloud-marketplace-${provider.toLowerCase()}`,
          model: 'lite',
          responseSchema: RESPONSE_SCHEMA,
          deltaKey: `cloud-marketplace-${provider.toLowerCase()}`,
          timeoutMs: 120_000,
          temperature: 0.1,
        })

        const parsed = JSON.parse(result.text)
        const clouds = parsed.clouds ?? parsed.providers ?? (Array.isArray(parsed) ? parsed : [])
        // Filter to only this provider
        return clouds.filter((c: any) =>
          String(c.provider).toLowerCase() === provider.toLowerCase()
        ) as CloudSection[]
      } catch (e: any) {
        console.warn(`[cloud-marketplace] ${provider} extraction failed: ${e.message}`)
        // Fallback: use previous cache data for this provider if available
        try {
          const cachePath = resolve(CLOUD_MARKETPLACE_CACHE_DIR, 'latest.json')
          if (existsSync(cachePath)) {
            const prev = JSON.parse(readFileSync(cachePath, 'utf-8'))
            const prevProvider = (prev.clouds ?? []).find((c: any) => c.provider === provider)
            if (prevProvider && (prevProvider.offerings?.length > 0 || prevProvider.programs?.length > 0)) {
              console.log(`[cloud-marketplace] ${provider}: using cached fallback (${prevProvider.offerings?.length ?? 0} offerings, ${prevProvider.programs?.length ?? 0} programs)`)
              return [prevProvider] as CloudSection[]
            }
          }
        } catch {}
        return [] as CloudSection[]
      }
    })()
    extractions.push(extraction)
  }

  // Flatten and merge
  const allSections = extractions.flat()
  const merged = mergeCloudSections(allSections)

  // Merge with baseline programs (deterministic floor)
  const withBaseline = mergeWithBaseline(merged)

  // Validate extraction quality via ADR-024 quality gate
  const extractionJson = JSON.stringify({ clouds: withBaseline })
  const gateResult = await validateAndRetry(
    extractionJson,
    { validator: cloudMarketplaceValidator },
    async (failures, attempt) => {
      console.warn(`[cloud-marketplace] quality gate failed (attempt ${attempt}): ${failures.map(f => f.name).join(', ')}`)
      // Don't retry extraction — just log and proceed with what we have
      return extractionJson
    }
  )
  if (!gateResult.scorecard.passed) {
    console.warn(`[cloud-marketplace] quality gate: ${gateResult.scorecard.score}/${gateResult.scorecard.passThreshold} — proceeding with best result`)
  }

  console.log(`[cloud-marketplace] extracted ${withBaseline.length} providers with ${withBaseline.reduce((sum, c) => sum + c.offerings.length, 0)} total offerings, ${withBaseline.reduce((sum, c) => sum + c.programs.length, 0)} programs`)
  return withBaseline
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

// ── Sync mutex ─────────────────────────────────────────────────────────────────

let _syncRunning = false

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'cloud-marketplace',
  displayName: 'Cloud Marketplace',
  refreshEndpoint: '/api/refresh/cloud-marketplace',
  scope: 'customer',
  signalRole: 'trigger',
  signalAudience: 'customer-specific',
  refreshInterval: 7 * 24 * 60 * 60 * 1000,

  cachePaths: () => ['data/cache/cloud-marketplace/latest.json'],
  cacheTtlMs: CLOUD_MARKETPLACE_TTL_MS,

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Check if cache has fresh content (both file age AND non-empty clouds)
    const existing = readCloudMarketplaceCache()
    if (existing?.clouds?.length && existing.cachedAt) {
      if (Date.now() - new Date(existing.cachedAt).getTime() < CLOUD_MARKETPLACE_TTL_MS) return
    }

    // Don't stack concurrent sync attempts
    if (_syncRunning) return

    // Try L3 Drive read first (hero install path)
    const driveOk = await syncFromDrive()
    if (driveOk) {
      const refreshed = readCloudMarketplaceCache()
      if (refreshed?.clouds?.length) return
    }
    await this.syncNow('')
  },

  async fetch(): Promise<void> {},
  async cleanup(): Promise<void> {},

  async syncNow(): Promise<void> {
    if (_syncRunning) {
      console.log('[cloud-marketplace] sync already in progress — skipping')
      return
    }
    _syncRunning = true

    // Clear delta cache for all cloud-marketplace keys to force re-extraction
    const deltaCacheDir = resolve('data/cache/gemini-delta')
    for (const provider of ['aws', 'google', 'microsoft']) {
      const deltaPath = resolve(deltaCacheDir, `cloud-marketplace-${provider}.json`)
      try { if (existsSync(deltaPath)) { unlinkSync(deltaPath); console.log(`[cloud-marketplace] cleared delta cache for ${provider}`) } } catch {}
    }

    console.log('[cloud-marketplace] fetching latest newsletter...')
    try {
      const { newsletterDate, fileIds, slideText, htmlBody } = await fetchNewsletterContent(DEFAULT_SEARCH_QUERY)

      // syncNow always re-extracts — no file-ID skip (PRINCIPLES.md: syncNow vs ensureFresh contract)
      const existing = readCloudMarketplaceCache()

      if (!slideText || slideText.trim().length < 100) {
        console.warn('[cloud-marketplace] insufficient slide text extracted')
        FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: 'no slide content' })
        return
      }

      const clouds = await extractCloudData(slideText, htmlBody, newsletterDate)

      // Stale-overwrite guard: don't save empty extraction when previous cache had data
      if (clouds.length === 0 && existing?.clouds?.length) {
        console.warn(`[cloud-marketplace] Gemini returned 0 clouds but cache has ${existing.clouds.length} — keeping existing cache`)
        FeatureModuleRegistry.recordOutcome('cloud-marketplace', { success: false, error: 'extraction returned 0 clouds' })
        return
      }

      // Filter expired programs/incentives at cache-write time (#708)
      const now = new Date().toISOString().slice(0, 10)
      for (const cloud of clouds) {
        const expiredProgs = cloud.programs.filter(p => p.validThrough && p.validThrough < now).length
        const expiredIncs = cloud.incentives.filter(i => i.validThrough && i.validThrough < now).length
        cloud.programs = cloud.programs.filter(p => !p.validThrough || p.validThrough >= now)
        cloud.incentives = cloud.incentives.filter(i => !i.validThrough || i.validThrough >= now)
        if (expiredProgs + expiredIncs > 0) {
          console.log(`[cloud-marketplace] ${cloud.provider}: removed ${expiredProgs} expired program(s), ${expiredIncs} expired incentive(s) at cache-write`)
        }
      }

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
    } finally {
      _syncRunning = false
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

    // Detect cloud usage from tech-stack intelligence — explicit provider matches only
    const techStackClouds = new Set<string>()
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
          }
        }
      }
    } catch { /* tech-stack cache missing */ }

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

      // Filter expired programs and incentives
      const now = new Date().toISOString().slice(0, 10)
      const activePrograms = cloud.programs.filter(p => !p.validThrough || p.validThrough >= now)
      const activeIncentives = cloud.incentives.filter(i => !i.validThrough || i.validThrough >= now)
      const expiredPrograms = cloud.programs.length - activePrograms.length
      const expiredIncentives = cloud.incentives.length - activeIncentives.length
      if (expiredPrograms > 0) console.log(`[cloud-marketplace] ${cloud.provider}: filtered ${expiredPrograms} expired program(s)`)
      if (expiredIncentives > 0) console.log(`[cloud-marketplace] ${cloud.provider}: filtered ${expiredIncentives} expired incentive(s)`)

      const detailParts: string[] = []
      for (const o of cloud.offerings) {
        let line = o.name
        if (o.availability) line += ` (${o.availability})`
        if (o.pricing) line += ` — ${o.pricing}`
        detailParts.push(line)
      }
      for (const p of activePrograms) {
        let line = `PROGRAM: ${p.name}`
        if (p.eligibility) line += ` — Eligibility: ${p.eligibility}`
        if (p.validThrough) line += ` (valid through ${p.validThrough})`
        detailParts.push(line)
      }
      for (const inc of activeIncentives) {
        let line = `INCENTIVE: ${inc.name}`
        if (inc.value) line += ` — Value: ${inc.value}`
        if (inc.validThrough) line += ` (valid through ${inc.validThrough})`
        detailParts.push(line)
      }
      if (cloud.newCountries.length) detailParts.push(`NEW COUNTRIES: ${cloud.newCountries.join(', ')}`)
      if (cloud.partnerships.length) detailParts.push(`PARTNERSHIPS: ${cloud.partnerships.join('; ')}`)

      const rawRelevance = hasSpend ? 0.8 : hasCloudIntel ? 0.65 : 0.4

      // #479: Use first offering or program URL as representative link
      const representativeUrl = cloud.offerings.find(o => o.url)?.url ?? activePrograms.find(p => p.url)?.url

      signals.push({
        source: 'cloud-marketplace',
        type: 'product-intel',
        headline,
        detail: detailParts.join('\n'),
        rawRelevance,
        timestamp: marketplaceCache.cachedAt,
        url: representativeUrl || undefined,
        metadata: {
          customerSlug: (hasSpend || hasCloudIntel) ? customerSlug : undefined,
          provider: cloud.provider,
          offeringType: 'summary',
          hasCloudSpend: hasSpend,
          hasCloudIntel: hasCloudIntel,
          acvPlus: cloudACV,
          cloudPartner: ccspPartner,
          offerings: cloud.offerings.map(o => ({ name: o.name, availability: o.availability, pricing: o.pricing, url: o.url })),
          programs: activePrograms.map(p => ({ name: p.name, eligibility: p.eligibility, url: p.url, description: p.description, validThrough: p.validThrough })),
          incentives: activeIncentives.map(i => ({ name: i.name, value: i.value, url: i.url, description: i.description, validThrough: i.validThrough })),
          newCountries: cloud.newCountries,
          partnerships: cloud.partnerships,
          sourceNoteId: `cloud-marketplace-${cloud.provider.toLowerCase()}-${marketplaceCache.newsletterDate}`,
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
