/**
 * Initiative Extractor — GitHub Issue #514
 *
 * Extracts structured business initiatives from intelligence module prose
 * using Gemini. Results are cached per customer with content-hash invalidation
 * to avoid unnecessary Gemini calls on unchanged intelligence text.
 */

import { createHash } from 'crypto'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { callGemini } from '../gemini-call.ts'
import { writeJsonAtomic } from './atomic-write.ts'

// ── Types ───────────────────────────────────────────────────────────────────────

export interface Initiative {
  name: string                             // e.g., "AI-native platform strategy"
  source: string                           // excerpt from intelligence text
  confidence: 'high' | 'medium' | 'low'
  alignsWithProducts: string[]             // Red Hat product categories
}

interface InitiativeCache {
  contentHash: string
  initiatives: Initiative[]
  cachedAt: string
}

// ── Configuration ───────────────────────────────────────────────────────────────

const CACHE_DIR = resolve(process.env.CACHE_DIR ?? 'data/cache', 'intelligence')

const VALID_PRODUCTS = new Set([
  'RHEL', 'OpenShift', 'Ansible', 'RHOAI', 'OpenShift AI',
  'OpenShift Virtualization', 'Satellite', 'Application Foundations',
])

// ── Helpers ─────────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function readCache(customerSlug: string): InitiativeCache | null {
  const path = resolve(CACHE_DIR, `${customerSlug}-initiatives.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function writeCache(customerSlug: string, cache: InitiativeCache): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true })
  }
  const path = resolve(CACHE_DIR, `${customerSlug}-initiatives.json`)
  writeJsonAtomic(path, cache)
}

function validateInitiative(item: any): Initiative | null {
  if (!item || typeof item !== 'object') return null
  if (typeof item.name !== 'string' || !item.name) return null
  if (typeof item.source !== 'string' || !item.source) return null

  const confidence = item.confidence
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null

  if (!Array.isArray(item.alignsWithProducts) || item.alignsWithProducts.length === 0) return null
  // Filter to valid product names
  const products = item.alignsWithProducts.filter((p: any) => typeof p === 'string' && VALID_PRODUCTS.has(p))
  if (products.length === 0) return null

  return {
    name: item.name,
    source: item.source,
    confidence,
    alignsWithProducts: products,
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Extract business initiatives from intelligence text using Gemini.
 * Results are cached per customer; cache is invalidated when text content changes.
 */
export async function extractInitiatives(
  intelligenceText: string,
  customerName: string,
): Promise<Initiative[]> {
  // Edge case: empty text
  if (!intelligenceText || !intelligenceText.trim()) {
    return []
  }

  const customerSlug = toSlug(customerName)
  const contentHash = hashContent(intelligenceText)

  // Check cache
  const cached = readCache(customerSlug)
  if (cached && cached.contentHash === contentHash) {
    return cached.initiatives
  }

  // Call Gemini for extraction
  const systemPrompt = `You are a business analyst specializing in IT strategy. Extract business initiatives and strategic priorities from company intelligence reports. Return structured JSON only.`

  const userPrompt = `Analyze the following intelligence text for ${customerName} and extract 2-5 business initiatives or strategic priorities.

For each initiative, identify which Red Hat product categories it aligns with. Valid categories: RHEL, OpenShift, Ansible, RHOAI, OpenShift AI, OpenShift Virtualization, Satellite, Application Foundations.

Return a JSON array where each element has:
- "name": short name for the initiative (e.g., "AI-native platform strategy")
- "source": the exact excerpt from the text that mentions this initiative
- "confidence": "high", "medium", or "low" based on how explicitly the initiative is stated
- "alignsWithProducts": array of Red Hat product category names that could address this initiative

Intelligence text:
${intelligenceText}`

  const responseSchema = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING' },
        source: { type: 'STRING' },
        confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        alignsWithProducts: {
          type: 'ARRAY',
          items: { type: 'STRING' },
        },
      },
      required: ['name', 'source', 'confidence', 'alignsWithProducts'],
    },
  }

  let initiatives: Initiative[] = []

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'initiative-extraction',
      customerName,
      responseSchema,
    })

    const parsed = JSON.parse(result.text)
    if (!Array.isArray(parsed)) {
      return []
    }

    initiatives = parsed
      .map(validateInitiative)
      .filter((i): i is Initiative => i !== null)
  } catch {
    // Malformed response or Gemini error — return empty gracefully
    return []
  }

  // Write cache
  writeCache(customerSlug, {
    contentHash,
    initiatives,
    cachedAt: new Date().toISOString(),
  })

  return initiatives
}
