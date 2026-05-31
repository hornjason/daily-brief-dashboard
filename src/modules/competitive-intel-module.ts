// src/modules/competitive-intel-module.ts
// GitHub Issue #319 — Competitive Intelligence module
// Ingests competitive slide decks + email series from Google Drive and Gmail,
// extracts competitor positioning, sales triggers, and counter-positioning via Gemini,
// and produces competitive signals for playbook SWOT, meeting prep, and campaigns.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { sanitizeErr } from '../utils.ts'
import { validateAndRetry, formatFailureFeedback } from '../gemini-quality-gate.ts'
import { competitiveIntelValidator } from '../quality-validators/competitive-intel-validator.ts'

// ── Paths ──────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const COMPETITIVE_CACHE_DIR = resolve(CACHE_DIR, 'competitive-intel')
const COMPETITIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

// Ensure cache directory exists
if (!existsSync(COMPETITIVE_CACHE_DIR)) {
  mkdirSync(COMPETITIVE_CACHE_DIR, { recursive: true })
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CompetitiveExtraction {
  competitor: string
  product: string
  announcement: string
  redHatCounter: string
  salesTriggers: string[]
  compensation: string | null
  keyDates: string[]
}

export interface DeckCache {
  deckId: string
  deckName: string
  deckDate: string
  contentHash: string
  extractions: CompetitiveExtraction[]
  cachedAt: string
}

export interface CompetitiveIntelCache {
  decks: DeckCache[]
  emailSearchTerms: string[]
  lastRefreshed: string
}

// ── Cache management ──────────────────────────────────────────────────────────

function readCompetitiveCache(): CompetitiveIntelCache | null {
  try {
    const cachePath = resolve(COMPETITIVE_CACHE_DIR, 'decks.json')
    if (!existsSync(cachePath)) return null
    return JSON.parse(readFileSync(cachePath, 'utf-8'))
  } catch (e: any) {
    console.warn(`[competitive-intel] Failed to read cache: ${sanitizeErr(e.message)}`)
    return null
  }
}

function writeCompetitiveCache(data: CompetitiveIntelCache): void {
  const cachePath = resolve(COMPETITIVE_CACHE_DIR, 'decks.json')
  writeFileSync(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 })
}

// ── Gemini extraction prompt ──────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a competitive intelligence slide deck from Red Hat.

Extract ALL competitive positions mentioned. For each competitor/product discussed, extract:

- competitor: Company name (e.g., "VMware", "AWS", "Microsoft")
- product: Specific product or service being discussed
- announcement: What the competitor is doing/announcing (1-2 sentences)
- redHatCounter: Red Hat's counter-positioning or response (1-2 sentences)
- salesTriggers: Array of customer phrases/situations that indicate this competitive scenario applies
  (e.g., "reduce IT staff but do more with less", "consolidate virtualization licensing")
- compensation: Any SPIFF, incentive, or compensation notes for sellers (null if none)
- keyDates: Array of relevant dates/deadlines (empty array if none)

Return a JSON array of extraction objects. Only include competitors explicitly discussed.`

// ── Signal generation ─────────────────────────────────────────────────────────

function generateSignals(cache: CompetitiveIntelCache): Signal[] {
  const signals: Signal[] = []

  for (const deck of cache.decks) {
    for (const extraction of deck.extractions) {
      // Build headline: competitor + key move
      const headline = `${extraction.competitor}: ${extraction.announcement.slice(0, 100)}`

      // Build detail: include counter-positioning
      const detailParts: string[] = []
      if (extraction.redHatCounter) {
        detailParts.push(`Counter: ${extraction.redHatCounter}`)
      }
      if (extraction.salesTriggers?.length) {
        detailParts.push(`Sales trigger: "${extraction.salesTriggers[0]}"`)
      }
      if (extraction.compensation) {
        detailParts.push(`Comp: ${extraction.compensation}`)
      }

      const detail = detailParts.join('. ') || extraction.announcement

      // rawRelevance: higher for entries with sales triggers and compensation
      let rawRelevance = 0.7
      if (extraction.salesTriggers?.length) rawRelevance += 0.05
      if (extraction.compensation) rawRelevance += 0.05
      if (extraction.keyDates?.length) rawRelevance += 0.05
      // Cap at 0.9
      rawRelevance = Math.min(rawRelevance, 0.9)

      signals.push({
        source: 'competitive-intel',
        type: 'competitive',
        headline,
        detail,
        rawRelevance,
        timestamp: deck.cachedAt,
        url: deck.deckId ? `https://docs.google.com/presentation/d/${deck.deckId}` : undefined,  // #479
        metadata: {
          competitor: extraction.competitor,
          product: extraction.product,
          redHatCounter: extraction.redHatCounter,
          salesTrigger: extraction.salesTriggers?.[0] ?? null,
          salesTriggers: extraction.salesTriggers ?? [],
          compensation: extraction.compensation,
          keyDates: extraction.keyDates ?? [],
          deckId: deck.deckId,
          deckDate: deck.deckDate,
          deckName: deck.deckName,
        },
      })
    }
  }

  return signals
}

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'competitive-intel',
  displayName: 'Competitive Intel',
  refreshEndpoint: '/api/refresh/competitive-intel',
  scope: 'portfolio',
  signalRole: 'enrichment',
  signalAudience: 'all',
  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: () => ['data/cache/competitive-intel/decks.json'],

  cacheTtlMs: COMPETITIVE_TTL_MS,

  async ensureFresh(_customerSlug: string): Promise<void> {
    // Portfolio-wide cache — check single file
    const cachePath = resolve(COMPETITIVE_CACHE_DIR, 'decks.json')
    try {
      const stat = statSync(cachePath)
      if (Date.now() - stat.mtimeMs < COMPETITIVE_TTL_MS) {
        // TTL is fresh — also verify content hashes haven't changed
        // For portfolio-scope modules, content hash check is per-deck inside the cache
        const existing = readCompetitiveCache()
        if (existing && existing.decks.length > 0) return // fresh and has data
      }
    } catch { /* file doesn't exist — needs refresh */ }

    // Stale or missing — refresh
    await this.syncNow('')
  },

  async fetch(): Promise<void> {
    // Portfolio-level data — actual fetching happens in syncNow()
  },

  async cleanup(): Promise<void> {
    // Portfolio-level cache — no per-customer cleanup needed
  },

  async syncNow(): Promise<void> {
    console.log('[competitive-intel] starting sync...')

    try {
      // Dynamic imports to avoid breaking tests that don't have Google auth
      const { google } = await import('googleapis')
      const { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } = await import('../google.ts')
      const { callGemini } = await import('../gemini-call.ts')

      const GMAIL_TOKEN_PATH = process.env.GMAIL_TOKEN ?? resolve(process.env.CONFIG_DIR ?? 'config', '.gmail-token.json')
      const auth = makeAuth(GMAIL_TOKEN_PATH)
      const gmail = google.gmail({ version: 'v1', auth })
      const drive = google.drive({ version: 'v3', auth })

      const existingCache = readCompetitiveCache()

      // 1. Search Gmail for competitive update emails
      const emailSearchTerms = ['subject:"15 Minute Competitive Update"', 'subject:"Competitive Update"']
      const emailFileIds = new Set<string>()

      for (const query of emailSearchTerms) {
        try {
          const listRes = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: 10,
          })

          for (const msg of listRes.data.messages ?? []) {
            const msgRes = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id!,
              format: 'full',
            })

            // Extract Drive links from email body
            const bodyData = extractBodyData(msgRes.data.payload)
            if (bodyData) {
              const ids = extractDriveFileIds(bodyData)
              ids.forEach(id => emailFileIds.add(id))
            }
          }
        } catch (e: any) {
          console.warn(`[competitive-intel] Gmail search failed for "${query}": ${sanitizeErr(e.message)}`)
        }
      }

      // 2. Search Drive for competitive decks by name pattern
      const drivePatterns = [
        'name contains "Competitive" and mimeType = "application/vnd.google-apps.presentation"',
        'name contains "15min Competitive" and mimeType = "application/vnd.google-apps.presentation"',
      ]

      const driveFileIds = new Set<string>()
      for (const q of drivePatterns) {
        try {
          const res = await drive.files.list({
            q,
            fields: 'files(id, name, modifiedTime)',
            pageSize: 20,
            orderBy: 'modifiedTime desc',
          })

          for (const file of res.data.files ?? []) {
            if (file.id) driveFileIds.add(file.id)
          }
        } catch (e: any) {
          console.warn(`[competitive-intel] Drive search failed: ${sanitizeErr(e.message)}`)
        }
      }

      // Merge email-discovered and drive-discovered file IDs
      const allFileIds = new Set([...emailFileIds, ...driveFileIds])

      if (allFileIds.size === 0) {
        console.warn('[competitive-intel] no competitive decks found')
        FeatureModuleRegistry.recordOutcome('competitive-intel', { success: true, recordCount: 0 })
        return
      }

      // 3. For each deck, export text and extract via Gemini (with content hash delta)
      const decks: DeckCache[] = []
      const existingHashMap = new Map<string, DeckCache>()
      if (existingCache?.decks) {
        for (const d of existingCache.decks) {
          existingHashMap.set(d.deckId, d)
        }
      }

      for (const fileId of allFileIds) {
        try {
          // Get file metadata
          const fileMeta = await drive.files.get({
            fileId,
            fields: 'id, name, modifiedTime',
          })

          const deckName = fileMeta.data.name ?? 'Unknown'
          const deckDate = fileMeta.data.modifiedTime?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)

          // Export as plain text
          const exportRes = await drive.files.export(
            { fileId, mimeType: 'text/plain' },
            { responseType: 'text' }
          )
          const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)

          if (!content || content.trim().length < 50) {
            console.warn(`[competitive-intel] skipping empty deck: ${deckName}`)
            continue
          }

          // Content hash for cache tagging (used in ensureFresh, never short-circuits syncNow)
          const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16)

          // Extract via Gemini
          const responseSchema = {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                competitor: { type: 'string' },
                product: { type: 'string' },
                announcement: { type: 'string' },
                redHatCounter: { type: 'string' },
                salesTriggers: { type: 'array', items: { type: 'string' } },
                compensation: { type: 'string' },
                keyDates: { type: 'array', items: { type: 'string' } },
              },
              required: ['competitor', 'product', 'announcement', 'redHatCounter', 'salesTriggers'],
            },
          }

          const result = await callGemini(EXTRACTION_PROMPT, content.slice(0, 40000), {
            callType: 'competitive-intel-extraction',
            responseSchema,
            deltaKey: `competitive-intel-${fileId}`,
            timeoutMs: 60_000,
            temperature: 0.2,
          })

          // ADR-024: Quality gate — validate and retry if below threshold
          const gateResult = await validateAndRetry(
            result.text,
            { validator: competitiveIntelValidator },
            async (failures, _attempt) => {
              const feedback = formatFailureFeedback(failures)
              const retryResult = await callGemini(EXTRACTION_PROMPT, content.slice(0, 40000) + '\n\n' + feedback, {
                callType: 'competitive-intel-extraction',
                responseSchema,
                deltaKey: `competitive-intel-${fileId}-retry`,
                timeoutMs: 60_000,
                temperature: 0.2,
              })
              return retryResult.text
            }
          )

          const parsed = JSON.parse(gateResult.output)
          const extractions: CompetitiveExtraction[] = (Array.isArray(parsed) ? parsed : []).map((e: any) => ({
            competitor: String(e.competitor ?? ''),
            product: String(e.product ?? ''),
            announcement: String(e.announcement ?? ''),
            redHatCounter: String(e.redHatCounter ?? ''),
            salesTriggers: Array.isArray(e.salesTriggers) ? e.salesTriggers.map(String) : [],
            compensation: e.compensation ? String(e.compensation) : null,
            keyDates: Array.isArray(e.keyDates) ? e.keyDates.map(String) : [],
          }))

          decks.push({
            deckId: fileId,
            deckName,
            deckDate,
            contentHash,
            extractions,
            cachedAt: new Date().toISOString(),
          })

          console.log(`[competitive-intel] extracted ${extractions.length} positions from "${deckName}"`)
        } catch (e: any) {
          console.error(`[competitive-intel] failed to process deck ${fileId}: ${sanitizeErr(e.message)}`)
        }
      }

      // 4. Write cache
      const cache: CompetitiveIntelCache = {
        decks,
        emailSearchTerms,
        lastRefreshed: new Date().toISOString(),
      }
      writeCompetitiveCache(cache)

      const totalExtractions = decks.reduce((sum, d) => sum + d.extractions.length, 0)
      FeatureModuleRegistry.recordOutcome('competitive-intel', { success: true, recordCount: totalExtractions })
      console.log(`[competitive-intel] cached ${decks.length} decks with ${totalExtractions} competitive positions`)

    } catch (e: any) {
      console.error(`[competitive-intel] sync failed: ${sanitizeErr(e.message)}`)
      FeatureModuleRegistry.recordOutcome('competitive-intel', { success: false, error: e.message })
      throw e
    }
  },

  async signals(_customerSlug: string): Promise<Signal[]> {
    const cache = readCompetitiveCache()
    if (!cache || !cache.decks?.length) return []

    return generateSignals(cache)
  },
})

// ── Utility functions ─────────────────────────────────────────────────────────

function extractBodyData(payload: any): string | null {
  if (payload?.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8')
  }

  if (payload?.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
      }
      if (part.parts) {
        const nested = extractBodyData(part)
        if (nested) return nested
      }
    }
  }

  return null
}

function extractDriveFileIds(html: string): string[] {
  const regex = /(?:docs|drive)\.google\.com\/(?:presentation|document|file)\/d\/([a-zA-Z0-9_-]+)/g
  const ids = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1])
  }

  return Array.from(ids)
}
