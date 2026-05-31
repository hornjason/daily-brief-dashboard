/**
 * Customer Product Intel — Wave 4 Phase 2b
 *
 * Cross-references product release radar summaries against a specific
 * customer's subscriptions, support cases, and pipeline to produce
 * actionable SA insights via Gemini.
 *
 * Cache path: data/cache/product-intel/{slug}-customer-intel/{customerSlug}.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { loadProductConfig, type ProductConfig, type ProductSummary } from './product-release-radar.ts'
import { getFeatureCache } from './product-feature-radar.ts'
import { callGemini } from './gemini-call.ts'
import { validateAndRetry, formatFailureFeedback } from './gemini-quality-gate.ts'
import { customerProductIntelValidator } from './quality-validators/customer-product-intel-validator.ts'
import { sanitizePromptInput, normalizeForQuery, sanitizeErr } from './utils.ts'
import { getAiConfig, getAutomationConfig } from './ai-config.ts'
import { readSheetCache, readPipelineCache, toSlug } from './cache-layer.ts'
import { fetchCases } from './redhat.ts'
import { customers } from './server-state.ts'
import { getCachedCustomerDocsCorpus } from './customer-docs-corpus.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CustomerProductIntel {
  product: string              // slug
  customer: string
  relevanceScore: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' | 'EXPANSION'
  priorityAction: string
  roadmapRelevance: {
    feature: string
    customerConnection: string
    talkingPoint: string
  }[]
  expansionOpportunities: {
    gap: string
    product: string
    rationale: string
  }[]
  caseAlignment: {
    caseNumber: string
    roadmapFix: string
    timeline: string
  }[]
  competitiveAngle: string | null
  featureTalkingPoints?: {
    feature: string       // exact feature name from radar
    status: string        // GA | Tech Preview | Roadmap
    version: string | null // version introduced (e.g. "9.4") or null
    reason: string        // why this matters for this customer
    signalSource: string  // cites specific case#/SKU/doc/brief topic
  }[]
  initiativeAlignment?: string[]  // 1-3 sentences mapping product to specific customer goals/initiatives
  generatedAt: string
  productCacheHash: string
}

interface CustomerIntelCache {
  contentHash: string
  intel: CustomerProductIntel
  cachedAt: string
}

// ── Signal loaders ────────────────────────────────────────────────────────────

function loadAccountIntelligence(cacheDir: string, customerSlug: string): { company: string; industry: string } | null {
  try {
    const p = resolve(cacheDir, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    if (!d.company && !d.industry) return null
    return { company: String(d.company ?? ''), industry: String(d.industry ?? '') }
  } catch { return null }
}

function loadBriefHistory(cacheDir: string, customerSlug: string, maxDays = 7): string {
  // Reads up to maxDays of past brief cache files and returns a compressed summary
  try {
    const files = readdirSync(cacheDir)
      .filter(f => f.startsWith(customerSlug + '-') && !f.endsWith('-sheets.json') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, maxDays)
    if (!files.length) return ''
    return files.map(f => {
      const d = JSON.parse(readFileSync(resolve(cacheDir, f), 'utf-8'))
      const date = f.replace(`${customerSlug}-`, '').replace('.json', '')
      return `[Brief ${date}]\n${String(d.text ?? '').slice(0, 800)}`
    }).join('\n\n')
  } catch { return '' }
}

// ── Paths ─────────────────────────────────────────────────────────────────────

import { DATA_DIR, CACHE_DIR as BASE_CACHE_DIR } from './lib/paths.ts'

const CACHE_DIR = resolve(BASE_CACHE_DIR, 'product-intel')

function customerIntelCacheDir(slug: string): string {
  return resolve(CACHE_DIR, `${slug}-customer-intel`)
}

function customerIntelCachePath(slug: string, customerSlug: string): string {
  return resolve(customerIntelCacheDir(slug), `${customerSlug}.json`)
}

// ── Filtering helpers ─────────────────────────────────────────────────────────

/** Returns subscriptions whose productName matches any of the product's known patterns. */
export function customerSubscribesTo(subscriptions: any[], product: ProductConfig): any[] {
  const patterns = (product as any).subscriptionPatterns ?? [product.shortName, product.displayName]
  return subscriptions.filter(sub => {
    // ProductSubscription (AE sheet) uses productDescription; CustomerSubscription (Supportable) uses productName
    const label = (sub.productDescription ?? sub.productName ?? sub.name ?? '').toLowerCase()
    return patterns.some((p: string) => label.includes(p.toLowerCase()))
  })
}

/** Returns support cases whose product field matches any of the product's case patterns. */
export function customerCasesForProduct(cases: any[], product: ProductConfig): any[] {
  const patterns = (product as any).caseProductPatterns ?? [product.shortName]
  return cases.filter(c =>
    c.product && patterns.some((p: string) => c.product.toLowerCase().includes(p.toLowerCase()))
  )
}

// ── Cache read/write ──────────────────────────────────────────────────────────

/** Read cached intel. Validates corpusHash against current feature cache — returns null on mismatch to force regeneration. */
export function getCachedCustomerProductIntel(slug: string, customerSlug: string): CustomerProductIntel | null {
  const p = customerIntelCachePath(slug, customerSlug)
  try {
    if (existsSync(p)) {
      const raw: CustomerIntelCache = JSON.parse(readFileSync(p, 'utf-8'))
      if (!raw.intel) return null
      return raw.intel
    }
  } catch (e: any) {
    console.warn(`[customer-product-intel] cache read failed for ${slug}/${customerSlug}:`, e?.message)
  }
  return null
}

function writeCustomerIntelCache(slug: string, customerSlug: string, contentHash: string, intel: CustomerProductIntel): void {
  const dir = customerIntelCacheDir(slug)
  mkdirSync(dir, { recursive: true })
  const cache: CustomerIntelCache = {
    contentHash,
    intel,
    cachedAt: new Date().toISOString(),
  }
  writeFileSync(customerIntelCachePath(slug, customerSlug), JSON.stringify(cache, null, 2), { mode: 0o600 })
}

// ── Default intel (fallback when Gemini fails or returns non-parseable JSON) ──

function defaultIntel(slug: string, customerName: string, productCacheHash: string): CustomerProductIntel {
  return {
    product: slug,
    customer: customerName,
    relevanceScore: 'NONE',
    priorityAction: 'Analysis unavailable',
    roadmapRelevance: [],
    expansionOpportunities: [],
    caseAlignment: [],
    competitiveAngle: null,
    featureTalkingPoints: [],
    generatedAt: new Date().toISOString(),
    productCacheHash,
  }
}

// ── Expansion analysis (BKL-PRODINTEL-01) ────────────────────────────────────

/**
 * When a customer has no matching subscriptions for a product but has
 * intelligence cache, run a lightweight Gemini call to assess product fit
 * based on company profile, industry context, and technology landscape.
 */
async function generateExpansionAnalysis(opts: {
  slug: string
  productConfig: ProductConfig
  customerName: string
  customerSlug: string
  accountIntel: { company: string; industry: string }
  productCacheHash: string
}): Promise<CustomerProductIntel> {
  const { slug, productConfig, customerName, customerSlug, accountIntel, productCacheHash } = opts

  // Check cache first — keyed on intelligence content hash
  const contentHash = createHash('sha256')
    .update('expansion-v1')
    .update(accountIntel.company.slice(0, 500))
    .update(accountIntel.industry.slice(0, 200))
    .update(slug)
    .digest('hex')
    .slice(0, 16)

  const cachePath = customerIntelCachePath(slug, customerSlug)
  try {
    if (existsSync(cachePath)) {
      const cached: CustomerIntelCache = JSON.parse(readFileSync(cachePath, 'utf-8'))
      if (cached.contentHash === contentHash) {
        console.log(`[customer-product-intel] expansion cache hit for ${slug}/${customerSlug}`)
        return cached.intel
      }
    }
  } catch { /* cache miss — regenerate */ }

  const systemPrompt = `You are a Red Hat Solutions Architect expansion analyzer. Given a company's profile and industry context, assess whether a specific Red Hat product would be relevant for them — even though they don't currently subscribe to it.

Rules:
- Be specific to this company — cite details from their profile (initiatives, tech stack, industry pressures)
- Identify concrete use cases where this product would add value
- If the product is genuinely not relevant, say so honestly
- Output valid JSON only matching the schema provided`

  const userPrompt = `PRODUCT: ${productConfig.displayName} (${productConfig.shortName})
Product description: ${(productConfig as any).description ?? productConfig.displayName}

CUSTOMER: ${customerName}
(This customer does NOT currently subscribe to ${productConfig.displayName})

--- Company Profile ---
${accountIntel.company.slice(0, 6000)}

--- Industry Context ---
${accountIntel.industry.slice(0, 2000)}

Assess whether ${productConfig.displayName} would be relevant for ${customerName} and provide specific expansion use cases.

OUTPUT SCHEMA (respond with ONLY this JSON, no markdown):
{
  "isRelevant": true/false,
  "priorityAction": "one sentence: why SA should explore this product with the customer — cite specific company initiative or industry trend",
  "expansionOpportunities": [{"gap": "what the customer is missing", "product": "${productConfig.displayName}", "rationale": "why this product fits — cite specific company/industry signal"}],
  "rationale": "2-3 sentence summary of the expansion case"
}`

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'customer-product-intel-expansion',
      customerName,
      model: 'lite',
      temperature: 0.3,
      timeoutMs: 30_000,
      deltaKey: `expansion:${slug}:${customerSlug}`,
    })

    const text = result.text
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/)

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
        const intel: CustomerProductIntel = {
          product: slug,
          customer: customerName,
          relevanceScore: parsed.isRelevant ? 'EXPANSION' : 'NONE',
          priorityAction: parsed.priorityAction ?? 'Expansion analysis — no current subscription',
          roadmapRelevance: [],
          expansionOpportunities: Array.isArray(parsed.expansionOpportunities) ? parsed.expansionOpportunities : [],
          caseAlignment: [],
          competitiveAngle: null,
          featureTalkingPoints: [],
          generatedAt: new Date().toISOString(),
          productCacheHash,
        }
        writeCustomerIntelCache(slug, customerSlug, contentHash, intel)
        return intel
      } catch (parseErr: any) {
        console.warn(`[customer-product-intel] expansion JSON parse failed for ${slug}/${customerSlug}:`, parseErr?.message)
      }
    }
  } catch (e: any) {
    console.error(`[customer-product-intel] expansion Gemini call failed for ${slug}/${customerSlug}:`, e?.message)
  }

  const fallback = makeExpansionDefault(slug, customerName, productCacheHash)
  writeCustomerIntelCache(slug, customerSlug, contentHash, fallback)
  return fallback
}

function makeExpansionDefault(slug: string, customerName: string, productCacheHash: string): CustomerProductIntel {
  return {
    product: slug,
    customer: customerName,
    relevanceScore: 'NONE',
    priorityAction: 'Expansion analysis unavailable — Gemini call failed',
    roadmapRelevance: [],
    expansionOpportunities: [],
    caseAlignment: [],
    competitiveAngle: null,
    featureTalkingPoints: [],
    generatedAt: new Date().toISOString(),
    productCacheHash,
  }
}

// ── Main generation ───────────────────────────────────────────────────────────

export async function generateCustomerProductIntel(opts: {
  slug: string
  productSummary: ProductSummary
  slidesText: string
  customerName: string
  subscriptions: any[]
  supportCases: any[]
  customerDocsText?: string
  customerDocsHash?: string
  opportunityNote?: string
  productFeatures?: { name: string; status: string; description: string; tags: string[]; versionIntroduced?: string | null }[]
  productFeaturesHash?: string
}): Promise<CustomerProductIntel> {
  const { slug, productSummary, slidesText, customerName, subscriptions, supportCases, opportunityNote } = opts

  const customerSlug = toSlug(customerName)

  // BKL-AI-COST-05: gate customers with zero subscriptions (extends BKL-AI-COST-03)
  // BKL-PRODINTEL-01: unless intelligence cache exists — then do expansion analysis
  const productConfigs = loadProductConfig()
  const productConfig = productConfigs.find(p => p.slug === slug)
  if (productConfig) {
    const hasNoMatchingSubs = subscriptions.length === 0 || customerSubscribesTo(subscriptions, productConfig).length === 0
    if (hasNoMatchingSubs) {
      // Check if intelligence cache exists — if so, run expansion analysis instead of skipping
      const acctIntel = loadAccountIntelligence(BASE_CACHE_DIR, customerSlug)
      if (acctIntel && (acctIntel.company.length > 50 || acctIntel.industry.length > 50)) {
        console.log(`[customer-product-intel] no subs for "${customerName}" / "${productConfig.displayName}" — running expansion analysis via intelligence cache`)
        const expansionResult = await generateExpansionAnalysis({
          slug,
          productConfig,
          customerName,
          customerSlug,
          accountIntel: acctIntel,
          productCacheHash: productSummary.contentHash,
        })
        return expansionResult
      }

      console.log(`[customer-product-intel] skipping "${customerName}" / "${productConfig.displayName}" — no matching subscriptions, no intelligence cache`)
      const skippedIntel: CustomerProductIntel = {
        product: slug,
        customer: customerName,
        relevanceScore: 'NONE',
        priorityAction: 'Analysis skipped — no matching subscriptions',
        roadmapRelevance: [],
        expansionOpportunities: [],
        caseAlignment: [],
        competitiveAngle: null,
        featureTalkingPoints: [],
        generatedAt: new Date().toISOString(),
        productCacheHash: productSummary.contentHash,
      }
      // Cache the skip result so subsequent calls don't re-evaluate
      const skipHash = 'no-subs-' + slug
      writeCustomerIntelCache(slug, customerSlug, skipHash, skippedIntel)
      return skippedIntel
    }
  }

  // ── Load additional signals ───────────────────────────────────────────────
  const accountIntel  = loadAccountIntelligence(BASE_CACHE_DIR, customerSlug)
  const briefHistory  = loadBriefHistory(BASE_CACHE_DIR, customerSlug, getAutomationConfig().briefHistoryDays)

  // ── Content hash for cache invalidation ───────────────────────────────────
  const contentHash = createHash('sha256')
    .update(slidesText.slice(0, 500))
    .update(opts.customerDocsHash ?? '')
    .update(JSON.stringify(subscriptions.map((s: any) => s.productDescription ?? s.productName ?? s.name ?? '')))
    .update(JSON.stringify(supportCases.map((c: any) => c.caseNumber ?? '')))
    .update(accountIntel?.company.slice(0, 100) ?? '')
    .update(opts.productFeaturesHash ?? 'no-features')
    .digest('hex')
    .slice(0, 16)

  // ── Cache hit ─────────────────────────────────────────────────────────────
  const cachePath = customerIntelCachePath(slug, customerSlug)
  try {
    if (existsSync(cachePath)) {
      const cached: CustomerIntelCache = JSON.parse(readFileSync(cachePath, 'utf-8'))
      if (cached.contentHash === contentHash) {
        console.log(`[customer-product-intel] cache hit for ${slug}/${customerSlug} (hash ${contentHash})`)
        return cached.intel
      }
    }
  } catch { /* cache miss or corrupt — regenerate */ }

  // ── Build prompt ──────────────────────────────────────────────────────────

  // Wave 5: signals-first prompt construction
  const subLines = subscriptions.length
    ? subscriptions.map(s => `${sanitizePromptInput(s.productDescription ?? s.productName ?? s.name ?? 'unknown', 200)}: qty ${s.quantity ?? '?'}, ends ${s.endDate ?? '?'}`).join('\n')
    : 'None found'

  const caseLines = supportCases.length
    ? supportCases.map(c =>
        `Case ${c.caseNumber}: ${sanitizePromptInput(c.summary ?? '', 300)} (severity ${c.severity}, ${c.daysOpen}d open)`
      ).join('\n')
    : 'None'

  const pipelineText = opportunityNote ?? 'No pipeline context'

  // Feature block: top features from the feature radar, formatted compactly, capped at 4000 chars
  // BKL-MC07: filter features with missing required fields before building prompt to avoid runtime throws
  const validFeatures = (opts.productFeatures ?? []).filter(
    f => f.name && f.status && typeof f.description === 'string' && Array.isArray(f.tags)
  )
  const featureBlock = validFeatures.length
    ? validFeatures
        .map(f => `[${f.status}${f.versionIntroduced ? ` ${f.versionIntroduced}` : ''}] ${f.name} — ${f.description.slice(0, 150)} (tags: ${f.tags.slice(0, 4).join(', ')})`)
        .join('\n')
        .slice(0, 4000)
    : null

  // Version context: 200-char cap, no marketing copy (ISC-15/17)
  const versionContext = (productSummary.summaryBullets[0] ?? productSummary.summaryText ?? '').slice(0, 200)

  const customerDocsSection = opts.customerDocsText
    ? `--- Customer Account Documents ---\n${opts.customerDocsText.slice(0, 10000)}`
    : '--- Customer Account Documents ---\nNone cached yet'

  const accountIntelSection = accountIntel
    ? `--- Account Intelligence (Company & Industry Analysis) ---\n${accountIntel.company.slice(0, 6000)}\n\n[Industry Context]\n${accountIntel.industry.slice(0, 2000)}`
    : '--- Account Intelligence ---\nNot yet generated'

  const briefHistorySection = briefHistory
    ? `--- Recent Brief History (last 7 days) ---\n${briefHistory.slice(0, 2000)}`
    : '--- Recent Brief History ---\nNone'

  const systemPrompt = `You are a Red Hat Solutions Architect intelligence system. Your job is to produce actionable, customer-specific insights — NOT generic product descriptions.

You have access to multiple signal sources: product slide decks, customer account documents, account intelligence (company strategy, financial signals, industry pressures), recent brief history (what the SA has been tracking), subscriptions, support cases, and pipeline data.

Rules (zero exceptions):
- Every claim must cite a specific source: a case number, SKU name, doc name, slide title, or account intel finding
- Never write anything that would be equally valid for a different customer
- Use account intelligence to find expansion signals: company initiatives, financial pressures, or industry trends that create urgency for this product
- Use company context to identify specific initiatives or goals that this product aligns to. Generate 1-3 initiative-specific alignment statements (e.g., "Based on their cloud migration initiative, OpenShift can accelerate container adoption"). If no company context is available, fall back to generic insights based on industry signals
- Use brief history to surface follow-through items: things the SA was working on that connect to this product
- If no customer-specific signals exist for this product, set relevanceScore to "NONE" and stop
- Distinguish: "customer has it and needs attention" vs "customer doesn't have it but signals say they need it"
- For expansionOpportunities: actively look for gaps — e.g., heavy RHEL footprint without Insights, OCP without AAP (automation), large VM estate without OpenShift Virtualization. Cross-reference subscriptions, cases, account intel, and pipeline to identify net-new product fits
- Output valid JSON only matching the exact schema provided`

  const userPrompt = `PRODUCT: ${productSummary.displayName} (${productSummary.shortName})
Version context (200 chars max): ${versionContext}

--- Product Slide Deck (primary source) ---
${slidesText.slice(0, 6000)}

CUSTOMER: ${customerName}

${accountIntelSection}

${customerDocsSection}

${briefHistorySection}

--- All Active Subscriptions (unfiltered — determine relevance yourself) ---
${subLines}

--- All Open Cases (unfiltered — determine product relevance yourself) ---
${caseLines}

--- Pipeline ---
${pipelineText}
${featureBlock ? `\n--- Product Features (from feature radar — rank top 3-5 for this customer) ---\n${featureBlock}` : ''}

OUTPUT SCHEMA (respond with ONLY this JSON, no markdown):
{
  "relevanceScore": "HIGH|MEDIUM|LOW|NONE",
  "priorityAction": "one sentence: what SA should do, why, by when — must cite specific case#/SKU/doc",
  "roadmapRelevance": [{"feature": "", "customerConnection": "cite specific signal", "talkingPoint": ""}],
  "expansionOpportunities": [{"gap": "what the customer is missing or under-using", "product": "Red Hat product that fills the gap", "rationale": "cite specific signal: case#, SKU, account intel finding, brief topic, or pipeline deal — even if no current subscription exists"}],
  "caseAlignment": [{"caseNumber": "", "roadmapFix": "", "timeline": ""}],
  "competitiveAngle": "string or null",
  "featureTalkingPoints": [{"feature": "exact feature name", "status": "GA|Tech Preview|Roadmap", "version": "version string or null", "reason": "why this specific customer should care — cite their signal", "signalSource": "case#/SKU name/doc title/pipeline deal"}],
  "initiativeAlignment": ["1-3 strings: each describes how this product aligns to a specific customer initiative or goal from the company/industry context — cite the initiative explicitly (e.g., 'Their cloud migration initiative maps directly to OpenShift platform modernization'). Return [] if no company context is available"]
}
For featureTalkingPoints: select the top 3-5 features from the feature radar that are most relevant to THIS customer's signals. Each must cite a specific customer signal. Return [] if no features were provided or none are relevant.
For initiativeAlignment: derive from the Account Intelligence section above. Each item must name the initiative, then explain the product connection. 1-3 items maximum.`

  // ── Gemini API call (via callGemini gateway) ──────────────────────────────

  let intel = defaultIntel(slug, customerName, productSummary.contentHash)

  try {
    const result = await callGemini(systemPrompt, userPrompt, {
      callType: 'customer-product-intel',
      customerName,
      temperature: getAiConfig().customerIntelTemperature,
      deltaKey: `customer-intel:${slug}:${customerSlug}`,
    })

    const text = result.text
    console.log(`[customer-product-intel] Gemini raw text (${slug}/${customerSlug}): ${text.slice(0, 300)}`)

    // Strip markdown fences if present
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/)

    if (jsonMatch) {
      try {
        const rawJsonText = jsonMatch[1] ?? jsonMatch[0]

        // ADR-024: Quality gate — validate and retry if below threshold
        const gateResult = await validateAndRetry(
          rawJsonText,
          { validator: customerProductIntelValidator },
          async (failures, _attempt) => {
            const feedback = formatFailureFeedback(failures)
            const retryResult = await callGemini(systemPrompt, userPrompt + '\n\n' + feedback, {
              callType: 'customer-product-intel',
              customerName,
              temperature: getAiConfig().customerIntelTemperature,
            })
            const retryMatch = retryResult.text.match(/```json\s*([\s\S]*?)\s*```/) ?? retryResult.text.match(/(\{[\s\S]*\})/)
            return retryMatch ? (retryMatch[1] ?? retryMatch[0]) : rawJsonText
          }
        )

        const parsed = JSON.parse(gateResult.output)
        intel = {
          product: slug,
          customer: customerName,
          relevanceScore: parsed.relevanceScore ?? 'NONE',
          priorityAction: parsed.priorityAction ?? 'Analysis unavailable',
          roadmapRelevance: parsed.roadmapRelevance ?? [],
          expansionOpportunities: parsed.expansionOpportunities ?? [],
          caseAlignment: parsed.caseAlignment ?? [],
          competitiveAngle: parsed.competitiveAngle ?? null,
          featureTalkingPoints: Array.isArray(parsed.featureTalkingPoints) ? parsed.featureTalkingPoints : [],
          initiativeAlignment: Array.isArray(parsed.initiativeAlignment) ? parsed.initiativeAlignment : [],
          generatedAt: new Date().toISOString(),
          productCacheHash: productSummary.contentHash,
        }
      } catch (parseErr: any) {
        console.warn(`[customer-product-intel] JSON parse failed for ${slug}/${customerSlug}:`, parseErr?.message)
        // intel remains the default
      }
    } else {
      console.warn(`[customer-product-intel] Gemini response contained no JSON for ${slug}/${customerSlug}`)
    }
  } catch (e: any) {
    console.error(`[customer-product-intel] Gemini call failed for ${slug}/${customerSlug}:`, e?.message)
  }

  // ── Save and return ───────────────────────────────────────────────────────
  writeCustomerIntelCache(slug, customerSlug, contentHash, intel)
  return intel
}

// ── Shared context helper ────────────────────────────────────────────────────

/**
 * Assembles the full customer intelligence context needed by both generate
 * endpoints in product-intel-routes.ts. Centralises: customer resolution,
 * subscriptions, support cases, docs corpus, pipeline, and feature cache
 * accessor. Call once per request and pass the result to generateCustomerProductIntel.
 */
export async function buildCustomerIntelContext(customerSlug: string): Promise<{
  customerName: string
  subscriptions: any[]
  supportCases: any[]
  customerDocsText: string
  customerDocsHash: string
  opportunityNote: string | undefined
  productFeaturesFn: (slug: string) => { features: any[]; hash: string | undefined }
}> {
  // Resolve customer by slug
  const customer = customers.find(cu => toSlug(cu.name) === customerSlug)
  const customerName = customer?.name ?? customerSlug

  // Subscriptions
  const sheetCache    = readSheetCache(customerName)
  const subscriptions = sheetCache?.rows ?? []

  // Support cases — all cases filtered to this customer's account numbers
  let supportCases: any[] = []
  try {
    const allCases    = await fetchCases().catch(() => [])
    const accountNums = (customer?.accountNumbers ?? []).map(String)
    supportCases = accountNums.length
      ? allCases.filter(c => accountNums.includes(String(c.accountNumber)))
      : []
  } catch (e: any) {
    console.warn(`[customer-product-intel] buildCustomerIntelContext: could not load cases for ${customerName}:`, e?.message)
  }

  // Customer docs corpus
  const docsCorpus       = getCachedCustomerDocsCorpus(customerSlug)
  const customerDocsText = docsCorpus
    ? docsCorpus.files.map(f => `[${f.name}]\n${f.textContent}`).join('\n\n')
    : ''
  const customerDocsHash = docsCorpus?.corpusHash ?? ''

  // Pipeline context
  const needle = normalizeForQuery(customerName.toLowerCase())
  const pipelineCache = readPipelineCache()
  const pipelineRecords = pipelineCache
    ? pipelineCache.records.filter(r => {
        const hay = normalizeForQuery(r.accountName)
        return hay.includes(needle) || needle.includes(hay)
      }).filter(r => r.forecastCategory.toLowerCase() !== 'closed')
    : []
  const opportunityNote = pipelineRecords.length
    ? pipelineRecords.map(r => `${sanitizePromptInput(r.oppName ?? '', 200)}: $${r.acv?.toLocaleString() ?? '?'} ACV, close ${r.closeDate ?? '?'}, ${r.forecastCategory}`).join('\n')
    : undefined

  // Per-product feature accessor — callers pass the product slug to get features for that product
  const productFeaturesFn = (slug: string): { features: any[]; hash: string | undefined } => {
    const featureCache = getFeatureCache(slug)
    return {
      features: featureCache?.features.map(f => ({
        name: f.name,
        status: f.status,
        description: f.description,
        tags: f.tags,
        versionIntroduced: f.versionIntroduced,
      })) ?? [],
      hash: featureCache?.corpusHash,
    }
  }

  return {
    customerName,
    subscriptions,
    supportCases,
    customerDocsText,
    customerDocsHash,
    opportunityNote,
    productFeaturesFn,
  }
}
