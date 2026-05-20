// src/modules/tech-stack-module.ts
// GitHub Issue #307 — Customer tech stack detection + Red Hat positioning research
// Detects customer technologies from intelligence, docs, news, and CCSP caches.
// Tier 1: static lookup from tech-positioning.json for industry tools.
// Tier 2: Gemini grounded search for proprietary/customer-specific tech.

import { FeatureModuleRegistry, type Signal } from '../feature-module-registry.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { toSlug } from '../cache-layer.ts'
import { getGeminiToken } from '../gemini-auth.ts'
import { getGeminiModel } from '../ai-config.ts'
import { recordGeminiUsage } from '../gemini-cost-tracker.ts'
import { sanitizeErr } from '../utils.ts'

// ── Paths ──────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.CACHE_DIR ?? 'data/cache'
const CONFIG_DIR = process.env.CONFIG_DIR ?? 'config'
const TECH_CACHE_DIR = resolve(CACHE_DIR, 'tech-stack')

// Ensure cache directory exists
if (!existsSync(TECH_CACHE_DIR)) {
  mkdirSync(TECH_CACHE_DIR, { recursive: true })
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface TechEntry {
  name: string
  category: 'proprietary' | 'industry-tool'
  context: 'using' | 'evaluating' | 'migrating_from' | 'developing'
  description: string
  infrastructure: string[]
  redHatProducts: string[]
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  redHatPositioning?: string
  lastResearched: string
}

interface TechStackCache {
  contentHash: string
  technologies: TechEntry[]
  cachedAt: string
}

interface TechPositioningEntry {
  name: string
  aliases: string[]
  category: string
  redHatPositioning: string
  redHatProducts: string[]
}

interface TechPositioningFile {
  version: number
  tools: TechPositioningEntry[]
}

// ── Static positioning lookup ──────────────────────────────────────────────────

let _positioningCache: TechPositioningFile | null = null

function loadTechPositioning(): TechPositioningFile {
  if (_positioningCache) return _positioningCache

  // Try config dir first (runtime copy), then config-templates (shipped default)
  const paths = [
    resolve(CONFIG_DIR, 'tech-positioning.json'),
    resolve('config-templates', 'tech-positioning.json'),
  ]

  for (const p of paths) {
    try {
      if (existsSync(p)) {
        _positioningCache = JSON.parse(readFileSync(p, 'utf-8'))
        return _positioningCache!
      }
    } catch { /* try next */ }
  }

  return { version: 1, tools: [] }
}

function lookupPositioning(techName: string): TechPositioningEntry | null {
  const positioning = loadTechPositioning()
  const needle = techName.toLowerCase()

  for (const tool of positioning.tools) {
    if (tool.name.toLowerCase() === needle) return tool
    if (tool.aliases.some(a => a.toLowerCase() === needle)) return tool
  }

  return null
}

// ── Source readers ──────────────────────────────────────────────────────────────

function readIntelligenceCache(customerSlug: string): { company: string; industry: string } | null {
  try {
    const p = resolve(CACHE_DIR, 'intelligence', `${customerSlug}.json`)
    if (!existsSync(p)) return null
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    return { company: String(d.company ?? ''), industry: String(d.industry ?? '') }
  } catch { return null }
}

function readNewsCache(customerSlug: string): { articleCount: number; techArticles: string[] } {
  try {
    const p = resolve(CACHE_DIR, 'news', `${customerSlug}.json`)
    if (!existsSync(p)) return { articleCount: 0, techArticles: [] }
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    const articles: any[] = d.articles ?? []
    const techArticles = articles
      .filter((a: any) => a.signalType === 'technology' || a.signalType === 'product_launch')
      .map((a: any) => `${a.headline}: ${a.summary?.slice(0, 200) ?? ''}`)
    return { articleCount: articles.length, techArticles }
  } catch { return { articleCount: 0, techArticles: [] } }
}

function readCcspCache(customerSlug: string): string[] {
  try {
    const p = resolve(CACHE_DIR, 'ccsp.json')
    if (!existsSync(p)) return []
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    const records: any[] = d.records ?? []
    const slug = customerSlug.toLowerCase()
    const matched = records.filter((r: any) => {
      const name = toSlug(r.accountName ?? '')
      return name === slug
    })
    // Extract unique cloud partner names
    const partners = new Set<string>()
    for (const r of matched) {
      if (r.cloudPartner) partners.add(r.cloudPartner)
      if (r.cloudProvider) partners.add(r.cloudProvider)
    }
    return Array.from(partners)
  } catch { return [] }
}

function readDocSignals(customerSlug: string): string[] {
  try {
    const p = resolve(CACHE_DIR, 'doc-classify', `${customerSlug}.json`)
    if (!existsSync(p)) return []
    const d = JSON.parse(readFileSync(p, 'utf-8'))
    // DocClassification stores technical_signals array
    const signals: string[] = []
    if (Array.isArray(d.classifications)) {
      for (const cls of d.classifications) {
        if (Array.isArray(cls.technical_signals)) {
          signals.push(...cls.technical_signals)
        }
      }
    }
    return signals
  } catch { return [] }
}

function readExistingTechCache(customerSlug: string): TechStackCache | null {
  try {
    const p = resolve(TECH_CACHE_DIR, `${customerSlug}.json`)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch { return null }
}

// ── Gemini calls ───────────────────────────────────────────────────────────────

async function extractTechnologies(customerName: string, context: string): Promise<TechEntry[]> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'

  if (!project) {
    console.warn('[tech-stack] GOOGLE_CLOUD_PROJECT not set — skipping tech extraction')
    return []
  }

  const model = getGeminiModel()
  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const systemPrompt = `You are a technology detection system for enterprise customer analysis. Given information about a company, identify all technologies, platforms, tools, and proprietary systems mentioned or implied.

Rules:
- Be specific — only include technologies explicitly mentioned or strongly implied
- Classify each as "proprietary" (customer-built/specific) or "industry-tool" (widely used)
- Context should reflect the customer's relationship: "using", "evaluating", "migrating_from", or "developing"
- For infrastructure, list underlying platforms (e.g., ["Kubernetes", "AWS"])
- For redHatProducts, suggest Red Hat product slugs that complement this tech: ocp, rhel, aap, acs, acm, satellite, rhdh, quay
- Confidence: HIGH = explicitly mentioned, MEDIUM = strongly implied, LOW = inferred from context
- Output valid JSON array only`

  const userPrompt = `CUSTOMER: ${customerName}

--- Context ---
${context.slice(0, 12000)}

Extract all technologies for this customer. Return a JSON array:
[
  {
    "name": "Technology Name",
    "category": "proprietary" | "industry-tool",
    "context": "using" | "evaluating" | "migrating_from" | "developing",
    "description": "1-2 sentence description of what it is and how the customer uses it",
    "infrastructure": ["underlying platforms"],
    "redHatProducts": ["ocp", "rhel", "aap"],
    "confidence": "HIGH" | "MEDIUM" | "LOW"
  }
]

Return ONLY the JSON array, no markdown fences.`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[tech-stack] Gemini extraction error ${res.status}: ${sanitizeErr(err)}`)
      return []
    }

    const json = await res.json() as any

    // Record token usage
    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp: new Date().toISOString(),
        callType: 'tech-stack-extract',
        customerName,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('\n').trim()

    // Parse JSON — handle markdown fences
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\[[\s\S]*\])/)

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
      if (!Array.isArray(parsed)) return []

      const now = new Date().toISOString()
      return parsed.map((t: any) => ({
        name: String(t.name ?? ''),
        category: t.category === 'proprietary' ? 'proprietary' : 'industry-tool',
        context: ['using', 'evaluating', 'migrating_from', 'developing'].includes(t.context) ? t.context : 'using',
        description: String(t.description ?? ''),
        infrastructure: Array.isArray(t.infrastructure) ? t.infrastructure.map(String) : [],
        redHatProducts: Array.isArray(t.redHatProducts) ? t.redHatProducts.map(String) : [],
        confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(t.confidence) ? t.confidence : 'LOW',
        lastResearched: now,
      })) as TechEntry[]
    }
  } catch (e: any) {
    console.error(`[tech-stack] Gemini extraction failed for ${customerName}: ${e?.message}`)
  }

  return []
}

async function enrichProprietaryTech(customerName: string, tech: TechEntry): Promise<TechEntry> {
  const project = process.env.GOOGLE_CLOUD_PROJECT
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'

  if (!project) return tech

  const model = getGeminiModel()
  const token = await getGeminiToken()
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`

  const userPrompt = `Research "${tech.name}" by ${customerName}. What is it, what does it run on, what infrastructure does it use, how could Red Hat products (OpenShift, RHEL, Ansible Automation Platform, Advanced Cluster Security, Advanced Cluster Management) complement it?

Return a JSON object:
{
  "description": "2-3 sentence description",
  "infrastructure": ["underlying platforms"],
  "redHatProducts": ["ocp", "rhel", "aap"],
  "redHatPositioning": "1-2 sentences on how Red Hat products complement this technology"
}

Return ONLY the JSON object, no markdown.`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    })

    if (!res.ok) {
      console.warn(`[tech-stack] Tier 2 enrichment failed for ${tech.name}: ${res.status}`)
      return tech
    }

    const json = await res.json() as any

    const usage = json.usageMetadata
    if (usage) {
      recordGeminiUsage({
        timestamp: new Date().toISOString(),
        callType: 'tech-stack-enrich',
        customerName,
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        model,
      })
    }

    const parts: any[] = json.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => p.text ?? '').join('\n').trim()
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/)

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
      return {
        ...tech,
        description: parsed.description ?? tech.description,
        infrastructure: Array.isArray(parsed.infrastructure) ? parsed.infrastructure.map(String) : tech.infrastructure,
        redHatProducts: Array.isArray(parsed.redHatProducts) ? parsed.redHatProducts.map(String) : tech.redHatProducts,
        redHatPositioning: parsed.redHatPositioning ?? undefined,
        lastResearched: new Date().toISOString(),
      }
    }
  } catch (e: any) {
    console.warn(`[tech-stack] Tier 2 enrichment error for ${tech.name}: ${e?.message}`)
  }

  return tech
}

// ── Module registration ────────────────────────────────────────────────────────

FeatureModuleRegistry.register({
  name: 'tech-stack',
  displayName: 'Tech Stack',
  refreshEndpoint: '/api/refresh/tech-stack',
  scope: 'customer',
  refreshInterval: 7 * 24 * 60 * 60 * 1000, // weekly

  cachePaths: (slug: string) => [`data/cache/tech-stack/${slug}.json`],

  async signals(customerSlug: string): Promise<Signal[]> {
    const cached = readExistingTechCache(customerSlug)
    if (!cached || !cached.technologies?.length) return []

    // ADR-027: rawRelevance based on confidence
    return cached.technologies.map((tech): Signal => {
      let rawRelevance = 0.5
      if (tech.confidence === 'HIGH') rawRelevance = 0.8
      else if (tech.confidence === 'MEDIUM') rawRelevance = 0.5
      else rawRelevance = 0.3

      return {
        source: 'tech-stack',
        type: 'technology' as const,
        headline: `${tech.name} (${tech.category}, ${tech.context})`,
        detail: `${tech.description}${tech.redHatPositioning ? ' Red Hat positioning: ' + tech.redHatPositioning : ''}`,
        rawRelevance,
        timestamp: tech.lastResearched,
        metadata: {
          customerSlug,  // ADR-027: Mark as customer-specific
          category: tech.category,
          context: tech.context,
          infrastructure: tech.infrastructure,
          redHatProducts: tech.redHatProducts,
          confidence: tech.confidence,
        },
      }
    })
  },

  async syncNow(customerName: string): Promise<void> {
    const customerSlug = toSlug(customerName)

    // 1. Gather inputs from all sources
    const intel = readIntelligenceCache(customerSlug)
    const news = readNewsCache(customerSlug)
    const docSignals = readDocSignals(customerSlug)
    const ccspPartners = readCcspCache(customerSlug)

    // 2. Content hash check — skip if inputs unchanged
    const contentHash = createHash('sha256')
      .update(intel?.company.slice(0, 1000) ?? '')
      .update(intel?.industry.slice(0, 500) ?? '')
      .update(String(news.articleCount))
      .update(ccspPartners.join(','))
      .update(docSignals.slice(0, 10).join(','))
      .digest('hex')
      .slice(0, 16)

    const existing = readExistingTechCache(customerSlug)
    if (existing && existing.contentHash === contentHash) {
      console.log(`[tech-stack] cache hit for ${customerSlug} (hash ${contentHash})`)
      FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, dataChanged: false, recordCount: existing.technologies.length })
      return
    }

    // 3. Build context for Gemini extraction
    const contextParts: string[] = []

    if (intel?.company) contextParts.push(`[Company Profile]\n${intel.company.slice(0, 6000)}`)
    if (intel?.industry) contextParts.push(`[Industry Context]\n${intel.industry.slice(0, 2000)}`)
    if (news.techArticles.length) contextParts.push(`[Technology News]\n${news.techArticles.join('\n')}`)
    if (docSignals.length) contextParts.push(`[Document Technical Signals]\n${docSignals.join('\n')}`)
    if (ccspPartners.length) contextParts.push(`[Cloud Partners (CCSP)]\n${ccspPartners.join(', ')}`)

    if (contextParts.length === 0) {
      console.log(`[tech-stack] no source data for ${customerSlug} — skipping`)
      FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, dataChanged: false, recordCount: 0 })
      return
    }

    const context = contextParts.join('\n\n')

    // 4. Extract technologies via Gemini
    console.log(`[tech-stack] extracting technologies for ${customerName}...`)
    let technologies = await extractTechnologies(customerName, context)

    if (technologies.length === 0) {
      console.log(`[tech-stack] no technologies detected for ${customerSlug}`)
      const cache: TechStackCache = { contentHash, technologies: [], cachedAt: new Date().toISOString() }
      writeFileSync(resolve(TECH_CACHE_DIR, `${customerSlug}.json`), JSON.stringify(cache, null, 2), { mode: 0o600 })
      FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, recordCount: 0 })
      return
    }

    // 5. Tier 1 enrichment — static lookup for industry tools
    for (const tech of technologies) {
      if (tech.category === 'industry-tool') {
        const positioning = lookupPositioning(tech.name)
        if (positioning) {
          tech.redHatPositioning = positioning.redHatPositioning
          // Merge Red Hat products from static file if not already present
          const existingSet = new Set(tech.redHatProducts)
          for (const p of positioning.redHatProducts) {
            if (!existingSet.has(p)) tech.redHatProducts.push(p)
          }
        }
      }
    }

    // 6. Tier 2 enrichment — Gemini grounded search for proprietary tech
    const proprietaryTechs = technologies.filter(t => t.category === 'proprietary')
    if (proprietaryTechs.length > 0) {
      console.log(`[tech-stack] enriching ${proprietaryTechs.length} proprietary technologies for ${customerName}...`)
      // Process sequentially to avoid rate limiting; cap at 5 to control costs
      for (const tech of proprietaryTechs.slice(0, 5)) {
        const enriched = await enrichProprietaryTech(customerName, tech)
        // Replace in-place
        const idx = technologies.indexOf(tech)
        if (idx >= 0) technologies[idx] = enriched
        // Small delay between calls
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    // 7. Write cache
    const cache: TechStackCache = {
      contentHash,
      technologies,
      cachedAt: new Date().toISOString(),
    }
    writeFileSync(resolve(TECH_CACHE_DIR, `${customerSlug}.json`), JSON.stringify(cache, null, 2), { mode: 0o600 })
    FeatureModuleRegistry.recordOutcome('tech-stack', { success: true, recordCount: technologies.length })
    console.log(`[tech-stack] cached ${technologies.length} technologies for ${customerSlug}`)
  },

  async fetch(customerName: string): Promise<void> {
    await this.syncNow(customerName)
  },

  async cleanup(customerName: string): Promise<void> {
    const slug = toSlug(customerName)
    const cachePath = resolve(TECH_CACHE_DIR, `${slug}.json`)
    if (existsSync(cachePath)) {
      unlinkSync(cachePath)
    }
  },
})
