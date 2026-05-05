/**
 * Expansion Opportunities — BKL-PRODINTEL-04
 *
 * Cross-product expansion analysis. Given all available customer signals
 * (intelligence cache, subscriptions, cases, Drive docs, feature caches),
 * recommends Red Hat products the customer doesn't already subscribe to.
 *
 * Cache path: data/cache/intelligence/{slug}-expansion.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { loadProductConfig, type ProductConfig } from './product-release-radar.ts'
import { getFeatureCache } from './product-feature-radar.ts'
import { getGeminiToken } from './gemini-auth.ts'
import { recordGeminiUsage } from './gemini-cost-tracker.ts'
import { sanitizePromptInput, normalizeForQuery, sanitizeErr } from './utils.ts'
import { getGeminiModel } from './ai-config.ts'
import { readSheetCache, readPipelineCache } from './cache-layer.ts'
import { fetchCases } from './redhat.ts'
import { customers } from './server-state.ts'
import { getCachedCustomerDocsCorpus } from './customer-docs-corpus.ts'
import { customerSubscribesTo } from './customer-product-intel.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpansionRecommendation {
  product: string       // product slug from config
  why: string           // 1-2 sentences citing the signal
  features: string[]    // 2-3 relevant feature names from feature cache
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export interface ExpansionOpportunitiesResult {
  customerName: string
  recommendations: ExpansionRecommendation[]
  generatedAt: string
  allProductsCovered: boolean  // true if customer has all products
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR  = process.env.DATA_DIR  ?? resolve(import.meta.dir, '../data')
const CACHE_DIR = process.env.CACHE_DIR ?? resolve(DATA_DIR, 'cache')

function expansionCachePath(customerSlug: string): string {
  if (!customerSlug || /[^a-zA-Z0-9_-]/.test(customerSlug)) {
    throw new Error(`[expansion-opps] unsafe slug for cache path: "${customerSlug}"`)
  }
  return resolve(CACHE_DIR, 'intelligence', `${customerSlug}-expansion.json`)
}

export function toCustomerSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

// ── Cache read/write ──────────────────────────────────────────────────────────

export function getCachedExpansionOpportunities(customerSlug: string): ExpansionOpportunitiesResult | null {
  const p = expansionCachePath(customerSlug)
  try {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, 'utf-8'))
    }
  } catch (e: any) {
    console.warn(`[expansion-opps] cache read failed for ${customerSlug}:`, e?.message)
  }
  return null
}

function writeExpansionCache(customerSlug: string, result: ExpansionOpportunitiesResult): void {
  const dir = resolve(CACHE_DIR, 'intelligence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(expansionCachePath(customerSlug), JSON.stringify(result, null, 2), { mode: 0o600 })
}

// ── Signal loading ────────────────────────────────────────────────────────────

function loadIntelligenceCache(customerSlug: string): { company: string; industry: string } | null {
  try {
    const p = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    return {
      company: String(d.company ?? ''),
      industry: String(d.industry ?? ''),
    }
  } catch { return null }
}

function loadDriveDocsContext(customerSlug: string): string {
  const corpus = getCachedCustomerDocsCorpus(customerSlug)
  if (!corpus || !corpus.files.length) return ''
  return corpus.files
    .map(f => `[${sanitizePromptInput(f.name, 100)}]\n${sanitizePromptInput(f.textContent, 2000)}`)
    .join('\n\n')
    .slice(0, 6000)
}

function getCasesCount(customerSlug: string, allCases: any[]): number {
  const customer = customers.find(cu => toCustomerSlug(cu.name) === customerSlug)
  if (!customer) return 0
  const accountNums = (customer.accountNumbers ?? []).map(String)
  if (!accountNums.length) return 0
  return allCases.filter(c => accountNums.includes(String(c.accountNumber))).length
}

// ── Main generation ───────────────────────────────────────────────────────────

export async function generateExpansionOpportunities(customerSlug: string): Promise<ExpansionOpportunitiesResult> {
  const customer = customers.find(cu => toCustomerSlug(cu.name) === customerSlug)
  const customerName = customer?.name ?? customerSlug

  const productConfigs = loadProductConfig()
  const sheetCache = readSheetCache(customerName)
  const subscriptions = sheetCache?.rows ?? []

  // Determine which products the customer already has
  const subscribedSlugs = new Set<string>()
  for (const product of productConfigs) {
    const matching = customerSubscribesTo(subscriptions, product)
    if (matching.length > 0) {
      subscribedSlugs.add(product.slug)
    }
  }

  const unsubscribedProducts = productConfigs.filter(p => !subscribedSlugs.has(p.slug))

  // If customer has all products, return early
  if (unsubscribedProducts.length === 0) {
    const result: ExpansionOpportunitiesResult = {
      customerName,
      recommendations: [],
      generatedAt: new Date().toISOString(),
      allProductsCovered: true,
    }
    writeExpansionCache(customerSlug, result)
    return result
  }

  // Load all signals
  const intelCache = loadIntelligenceCache(customerSlug)
  const driveDocsContext = loadDriveDocsContext(customerSlug)

  let allCases: any[] = []
  try { allCases = await fetchCases().catch(() => []) } catch { /* no cases */ }
  const casesCount = getCasesCount(customerSlug, allCases)

  // Build subscription summary for context
  const subSummary = subscriptions.length
    ? subscriptions.map((s: any) => `${sanitizePromptInput(s.productDescription ?? s.productName ?? s.name ?? 'unknown', 200)}: qty ${s.quantity ?? '?'}`).join('\n')
    : 'No subscription data available'

  // Pipeline context
  const needle = normalizeForQuery(customerName.toLowerCase())
  const pipelineCache = readPipelineCache()
  const pipelineRecords = pipelineCache
    ? pipelineCache.records.filter((r: any) => {
        const hay = normalizeForQuery(r.accountName)
        return hay.includes(needle) || needle.includes(hay)
      }).filter((r: any) => r.forecastCategory?.toLowerCase() !== 'closed')
    : []
  const pipelineText = pipelineRecords.length
    ? pipelineRecords.map((r: any) => `${sanitizePromptInput(r.oppName ?? '', 200)}: $${r.acv?.toLocaleString() ?? '?'} ACV, ${sanitizePromptInput(r.forecastCategory ?? '', 50)}`).join('\n')
    : 'No pipeline data'

  // Build available features for unsubscribed products
  const productFeaturesMap: Record<string, string[]> = {}
  for (const product of unsubscribedProducts) {
    const featureCache = getFeatureCache(product.slug)
    if (featureCache?.features.length) {
      productFeaturesMap[product.slug] = featureCache.features
        .slice(0, 10)
        .map(f => f.name)
    }
  }

  // Build product list for prompt
  const productsForPrompt = unsubscribedProducts.map(p => {
    const features = productFeaturesMap[p.slug]
    const featureStr = features?.length ? `\n  Key features: ${features.join(', ')}` : ''
    return `- ${sanitizePromptInput(p.displayName ?? '', 100)} (slug: ${sanitizePromptInput(p.slug ?? '', 50)}, short: ${sanitizePromptInput(p.shortName ?? '', 50)})${(p as any).description ? `\n  Description: ${sanitizePromptInput((p as any).description ?? '', 300)}` : ''}${featureStr}`
  }).join('\n')

  // If no intelligence cache and no docs, we can't make good recommendations
  if (!intelCache && !driveDocsContext && subscriptions.length === 0) {
    const result: ExpansionOpportunitiesResult = {
      customerName,
      recommendations: [],
      generatedAt: new Date().toISOString(),
      allProductsCovered: false,
    }
    writeExpansionCache(customerSlug, result)
    return result
  }

  // ── Gemini prompt ─────────────────────────────────────────────────────────

  const systemPrompt = `You are a Red Hat Solutions Architect expansion advisor. Given comprehensive signals about a customer, recommend which Red Hat products would benefit them most among those they don't currently subscribe to.

Rules:
- Recommend up to 3 products maximum — only recommend products with strong signal support
- Every recommendation must cite a specific signal: a company initiative, industry pressure, support case pattern, subscription gap, or document finding
- The "why" field must be 1-2 sentences referencing the specific signal that drove the recommendation
- The "features" field must contain 2-3 real feature names from the product's feature list provided
- Confidence: HIGH = multiple strong signals converge, MEDIUM = one clear signal, LOW = inferential
- If fewer than 3 products have strong signal support, return fewer recommendations
- Do not recommend products that would not genuinely help this customer
- Output valid JSON only`

  const userPrompt = `CUSTOMER: ${customerName}
${casesCount > 0 ? `Open RH support cases: ${casesCount}` : 'No open support cases'}

--- Current Subscriptions ---
${subSummary}

--- Company Intelligence ---
${intelCache ? `${sanitizePromptInput(intelCache.company, 6000)}\n\n[Industry Context]\n${sanitizePromptInput(intelCache.industry, 2000)}` : 'Not available'}

--- Customer Account Documents ---
${driveDocsContext || 'None cached'}

--- Pipeline ---
${pipelineText}

--- Products This Customer Does NOT Have (recommend from these only) ---
${productsForPrompt}

Which of these products would most benefit ${customerName}? Return up to 3 recommendations.

OUTPUT SCHEMA (respond with ONLY this JSON, no markdown):
{
  "recommendations": [
    {
      "product": "product-slug-from-list-above",
      "why": "1-2 sentences citing the specific signal",
      "features": ["Feature Name 1", "Feature Name 2", "Feature Name 3"],
      "confidence": "HIGH|MEDIUM|LOW"
    }
  ]
}`

  // ── Gemini API call ─────────────────────────────────────────────────────────

  const project  = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
  const model    = getGeminiModel()

  if (!project) {
    console.warn('[expansion-opps] GOOGLE_CLOUD_PROJECT not set — returning empty')
    const result: ExpansionOpportunitiesResult = {
      customerName,
      recommendations: [],
      generatedAt: new Date().toISOString(),
      allProductsCovered: false,
    }
    writeExpansionCache(customerSlug, result)
    return result
  }

  try {
    const token = await getGeminiToken()
    const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[expansion-opps] Gemini error ${res.status}: ${sanitizeErr(err)}`)
      const fallback: ExpansionOpportunitiesResult = {
        customerName,
        recommendations: [],
        generatedAt: new Date().toISOString(),
        allProductsCovered: false,
      }
      writeExpansionCache(customerSlug, fallback)
      return fallback
    }

    const json = await res.json() as any

    // Record token usage
    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp:    new Date().toISOString(),
        callType:     'expansion-opportunities',
        customerName,
        inputTokens:  usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    // Parse response
    const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('\n').trim()

    // Extract JSON
    const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
    let parsed: any = null
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1]) } catch { /* fall through */ }
    }
    if (!parsed) {
      const firstBrace = text.indexOf('{')
      const lastBrace = text.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try { parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1)) } catch { /* fall through */ }
      }
    }

    if (parsed?.recommendations && Array.isArray(parsed.recommendations)) {
      // Validate each recommendation
      const validSlugs = new Set(unsubscribedProducts.map(p => p.slug))
      const validated: ExpansionRecommendation[] = parsed.recommendations
        .filter((r: any) => r.product && r.why && validSlugs.has(r.product))
        .slice(0, 3)
        .map((r: any) => ({
          product: r.product,
          why: String(r.why).slice(0, 500),
          features: Array.isArray(r.features) ? r.features.slice(0, 3).map(String) : [],
          confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(r.confidence) ? r.confidence : 'LOW',
        }))

      const result: ExpansionOpportunitiesResult = {
        customerName,
        recommendations: validated,
        generatedAt: new Date().toISOString(),
        allProductsCovered: false,
      }
      writeExpansionCache(customerSlug, result)
      console.log(`[expansion-opps] generated ${validated.length} recommendations for ${customerName}`)
      return result
    }

    console.warn(`[expansion-opps] Gemini returned unparseable response for ${customerSlug}`)
  } catch (e: any) {
    console.error(`[expansion-opps] Gemini call failed for ${customerSlug}:`, e?.message)
  }

  // Fallback
  const fallback: ExpansionOpportunitiesResult = {
    customerName,
    recommendations: [],
    generatedAt: new Date().toISOString(),
    allProductsCovered: false,
  }
  writeExpansionCache(customerSlug, fallback)
  return fallback
}
